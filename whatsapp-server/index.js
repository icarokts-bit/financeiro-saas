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
// Cache de mensagens enviadas para evitar o erro "Aguardando mensagem" no WhatsApp
const sentMessagesCache = new Map();

const semAcento = (str) => str ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';

const formatarDataBR = (isoDate) => {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '';
  const [a, m, d] = isoDate.split('-');
  return `${d}/${m}/${a}`;
};

// Função segura de envio que guarda a mensagem no cache de retry do protocolo Signal
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

// Rota principal super leve para o cron-job.org
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
// 2. ADAPTADOR DE AUTENTICAÇÃO COM CACHE EM MEMÓRIA (EVITA ERRO DE CRIPTOGRAFIA)
// ============================================================================
async function useFirestoreAuthState(userId) {
  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');
  const fixId = (id) => id.replace(/\//g, '__').replace(/\./g, '_');
  const localCache = new Map();

  // Pré-carrega todas as chaves existentes na memória para leitura instantânea pelo Signal
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
// 3. INICIALIZAÇÃO DO SOCKET DO WHATSAPP (COM GETMESSAGE ANTI-FALHA DE CIFRA)
// ============================================================================
async function startWhatsAppForUser(userId) {
  try {
    console.log(`⚡ Iniciando instância WhatsApp para userId: ${userId}`);
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
      // Essencial para o WhatsApp re-encriptar a mensagem caso apareça "Aguardando mensagem"
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
      if (!msg.message || !msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid || '';

      // Bloqueia grupos, canais e conversas com outras pessoas
      if (remoteJid.endsWith('@g.us') || remoteJid.includes('broadcast') || remoteJid.includes('newsletter')) return;

      const meuNumero = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
      const meuLid = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
      const destinoNumero = remoteJid.split(':')[0].split('@')[0];

      const isChatProprio = (meuNumero && destinoNumero === meuNumero) || (meuLid && destinoNumero === meuLid);
      if (!isChatProprio) return;

      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!texto) return;

      // Filtro anti-loop de mensagens enviadas pelo próprio robô
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
        texto.startsWith('🟢')
      ) return;

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
// 5. EXTRAÇÃO INTELIGENTE DE DATA E DE CATEGORIA + SUBCATEGORIA
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

function classificarCategoriaESubcategoria(pLimpo, isReceita, categorias, subcategoriasMap = {}) {
  if (isReceita) {
    if (/salario|pagamento|pro-labore|adiantamento/i.test(pLimpo)) {
      return { categoria: 'Receita', subcategoria: 'Salário', reconhecida: true };
    }
    return { categoria: 'Receita', subcategoria: 'Vendas / Extras', reconhecida: true };
  }

  // 1. Alimentação > Mercado (Hortifruti, Supermercado, Feira, Carnes, Grãos)
  if (/mercado|supermercado|atacadao|assai|tenda|compras|feira|acougue|hortifruti|maca|banana|fruta|verdura|legume|cebola|alho|tomate|batata|arroz|feijao|macarrao|carne|frango|peixe|ovo|leite|pao|queijo|presunto|manteiga|oleo|azeite|acucar|sal|sabao|detergente|papel higienico/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Mercado', reconhecida: true };
  }

  // 2. Alimentação > Lazer (Lanches, Restaurantes, Delivery, Cafés, Bares)
  if (/lanche|hamburguer|burger|pizza|pizzaria|restaurante|ifood|padaria|almoco|jantar|cafe|sorvete|acai|pastel|salgado|churrasco|barzinho|bebida|cerveja|refrigerante|suco|doceria|bolo|chocolate/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Lazer', reconhecida: true };
  }

  // 3. Transporte
  if (/uber|99|taxi|onibus|metro|passagem|estacionamento|pedagio/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Apps / Pedágio', reconhecida: true };
  }
  if (/gasolina|etanol|alcool|diesel|combustivel|posto|abastecimento/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Combustível', reconhecida: true };
  }
  if (/mecanico|oficina|oleo do motor|pneu|ipva|licenciamento|seguro auto|lavagem/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Manutenção / Veículo', reconhecida: true };
  }

  // 4. Lazer
  if (/cinema|passeio|parque|show|ingresso|viagem|hotel|pousada|shopping|jogo|game|brinquedo/i.test(pLimpo)) {
    return { categoria: 'Lazer', subcategoria: 'Passeios', reconhecida: true };
  }
  if (/netflix|spotify|prime|disney|hbo|youtube|streaming|assinatura/i.test(pLimpo)) {
    return { categoria: 'Lazer', subcategoria: 'Streaming', reconhecida: true };
  }

  // 5. Contas
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
// 6. GRAVAÇÃO NO FIRESTORE + CÁLCULO PRECISO DE LIMITE E CHEQUE ESPECIAL
// ============================================================================
async function gravarItensNoBanco(userId, itens, cartoes, bancos, orcamentos, anoMesPadrao, textoOriginal) {
  const hoje = new Date();
  const hojeStr = hoje.toISOString().split('T')[0];
  let respostas = [];

  // Lê todas as transações ANTES de inserir as novas para não haver duplicidade nem atraso de indexação
  const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
  const todasTransacoes = snapAll.docs.map(d => d.data());

  for (const item of itens) {
    const parcelasTotal = item.parcelasTotal || 1;
    const valorParcela = Number(item.valorParcela);
    const isAgendado = item.pago === false;
    const catFinal = item.categoria || 'Outros';
    const subFinal = item.subcategoria || 'Geral';

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
        fatura_paga: false,
        pago: item.pago !== undefined ? item.pago : true,
        data_vencimento: dataVencItem,
        anoMes: anoMesItem,
        origem: 'WHATSAPP_IA',
        mensagem_original: textoOriginal,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('users').doc(userId).collection('transacoes').add(novoDoc);
      // Empurra na lista em memória imediatamente para o cálculo do limite ser 100% exato!
      todasTransacoes.push(novoDoc);
    }

    if (isAgendado) {
      respostas.push(
        `📅 *Conta Lançada (${item.tipo === 'RECEITA' ? 'A Receber' : 'A Vencer'})*\n` +
        `• *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
        `• Valor: *R$ ${valorParcela.toFixed(2)}*\n` +
        `• Vencimento: *${formatarDataBR(item.data_vencimento)}* (Status: Em Aberto)`
      );
      continue;
    }

    let alertasExtras = '';

    // 1. Alerta de Limite de Categoria
    const limiteCat = Number(orcamentos[catFinal] || 0);
    if (limiteCat > 0 && item.tipo === 'DESPESA') {
      const gastoCatMes = todasTransacoes
        .filter(t => t.anoMes === anoMesPadrao && t.tipo === 'DESPESA' && semAcento(t.categoria) === semAcento(catFinal) && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
        .reduce((a, b) => a + Number(b.valor || 0), 0);
      const pctCat = Math.round((gastoCatMes / limiteCat) * 100);
      if (pctCat >= 100) {
        alertasExtras += `\n🚨 *Limite da Categoria ${catFinal} Estourado!* (${pctCat}% usado)`;
      } else if (pctCat >= 80) {
        alertasExtras += `\n⚠️ *Atenção:* Categoria ${catFinal} chegou a ${pctCat}% do limite.`;
      }
    }

    // 2. Alerta de Limite do Cartão de Crédito (100% preciso somando a lista atualizada)
    if (item.metodo === 'CREDITO' && item.cartao_nome) {
      const objCartao = cartoes.find(c => semAcento(c.nome) === semAcento(item.cartao_nome));
      if (objCartao && Number(objCartao.limite) > 0) {
        const gastoAcumuladoCartao = todasTransacoes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(objCartao.nome) && !t.fatura_paga && t.anoMes >= anoMesPadrao)
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteTotal = Number(objCartao.limite);
        const disponivel = limiteTotal - gastoAcumuladoCartao;
        const pctCartao = Math.round((gastoAcumuladoCartao / limiteTotal) * 100);

        if (pctCartao >= 100) {
          alertasExtras += `\n🚨 *ALERTA DE CARTÃO:* O limite do *${objCartao.nome}* estourou! (${pctCartao}% utilizado | Excedido em R$ ${Math.abs(disponivel).toFixed(2)})`;
        } else if (pctCartao >= 80) {
          alertasExtras += `\n⚠️ *Alerta de Limite (${objCartao.nome}):* ${pctCartao}% do limite comprometido! Restam *R$ ${disponivel.toFixed(2)}* disponíveis.`;
        } else {
          alertasExtras += `\n💳 _Limite disponível no ${objCartao.nome}: R$ ${disponivel.toFixed(2)}_`;
        }
      }
    }

    // 3. Alerta de Uso do Cheque Especial (Saldo Negativo na Conta Bancária)
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
          alertasExtras += `\n🚨 *ALERTA DE CHEQUE ESPECIAL:* A conta *${bObj.nome}* entrou no negativo! Saldo atual: *R$ ${saldoAtualBanco.toFixed(2)}*`;
        } else {
          alertasExtras += `\n🏦 _Saldo restante no ${bObj.nome}: R$ ${saldoAtualBanco.toFixed(2)}_`;
        }
      }
    }

    const origemPagamento = item.metodo === 'CREDITO'
      ? `Cartão ${item.cartao_nome}`
      : item.banco_nome
        ? `${item.metodo} (${item.banco_nome})`
        : item.metodo;

    respostas.push(
      `✅ *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
      `💰 R$ ${valorParcela.toFixed(2)} ${parcelasTotal > 1 ? `(${parcelasTotal}x de R$ ${valorParcela.toFixed(2)})` : ''} • ${origemPagamento}${alertasExtras}`
    );
  }

  return respostas;
}

// ============================================================================
// 7. FILA DE PENDÊNCIAS: PERGUNTA FORMA DE PAGAMENTO -> QUAL BANCO -> CATEGORIA
// ============================================================================
async function processarFilaDePendencias(userId, itens, cartoes, bancos, orcamentos, anoMesAtual, textoOriginal, sock, remoteJid) {
  const userRef = db.collection('users').doc(userId);

  const prontos = [];
  const pendentes = [];

  for (const item of itens) {
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
        `🏦 *De qual conta bancária saiu esse ${primeiro.metodo}?*\n${resumoPendentes}\n\n` +
        `Responda com o nome do banco: *${opcoesBancos}*`;
    } else {
      etapa = 'CATEGORIA';
      textoPergunta =
        `📂 *Em qual Categoria e Subcategoria deseja lançar?*\n${resumoPendentes}\n\n` +
        `Exemplos de resposta:\n` +
        `• *Mercado* (vai para Alimentação > Mercado)\n` +
        `• *Lazer* (vai para Alimentação > Lazer)\n` +
        `• *Transporte* ou *Contas*`;
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
    const cartoes = userData.cartoes || [
      { id: '1', nome: 'VISA', limite: 5000, diaFechamento: 5, diaVencimento: 12 },
      { id: '2', nome: 'NUBANK', limite: 3500, diaFechamento: 10, diaVencimento: 17 }
    ];
    const bancos = userData.bancos || [
      { id: 'b1', nome: 'Itaú', tipo: 'Conta Corrente / Débito', saldoInicial: 1500 },
      { id: 'b2', nome: 'Nubank Conta', tipo: 'Conta Digital / Pix', saldoInicial: 800 }
    ];
    const categorias = userData.categorias || ['Alimentação', 'Mercado', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const subcategorias = userData.subcategorias || {
      'Alimentação': ['Mercado', 'Lazer', 'Restaurante', 'Delivery'],
      'Mercado': ['Supermercado', 'Hortifruti', 'Açougue'],
      'Transporte': ['Combustível', 'Apps / Pedágio', 'Manutenção'],
      'Lazer': ['Passeios', 'Streaming', 'Viagens'],
      'Contas': ['Casa / Fixas', 'Saúde / Farmácia', 'Boletos / Serviços'],
      'Receita': ['Salário', 'Vendas / Extras'],
      'Outros': ['Geral']
    };
    const orcamentos = userData.orcamentos || {};
    const pendente = userData.pendente_pagamento || null;

    const txtLimpo = semAcento(textoUsuario).trim();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const hojeStr = hoje.toISOString().split('T')[0];

    // ------------------------------------------------------------------------
    // COMANDO "TESTE" PARA VERIFICAR SE A CONEXÃO ESTÁ OK
    // ------------------------------------------------------------------------
    if (/^(teste|testar|ping|status|conexao|ta funcionando|esta funcionando)$/i.test(txtLimpo)) {
      await enviarMensagemSegura(sock, remoteJid, {
        text: `🟢 *Conexão FinZap 100% Online!*\n\n` +
              `• Status do Bot: *Conectado e Operacional*\n` +
              `• Criptografia Signal: *Sincronizada*\n` +
              `• Competência Ativa: *${anoMesAtual}*`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO -1: TRATAMENTO DE RESPOSTAS PENDENTES (METODO -> BANCO -> CATEGORIA)
    // ------------------------------------------------------------------------
    if (pendente) {
      if (/^(cancelar|esquecer|nao|abortar)$/i.test(txtLimpo)) {
        await userRef.set({ pendente_pagamento: null }, { merge: true });
        await enviarMensagemSegura(sock, remoteJid, { text: '🗑️ Operação pendente cancelada.' });
        return;
      }

      if (pendente.etapa === 'BAIXA_CONTA_BANCO' || pendente.etapa === 'PAGAR_FATURA_BANCO') {
        const bancoEscolhido = bancos.find(b => txtLimpo.includes(semAcento(b.nome))) || bancos[0];
        if (bancoEscolhido) {
          if (pendente.etapa === 'PAGAR_FATURA_BANCO') {
            const { cartaoNome, valorFatura } = pendente;
            const snapFatura = await db.collection('users').doc(userId).collection('transacoes')
              .where('anoMes', '==', anoMesAtual)
              .get();

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
            await enviarMensagemSegura(sock, remoteJid, {
              text: `✅ *Fatura do cartão ${cartaoNome} paga com sucesso!*\n` +
                    `💰 Valor: *R$ ${Number(valorFatura).toFixed(2)}*\n` +
                    `🏦 Debitado da conta: *${bancoEscolhido.nome}*\n` +
                    `📊 _O pagamento já consta no seu Extrato de Movimentação e o limite foi liberado._`
            });
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
            await enviarMensagemSegura(sock, remoteJid, {
              text: `✅ *Baixa de Conta Efetivada!*\n` +
                    `• Conta: *${descricao}*\n` +
                    `• Valor: *R$ ${Number(valor).toFixed(2)}*\n` +
                    `• Debitado de: *${bancoEscolhido.nome}* (${metodo || 'PIX'})`
            });
            return;
          }
        }
      }

      if (Array.isArray(pendente.itens) && pendente.itens.length > 0) {
        let itensAtualizados = [...pendente.itens];

        if (pendente.etapa === 'METODO') {
          let metodoEscolhido = null;
          let cartaoEscolhido = null;
          let bancoEscolhido = null;

          for (const c of cartoes) {
            if (txtLimpo.includes(semAcento(c.nome))) {
              metodoEscolhido = 'CREDITO';
              cartaoEscolhido = c.nome;
              break;
            }
          }

          for (const b of bancos) {
            if (txtLimpo.includes(semAcento(b.nome))) {
              bancoEscolhido = b.nome;
              if (!metodoEscolhido) {
                metodoEscolhido = /debito/i.test(txtLimpo) ? 'DEBITO' : 'PIX';
              }
              break;
            }
          }

          if (!metodoEscolhido) {
            if (/credito|cartao/i.test(txtLimpo)) {
              metodoEscolhido = 'CREDITO';
              cartaoEscolhido = cartoes[0]?.nome || 'CREDITO';
            } else if (/debito/i.test(txtLimpo)) {
              metodoEscolhido = 'DEBITO';
            } else if (/pix/i.test(txtLimpo)) {
              metodoEscolhido = 'PIX';
            } else if (/dinheiro|especie/i.test(txtLimpo)) {
              metodoEscolhido = 'DINHEIRO';
            }
          }

          if (metodoEscolhido) {
            const matchParcelasResp = txtLimpo.match(/(\d+)\s*(?:x|vezes|parcelas)/);
            const parcelasResp = matchParcelasResp ? parseInt(matchParcelasResp[1]) : null;

            itensAtualizados = itensAtualizados.map(it => {
              const pTotal = parcelasResp || it.parcelasTotal || 1;
              const vParc = pTotal > 1 ? Number((it.valorTotal / pTotal).toFixed(2)) : it.valorTotal;
              return {
                ...it,
                parcelasTotal: pTotal,
                valorParcela: vParc,
                metodo: metodoEscolhido,
                cartao_nome: cartaoEscolhido,
                // Se respondeu apenas "Pix" ou "Débito" sem citar o banco, deixa banco_nome null para ele perguntar de qual conta bancária vai sair!
                banco_nome: metodoEscolhido === 'CREDITO' ? null : (bancoEscolhido || it.banco_nome || null),
                pago: true
              };
            });

            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
            return;
          }
        } else if (pendente.etapa === 'BANCO') {
          const bancoObj = bancos.find(b => txtLimpo.includes(semAcento(b.nome))) || bancos.find(b => semAcento(b.nome).includes(txtLimpo));
          if (bancoObj) {
            itensAtualizados = itensAtualizados.map(it => ({
              ...it,
              banco_nome: bancoObj.nome
            }));
            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
            return;
          }
        } else if (pendente.etapa === 'CATEGORIA') {
          const classif = classificarCategoriaESubcategoria(txtLimpo, false, categorias, subcategorias);
          let catResp = classif.categoria;
          let subResp = classif.subcategoria;

          if (!catResp) {
            if (textoUsuario.includes('>')) {
              const [c, s] = textoUsuario.split('>').map(x => x.trim());
              catResp = c;
              subResp = s || 'Geral';
            } else {
              catResp = textoUsuario.trim();
              subResp = 'Geral';
            }
          }

          itensAtualizados = itensAtualizados.map(it => ({
            ...it,
            categoria: catResp,
            subcategoria: subResp,
            precisaPerguntarCategoria: false
          }));

          await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
          return;
        }

        await userRef.set({ pendente_pagamento: null }, { merge: true });
      }
    }

    // ------------------------------------------------------------------------
    // TRANSFERÊNCIA ENTRE CONTAS BANCÁRIAS PELO WHATSAPP
    // ------------------------------------------------------------------------
    if (/transferir|transferencia|transferi|passei.*para/i.test(txtLimpo)) {
      const textoNormTransf = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
      const matchVal = textoNormTransf.match(/(\d+\.\d{2}|\d+)/);
      if (matchVal) {
        const valorTransf = parseFloat(matchVal[0]);
        let bancoOrigem = null;
        let bancoDestino = null;

        for (const b of bancos) {
          const nomeB = semAcento(b.nome);
          const regexOrigem = new RegExp(`(?:do|da|de)\\s+${nomeB}`, 'i');
          const regexDestino = new RegExp(`(?:para|pro|pra|no|na)\\s+${nomeB}`, 'i');
          if (regexOrigem.test(txtLimpo)) bancoOrigem = b.nome;
          if (regexDestino.test(txtLimpo)) bancoDestino = b.nome;
        }

        if (!bancoOrigem || !bancoDestino) {
          const encontrados = bancos.filter(b => txtLimpo.includes(semAcento(b.nome)));
          if (encontrados.length >= 2) {
            bancoOrigem = encontrados[0].nome;
            bancoDestino = encontrados[1].nome;
          }
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

          await enviarMensagemSegura(sock, remoteJid, {
            text: `🔄 *Transferência Realizada com Sucesso!*\n\n` +
                  `• Origem: *${bancoOrigem}* (- R$ ${valorTransf.toFixed(2)})\n` +
                  `• Destino: *${bancoDestino}* (+ R$ ${valorTransf.toFixed(2)})\n` +
                  `• Data: *${formatarDataBR(hojeStr)}*`
          });
          return;
        }
      }
    }

    // ------------------------------------------------------------------------
    // DAR BAIXA EM CONTAS EM ABERTO OU PAGAR FATURA PELO WHATSAPP
    // ------------------------------------------------------------------------
    const isComandoBaixa = /^(paguei|dar baixa|baixa|quitei|pagar fatura)/i.test(txtLimpo) && !/\b\d+[,\.]\d{2}\b/.test(textoUsuario);
    if (isComandoBaixa) {
      const snapMes = await db.collection('users').doc(userId).collection('transacoes')
        .where('anoMes', '==', anoMesAtual)
        .get();
      const transMes = snapMes.docs.map(d => ({ id: d.id, ...d.data() }));

      const bancoInformado = bancos.find(b => txtLimpo.includes(semAcento(b.nome)));

      if (/fatura/i.test(txtLimpo)) {
        const cartaoAlvo = cartoes.find(c => txtLimpo.includes(semAcento(c.nome))) || cartoes[0];
        if (cartaoAlvo) {
          const itensFatura = transMes.filter(
            t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(cartaoAlvo.nome) && !t.fatura_paga
          );
          const totalFatura = itensFatura.reduce((a, b) => a + Number(b.valor || 0), 0);

          if (totalFatura <= 0) {
            await enviarMensagemSegura(sock, remoteJid, { text: `✅ A fatura do cartão *${cartaoAlvo.nome}* em ${anoMesAtual} já consta como paga!` });
            return;
          }

          if (!bancoInformado) {
            const listaBancos = bancos.map(b => b.nome).join(' ou ');
            await userRef.set({
              pendente_pagamento: {
                etapa: 'PAGAR_FATURA_BANCO',
                cartaoNome: cartaoAlvo.nome,
                valorFatura: totalFatura,
                criadoEm: Date.now()
              }
            }, { merge: true });

            await enviarMensagemSegura(sock, remoteJid, {
              text: `💳 *Pagamento da Fatura ${cartaoAlvo.nome} (R$ ${totalFatura.toFixed(2)})*\n\n` +
                    `🏦 *De qual conta bancária vai debitar o valor?*\nResponda com: *${listaBancos}*`
            });
            return;
          }

          const batch = db.batch();
          snapMes.docs.forEach(d => {
            const dt = d.data();
            if (dt.tipo === 'DESPESA' && semAcento(dt.cartao_nome) === semAcento(cartaoAlvo.nome) && !dt.fatura_paga) {
              batch.update(d.ref, { fatura_paga: true });
            }
          });
          await batch.commit();

          await db.collection('users').doc(userId).collection('transacoes').add({
            descricao: `Pagamento Fatura Cartão ${cartaoAlvo.nome}`,
            valor: totalFatura,
            tipo: 'DESPESA',
            metodo: 'PAGAMENTO_FATURA',
            cartao_nome: null,
            banco_nome: bancoInformado.nome,
            categoria: 'Contas',
            subcategoria: 'Fatura Cartão',
            pago: true,
            data_vencimento: hojeStr,
            anoMes: anoMesAtual,
            origem: 'WHATSAPP_IA',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
          });

          await enviarMensagemSegura(sock, remoteJid, {
            text: `✅ *Fatura ${cartaoAlvo.nome} paga com sucesso!*\n💰 Valor: R$ ${totalFatura.toFixed(2)} debitado de *${bancoInformado.nome}*.`
          });
          return;
        }
      }

      const contasAbertas = transMes.filter(t => t.pago === false);
      const contaEncontrada = contasAbertas.find(t => {
        const descLimpa = semAcento(t.descricao);
        return txtLimpo.includes(descLimpa) || descLimpa.split(' ').some(palavra => palavra.length > 2 && txtLimpo.includes(palavra));
      });

      if (contaEncontrada) {
        const metodoBaixa = /debito/i.test(txtLimpo) ? 'DEBITO' : 'PIX';
        if (!bancoInformado) {
          const listaBancos = bancos.map(b => b.nome).join(' ou ');
          await userRef.set({
            pendente_pagamento: {
              etapa: 'BAIXA_CONTA_BANCO',
              docId: contaEncontrada.id,
              descricao: contaEncontrada.descricao,
              valor: contaEncontrada.valor,
              metodo: metodoBaixa,
              criadoEm: Date.now()
            }
          }, { merge: true });

          await enviarMensagemSegura(sock, remoteJid, {
            text: `🏦 *Dar baixa em: ${contaEncontrada.descricao} (R$ ${Number(contaEncontrada.valor).toFixed(2)})*\n\n` +
                  `De qual conta bancária saiu o pagamento?\nResponda com: *${listaBancos}*`
          });
          return;
        }

        await db.collection('users').doc(userId).collection('transacoes').doc(contaEncontrada.id).update({
          pago: true,
          metodo: metodoBaixa,
          banco_nome: bancoInformado.nome,
          data_pagamento: hojeStr
        });

        await enviarMensagemSegura(sock, remoteJid, {
          text: `✅ *Baixa realizada com sucesso!*\n• *${contaEncontrada.descricao}* — R$ ${Number(contaEncontrada.valor).toFixed(2)}\n• Debitado de: *${bancoInformado.nome}* (${metodoBaixa})`
        });
        return;
      }
    }

    // ------------------------------------------------------------------------
    // MODO 0: DESFAZER / APAGAR ÚLTIMO LANÇAMENTO
    // ------------------------------------------------------------------------
    const isDesfazer = /^(apagar|excluir|deletar|remover|desfazer|cancelar)\s*(ultimo|ultima|lancamento|gasto)?$/i.test(txtLimpo);

    if (isDesfazer) {
      const ultimoSnap = await db.collection('users').doc(userId).collection('transacoes')
        .orderBy('criadoEm', 'desc')
        .limit(1)
        .get();

      if (ultimoSnap.empty) {
        await enviarMensagemSegura(sock, remoteJid, { text: '⚠️ Nenhum lançamento encontrado para apagar.' });
        return;
      }

      const docRecente = ultimoSnap.docs[0];
      const dadosRecentes = docRecente.data();

      if (dadosRecentes.mensagem_original) {
        const loteSnap = await db.collection('users').doc(userId).collection('transacoes')
          .where('mensagem_original', '==', dadosRecentes.mensagem_original)
          .get();

        const tempoBase = dadosRecentes.criadoEm?.toMillis ? dadosRecentes.criadoEm.toMillis() : Date.now();
        const docsParaApagar = loteSnap.docs.filter(d => {
          const t = d.data().criadoEm?.toMillis ? d.data().criadoEm.toMillis() : tempoBase;
          return Math.abs(tempoBase - t) < 120000;
        });

        if (docsParaApagar.length > 1) {
          const batch = db.batch();
          let totalRemovido = 0;
          docsParaApagar.forEach(d => {
            totalRemovido += Number(d.data().valor || 0);
            batch.delete(d.ref);
          });
          await batch.commit();

          await enviarMensagemSegura(sock, remoteJid, {
            text: `🗑️ *Último envio desfeito!*\nForam removidos *${docsParaApagar.length} lançamentos* vinculados (Total: R$ ${totalRemovido.toFixed(2)}).`
          });
          return;
        }
      }

      await docRecente.ref.delete();
      await enviarMensagemSegura(sock, remoteJid, {
        text: `🗑️ *Lançamento removido com sucesso!*\n• ${dadosRecentes.descricao} [${dadosRecentes.categoria}] — R$ ${Number(dadosRecentes.valor || 0).toFixed(2)}`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO 0.5: CONTAS PRÓXIMAS DO VENCIMENTO (ATÉ 5 DIAS) E CONTAS A VENCER DO MÊS
    // ------------------------------------------------------------------------
    const isProximasVencimento = /proxima|proximo|proximos|vencendo|5 dias/i.test(txtLimpo) && /conta|vencimento|vencer/i.test(txtLimpo);
    const isContasAVencerMes = /contas a vencer|contas em aberto|o que vence|contas pendentes|a pagar/i.test(txtLimpo);

    if (isProximasVencimento || isContasAVencerMes) {
      const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
      const todasTrans = snapAll.docs.map(d => d.data());

      if (isProximasVencimento) {
        const hojeZero = new Date(hojeStr + 'T00:00:00');
        const limite5Dias = new Date(hojeZero.getTime() + 5 * 24 * 60 * 60 * 1000);

        const listaProximas = todasTrans.filter(t => {
          if (t.pago !== false || !t.data_vencimento) return false;
          const dtVenc = new Date(t.data_vencimento + 'T00:00:00');
          return dtVenc <= limite5Dias;
        }).sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || ''));

        if (listaProximas.length === 0) {
          await enviarMensagemSegura(sock, remoteJid, {
            text: `⏳ *Contas Próximas do Vencimento (Até 5 dias)*\n\n🎉 Você não tem nenhuma conta em aberto vencendo nos próximos 5 dias!`
          });
          return;
        }

        const totalProx = listaProximas.reduce((acc, t) => acc + Number(t.valor || 0), 0);
        const linhas = listaProximas.map(t => {
          const dtVenc = new Date(t.data_vencimento + 'T00:00:00');
          const diffDias = Math.round((dtVenc - hojeZero) / (1000 * 60 * 60 * 24));
          const tagDia = diffDias < 0 ? `🚨 *Vencida há ${Math.abs(diffDias)} dia(s)*` : diffDias === 0 ? '⚠️ *Vence HOJE*' : `faltam ${diffDias} dia(s)`;
          return `• *${t.descricao}* [${t.categoria}]\n   💰 R$ ${Number(t.valor).toFixed(2)} — Vence: *${formatarDataBR(t.data_vencimento)}* (${tagDia})`;
        }).join('\n\n');

        await enviarMensagemSegura(sock, remoteJid, {
          text: `⏳ *Contas Próximas do Vencimento (Até 5 dias)*\n\n${linhas}\n\n📌 *Total:* R$ ${totalProx.toFixed(2)}`
        });
        return;
      }

      if (isContasAVencerMes) {
        const abertasMes = todasTrans
          .filter(t => t.anoMes === anoMesAtual && t.pago === false)
          .sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || ''));

        if (abertasMes.length === 0) {
          await enviarMensagemSegura(sock, remoteJid, {
            text: `📅 *Contas a Vencer (${anoMesAtual})*\n\n✅ Você não tem nenhuma conta em aberto neste mês!`
          });
          return;
        }

        const totalPagar = abertasMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);
        const totalReceber = abertasMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);

        const linhas = abertasMes.map(t => {
          const icone = t.tipo === 'RECEITA' ? '🟢 [A Receber]' : '🔴 [A Pagar]';
          return `${icone} *${t.descricao}* — R$ ${Number(t.valor).toFixed(2)}\n   📅 Vencimento: *${formatarDataBR(t.data_vencimento)}*`;
        }).join('\n\n');

        await enviarMensagemSegura(sock, remoteJid, {
          text: `📅 *Contas em Aberto do Mês (${anoMesAtual})*\n\n${linhas}\n\n🔴 *Total a Pagar:* R$ ${totalPagar.toFixed(2)}\n🟢 *Total a Receber:* R$ ${totalReceber.toFixed(2)}`
        });
        return;
      }
    }

    // ------------------------------------------------------------------------
    // MODO 1: CONSULTOR FINANCEIRO
    // ------------------------------------------------------------------------
    const isPergunta = /\?|quanto|qual|resumo|saldo|saldos|fatura|limite|disponivel|melhor dia|posso gastar/i.test(txtLimpo) && !/gastei|comprei|paguei|recebi|vence/i.test(txtLimpo);
    
    if (isPergunta) {
      const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
      const todasTrans = snapAll.docs.map(d => d.data());
      const transMes = todasTrans.filter(t => t.anoMes === anoMesAtual);

      const catPerguntada = categorias.find(cat => txtLimpo.includes(semAcento(cat)));
      if (catPerguntada) {
        const gastoCat = transMes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.categoria) === semAcento(catPerguntada) && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteCat = Number(orcamentos[catPerguntada] || 0);

        if (limiteCat > 0) {
          const disponivel = limiteCat - gastoCat;
          const pct = Math.round((gastoCat / limiteCat) * 100);
          await enviarMensagemSegura(sock, remoteJid, {
            text: `🎯 *Categoria: ${catPerguntada} (${anoMesAtual})*\n\n` +
                  `• Limite definido: *R$ ${limiteCat.toFixed(2)}*\n` +
                  `• Gasto até agora: *R$ ${gastoCat.toFixed(2)}* (${pct}%)\n` +
                  `• ${disponivel >= 0 ? `Disponível para gastar: *R$ ${disponivel.toFixed(2)}* 🟢` : `Limite excedido em: *R$ ${Math.abs(disponivel).toFixed(2)}* 🔴`}`
          });
        } else {
          await enviarMensagemSegura(sock, remoteJid, {
            text: `📂 *Categoria: ${catPerguntada} (${anoMesAtual})*\n\n` +
                  `• Gasto acumulado: *R$ ${gastoCat.toFixed(2)}*\n` +
                  `• Limite mensal: *Sem limite definido no painel*`
          });
        }
        return;
      }

      const cartaoPerguntado = cartoes.find(c => txtLimpo.includes(semAcento(c.nome)));
      if (cartaoPerguntado) {
        const faturaMes = transMes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(cartaoPerguntado.nome) && !t.fatura_paga)
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const comprometidoTotal = todasTrans
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(cartaoPerguntado.nome) && !t.fatura_paga && t.anoMes >= anoMesAtual)
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteCartao = Number(cartaoPerguntado.limite || 0);
        const disponivelCartao = limiteCartao - comprometidoTotal;

        await enviarMensagemSegura(sock, remoteJid, {
          text: `💳 *Cartão ${cartaoPerguntado.nome}*\n\n` +
                `• Fatura deste mês (${anoMesAtual}): *R$ ${faturaMes.toFixed(2)}*\n` +
                `• Total comprometido (com parcelas): *R$ ${comprometidoTotal.toFixed(2)}*\n` +
                `• Limite total: *R$ ${limiteCartao.toFixed(2)}*\n` +
                `• Limite disponível: *R$ ${disponivelCartao.toFixed(2)}*\n` +
                `📅 Fechamento (Melhor dia): *Dia ${cartaoPerguntado.diaFechamento || 5}* | Vencimento: *Dia ${cartaoPerguntado.diaVencimento || 12}*`
        });
        return;
      }

      if (/cartao|cartoes|fatura|melhor dia/i.test(txtLimpo)) {
        let msgCartoes = `💳 *Resumo dos seus Cartões*\n\n`;
        for (const c of cartoes) {
          const faturaC = transMes
            .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(c.nome) && !t.fatura_paga)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          const compC = todasTrans
            .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(c.nome) && !t.fatura_paga && t.anoMes >= anoMesAtual)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          const dispC = Number(c.limite || 0) - compC;
          msgCartoes += `🔹 *${c.nome}*\n   Fatura Mês: R$ ${faturaC.toFixed(2)} | Disponível: R$ ${dispC.toFixed(2)}\n   Melhor dia compra: Dia ${c.diaFechamento || 5} (Vence dia ${c.diaVencimento || 12})\n\n`;
        }
        await enviarMensagemSegura(sock, remoteJid, { text: msgCartoes.trim() });
        return;
      }

      const rec = transMes.filter(t => t.tipo === 'RECEITA' && t.pago !== false && t.metodo !== 'TRANSFERENCIA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA').reduce((a, b) => a + Number(b.valor || 0), 0);

      let linhasBancos = '';
      let somaBancos = 0;
      bancos.forEach((b, idx) => {
        const entB = todasTrans
          .filter(t => t.tipo === 'RECEITA' && t.pago !== false && (semAcento(t.banco_nome) === semAcento(b.nome) || (!t.banco_nome && idx === 0)))
          .reduce((a, x) => a + Number(x.valor || 0), 0);
        const saiB = todasTrans
          .filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'CREDITO' && (semAcento(t.banco_nome) === semAcento(b.nome) || (!t.banco_nome && idx === 0)))
          .reduce((a, x) => a + Number(x.valor || 0), 0);
        const sldB = Number(b.saldoInicial || 0) + entB - saiB;
        somaBancos += sldB;
        linhasBancos += `• *${b.nome}:* R$ ${sldB.toFixed(2)} ${sldB < 0 ? '🚨 *(Cheque Especial)*' : ''}\n`;
      });

      await enviarMensagemSegura(sock, remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n` +
              `🟢 Receitas do Mês: R$ ${rec.toFixed(2)}\n` +
              `🔴 Despesas do Mês: R$ ${desp.toFixed(2)}\n` +
              `📈 Resultado: *R$ ${(rec - desp).toFixed(2)}*\n\n` +
              `🏦 *Saldos por Conta:*\n${linhasBancos}\n` +
              `💰 *Saldo Geral Disponível: R$ ${somaBancos.toFixed(2)}*`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO 2: LANÇAMENTOS (Com Regex Corrigida para não cortar palavras como "Supermercado")
    // ------------------------------------------------------------------------
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    
    let itensExtraidos = [];

    for (const parte of partes) {
      const pLimpo = semAcento(parte);

      const infoVencimento = extrairDataVencimento(parte);
      const isAgendado = Boolean(infoVencimento) || /\b(vence|vencimento|a pagar|a receber|boleto para)\b/i.test(pLimpo);

      const parteSemData = infoVencimento ? parte.replace(infoVencimento.trechoRemovido, ' ') : parte;
      const pLimpoSemData = semAcento(parteSemData);

      const matchParcelas = pLimpoSemData.match(/\b(\d+)\s*(?:x|vezes|parcelas)\b/i);
      const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

      const textoSemParcela = matchParcelas ? parteSemData.replace(new RegExp(matchParcelas[0], 'i'), '') : parteSemData;
      const matchValor = textoSemParcela.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0]);
      if (isNaN(valorTotal) || valorTotal <= 0) continue;

      const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
      const isReceita = /\b(recebi|ganhei|salario|venda|a receber|receber)\b/i.test(pLimpo);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      let metodo = null;
      let cartaoNome = null;
      let bancoNome = null;

      for (const c of cartoes) {
        if (pLimpo.includes(semAcento(c.nome))) {
          metodo = 'CREDITO';
          cartaoNome = c.nome;
          break;
        }
      }

      for (const b of bancos) {
        if (pLimpo.includes(semAcento(b.nome))) {
          bancoNome = b.nome;
          if (!metodo) {
            metodo = /\bdebito\b/i.test(pLimpo) ? 'DEBITO' : 'PIX';
          }
          break;
        }
      }

      if (!metodo) {
        if (/\b(credito|cartao)\b/i.test(pLimpo) || parcelasTotal > 1) {
          metodo = 'CREDITO';
          cartaoNome = cartoes[0]?.nome || 'CREDITO';
        } else if (/\bdebito\b/i.test(pLimpo)) {
          metodo = 'DEBITO';
        } else if (/\bpix\b/i.test(pLimpo)) {
          metodo = 'PIX';
        } else if (/\b(dinheiro|especie)\b/i.test(pLimpo)) {
          metodo = 'DINHEIRO';
        } else if (isAgendado) {
          metodo = 'BOLETO / AGENDADO';
        } else if (isReceita) {
          metodo = 'PIX';
        }
      }

      const classif = classificarCategoriaESubcategoria(pLimpo, isReceita, categorias, subcategorias);

      // Limpeza de palavras com limites de palavra (\b) para NUNCA cortar o final de "Supermercado" ou "Cartão"
      let descricao = textoSemParcela
        .replace(/\b(fui no|fui na|comprei|gastei|paguei|recebi|ganhei|vence|vencimento|valor|a pagar|a receber|dia|no cartao de credito|cartao de credito|no cartao|cartão|cartao|no pix|no credito|no debito|no débito|credito|crédito|debito|débito|pix|dinheiro|reais|um|uma|uns|umas|de|do|da|no|na|em)\b/gi, ' ')
        .replace(/r\$/gi, ' ')
        .replace(matchValor[0], '')
        .replace(cartaoNome ? new RegExp(`\\b${cartaoNome}\\b`, 'gi') : '', '')
        .replace(bancoNome ? new RegExp(`\\b${bancoNome}\\b`, 'gi') : '', '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = classif.subcategoria || classif.categoria || 'Lançamento';
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      itensExtraidos.push({
        descricao,
        valorTotal,
        valorParcela,
        parcelasTotal,
        tipo,
        metodo,
        cartao_nome: cartaoNome,
        banco_nome: bancoNome,
        categoria: classif.categoria,
        subcategoria: classif.subcategoria,
        precisaPerguntarCategoria: !classif.reconhecida,
        pago: !isAgendado,
        data_vencimento: infoVencimento ? infoVencimento.dataVencimento : hojeStr,
        anoMes: infoVencimento ? infoVencimento.anoMes : anoMesAtual
      });
    }

    if (itensExtraidos.length > 0) {
      await processarFilaDePendencias(userId, itensExtraidos, cartoes, bancos, orcamentos, anoMesAtual, textoUsuario, sock, remoteJid);
    }

  } catch (e) {
    console.error('Erro no processamento da mensagem:', e);
  }
}

// ============================================================================
// 9. AUTO-RECONEXÃO QUANDO O SERVIDOR REINICIA
// ============================================================================
async function restaurarSessoesAtivas() {
  try {
    const usersSnap = await db.collection('users')
      .where('whatsapp_status', '==', 'CONNECTED')
      .get();

    usersSnap.forEach(doc => {
      console.log(`🔄 Restaurando sessão automática para o usuário: ${doc.id}`);
      startWhatsAppForUser(doc.id);
    });
  } catch (err) {
    console.error('Erro ao restaurar sessões:', err);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 FinZap WhatsApp Server rodando na porta ${PORT}`);
  restaurarSessoesAtivas();
});