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

const semAcento = (str) => str ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';

const formatarDataBR = (isoDate) => {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '';
  const [a, m, d] = isoDate.split('-');
  return `${d}/${m}/${a}`;
};

// Rota principal leve para o cron-job.org e verificação de alertas diários
app.get('/', (req, res) => {
  verificarAlertasVencimento().catch(() => {});
  res.status(200).send('OK');
});

app.get('/verificar-alertas', async (req, res) => {
  await verificarAlertasVencimento();
  res.status(200).send('Alertas verificados');
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
// 2. ADAPTADOR DE AUTENTICAÇÃO DO BAILEYS NO FIREBASE FIRESTORE
// ============================================================================
async function useFirestoreAuthState(userId) {
  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');
  const fixId = (id) => id.replace(/\//g, '__').replace(/\./g, '_');

  const writeData = async (data, id) => {
    try {
      const jsonString = JSON.stringify(data, BufferJSON.replacer);
      await sessionRef.doc(fixId(id)).set({ payload: jsonString });
    } catch (err) {
      console.error('Erro ao salvar chave no Firestore:', err);
    }
  };

  const readData = async (id) => {
    try {
      const docSnap = await sessionRef.doc(fixId(id)).get();
      if (!docSnap.exists) return null;
      const { payload } = docSnap.data();
      if (!payload) return null;
      return JSON.parse(payload, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await sessionRef.doc(fixId(id)).delete();
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
    console.log(`⚡ Iniciando instância WhatsApp para userId: ${userId}`);
    const { state, saveCreds } = await useFirestoreAuthState(userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['FinZap SaaS', 'Chrome', '1.0.0']
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

      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!texto) return;

      // Ignora respostas automáticas do próprio robô
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
        texto.startsWith('⏳')
      ) return;

      userJids.set(userId, msg.key.remoteJid);
      await processarMensagemInteligente(userId, texto, sock, msg.key.remoteJid);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp com Firestore:', err);
  }
}

// ============================================================================
// 4. DISPARO DE ALERTAS DE VENCIMENTO DE CONTAS AGENDADAS E FATURAS NO WHATSAPP
// ============================================================================
async function verificarAlertasVencimento() {
  try {
    const agora = new Date();
    const brTime = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    const diaHoje = brTime.getUTCDate();
    const horaAtual = brTime.getUTCHours();
    const dataHojeStr = brTime.toISOString().split('T')[0];
    const anoMesAtual = dataHojeStr.slice(0, 7);

    if (horaAtual < 8) return;

    const usersSnap = await db.collection('users')
      .where('whatsapp_status', '==', 'CONNECTED')
      .get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      if (userData.ultimo_alerta_data === dataHojeStr) continue;

      const sock = sessions.get(userId);
      const remoteJid = userJids.get(userId) || userData.whatsapp_jid;
      if (!sock || !remoteJid) continue;

      const cartoes = userData.cartoes || [];
      const snapTrans = await db.collection('users').doc(userId).collection('transacoes')
        .where('anoMes', '==', anoMesAtual)
        .get();
      const transMes = snapTrans.docs.map(d => d.data());

      let avisos = [];

      // 1. Contas agendadas (a vencer) que vencem exatamente hoje e estão em aberto
      const contasVencendoHoje = transMes.filter(
        t => t.pago === false && t.data_vencimento === dataHojeStr
      );
      for (const c of contasVencendoHoje) {
        avisos.push(`• *${c.descricao}* (${c.tipo === 'RECEITA' ? 'A Receber' : 'A Pagar'}) — R$ ${Number(c.valor || 0).toFixed(2)}`);
      }

      // 2. Faturas de Cartão que vencem hoje
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
        await sock.sendMessage(remoteJid, {
          text: `🔔 *Lembrete de Vencimento Hoje (${formatarDataBR(dataHojeStr)})*\n\n` +
                `Os seguintes compromissos vencem hoje e constam em aberto:\n` +
                `${avisos.join('\n')}\n\n` +
                `💡 _Acesse a aba "A Vencer & Receber" ou "Cartões" no painel para dar baixa._`
        });
      }

      await db.collection('users').doc(userId).set({ ultimo_alerta_data: dataHojeStr }, { merge: true });
    }
  } catch (e) {
    console.error('Erro ao verificar alertas de vencimento:', e);
  }
}

setInterval(verificarAlertasVencimento, 30 * 60 * 1000);

// ============================================================================
// 5. FUNÇÃO AUXILIAR PARA EXTRAIR DATA DE VENCIMENTO (Ex: "vence 25/10", "dia 25")
// ============================================================================
function extrairDataVencimento(texto) {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;

  // Padrão DD/MM/YYYY ou DD/MM ou DD-MM
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

  // Padrão "vence dia 25" ou "vencimento 25"
  const matchDia = texto.match(/(?:vence|vencimento|dia)\s+(\d{1,2})\b/i);
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

// ============================================================================
// 6. GRAVAÇÃO NO FIRESTORE (COM SUPORTE A CONTAS A VENCER E ALERTAS DE LIMITE)
// ============================================================================
async function gravarItensNoBanco(userId, itens, cartoes, orcamentos, anoMesPadrao, textoOriginal) {
  const hoje = new Date();
  const hojeStr = hoje.toISOString().split('T')[0];
  let respostas = [];

  const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
  const todasTransacoes = snapAll.docs.map(d => d.data());

  for (const item of itens) {
    const parcelasTotal = item.parcelasTotal || 1;
    const valorParcela = item.valorParcela;
    const isAgendado = item.pago === false;

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

      await db.collection('users').doc(userId).collection('transacoes').add({
        descricao: parcelasTotal > 1 ? `${item.descricao} (${i + 1}/${parcelasTotal})` : item.descricao,
        valor: valorParcela,
        tipo: item.tipo,
        metodo: item.metodo || 'A DEFINIR',
        cartao_nome: item.cartao_nome || null,
        banco_nome: item.banco_nome || null,
        categoria: item.categoria,
        parcela_atual: i + 1,
        parcelas_total: parcelasTotal,
        fatura_paga: false,
        pago: item.pago !== undefined ? item.pago : true,
        data_vencimento: dataVencItem,
        anoMes: anoMesItem,
        origem: 'WHATSAPP_IA',
        mensagem_original: textoOriginal,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    if (isAgendado) {
      respostas.push(
        `📅 *Conta Agendada (${item.tipo === 'RECEITA' ? 'A Receber' : 'A Vencer'})*\n` +
        `• *${item.descricao}* [${item.categoria}]\n` +
        `• Valor: *R$ ${valorParcela.toFixed(2)}*\n` +
        `• Vencimento: *${formatarDataBR(item.data_vencimento)}* (Status: Em aberto)`
      );
      continue;
    }

    let alertasExtras = '';

    // 1. Alerta de Limite de Categoria
    const limiteCat = Number(orcamentos[item.categoria] || 0);
    if (limiteCat > 0 && item.tipo === 'DESPESA') {
      const gastoCatMes = todasTransacoes
        .filter(t => t.anoMes === anoMesPadrao && t.tipo === 'DESPESA' && semAcento(t.categoria) === semAcento(item.categoria))
        .reduce((a, b) => a + Number(b.valor || 0), 0) + valorParcela;
      const pctCat = Math.round((gastoCatMes / limiteCat) * 100);
      if (pctCat >= 100) {
        alertasExtras += `\n🚨 *Limite da Categoria ${item.categoria} Estourado!* (${pctCat}% usado)`;
      } else if (pctCat >= 80) {
        alertasExtras += `\n⚠️ *Atenção:* Categoria ${item.categoria} chegou a ${pctCat}% do limite.`;
      }
    }

    // 2. Alerta de Limite do Cartão de Crédito
    if (item.metodo === 'CREDITO' && item.cartao_nome) {
      const objCartao = cartoes.find(c => semAcento(c.nome) === semAcento(item.cartao_nome));
      if (objCartao && Number(objCartao.limite) > 0) {
        const gastoAcumuladoCartao = todasTransacoes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(objCartao.nome) && !t.fatura_paga && t.anoMes >= anoMesPadrao)
          .reduce((a, b) => a + Number(b.valor || 0), 0) + (valorParcela * parcelasTotal);

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

    respostas.push(
      `✅ *${item.descricao}* [${item.categoria}]\n` +
      `💰 R$ ${valorParcela.toFixed(2)} ${parcelasTotal > 1 ? `(${parcelasTotal}x de R$ ${valorParcela.toFixed(2)})` : ''} • ${item.cartao_nome || item.banco_nome || item.metodo}${alertasExtras}`
    );
  }

  return respostas;
}

// ============================================================================
// 7. MOTOR DE INTELIGÊNCIA FINANCEIRA (COMANDOS DE VENCIMENTO, SALDOS E GASTOS)
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
      { id: 'b1', nome: 'Itaú', tipo: 'Conta Corrente / Débito', saldoInicial: 0 },
      { id: 'b2', nome: 'Nubank Conta', tipo: 'Conta Digital / Pix', saldoInicial: 0 }
    ];
    const categorias = userData.categorias || ['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const orcamentos = userData.orcamentos || {};
    const pendente = userData.pendente_pagamento || null;

    const txtLimpo = semAcento(textoUsuario).trim();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const hojeStr = hoje.toISOString().split('T')[0];

    // ------------------------------------------------------------------------
    // MODO -1: RESPOSTA A UM LANÇAMENTO PENDENTE DE FORMA DE PAGAMENTO
    // ------------------------------------------------------------------------
    if (pendente && Array.isArray(pendente.itens) && pendente.itens.length > 0) {
      if (/^(cancelar|esquecer|nao|abortar)$/i.test(txtLimpo)) {
        await userRef.set({ pendente_pagamento: null }, { merge: true });
        await sock.sendMessage(remoteJid, { text: '🗑️ Lançamento pendente cancelado.' });
        return;
      }

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

      if (!metodoEscolhido) {
        for (const b of bancos) {
          if (txtLimpo.includes(semAcento(b.nome))) {
            metodoEscolhido = /pix/i.test(txtLimpo) ? 'PIX' : 'DEBITO';
            bancoEscolhido = b.nome;
            break;
          }
        }
      }

      if (!metodoEscolhido) {
        if (/credito|cartao/i.test(txtLimpo)) {
          metodoEscolhido = 'CREDITO';
          cartaoEscolhido = cartoes[0]?.nome || 'CREDITO';
        } else if (/debito/i.test(txtLimpo)) {
          metodoEscolhido = 'DEBITO';
          bancoEscolhido = bancos[0]?.nome || null;
        } else if (/pix/i.test(txtLimpo)) {
          metodoEscolhido = 'PIX';
          bancoEscolhido = bancos[0]?.nome || null;
        } else if (/dinheiro|especie/i.test(txtLimpo)) {
          metodoEscolhido = 'DINHEIRO';
        }
      }

      if (metodoEscolhido) {
        const matchParcelasResp = txtLimpo.match(/(\d+)\s*(?:x|vezes|parcelas)/);
        const parcelasResp = matchParcelasResp ? parseInt(matchParcelasResp[1]) : null;

        const itensFinalizados = pendente.itens.map(it => {
          const pTotal = parcelasResp || it.parcelasTotal || 1;
          const vParc = pTotal > 1 ? Number((it.valorTotal / pTotal).toFixed(2)) : it.valorTotal;
          return {
            ...it,
            parcelasTotal: pTotal,
            valorParcela: vParc,
            metodo: metodoEscolhido,
            cartao_nome: cartaoEscolhido,
            banco_nome: bancoEscolhido,
            pago: true
          };
        });

        await userRef.set({ pendente_pagamento: null }, { merge: true });
        const respostas = await gravarItensNoBanco(userId, itensFinalizados, cartoes, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`);
        await sock.sendMessage(remoteJid, { text: respostas.join('\n\n') });
        return;
      }
      await userRef.set({ pendente_pagamento: null }, { merge: true });
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
        await sock.sendMessage(remoteJid, { text: '⚠️ Nenhum lançamento encontrado para apagar.' });
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

          await sock.sendMessage(remoteJid, {
            text: `🗑️ *Último envio desfeito!*\nForam removidos *${docsParaApagar.length} lançamentos* vinculados (Total: R$ ${totalRemovido.toFixed(2)}).`
          });
          return;
        }
      }

      await docRecente.ref.delete();
      await sock.sendMessage(remoteJid, {
        text: `🗑️ *Lançamento removido com sucesso!*\n• ${dadosRecentes.descricao} [${dadosRecentes.categoria}] — R$ ${Number(dadosRecentes.valor || 0).toFixed(2)}`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO 0.5: COMANDOS DE CONTAS PRÓXIMAS DO VENCIMENTO (ATÉ 5 DIAS) E CONTAS A VENCER DO MÊS
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
          return dtVenc >= hojeZero && dtVenc <= limite5Dias;
        }).sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || ''));

        if (listaProximas.length === 0) {
          await sock.sendMessage(remoteJid, {
            text: `⏳ *Contas Próximas do Vencimento (Até 5 dias)*\n\n🎉 Nenhuma conta em aberto vencendo nos próximos 5 dias!`
          });
          return;
        }

        const totalProx = listaProximas.reduce((acc, t) => acc + Number(t.valor || 0), 0);
        const linhas = listaProximas.map(t => {
          const dtVenc = new Date(t.data_vencimento + 'T00:00:00');
          const diffDias = Math.round((dtVenc - hojeZero) / (1000 * 60 * 60 * 24));
          const tagDia = diffDias === 0 ? '⚠️ *Vence HOJE*' : `faltam ${diffDias} dia(s)`;
          return `• *${t.descricao}* [${t.categoria}]\n   💰 R$ ${Number(t.valor).toFixed(2)} — Vence: *${formatarDataBR(t.data_vencimento)}* (${tagDia})`;
        }).join('\n\n');

        await sock.sendMessage(remoteJid, {
          text: `⏳ *Contas Próximas do Vencimento (Até 5 dias)*\n\n${linhas}\n\n📌 *Total nos próximos 5 dias:* R$ ${totalProx.toFixed(2)}`
        });
        return;
      }

      if (isContasAVencerMes) {
        const abertasMes = todasTrans
          .filter(t => t.anoMes === anoMesAtual && t.pago === false)
          .sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || ''));

        if (abertasMes.length === 0) {
          await sock.sendMessage(remoteJid, {
            text: `📅 *Contas em Aberto (${anoMesAtual})*\n\n✅ Você não tem nenhuma conta em aberto neste mês!`
          });
          return;
        }

        const totalPagar = abertasMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);
        const totalReceber = abertasMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);

        const linhas = abertasMes.map(t => {
          const icone = t.tipo === 'RECEITA' ? '🟢 [A Receber]' : '🔴 [A Pagar]';
          return `${icone} *${t.descricao}* — R$ ${Number(t.valor).toFixed(2)}\n   📅 Vencimento: *${formatarDataBR(t.data_vencimento)}*`;
        }).join('\n\n');

        await sock.sendMessage(remoteJid, {
          text: `📅 *Contas em Aberto do Mês (${anoMesAtual})*\n\n${linhas}\n\n🔴 *Total a Pagar:* R$ ${totalPagar.toFixed(2)}\n🟢 *Total a Receber:* R$ ${totalReceber.toFixed(2)}`
        });
        return;
      }
    }

    // ------------------------------------------------------------------------
    // MODO 1: CONSULTOR FINANCEIRO (Limites, Cartões, Melhor Dia e Saldo)
    // ------------------------------------------------------------------------
    const isPergunta = /\?|quanto|qual|resumo|saldo|fatura|limite|disponivel|melhor dia|posso gastar/i.test(txtLimpo) && !/gastei|comprei|paguei|recebi|vence/i.test(txtLimpo);
    
    if (isPergunta) {
      const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
      const todasTrans = snapAll.docs.map(d => d.data());
      const transMes = todasTrans.filter(t => t.anoMes === anoMesAtual);

      // A) Categoria específica
      const catPerguntada = categorias.find(cat => txtLimpo.includes(semAcento(cat)));
      if (catPerguntada) {
        const gastoCat = transMes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.categoria) === semAcento(catPerguntada))
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteCat = Number(orcamentos[catPerguntada] || 0);

        if (limiteCat > 0) {
          const disponivel = limiteCat - gastoCat;
          const pct = Math.round((gastoCat / limiteCat) * 100);
          await sock.sendMessage(remoteJid, {
            text: `🎯 *Categoria: ${catPerguntada} (${anoMesAtual})*\n\n` +
                  `• Limite definido: *R$ ${limiteCat.toFixed(2)}*\n` +
                  `• Gasto até agora: *R$ ${gastoCat.toFixed(2)}* (${pct}%)\n` +
                  `• ${disponivel >= 0 ? `Disponível para gastar: *R$ ${disponivel.toFixed(2)}* 🟢` : `Limite excedido em: *R$ ${Math.abs(disponivel).toFixed(2)}* 🔴`}`
          });
        } else {
          await sock.sendMessage(remoteJid, {
            text: `📂 *Categoria: ${catPerguntada} (${anoMesAtual})*\n\n` +
                  `• Gasto acumulado: *R$ ${gastoCat.toFixed(2)}*\n` +
                  `• Limite mensal: *Sem limite definido no painel*`
          });
        }
        return;
      }

      // B) Cartão específico
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

        await sock.sendMessage(remoteJid, {
          text: `💳 *Cartão ${cartaoPerguntado.nome}*\n\n` +
                `• Fatura deste mês (${anoMesAtual}): *R$ ${faturaMes.toFixed(2)}*\n` +
                `• Total comprometido (com parcelas): *R$ ${comprometidoTotal.toFixed(2)}*\n` +
                `• Limite total: *R$ ${limiteCartao.toFixed(2)}*\n` +
                `• Limite disponível: *R$ ${disponivelCartao.toFixed(2)}*\n` +
                `📅 Fechamento (Melhor dia): *Dia ${cartaoPerguntado.diaFechamento || 5}* | Vencimento: *Dia ${cartaoPerguntado.diaVencimento || 12}*`
        });
        return;
      }

      // C) Cartões em geral
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
        await sock.sendMessage(remoteJid, { text: msgCartoes.trim() });
        return;
      }

      // D) Resumo Geral e Saldos por Conta
      const rec = transMes.filter(t => t.tipo === 'RECEITA' && t.pago !== false).reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'CREDITO').reduce((a, b) => a + Number(b.valor || 0), 0);

      await sock.sendMessage(remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n🟢 Entradas Recebidas: R$ ${rec.toFixed(2)}\n🔴 Saídas Pagas (Pix/Débito): R$ ${desp.toFixed(2)}\n💰 *Saldo Líquido: R$ ${(rec - desp).toFixed(2)}*`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO 2: LANÇAMENTOS (Gastos imediatos, Parcelados ou Contas com Vencimento Futuro)
    // ------------------------------------------------------------------------
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    
    let itensComMetodo = [];
    let itensSemMetodo = [];

    for (const parte of partes) {
      const pLimpo = semAcento(parte);

      // 1. Verifica se possui data de vencimento / agendamento (ex: "Agua vence 25/10 valor 10.00")
      const infoVencimento = extrairDataVencimento(parte);
      const isAgendado = Boolean(infoVencimento) || /vence|vencimento|a pagar|a receber|boleto para/i.test(pLimpo);

      const parteSemData = infoVencimento ? parte.replace(infoVencimento.trechoRemovido, ' ') : parte;
      const pLimpoSemData = semAcento(parteSemData);

      const matchParcelas = pLimpoSemData.match(/(\d+)\s*(?:x|vezes|parcelas)/);
      const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

      const textoSemParcela = matchParcelas ? parteSemData.replace(new RegExp(matchParcelas[0], 'i'), '') : parteSemData;
      const matchValor = textoSemParcela.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0]);
      if (isNaN(valorTotal) || valorTotal <= 0) continue;

      const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
      const isReceita = /recebi|ganhei|salario|venda|a receber|receber/i.test(pLimpo);
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

      if (!metodo) {
        for (const b of bancos) {
          if (pLimpo.includes(semAcento(b.nome))) {
            metodo = /pix/i.test(pLimpo) ? 'PIX' : 'DEBITO';
            bancoNome = b.nome;
            break;
          }
        }
      }

      if (!metodo) {
        if (/credito|cartao/i.test(pLimpo) || parcelasTotal > 1) {
          metodo = 'CREDITO';
          cartaoNome = cartoes[0]?.nome || 'CREDITO';
        } else if (/debito/i.test(pLimpo)) {
          metodo = 'DEBITO';
          bancoNome = bancos[0]?.nome || null;
        } else if (/pix/i.test(pLimpo)) {
          metodo = 'PIX';
          bancoNome = bancos[0]?.nome || null;
        } else if (/dinheiro|especie/i.test(pLimpo)) {
          metodo = 'DINHEIRO';
        } else if (isAgendado) {
          metodo = 'BOLETO / AGENDADO';
        } else if (isReceita) {
          metodo = 'PIX';
          bancoNome = bancos[0]?.nome || null;
        }
      }

      let categoria = isReceita ? 'Receita' : 'Outros';
      if (/mercado|supermercado|compras|cebola|atacadao|acougue|hortifruti/i.test(pLimpo)) categoria = 'Mercado';
      else if (/lanche|restaurante|ifood|padaria|almoco|jantar|burger|pizza|cafe/i.test(pLimpo)) categoria = 'Alimentação';
      else if (/uber|gasolina|combustivel|posto|estacionamento|pedagio/i.test(pLimpo)) categoria = 'Transporte';
      else if (/cinema|passeio|bar|viagem|lazer|shopping|netflix|streaming/i.test(pLimpo)) categoria = 'Lazer';
      else if (/luz|agua|internet|energia|boleto|aluguel|condominio|vence|vencimento/i.test(pLimpo)) categoria = 'Contas';

      for (const cat of categorias) {
        if (pLimpo.includes(semAcento(cat))) {
          categoria = cat;
          break;
        }
      }

      let descricao = textoSemParcela
        .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|vence|vencimento|valor|a pagar|a receber|dia|no cartao de credito|no cartao|no pix|no credito|no debito|no débito|credito|crédito|debito|débito|pix|dinheiro|reais|r\$|de |do |da |no |na |em /gi, ' ')
        .replace(matchValor[0], '')
        .replace(cartaoNome ? new RegExp(cartaoNome, 'gi') : '', '')
        .replace(bancoNome ? new RegExp(bancoNome, 'gi') : '', '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = categoria;
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      const objItem = {
        descricao,
        valorTotal,
        valorParcela,
        parcelasTotal,
        tipo,
        metodo,
        cartao_nome: cartaoNome,
        banco_nome: bancoNome,
        categoria,
        pago: !isAgendado,
        data_vencimento: infoVencimento ? infoVencimento.dataVencimento : hojeStr,
        anoMes: infoVencimento ? infoVencimento.anoMes : anoMesAtual
      };

      if (metodo || isAgendado) {
        itensComMetodo.push(objItem);
      } else {
        itensSemMetodo.push(objItem);
      }
    }

    let mensagensSaida = [];

    if (itensComMetodo.length > 0) {
      const respGravados = await gravarItensNoBanco(userId, itensComMetodo, cartoes, orcamentos, anoMesAtual, textoUsuario);
      mensagensSaida.push(...respGravados);
    }

    if (itensSemMetodo.length > 0) {
      await userRef.set({
        pendente_pagamento: {
          itens: itensSemMetodo,
          textoOriginal: textoUsuario,
          criadoEm: Date.now()
        }
      }, { merge: true });

      const resumoPendentes = itensSemMetodo
        .map(i => `• *${i.descricao}* [${i.categoria}] — R$ ${i.valorTotal.toFixed(2)}`)
        .join('\n');

      const opcoesCartoes = cartoes.map(c => c.nome).join(', ');
      mensagensSaida.push(
        `❓ *Qual foi a forma de pagamento?*\n` +
        `${resumoPendentes}\n\n` +
        `Responda com: *Pix*, *Débito*, *Dinheiro* ou o nome do cartão (*${opcoesCartoes}*).`
      );
    }

    if (mensagensSaida.length > 0) {
      await sock.sendMessage(remoteJid, { text: mensagensSaida.join('\n\n') });
    }

  } catch (e) {
    console.error('Erro no processamento da mensagem:', e);
  }
}

// ============================================================================
// 8. AUTO-RECONEXÃO QUANDO O SERVIDOR REINICIA
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