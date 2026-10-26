import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import admin from 'firebase-admin';

// 1. Inicialização do Firebase Admin
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ ERRO: Variável FIREBASE_SERVICE_ACCOUNT não configurada!');
} else {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();
const userJids = new Map();
const sentMessagesCache = new Map();

const semAcento = (str) => str ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';

const formatarDataBR = (isoDate) => {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '';
  const [a, m, d] = isoDate.split('-');
  return `${d}/${m}/${a}`;
};

async function enviarMensagemSegura(sock, remoteJid, conteudo) {
  const msgEnviada = await sock.sendMessage(remoteJid, conteudo);
  if (msgEnviada?.key?.id && msgEnviada?.message) {
    sentMessagesCache.set(msgEnviada.key.id, msgEnviada.message);
    if (sentMessagesCache.size > 500) {
      const firstKey = sentMessagesCache.keys().next().value;
      sentMessagesCache.delete(firstKey);
    }
  }
  return msgEnviada;
}

app.get('/', (req, res) => {
  verificarAlertasVencimento(false).catch(() => {});
  res.status(200).send('OK');
});

app.get('/verificar-alertas', async (req, res) => {
  await verificarAlertasVencimento(true);
  res.status(200).send('OK - Alertas verificados');
});

app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  try {
    const sockAntigo = sessions.get(userId);
    if (sockAntigo) {
      try { sockAntigo.end(); } catch (e) {}
      sessions.delete(userId);
    }

    const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');
    const docs = await sessionRef.get();
    if (!docs.empty) {
      const batch = db.batch();
      docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    startWhatsAppForUser(userId);
    res.json({ ok: true, message: 'Gerando novo QR Code...' });
  } catch (err) {
    console.error('Erro na rota /conectar:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/desconectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  const sock = sessions.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    sessions.delete(userId);
  }

  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');
  const docs = await sessionRef.get();
  if (!docs.empty) {
    const batch = db.batch();
    docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await db.collection('users').doc(userId).set({
    whatsapp_status: 'DISCONNECTED',
    whatsapp_qrcode: null
  }, { merge: true });

  res.json({ ok: true });
});

// ============================================================================
// 2. ADAPTADOR DE AUTENTICAÇÃO COM CACHE EM MEMÓRIA
// ============================================================================
async function useFirestoreAuthState(userId) {
  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');
  const fixId = (id) => id.replace(/\//g, '__').replace(/\./g, '_');
  const localCache = new Map();

  try {
    const allDocs = await sessionRef.get();
    allDocs.forEach(doc => {
      const payload = doc.data()?.payload;
      if (payload) {
        try {
          localCache.set(doc.id, JSON.parse(payload, BufferJSON.reviver));
        } catch (e) {}
      }
    });
  } catch (err) {
    console.error('Erro ao pré-carregar sessão do Firestore:', err);
  }

  const writeData = async (data, id) => {
    const fixed = fixId(id);
    localCache.set(fixed, data);
    try {
      const jsonString = JSON.stringify(data, BufferJSON.replacer);
      await sessionRef.doc(fixed).set({ payload: jsonString });
    } catch (err) {
      console.error('Erro ao salvar chave no Firestore:', err);
    }
  };

  const readData = async (id) => {
    const fixed = fixId(id);
    if (localCache.has(fixed)) return localCache.get(fixed);
    try {
      const docSnap = await sessionRef.doc(fixed).get();
      if (!docSnap.exists) return null;
      const { payload } = docSnap.data();
      if (!payload) return null;
      const parsed = JSON.parse(payload, BufferJSON.reviver);
      localCache.set(fixed, parsed);
      return parsed;
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    const fixed = fixId(id);
    localCache.delete(fixed);
    try {
      await sessionRef.doc(fixed).delete();
    } catch (error) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

// ============================================================================
// 3. INICIALIZAÇÃO DO SOCKET DO WHATSAPP
// ============================================================================
async function startWhatsAppForUser(userId) {
  try {
    console.log(`⚡ A iniciar instância WhatsApp para userId: ${userId}`);
    const { state, saveCreds } = await useFirestoreAuthState(userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['FinZap SaaS', 'Chrome', '1.0.0'],
      keepAliveIntervalMs: 25000,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        if (sentMessagesCache.has(key.id)) {
          return sentMessagesCache.get(key.id);
        }
        return { conversation: 'FinZap SaaS' };
      }
    });

    sessions.set(userId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const userRef = db.collection('users').doc(userId);

      if (qr) {
        const qrBase64 = await QRCode.toDataURL(qr);
        await userRef.set({
          whatsapp_status: 'WAITING_QR',
          whatsapp_qrcode: qrBase64
        }, { merge: true });
      }

      if (connection === 'open') {
        const meJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (meJid) userJids.set(userId, meJid);

        await userRef.set({
          whatsapp_status: 'CONNECTED',
          whatsapp_qrcode: null,
          whatsapp_jid: meJid
        }, { merge: true });
        console.log(`✅ WhatsApp CONECTADO para: ${userId} (${meJid})`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startWhatsAppForUser(userId), 4000);
        } else {
          await userRef.set({
            whatsapp_status: 'DISCONNECTED',
            whatsapp_qrcode: null
          }, { merge: true });
          sessions.delete(userId);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message) return;

      const remoteJid = msg.key.remoteJid || '';

      if (remoteJid.endsWith('@g.us') || remoteJid.includes('broadcast') || remoteJid.includes('newsletter')) return;

      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.ephemeralMessage?.message?.conversation ||
        msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
        ''
      ).trim();

      if (!texto) return;

      if (
        texto.startsWith('✅') || 
        texto.startsWith('📊') || 
        texto.startsWith('💳') || 
        texto.startsWith('🤖') || 
        texto.startsWith('📂') || 
        texto.startsWith('🎯') ||
        texto.startsWith('⚠️') ||
        texto.startsWith('🗑️') ||
        texto.startsWith('❓') ||
        texto.startsWith('🔔') ||
        texto.startsWith('🚨') ||
        texto.startsWith('📅') ||
        texto.startsWith('⏳') ||
        texto.startsWith('🏦') ||
        texto.startsWith('🔄') ||
        texto.startsWith('🟢') ||
        texto.startsWith('🧠')
      ) return;

      const meuNumero = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].split('@')[0];
      const meuLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].split('@')[0];
      const destinoNumero = remoteJid.split(':')[0].split('@')[0];

      const isChatComOutraPessoa = remoteJid.endsWith('@s.whatsapp.net') && meuNumero && destinoNumero !== meuNumero;
      const isOutroLid = remoteJid.endsWith('@lid') && meuLid && destinoNumero !== meuLid;

      if (isChatComOutraPessoa || isOutroLid) return;

      userJids.set(userId, remoteJid);
      await processarMensagemInteligente(userId, texto, sock, remoteJid);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp com Firestore:', err);
  }
}

// ============================================================================
// 4. ALERTA AUTOMÁTICO NO WHATSAPP DE VENCIMENTO DE CONTAS E FATURAS
// ============================================================================
async function verificarAlertasVencimento(forcarDisparoManual = false) {
  try {
    const agora = new Date();
    const brTime = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    const diaHoje = brTime.getUTCDate();
    const horaAtual = brTime.getUTCHours();
    const dataHojeStr = brTime.toISOString().split('T')[0];
    const anoMesAtual = dataHojeStr.slice(0, 7);

    if (!forcarDisparoManual && horaAtual < 8) return;

    const usersSnap = await db.collection('users')
      .where('whatsapp_status', '==', 'CONNECTED')
      .get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      if (!forcarDisparoManual && userData.ultimo_alerta_data === dataHojeStr) continue;

      const sock = sessions.get(userId);
      const remoteJid = userJids.get(userId) || userData.whatsapp_jid;
      if (!sock || !remoteJid) continue;

      const contasFixas = userData.contasFixas || [];
      const cartoes = userData.cartoes || [];

      const snapTrans = await db.collection('users').doc(userId).collection('transacoes')
        .where('anoMes', '==', anoMesAtual)
        .get();
      const transMes = snapTrans.docs.map(d => d.data());

      let avisos = [];

      for (const cf of contasFixas) {
        if (Number(cf.diaVencimento) === diaHoje) {
          const jaPaga = transMes.some(
            t => (t.conta_fixa_id === cf.id || semAcento(t.descricao).includes(semAcento(cf.nome))) && t.pago !== false
          );
          if (!jaPaga) {
            avisos.push(`• *${cf.nome}* (Conta Fixa) — R$ ${Number(cf.valorPadrao || 0).toFixed(2)}`);
          }
        }
      }

      const agendadasHoje = transMes.filter(
        t => t.pago === false && t.data_vencimento === dataHojeStr
      );
      for (const ag of agendadasHoje) {
        avisos.push(`• *${ag.descricao}* (${ag.tipo === 'RECEITA' ? 'A Receber' : 'A Pagar'}) — R$ ${Number(ag.valor || 0).toFixed(2)}`);
      }

      for (const c of cartoes) {
        if (Number(c.diaVencimento) === diaHoje) {
          const faturaMes = transMes
            .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(c.nome) && !t.fatura_paga)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          if (faturaMes > 0) {
            avisos.push(`• *Fatura Cartão ${c.nome}* — R$ ${faturaMes.toFixed(2)}`);
          }
        }
      }

      if (avisos.length > 0) {
        await enviarMensagemSegura(sock, remoteJid, {
          text: `🔔 *Alerta de Vencimento Hoje (${formatarDataBR(dataHojeStr)})*\n\n` +
                `Você possui os seguintes compromissos vencendo hoje:\n` +
                `${avisos.join('\n')}\n\n` +
                `💡 _Você pode dar baixa enviando "paguei [nome da conta] no pix" aqui no WhatsApp!_`
        });
      } else if (forcarDisparoManual) {
        await enviarMensagemSegura(sock, remoteJid, {
          text: `🔔 *Teste de Alerta FinZap (${formatarDataBR(dataHojeStr)})*\n\n✅ Nenhuma conta ou fatura em aberto vence no dia de hoje (Dia ${diaHoje}).`
        });
      }

      await db.collection('users').doc(userId).set({ ultimo_alerta_data: dataHojeStr }, { merge: true });
    }
  } catch (e) {
    console.error('Erro ao verificar alertas de vencimento:', e);
  }
}

