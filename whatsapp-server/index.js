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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'FinZap WhatsApp Worker (Firestore Auth)', activeSessions: sessions.size });
});

app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
  startWhatsAppForUser(userId);
  res.json({ ok: true, message: 'Iniciando conexão com o Firestore...' });
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
  const batch = db.batch();
  docs.forEach(d => batch.delete(d.ref));
  await batch.commit();

  await db.collection('users').doc(userId).set({
    whatsapp_status: 'DISCONNECTED',
    whatsapp_qrcode: null
  }, { merge: true });

  res.json({ ok: true });
});

// ADAPTADOR DE AUTENTICAÇÃO DO BAILEYS PARA O FIRESTORE
function useFirestoreAuthState(userId) {
  const sessionRef = db.collection('users').doc(userId).collection('whatsapp_session');

  const writeData = async (data, id) => {
    const jsonString = JSON.stringify(data, BufferJSON.replacer);
    const json = JSON.parse(jsonString);
    await sessionRef.doc(id).set(json);
  };

  const readData = async (id) => {
    try {
      const doc = await sessionRef.doc(id).get();
      if (!doc.exists) return null;
      const jsonString = JSON.stringify(doc.data(), BufferJSON.reviver);
      return JSON.parse(jsonString, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await sessionRef.doc(id).delete();
    } catch (error) {}
  };

  return {
    state: {
      creds: async () => {
        let creds = await readData('creds');
        return creds || initAuthCreds();
      },
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = BufferJSON.reviver('', value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {}
  };
}

async function startWhatsAppForUser(userId) {
  try {
    const { state, saveCreds } = useFirestoreAuthState(userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['FinZap SaaS', 'Chrome', '1.0.0']
    });

    sessions.set(userId, sock);
    sock.ev.on('creds.update', async () => {
      const creds = await state.creds();
      await db.collection('users').doc(userId).collection('whatsapp_session').doc('creds').set(JSON.parse(JSON.stringify(creds, BufferJSON.replacer)));
      saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const userRef = db.collection('users').doc(userId);

      if (qr) {
        const qrBase64 = await QRCode.toDataURL(qr);
        await userRef.set({ whatsapp_status: 'WAITING_QR', whatsapp_qrcode: qrBase64 }, { merge: true });
      }

      if (connection === 'open') {
        await userRef.set({ whatsapp_status: 'CONNECTED', whatsapp_qrcode: null }, { merge: true });
        console.log(`✅ WhatsApp conectado e salvo no Firebase para: ${userId}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startWhatsAppForUser(userId), 4000);
        } else {
          await userRef.set({ whatsapp_status: 'DISCONNECTED', whatsapp_qrcode: null }, { merge: true });
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

      if (texto.startsWith('✅') || texto.startsWith('📊') || texto.startsWith('💳') || texto.startsWith('🤖')) return;

      await processarMensagemInteligente(userId, texto, sock, msg.key.remoteJid);
    });

  } catch (err) {
    console.error('Erro ao iniciar WhatsApp com Firestore:', err);
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

    // 2. Normalização: unifica números decimais (ex: 50,00 vira 50.00 para não quebrar na vírgula)
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');

    // Divide por vírgulas ou pela conjunção "e"
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    let respostas = [];

    for (const parte of partes) {
      const pLow = parte.toLowerCase();
      
      // Procura o valor numérico correto (agora com ponto decimal)
      const matchValor = parte.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valor = parseFloat(matchValor[0]);
      if (isNaN(valor) || valor <= 0) continue;

      const isReceita = /recebi|ganhei|salário|salario|venda/i.test(pLow);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      // Identifica método e cartão individual do item
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

      // Identifica Categoria
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

      // Limpeza da descrição do gasto
      let descricao = parte
        .replace(/no pix|no credito|no débito|credito|debito|pix|reais|r\$/gi, '')
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 FinZap WhatsApp Server (Firestore Auth) rodando na porta ${PORT}`));