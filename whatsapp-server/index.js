import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import admin from 'firebase-admin';

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

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'FinZap WhatsApp Worker (Firestore Auth)', activeSessions: sessions.size });
});

// Quando clica no botão "Gerar QR Code" no painel, limpa sessão travada e gera um novo QR Code
app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  try {
    // Se já houver um socket antigo travado, encerra antes de gerar novo QR
    const sockAntigo = sessions.get(userId);
    if (sockAntigo) {
      try { sockAntigo.end(); } catch (e) {}
      sessions.delete(userId);
    }

    // Limpa credenciais antigas corrompidas para forçar a criação de um QR Code novo
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

// ADAPTADOR CORRIGIDO (ASYNC) DO BAILEYS PARA O FIRESTORE
async function useFirestoreAuthState(userId) {
  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');

  // O Firestore não aceita caracteres '/' no ID do documento
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

  // IMPORTANTE: creds precisa ser um objeto resolvido com await!
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

      if (texto.startsWith('✅') || texto.startsWith('📊') || texto.startsWith('💳') || texto.startsWith('🤖') || texto.startsWith('📂')) return;

      await processarMensagemInteligente(userId, texto, sock, msg.key.remoteJid);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp com Firestore:', err);
  }
}

async function processarMensagemInteligente(userId, textoUsuario, sock, remoteJid) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const cartoes = userData.cartoes || [{ nome: 'VISA', limite: 5000 }, { nome: 'NUBANK', limite: 3500 }];
    const categorias = userData.categorias || ['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];

    const txtLower = textoUsuario.toLowerCase();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

    // 1. Consultas Rápidas
    const isPergunta = /\?|quanto|qual|resumo|saldo|fatura|limite/i.test(txtLower) && !/gastei|comprei|paguei|recebi/i.test(txtLower);
    if (isPergunta) {
      const snap = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
      const transMes = snap.docs.map(d => d.data());
      const rec = transMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);

      await sock.sendMessage(remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Saldo Atual: R$ ${(rec - desp).toFixed(2)}*`
      });
      return;
    }

    // 2. Normalização de decimais (50,00 -> 50.00) para não fatiar na vírgula
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    let respostas = [];

    for (const parte of partes) {
      const pLow = parte.toLowerCase();
      const matchValor = parte.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valor = parseFloat(matchValor[0]);
      if (isNaN(valor) || valor <= 0) continue;

      const isReceita = /recebi|ganhei|salário|salario|venda/i.test(pLow);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      let metodo = 'PIX/DINHEIRO';
      let cartaoNome = null;
      if (/crédito|credito|cartão|cartao/i.test(pLow)) {
        metodo = 'CREDITO';
        for (const c of cartoes) {
          if (pLow.includes(c.nome.toLowerCase())) {
            cartaoNome = c.nome;
            break;
          }
        }
        if (!cartaoNome && cartoes.length > 0) cartaoNome = cartoes[0].nome;
      } else if (/débito|debito/i.test(pLow)) {
        metodo = 'DEBITO';
      } else if (/pix/i.test(pLow)) {
        metodo = 'PIX';
      }

      let categoria = isReceita ? 'Receita' : 'Outros';
      if (/mercado|supermercado|compras|cebola/i.test(pLow)) categoria = 'Mercado';
      else if (/lanche|restaurante|ifood|padaria|almoço|jantar|burger|pizza/i.test(pLow)) categoria = 'Alimentação';
      else if (/uber|gasolina|combustível|posto|estacionamento|pedágio/i.test(pLow)) categoria = 'Transporte';
      else if (/cinema|passeio|bar|viagem|lazer|shopping/i.test(pLow)) categoria = 'Lazer';
      else if (/luz|água|internet|energia|boleto|aluguel/i.test(pLow)) categoria = 'Contas';

      for (const cat of categorias) {
        if (pLow.includes(cat.toLowerCase())) {
          categoria = cat;
          break;
        }
      }

      let descricao = parte
        .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|no pix|no credito|no débito|credito|debito|pix|reais|r\$|de |do |da |no |na /gi, ' ')
        .replace(matchValor[0], '')
        .replace(cartaoNome ? new RegExp(cartaoNome, 'gi') : '', '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = categoria;
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      await db.collection('users').doc(userId).collection('transacoes').add({
        descricao,
        valor,
        tipo,
        metodo,
        cartao_nome: cartaoNome,
        categoria,
        anoMes: anoMesAtual,
        origem: 'WHATSAPP_IA',
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      respostas.push(`✅ *${descricao}* [${categoria}]\n💰 R$ ${valor.toFixed(2)} • ${cartaoNome || metodo}`);
    }

    if (respostas.length > 0) {
      await sock.sendMessage(remoteJid, { text: respostas.join('\n\n') });
    }

  } catch (e) {
    console.error('Erro:', e);
  }
}

// Reconecta automaticamente todas as sessões ativas no Firestore quando o servidor reinicia
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