setInterval(() => verificarAlertasVencimento(false), 30 * 60 * 1000);

// ============================================================================
// 5. EXTRAÇÃO INTELIGENTE DE DATA E DE CATEGORIA + MOTOR DE APRENDIZADO
// ============================================================================
function extrairDataVencimento(texto) {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;

  const matchData = texto.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (matchData) {
    const dia = String(matchData[1]).padStart(2, '0');
    const mes = String(matchData[2]).padStart(2, '0');
    let ano = matchData[3] ? String(matchData[3]) : String(anoAtual);
    if (ano.length === 2) ano = `20${ano}`;
    return {
      dataVencimento: `${ano}-${mes}-${dia}`,
      anoMes: `${ano}-${mes}`,
      trechoRemovido: matchData[0]
    };
  }

  const matchDia = texto.match(/(?:vence|vencimento|vencer|dia)\s*(?:dia)?\s*(\d{1,2})\b/i);
  if (matchDia) {
    const dia = String(matchDia[1]).padStart(2, '0');
    const mes = String(mesAtual).padStart(2, '0');
    return {
      dataVencimento: `${anoAtual}-${mes}-${dia}`,
      anoMes: `${anoAtual}-${mes}`,
      trechoRemovido: matchDia[0]
    };
  }

  return null;
}

