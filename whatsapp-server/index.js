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

// Função auxiliar para remover acentos nas comparações ("alimentação" -> "alimentacao")
const semAcento = (str) => str ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';

// Rota principal (usada pelo cron-job.org para manter o servidor acordado 24h)
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'FinZap WhatsApp Worker (Firestore Auth + IA)', 
    activeSessions: sessions.size 
  });
});

// Rota para gerar novo QR Code
app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  try {
    const sockAntigo = sessions.get(userId);
    if (sockAntigo) {
      try { sockAntigo.end(); } catch (e) {}
      sessions.delete(userId);
    }

    // Limpa sessão antiga travada para forçar um QR Code novo
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

// Rota para desconectar aparelho
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
        console.log(`📱 Novo QR Code gerado para: ${userId}`);
        const qrBase64 = await QRCode.toDataURL(qr);
        await userRef.set({
          whatsapp_status: 'WAITING_QR',
          whatsapp_qrcode: qrBase64
        }, { merge: true });
      }

      if (connection === 'open') {
        console.log(`✅ WhatsApp CONECTADO para: ${userId}`);
        await userRef.set({
          whatsapp_status: 'CONNECTED',
          whatsapp_qrcode: null
        }, { merge: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Conexão fechada para ${userId}. StatusCode: ${statusCode}`);

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

      // Filtro anti-loop de mensagens enviadas pelo próprio robô
      if (
        texto.startsWith('✅') || 
        texto.startsWith('📊') || 
        texto.startsWith('💳') || 
        texto.startsWith('🤖') || 
        texto.startsWith('📂') || 
        texto.startsWith('🎯') ||
        texto.startsWith('⚠️') ||
        texto.startsWith('🗑️')
      ) return;

      await processarMensagemInteligente(userId, texto, sock, msg.key.remoteJid);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp com Firestore:', err);
  }
}

// ============================================================================
// 4. MOTOR DE INTELIGÊNCIA FINANCEIRA (DESFAZER, CONSULTAS E LANÇAMENTOS)
// ============================================================================
async function processarMensagemInteligente(userId, textoUsuario, sock, remoteJid) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const cartoes = userData.cartoes || [{ nome: 'VISA', limite: 5000 }, { nome: 'NUBANK', limite: 3500 }];
    const categorias = userData.categorias || ['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const orcamentos = userData.orcamentos || {};

    const txtLimpo = semAcento(textoUsuario);
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

    // ------------------------------------------------------------------------
    // MODO 0: DESFAZER / APAGAR ÚLTIMO LANÇAMENTO
    // ------------------------------------------------------------------------
    const isDesfazer = /^(apagar|excluir|deletar|remover|desfazer|cancelar)\s*(ultimo|ultima|lancamento|gasto)?$/i.test(txtLimpo.trim());

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
    // MODO 1: CONSULTOR FINANCEIRO (Responde sobre Limites, Cartões e Saldo)
    // ------------------------------------------------------------------------
    const isPergunta = /\?|quanto|qual|resumo|saldo|fatura|limite|disponivel|posso gastar/i.test(txtLimpo) && !/gastei|comprei|paguei|recebi/i.test(txtLimpo);
    
    if (isPergunta) {
      const snap = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
      const transMes = snap.docs.map(d => d.data());

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
        const gastoCartao = transMes
          .filter(t => semAcento(t.cartao_nome) === semAcento(cartaoPerguntado.nome))
          .reduce((a, b) => a + Number(b.valor || 0), 0);
        const limiteCartao = Number(cartaoPerguntado.limite || 0);
        const disponivelCartao = limiteCartao - gastoCartao;

        await sock.sendMessage(remoteJid, {
          text: `💳 *Cartão ${cartaoPerguntado.nome} (${anoMesAtual})*\n\n` +
                `• Fatura atual: *R$ ${gastoCartao.toFixed(2)}*\n` +
                `• Limite total: *R$ ${limiteCartao.toFixed(2)}*\n` +
                `• Limite disponível: *R$ ${disponivelCartao.toFixed(2)}*`
        });
        return;
      }

      // C) Cartões em geral
      if (/cartao|cartoes|fatura/i.test(txtLimpo)) {
        let msgCartoes = `💳 *Resumo dos seus Cartões (${anoMesAtual})*\n\n`;
        for (const c of cartoes) {
          const gastoC = transMes
            .filter(t => semAcento(t.cartao_nome) === semAcento(c.nome))
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          const dispC = Number(c.limite || 0) - gastoC;
          msgCartoes += `🔹 *${c.nome}*\n   Fatura: R$ ${gastoC.toFixed(2)} | Disponível: R$ ${dispC.toFixed(2)}\n\n`;
        }
        await sock.sendMessage(remoteJid, { text: msgCartoes.trim() });
        return;
      }

      // D) Resumo Geral
      const rec = transMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);

      await sock.sendMessage(remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Saldo Atual: R$ ${(rec - desp).toFixed(2)}*`
      });
      return;
    }

    // ------------------------------------------------------------------------
    // MODO 2: LANÇAMENTOS (Simples, Múltiplos ou Parcelados)
    // ------------------------------------------------------------------------
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    let respostas = [];

    for (const parte of partes) {
      const pLimpo = semAcento(parte);

      const matchParcelas = pLimpo.match(/(\d+)\s*(?:x|vezes|parcelas)/);
      const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

      const textoSemParcela = matchParcelas ? parte.replace(new RegExp(matchParcelas[0], 'i'), '') : parte;
      const matchValor = textoSemParcela.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0]);
      if (isNaN(valorTotal) || valorTotal <= 0) continue;

      const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
      const isReceita = /recebi|ganhei|salario|venda/i.test(pLimpo);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      let metodo = 'PIX/DINHEIRO';
      let cartaoNome = null;
      if (/credito|cartao/i.test(pLimpo) || parcelasTotal > 1) {
        metodo = 'CREDITO';
        for (const c of cartoes) {
          if (pLimpo.includes(semAcento(c.nome))) {
            cartaoNome = c.nome;
            break;
          }
        }
        if (!cartaoNome && cartoes.length > 0) cartaoNome = cartoes[0].nome;
      } else if (/debito/i.test(pLimpo)) {
        metodo = 'DEBITO';
      } else if (/pix/i.test(pLimpo)) {
        metodo = 'PIX';
      }

      let categoria = isReceita ? 'Receita' : 'Outros';
      if (/mercado|supermercado|compras|cebola|atacadao|acougue|hortifruti/i.test(pLimpo)) categoria = 'Mercado';
      else if (/lanche|restaurante|ifood|padaria|almoco|jantar|burger|pizza|cafe/i.test(pLimpo)) categoria = 'Alimentação';
      else if (/uber|gasolina|combustivel|posto|estacionamento|pedagio/i.test(pLimpo)) categoria = 'Transporte';
      else if (/cinema|passeio|bar|viagem|lazer|shopping|netflix|streaming/i.test(pLimpo)) categoria = 'Lazer';
      else if (/luz|agua|internet|energia|boleto|aluguel|condominio/i.test(pLimpo)) categoria = 'Contas';

      for (const cat of categorias) {
        if (pLimpo.includes(semAcento(cat))) {
          categoria = cat;
          break;
        }
      }

      let descricao = textoSemParcela
        .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|no cartao de credito|no cartao|no pix|no credito|no debito|no débito|credito|crédito|debito|débito|pix|reais|r\$|de |do |da |no |na |em /gi, ' ')
        .replace(matchValor[0], '')
        .replace(cartaoNome ? new RegExp(cartaoNome, 'gi') : '', '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = categoria;
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      for (let i = 0; i < parcelasTotal; i++) {
        const dataParcela = new Date(hoje.getFullYear(), hoje.getMonth() + i, 15);
        const anoM = dataParcela.getFullYear();
        const mesM = String(dataParcela.getMonth() + 1).padStart(2, '0');

        await db.collection('users').doc(userId).collection('transacoes').add({
          descricao: parcelasTotal > 1 ? `${descricao} (${i + 1}/${parcelasTotal})` : descricao,
          valor: valorParcela,
          tipo,
          metodo,
          cartao_nome: cartaoNome,
          categoria,
          anoMes: `${anoM}-${mesM}`,
          origem: 'WHATSAPP_IA',
          mensagem_original: textoUsuario,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      respostas.push(
        `✅ *${descricao}* [${categoria}]\n` +
        `💰 R$ ${valorParcela.toFixed(2)} ${parcelasTotal > 1 ? `(${parcelasTotal}x)` : ''} • ${cartaoNome || metodo}`
      );
    }

    if (respostas.length > 0) {
      await sock.sendMessage(remoteJid, { text: respostas.join('\n\n') });
    }

  } catch (e) {
    console.error('Erro no processamento da mensagem:', e);
  }
}

// ============================================================================
// 5. AUTO-RECONEXÃO QUANDO O SERVIDOR REINICIA
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
  console.log(`🚀 FinZap WhatsApp Server (Firestore Auth) rodando na porta ${PORT}`);
  restaurarSessoesAtivas();
});