async function consultarRegraAprendida(userId, descricaoItem) {
  try {
    const descLimpa = semAcento(descricaoItem).trim();
    const regrasSnap = await db.collection('users').doc(userId).collection('regras_aprendidas').get();
    
    for (const docRegra of regrasSnap.docs) {
      const data = docRegra.data();
      if (descLimpa.includes(semAcento(data.termo))) {
        return { categoria: data.categoria, subcategoria: data.subcategoria };
      }
    }
  } catch (e) {}
  return null;
}

async function salvarRegraAprendida(userId, termo, categoria, subcategoria) {
  try {
    const termoLimpo = semAcento(termo).trim();
    if (!termoLimpo || termoLimpo.length < 2) return;
    await db.collection('users').doc(userId).collection('regras_aprendidas').doc(termoLimpo).set({
      termo: termoLimpo,
      categoria,
      subcategoria,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {}
}

function classificarCategoriaESubcategoria(pLimpo, isReceita, categorias, subcategoriasMap = {}) {
  if (isReceita) {
    if (/salario|pagamento|pro-labore|adiantamento/i.test(pLimpo)) {
      return { categoria: 'Receita', subcategoria: 'Salário', reconhecida: true };
    }
    return { categoria: 'Receita', subcategoria: 'Vendas / Extras', reconhecida: true };
  }

  if (/mercado|supermercado|atacadao|assai|tenda|compras|feira|acougue|hortifruti|laranja|maca|banana|uva|morango|fruta|verdura|legume|cebola|alho|tomate|batata|arroz|feijao|macarrao|carne|frango|peixe|ovo|leite|pao|queijo|presunto|manteiga|oleo|azeite|acucar|sal|sabao|detergente|papel higienico/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Mercado', reconhecida: true };
  }

  if (/lanche|hamburguer|burger|pizza|pizzaria|restaurante|ifood|padaria|almoco|jantar|cafe|sorvete|acai|pastel|salgado|churrasco|barzinho|bebida|cerveja|refrigerante|suco|doceria|bolo|chocolate/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Lazer', reconhecida: true };
  }

  if (/uber|99|taxi|onibus|metro|passagem|estacionamento|pedagio/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Apps / Pedágio', reconhecida: true };
  }
  if (/gasolina|etanol|alcool|diesel|combustivel|posto|abastecimento/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Combustível', reconhecida: true };
  }
  if (/mecanico|oficina|oleo do motor|pneu|ipva|licenciamento|seguro auto|lavagem/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Manutenção / Veículo', reconhecida: true };
  }

  if (/cinema|passeio|parque|show|ingresso|viagem|hotel|pousada|shopping|jogo|game|brinquedo/i.test(pLimpo)) {
    return { categoria: 'Lazer', subcategoria: 'Passeios', reconhecida: true };
  }
  if (/netflix|spotify|prime|disney|hbo|youtube|streaming|assinatura/i.test(pLimpo)) {
    return { categoria: 'Lazer', subcategoria: 'Streaming', reconhecida: true };
  }

  if (/luz|energia|agua|sabesp|gas|internet|wifi|telefone|celular|vivo|claro|tim|aluguel|condominio|iptu|boleto|imposto|mei|das|contador|escola|faculdade|curso|farmacia|remedio|medico|consulta|exame|dentista/i.test(pLimpo)) {
    if (/luz|energia|agua|gas|internet|telefone|celular|aluguel|condominio|iptu/i.test(pLimpo)) {
      return { categoria: 'Contas', subcategoria: 'Casa / Fixas', reconhecida: true };
    }
    if (/farmacia|remedio|medico|consulta|exame|dentista/i.test(pLimpo)) {
      return { categoria: 'Contas', subcategoria: 'Saúde / Farmácia', reconhecida: true };
    }
    return { categoria: 'Contas', subcategoria: 'Boletos / Serviços', reconhecida: true };
  }

  for (const cat of categorias) {
    const subs = subcategoriasMap[cat] || [];
    for (const sub of subs) {
      if (pLimpo.includes(semAcento(sub))) {
        return { categoria: cat, subcategoria: sub, reconhecida: true };
      }
    }
    if (pLimpo.includes(semAcento(cat))) {
      return { categoria: cat, subcategoria: subs[0] || 'Geral', reconhecida: true };
    }
  }

  return { categoria: null, subcategoria: null, reconhecida: false };
}

// ============================================================================
// 6. GRAVAÇÃO NO FIRESTORE + ALERTAS DE CARTÃO E CHEQUE ESPECIAL
// ============================================================================
async function gravarItensNoBanco(userId, itens, cartoes, bancos, orcamentos, anoMesPadrao, textoOriginal) {
  const hoje = new Date();
  const hojeStr = hoje.toISOString().split('T')[0];
  let respostas = [];

  const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
  const todasTransacoes = snapAll.docs.map(d => d.data());

  for (const item of itens) {
    const parcelasTotal = item.parcelasTotal || 1;
    const valorParcela = Number(item.valorParcela);
    const isAgendado = item.pago === false;
    const catFinal = item.categoria || 'Outros';
    const subFinal = item.subcategoria || 'Geral';
    // Gera o ID único para vincular todas as parcelas desta compra
    const grupoId = `compra_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    await salvarRegraAprendida(userId, item.descricao, catFinal, subFinal);

    for (let i = 0; i < parcelasTotal; i++) {
      let anoMesItem = item.anoMes || anoMesPadrao;
      let dataVencItem = item.data_vencimento || hojeStr;

      if (parcelasTotal > 1) {
        const dataParcela = new Date(hoje.getFullYear(), hoje.getMonth() + i, 15);
        const anoM = dataParcela.getFullYear();
        const mesM = String(dataParcela.getMonth() + 1).padStart(2, '0');
        anoMesItem = `${anoM}-${mesM}`;
        dataVencItem = `${anoM}-${mesM}-15`;
      }

      const novoDoc = {
        descricao: parcelasTotal > 1 ? `${item.descricao} (${i + 1}/${parcelasTotal})` : item.descricao,
        valor: valorParcela,
        tipo: item.tipo,
        metodo: item.metodo || 'A DEFINIR',
        cartao_nome: item.cartao_nome || null,
        banco_nome: item.banco_nome || null,
        categoria: catFinal,
        subcategoria: subFinal,
        parcela_atual: i + 1,
        parcelas_total: parcelasTotal,
        grupo_id: parcelasTotal > 1 ? grupoId : null, // Adiciona o vínculo no banco
        fatura_paga: false,
        pago: item.pago !== undefined ? item.pago : true,
        data_vencimento: dataVencItem,
        anoMes: anoMesItem,
        origem: 'WHATSAPP_IA',
        mensagem_original: textoOriginal,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('users').doc(userId).collection('transacoes').add(novoDoc);
      todasTransacoes.push(novoDoc);
    }

    if (isAgendado) {
      respostas.push(
        `📅 *Conta Lançada (${item.tipo === 'RECEITA' ? 'A Receber' : 'A Vencer'})*\n` +
        `• *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
        `• Valor: *R$ ${valorParcela.toFixed(2)}*\n` +
        `• Vencimento: *${formatarDataBR(item.data_vencimento)}*`
      );
      continue;
    }

    let alertasExtras = '';

    const limiteCat = Number(orcamentos[catFinal] || 0);
    if (limiteCat > 0 && item.tipo === 'DESPESA') {
      const gastoCatMes = todasTransacoes
        .filter(t => t.anoMes === anoMesPadrao && t.tipo === 'DESPESA' && semAcento(t.categoria) === semAcento(catFinal) && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
        .reduce((a, b) => a + Number(b.valor || 0), 0);
      const pctCat = Math.round((gastoCatMes / limiteCat) * 100);
      if (pctCat >= 100) alertasExtras += `\n🚨 *Limite da Categoria ${catFinal} Estourado!* (${pctCat}%)`;
      else if (pctCat >= 80) alertasExtras += `\n⚠️ *Atenção:* Categoria ${catFinal} em ${pctCat}%.`;
    }

    if (item.metodo === 'CREDITO' && item.cartao_nome) {
      const objCartao = cartoes.find(c => semAcento(c.nome) === semAcento(item.cartao_nome));
      if (objCartao && Number(objCartao.limite) > 0) {
        const gastoAcumuladoCartao = todasTransacoes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(objCartao.nome) && !t.fatura_paga && t.anoMes >= anoMesPadrao)
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteTotal = Number(objCartao.limite);
        const disponivel = limiteTotal - gastoAcumuladoCartao;
        const pctCartao = Math.round((gastoAcumuladoCartao / limiteTotal) * 100);

        if (pctCartao >= 100) alertasExtras += `\n🚨 *ALERTA:* O limite do *${objCartao.nome}* estourou!`;
        else if (pctCartao >= 80) alertasExtras += `\n⚠️ *Alerta de Limite (${objCartao.nome}):* ${pctCartao}% comprometido!`;
        else alertasExtras += `\n💳 _Disponível no ${objCartao.nome}: R$ ${disponivel.toFixed(2)}_`;
      }
    }

    if (item.metodo !== 'CREDITO' && item.banco_nome) {
      const idxBanco = bancos.findIndex(b => semAcento(b.nome) === semAcento(item.banco_nome));
      if (idxBanco !== -1) {
        const bObj = bancos[idxBanco];
        const entB = todasTransacoes
          .filter(t => t.tipo === 'RECEITA' && t.pago !== false && (semAcento(t.banco_nome) === semAcento(bObj.nome) || (!t.banco_nome && idxBanco === 0)))
          .reduce((a, x) => a + Number(x.valor || 0), 0);
        const saiB = todasTransacoes
          .filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'CREDITO' && (semAcento(t.banco_nome) === semAcento(bObj.nome) || (!t.banco_nome && idxBanco === 0)))
          .reduce((a, x) => a + Number(x.valor || 0), 0);
        const saldoAtualBanco = Number(bObj.saldoInicial || 0) + entB - saiB;

        if (saldoAtualBanco < 0) {
          alertasExtras += `\n🚨 *ALERTA DE CHEQUE ESPECIAL:* Conta *${bObj.nome}* negativa (R$ ${saldoAtualBanco.toFixed(2)})!`;
        } else {
          alertasExtras += `\n🏦 _Saldo no ${bObj.nome}: R$ ${saldoAtualBanco.toFixed(2)}_`;
        }
      }
    }

    const origemPagamento = item.metodo === 'CREDITO' ? `Cartão ${item.cartao_nome}` : item.banco_nome ? `${item.metodo} (${item.banco_nome})` : item.metodo;

    respostas.push(
      `🧠 *[Aprendido]* ✅ *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
      `💰 R$ ${valorParcela.toFixed(2)} - ${origemPagamento}${alertasExtras}`
    );
  }

  return respostas;
}

// ============================================================================
// 7. FILA DE PENDÊNCIAS COM CONSULTA PRÉVIA DE REGRAS APRENDIDAS
// ============================================================================
async function processarFilaDePendencias(userId, itens, cartoes, bancos, orcamentos, anoMesAtual, textoOriginal, sock, remoteJid) {
  const userRef = db.collection('users').doc(userId);

  const prontos = [];
  const pendentes = [];

  for (const item of itens) {
    const regraSalva = await consultarRegraAprendida(userId, item.descricao);
    if (regraSalva) {
      item.categoria = regraSalva.categoria;
      item.subcategoria = regraSalva.subcategoria;
      item.precisaPerguntarCategoria = false;
    }

    const precisaMetodo = !item.metodo && item.pago !== false;
    const precisaBanco = (item.metodo === 'PIX' || item.metodo === 'DEBITO') && !item.banco_nome && item.pago !== false;
    const precisaCategoria = !item.categoria || item.precisaPerguntarCategoria;

    if (!precisaMetodo && !precisaBanco && !precisaCategoria) {
      prontos.push(item);
    } else {
      pendentes.push(item);
    }
  }

  let msgs = [];

  if (prontos.length > 0) {
    const resps = await gravarItensNoBanco(userId, prontos, cartoes, bancos, orcamentos, anoMesAtual, textoOriginal);
    msgs.push(...resps);
  }

  if (pendentes.length > 0) {
    const primeiro = pendentes[0];
    let etapa = 'METODO';
    let textoPergunta = '';

    const resumoPendentes = pendentes
      .map(i => `• *${i.descricao}* [${i.categoria || '?'} > ${i.subcategoria || '?'}] — R$ ${i.valorTotal.toFixed(2)}`)
      .join('\n');

    if (!primeiro.metodo && primeiro.pago !== false) {
      etapa = 'METODO';
      const opcoesCartoes = cartoes.map(c => c.nome).join(', ');
      textoPergunta =
        `❓ *Qual foi a forma de pagamento?*\n${resumoPendentes}\n\n` +
        `Responda com: *Pix*, *Débito*, *Dinheiro* ou o nome do cartão (*${opcoesCartoes}*).`;
    } else if ((primeiro.metodo === 'PIX' || primeiro.metodo === 'DEBITO') && !primeiro.banco_nome && primeiro.pago !== false) {
      etapa = 'BANCO';
      const opcoesBancos = bancos.map(b => b.nome).join(' ou ');
      textoPergunta =
        `🏦 *De qual conta bancária vai sair esse ${primeiro.metodo}?*\n${resumoPendentes}\n\n` +
        `Responda com o nome do banco: *${opcoesBancos}*`;
    } else {
      etapa = 'CATEGORIA';
      textoPergunta =
        `📂 *Em qual Categoria e Subcategoria deseja lançar?*\n${resumoPendentes}\n\n` +
        `Exemplos: *Mercado*, *Lazer*, *Transporte* ou *Contas*. O robô vai gravar para as próximas vezes!`;
    }

    await userRef.set({
      pendente_pagamento: {
        etapa,
        itens: pendentes,
        textoOriginal,
        criadoEm: Date.now()
      }
    }, { merge: true });

    msgs.push(textoPergunta);
  } else {
    await userRef.set({ pendente_pagamento: null }, { merge: true });
  }

  if (msgs.length > 0) {
    await enviarMensagemSegura(sock, remoteJid, { text: msgs.join('\n\n') });
  }
}

// ============================================================================
// 8. MOTOR DE INTELIGÊNCIA FINANCEIRA COMPLETO
// ============================================================================
async function processarMensagemInteligente(userId, textoUsuario, sock, remoteJid) {
  try {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data() || {};
    const cartoes = userData.cartoes || [];
    const bancos = userData.bancos || [{ id: 'b1', nome: 'Itaú', tipo: 'Conta Corrente' }, { id: 'b2', nome: 'Nubank Conta', tipo: 'Digital' }];
    const categorias = userData.categorias || ['Alimentação', 'Mercado', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const subcategorias = userData.subcategorias || {};
    const orcamentos = userData.orcamentos || {};
    const pendente = userData.pendente_pagamento || null;

    const txtLimpo = semAcento(textoUsuario).trim();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const hojeStr = hoje.toISOString().split('T')[0];

    if (/^(teste|ping|status)$/i.test(txtLimpo)) {
      await enviarMensagemSegura(sock, remoteJid, {
        text: `🟢 *FinZap 100% Online com Aprendizado Adaptativo!*\nCompetência: ${anoMesAtual}`
      });
      return;
    }

    const pareceNovoLancamento = /[a-zA-ZÀ-ÿ]+\s+\d+[,\.]?\d*/.test(textoUsuario) && !/\b(x|vezes|parcelas)\b/i.test(txtLimpo);

    if (pendente && !pareceNovoLancamento) {
      if (/^(cancelar|esquecer|nao)$/i.test(txtLimpo)) {
        await userRef.set({ pendente_pagamento: null }, { merge: true });
        await enviarMensagemSegura(sock, remoteJid, { text: '🗑️ Cancelado.' });
        return;
      }

      if (pendente.etapa === 'BAIXA_CONTA_BANCO' || pendente.etapa === 'PAGAR_FATURA_BANCO') {
        const bancoEscolhido = bancos.find(b => txtLimpo.includes(semAcento(b.nome))) || bancos[0];
        if (bancoEscolhido) {
          if (pendente.etapa === 'PAGAR_FATURA_BANCO') {
            const { cartaoNome, valorFatura } = pendente;
            const snapFatura = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();

            const batch = db.batch();
            snapFatura.docs.forEach(d => {
              const dt = d.data();
              if (dt.tipo === 'DESPESA' && semAcento(dt.cartao_nome) === semAcento(cartaoNome) && !dt.fatura_paga) {
                batch.update(d.ref, { fatura_paga: true });
              }
            });
            await batch.commit();

            await db.collection('users').doc(userId).collection('transacoes').add({
              descricao: `Pagamento Fatura Cartão ${cartaoNome}`,
              valor: Number(valorFatura),
              tipo: 'DESPESA',
              metodo: 'PAGAMENTO_FATURA',
              cartao_nome: null,
              banco_nome: bancoEscolhido.nome,
              categoria: 'Contas',
              subcategoria: 'Fatura Cartão',
              pago: true,
              data_vencimento: hojeStr,
              anoMes: anoMesAtual,
              origem: 'WHATSAPP_IA',
              criadoEm: admin.firestore.FieldValue.serverTimestamp()
            });

            await userRef.set({ pendente_pagamento: null }, { merge: true });
            await enviarMensagemSegura(sock, remoteJid, { text: `✅ *Fatura ${cartaoNome} paga com sucesso via ${bancoEscolhido.nome}!*` });
            return;
          }

          if (pendente.etapa === 'BAIXA_CONTA_BANCO') {
            const { docId, descricao, valor, metodo } = pendente;
            await db.collection('users').doc(userId).collection('transacoes').doc(docId).update({
              pago: true,
              metodo: metodo || 'PIX',
              banco_nome: bancoEscolhido.nome,
              data_pagamento: hojeStr
            });
            await userRef.set({ pendente_pagamento: null }, { merge: true });
            await enviarMensagemSegura(sock, remoteJid, { text: `✅ *Baixa efetivada em ${descricao} (${bancoEscolhido.nome})!*` });
            return;
          }
        }
      }

      if (Array.isArray(pendente.itens) && pendente.itens.length > 0) {
        let itensAtualizados = [...pendente.itens];

        if (pendente.etapa === 'METODO') {
          let metodoResp = null;
          let cartaoResp = null;
          let bancoResp = null;

          for (const c of cartoes) {
            if (txtLimpo.includes(semAcento(c.nome))) { metodoResp = 'CREDITO'; cartaoResp = c.nome; break; }
          }
          for (const b of bancos) {
            if (txtLimpo.includes(semAcento(b.nome))) {
              bancoResp = b.nome;
              if (!metodoResp) metodoResp = /debito/i.test(txtLimpo) ? 'DEBITO' : 'PIX';
              break;
            }
          }
          if (!metodoResp) {
            if (/credito|cartao/i.test(txtLimpo)) { metodoResp = 'CREDITO'; cartaoResp = cartoes[0]?.nome || 'CREDITO'; }
            else if (/debito/i.test(txtLimpo)) metodoResp = 'DEBITO';
            else if (/pix/i.test(txtLimpo)) metodoResp = 'PIX';
            else if (/dinheiro/i.test(txtLimpo)) metodoResp = 'DINHEIRO';
          }

          if (metodoResp) {
            itensAtualizados = itensAtualizados.map(it => ({
              ...it,
              metodo: metodoResp,
              cartao_nome: cartaoResp,
              banco_nome: metodoResp === 'CREDITO' ? null : (bancoResp || it.banco_nome || null),
              pago: true
            }));
            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
            return;
          }
        } else if (pendente.etapa === 'BANCO') {
          const bancoObj = bancos.find(b => txtLimpo.includes(semAcento(b.nome))) || bancos[0];
          if (bancoObj) {
            itensAtualizados = itensAtualizados.map(it => ({ ...it, banco_nome: bancoObj.nome }));
            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
            return;
          }
        } else if (pendente.etapa === 'CATEGORIA') {
          const itemAlvo = itensAtualizados[0];
          const classif = classificarCategoriaESubcategoria(txtLimpo, false, categorias, subcategorias);
          const catFinal = classif.categoria || textoUsuario.trim();
          const subFinal = classif.subcategoria || 'Geral';

          if (itemAlvo) {
            await salvarRegraAprendida(userId, itemAlvo.descricao, catFinal, subFinal);
          }

          itensAtualizados = itensAtualizados.map(it => ({
            ...it,
            categoria: catFinal,
            subcategoria: subFinal,
            precisaPerguntarCategoria: false
          }));

          await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
          return;
        }
      }
    }

    // Transferência entre contas
    if (/transferir|transferencia|transferi|passei.*para/i.test(txtLimpo)) {
      const textoNormTransf = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
      const matchVal = textoNormTransf.match(/(\d+\.\d{2}|\d+)/);
      if (matchVal) {
        const valorTransf = parseFloat(matchVal[0]);
        let bancoOrigem = null;
        let bancoDestino = null;

        for (const b of bancos) {
          const nomeB = semAcento(b.nome);
          if (new RegExp(`(?:do|da|de)\\s+${nomeB}`, 'i').test(txtLimpo)) bancoOrigem = b.nome;
          if (new RegExp(`(?:para|pro|pra|no|na)\\s+${nomeB}`, 'i').test(txtLimpo)) bancoDestino = b.nome;
        }

        if (!bancoOrigem || !bancoDestino) {
          const encontrados = bancos.filter(b => txtLimpo.includes(semAcento(b.nome)));
          if (encontrados.length >= 2) { bancoOrigem = encontrados[0].nome; bancoDestino = encontrados[1].nome; }
        }

        if (bancoOrigem && bancoDestino && valorTransf > 0) {
          await db.collection('users').doc(userId).collection('transacoes').add({
            descricao: `Transferência enviada para ${bancoDestino}`,
            valor: valorTransf,
            tipo: 'DESPESA',
            metodo: 'TRANSFERENCIA',
            banco_nome: bancoOrigem,
            categoria: 'Transferência',
            subcategoria: 'Entre Contas',
            pago: true,
            data_vencimento: hojeStr,
            anoMes: anoMesAtual,
            origem: 'WHATSAPP_IA',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });

          await db.collection('users').doc(userId).collection('transacoes').add({
            descricao: `Transferência recebida de ${bancoOrigem}`,
            valor: valorTransf,
            tipo: 'RECEITA',
            metodo: 'TRANSFERENCIA',
            banco_nome: bancoDestino,
            categoria: 'Transferência',
            subcategoria: 'Entre Contas',
            pago: true,
            data_vencimento: hojeStr,
            anoMes: anoMesAtual,
            origem: 'WHATSAPP_IA',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });

          await enviarMensagemSegura(sock, remoteJid, { text: `🔄 *Transferência de R$ ${valorTransf.toFixed(2)} de ${bancoOrigem} para ${bancoDestino} realizada!*` });
          return;
        }
      }
    }

    // Dar baixa em contas pelo WhatsApp
    const isComandoBaixa = /^(paguei|dar baixa|baixa|quitei|pagar fatura)/i.test(txtLimpo) && !/\b\d+[,\.]\d{2}\b/.test(textoUsuario);
    if (isComandoBaixa) {
      const snapMes = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
      const transMes = snapMes.docs.map(d => ({ id: d.id, ...d.data() }));
      const bancoInformado = bancos.find(b => txtLimpo.includes(semAcento(b.nome)));

      if (/fatura/i.test(txtLimpo)) {
        const cartaoAlvo = cartoes.find(c => txtLimpo.includes(semAcento(c.nome))) || cartoes[0];
        if (cartaoAlvo) {
          const itensFatura = transMes.filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(cartaoAlvo.nome) && !t.fatura_paga);
          const totalFatura = itensFatura.reduce((a, b) => a + Number(b.valor || 0), 0);
          if (totalFatura <= 0) {
            await enviarMensagemSegura(sock, remoteJid, { text: `✅ Fatura de ${cartaoAlvo.nome} já paga!` });
            return;
          }
          if (!bancoInformado) {
            await userRef.set({ pendente_pagamento: { etapa: 'PAGAR_FATURA_BANCO', cartaoNome: cartaoAlvo.nome, valorFatura: totalFatura, criadoEm: Date.now() } }, { merge: true });
            await enviarMensagemSegura(sock, remoteJid, { text: `🏦 *De qual banco vai debitar a fatura do ${cartaoAlvo.nome} (R$ ${totalFatura.toFixed(2)})?*\nResponda com: *${bancos.map(b => b.nome).join(' ou ')}*.` });
            return;
          }
        }
      }

      const contasAbertas = transMes.filter(t => t.pago === false);
      const contaEncontrada = contasAbertas.find(t => txtLimpo.includes(semAcento(t.descricao)));
      if (contaEncontrada) {
        const metodoBaixa = /debito/i.test(txtLimpo) ? 'DEBITO' : 'PIX';
        if (!bancoInformado) {
          await userRef.set({ pendente_pagamento: { etapa: 'BAIXA_CONTA_BANCO', docId: contaEncontrada.id, descricao: contaEncontrada.descricao, valor: contaEncontrada.valor, metodo: metodoBaixa, criadoEm: Date.now() } }, { merge: true });
          await enviarMensagemSegura(sock, remoteJid, { text: `🏦 *De qual banco vai sair o pagamento de ${contaEncontrada.descricao}?*\nResponda com: *${bancos.map(b => b.nome).join(' ou ')}*.` });
          return;
        }
      }
    }

    // Desfazer
    const isDesfazer = /^(apagar|excluir|deletar|remover|desfazer|cancelar)\s*(ultimo|ultima|lancamento|gasto)?$/i.test(txtLimpo);
    if (isDesfazer) {
      const ultimoSnap = await db.collection('users').doc(userId).collection('transacoes').orderBy('criadoEm', 'desc').limit(1).get();
      if (!ultimoSnap.empty) {
        await ultimoSnap.docs[0].ref.delete();
        await enviarMensagemSegura(sock, remoteJid, { text: '🗑️ Último lançamento removido!' });
        return;
      }
    }

    // Injeção da variável transacoesFiltradas
    const snapMesGeral = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
    const transacoesFiltradas = snapMesGeral.docs.map(d => d.data());

    // Consultas de Contas a Vencer
    if (/proxima|proximas|5 dias/i.test(txtLimpo) && /conta|vencimento|vencer/i.test(txtLimpo)) {
      const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
      const hojeZero = new Date(hojeStr + 'T00:00:00');
      const limite5 = new Date(hojeZero.getTime() + 5 * 24 * 60 * 60 * 1000);
      const prox = snapAll.docs.map(d => d.data()).filter(t => t.pago === false && t.data_vencimento && new Date(t.data_vencimento + 'T00:00:00') <= limite5);
      const linhas = prox.map(t => `• *${t.descricao}*: R$ ${Number(t.valor).toFixed(2)} (Vence: ${formatarDataBR(t.data_vencimento)})`).join('\n');
      await enviarMensagemSegura(sock, remoteJid, { text: `⏳ *Contas Próximas (Até 5 dias)*\n\n${linhas || 'Nenhuma conta nos próximos 5 dias.'}` });
      return;
    }

    if (/contas a vencer|contas em aberto/i.test(txtLimpo)) {
      const abertas = transacoesFiltradas.filter(t => t.anoMes === anoMesAtual && t.pago === false);
      const linhas = abertas.map(t => `• *${t.descricao}*: R$ ${Number(t.valor).toFixed(2)} (Vence: ${formatarDataBR(t.data_vencimento)})`).join('\n');
      await enviarMensagemSegura(sock, remoteJid, { text: `📅 *Contas em Aberto*\n\n${linhas || 'Nenhuma conta em aberto.'}` });
      return;
    }

    // Consultor Geral
    const isPergunta = /\?|quanto|qual|resumo|saldo|saldos|fatura|limite/i.test(txtLimpo) && !/gastei|comprei|paguei|recebi|vence/i.test(txtLimpo);
    if (isPergunta) {
      const transMes = transacoesFiltradas;
      const rec = transMes.filter(t => t.tipo === 'RECEITA' && t.pago !== false).reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'PAGAMENTO_FATURA').reduce((a, b) => a + Number(b.valor || 0), 0);
      await enviarMensagemSegura(sock, remoteJid, { text: `📊 *Resumo FinZap (${anoMesAtual})*\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Resultado: R$ ${(rec - desp).toFixed(2)}*` });
      return;
    }

    // Lançamentos normais com aprendizado
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    let itensExtraidos = [];

    for (const parte of partes) {
      const pLimpo = semAcento(parte);
      const infoVenc = extrairDataVencimento(parte);
      const isAgendado = Boolean(infoVenc) || /\b(vence|vencimento|a pagar|a receber)\b/i.test(pLimpo);
      const parteSemData = infoVenc ? parte.replace(infoVenc.trechoRemovido, ' ') : parte;
      const matchValor = parteSemData.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0]);
      if (isNaN(valorTotal) || valorTotal <= 0) continue;

      const isReceita = /\b(recebi|ganhei|salario|venda|a receber)\b/i.test(pLimpo);
      let metodo = null;
      let cartaoNome = null;
      let bancoNome = null;

      for (const c of cartoes) { if (pLimpo.includes(semAcento(c.nome))) { metodo = 'CREDITO'; cartaoNome = c.nome; break; } }
      for (const b of bancos) { if (pLimpo.includes(semAcento(b.nome))) { bancoNome = b.nome; if (!metodo) metodo = /debito/i.test(pLimpo) ? 'DEBITO' : 'PIX'; break; } }

      let descricao = parteSemData.replace(/\b(comprei|gastei|paguei|no pix|no debito|pix|debito|reais|r\$|de|do|da|no|na|em)\b/gi, ' ').replace(matchValor[0], '').trim();
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      const regraSalva = await consultarRegraAprendida(userId, descricao);
      let cat = regraSalva ? regraSalva.categoria : null;
      let sub = regraSalva ? regraSalva.subcategoria : null;

      if (!cat) {
        const classif = classificarCategoriaESubcategoria(pLimpo, isReceita, categorias, subcategorias);
        cat = classif.categoria;
        sub = classif.subcategoria;
      }

      itensExtraidos.push({
        descricao,
        valorTotal,
        valorParcela: valorTotal,
        parcelasTotal: 1,
        tipo: isReceita ? 'RECEITA' : 'DESPESA',
        metodo,
        cartao_nome: cartaoNome,
        banco_nome: bancoNome,
        categoria: cat,
        subcategoria: sub,
        precisaPerguntarCategoria: !cat,
        pago: !isAgendado,
        data_vencimento: infoVenc ? infoVenc.dataVencimento : hojeStr,
        anoMes: infoVenc ? infoVenc.anoMes : anoMesAtual
      });
    }

    if (itensExtraidos.length > 0) {
      await processarFilaDePendencias(userId, itensExtraidos, cartoes, bancos, orcamentos, anoMesAtual, textoUsuario, sock, remoteJid);
    }

  } catch (e) {
    console.error('Erro no processamento da mensagem:', e);
  }
}

async function restaurarSessoesAtivas() {
  try {
    const usersSnap = await db.collection('users').where('whatsapp_status', '==', 'CONNECTED').get();
    usersSnap.forEach(doc => startWhatsAppForUser(doc.id));
  } catch (err) {}
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  restaurarSessoesAtivas();
});