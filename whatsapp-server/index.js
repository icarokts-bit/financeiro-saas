import express from 'express';
import cors from 'cors';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import admin from 'firebase-admin';
import fs from 'fs';

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
  res.json({ status: 'online', service: 'FinZap WhatsApp Worker (Advanced IA)', activeSessions: sessions.size });
});

app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
  startWhatsAppForUser(userId);
  res.json({ ok: true, message: 'Iniciando QR Code...' });
});

app.post('/desconectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
  const sock = sessions.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    sessions.delete(userId);
  }
  fs.rmSync(`./auth_sessions/${userId}`, { recursive: true, force: true });
  await db.collection('users').doc(userId).set({
    whatsapp_status: 'DISCONNECTED',
    whatsapp_qrcode: null
  }, { merge: true });
  res.json({ ok: true });
});

async function startWhatsAppForUser(userId) {
  try {
    const authFolder = `./auth_sessions/${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
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
        await userRef.set({ whatsapp_status: 'WAITING_QR', whatsapp_qrcode: qrBase64 }, { merge: true });
      }

      if (connection === 'open') {
        await userRef.set({ whatsapp_status: 'CONNECTED', whatsapp_qrcode: null }, { merge: true });
        console.log(`✅ WhatsApp conectado para: ${userId}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startWhatsAppForUser(userId), 4000);
        } else {
          fs.rmSync(authFolder, { recursive: true, force: true });
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
    console.error('Erro ao iniciar WhatsApp:', err);
  }
}

// ============================================================================
// MOTOR INTELIGENTE DE INTERPRETAÇÃO DE MENSAGENS NO WHATSAPP
// ============================================================================
async function processarMensagemInteligente(userId, textoUsuario, sock, remoteJid) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const cartoes = userData.cartoes || [{ nome: 'VISA', limite: 5000 }, { nome: 'NUBANK', limite: 3500 }, { nome: 'C6', limite: 4000 }];
    const categorias = userData.categorias || ['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const orcamentos = userData.orcamentos || {};

    const txtLower = textoUsuario.toLowerCase();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

    // 1. TRATAMENTO DE PERGUNTAS E CONSULTAS (Saldo, Faturas, Limites)
    const isPergunta = /\?|quanto|qual|resumo|saldo|fatura|limite/i.test(txtLower) && !/gastei|comprei|paguei|recebi/i.test(txtLower);
    if (isPergunta) {
      const snap = await db.collection('users').doc(userId).collection('transacoes')
        .where('anoMes', '==', anoMesAtual).get();
      const transMes = snap.docs.map(d => d.data());

      const rec = transMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);

      // Consulta de Categoria específica (ex: "Quanto gastei de alimentação?")
      for (const cat of categorias) {
        if (txtLower.includes(cat.toLowerCase())) {
          const totalCat = transMes.filter(t => t.tipo === 'DESPESA' && t.categoria.toLowerCase() === cat.toLowerCase()).reduce((a, b) => a + Number(b.valor || 0), 0);
          const lim = orcamentos[cat] || 0;
          await sock.sendMessage(remoteJid, {
            text: `📂 *Categoria: ${cat}*\n• Gasto no mês: *R$ ${totalCat.toFixed(2)}*\n${lim > 0 ? `• Limite definido: R$ ${lim.toFixed(2)}` : '• Sem limite cadastrado'}`
          });
          return;
        }
      }

      // Consulta de Cartão específico
      const cartaoPerguntado = cartoes.find(c => txtLower.includes(c.nome.toLowerCase()));
      if (cartaoPerguntado) {
        const totalCartao = transMes.filter(t => t.cartao_nome?.toLowerCase() === cartaoPerguntado.nome.toLowerCase()).reduce((a, b) => a + Number(b.valor || 0), 0);
        const disp = cartaoPerguntado.limite - totalCartao;
        await sock.sendMessage(remoteJid, {
          text: `💳 *Cartão ${cartaoPerguntado.nome}*\n• Fatura atual: *R$ ${totalCartao.toFixed(2)}*\n• Limite total: R$ ${cartaoPerguntado.limite.toFixed(2)}\n• Disponível: *R$ ${disp.toFixed(2)}*`
        });
        return;
      }

      // Resumo Geral
      await sock.sendMessage(remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Saldo Atual: R$ ${(rec - desp).toFixed(2)}*`
      });
      return;
    }

    // 2. DETECÇÃO DE CONTEXTO GERAL (Método global para frases compostas como "tudo no crédito")
    let metodoGlobal = 'PIX/DINHEIRO';
    let cartaoGlobal = null;
    if (/crédito|credito|cartão|cartao/i.test(txtLower)) {
      metodoGlobal = 'CREDITO';
      for (const c of cartoes) {
        if (txtLower.includes(c.nome.toLowerCase())) {
          cartaoGlobal = c.nome;
          break;
        }
      }
      if (!cartaoGlobal && cartoes.length > 0) cartaoGlobal = cartoes[0].nome; // Padrão se não especificar
    } else if (/débito|debito/i.test(txtLower)) {
      metodoGlobal = 'DEBITO';
    } else if (/pix/i.test(txtLower)) {
      metodoGlobal = 'PIX';
    }

    // 3. QUEBRA DE FRASES COM MÚLTIPLOS LANÇAMENTOS (ex: "40 de estacionamento, 50 do cinema e 100 de lanche")
    // Substitui " e " por vírgulas para padronizar a separação
    const textoLimpoSplit = textoUsuario.replace(/\s+e\s+/gi, ', ');
    const fragmentos = textoLimpoSplit.split(',').map(p => p.trim()).filter(Boolean);

    let respostas = [];

    for (const frag of fragmentos) {
      const fLow = frag.toLowerCase();
      const matchValor = fLow.match(/(\d+[.,]\d{2}|\d+)/);
      if (!matchValor) continue;

      const valor = parseFloat(matchValor[0].replace(',', '.'));
      const isReceita = /recebi|ganhei|salário|salario|venda/i.test(fLow);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      // Identifica categoria com base em palavras-chave
      let categoria = isReceita ? 'Receita' : 'Outros';
      if (/mercado|supermercado|compras|cebola|batatas/i.test(fLow)) categoria = 'Mercado';
      else if (/lanche|restaurante|ifood|padaria|almoço|jantar|burger|pizza/i.test(fLow)) categoria = 'Alimentação';
      else if (/uber|gasolina|combustível|posto|estacionamento|pedágio|transporte/i.test(fLow)) categoria = 'Transporte';
      else if (/cinema|passeio|bar|viagem|streaming|lazer|shopping/i.test(fLow)) categoria = 'Lazer';
      else if (/luz|água|internet|energia|boleto|aluguel/i.test(fLow)) categoria = 'Contas';

      for (const cat of categorias) {
        if (fLow.includes(cat.toLowerCase())) {
          categoria = cat;
          break;
        }
      }

      let descricao = frag
        .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|estacionamento|cinema|lanche|no cartão de credito|no cartão|no credito|no pix|reais|r\$|de |em /gi, ' ')
        .replace(matchValor[0], '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = frag.charAt(0).toUpperCase() + frag.slice(1);
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      const metodoFinal = metodoGlobal;
      const cartaoFinal = cartaoGlobal;

      await db.collection('users').doc(userId).collection('transacoes').add({
        descricao,
        valor,
        tipo,
        metodo: metodoFinal,
        cartao_nome: cartaoFinal,
        categoria,
        anoMes: anoMesAtual,
        origem: 'WHATSAPP_IA',
        mensagem_original: textoUsuario,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      respostas.push(`✅ *${descricao}* [${categoria}]\n💰 R$ ${valor.toFixed(2)} • ${cartaoFinal || metodoFinal}`);
    }

    if (respostas.length > 0) {
      await sock.sendMessage(remoteJid, { text: respostas.join('\n\n') });
    } else {
      await sock.sendMessage(remoteJid, { text: '🤔 Não consegui extrair os valores da sua frase. Tente: "Gastei 40 no mercado"' });
    }

  } catch (e) {
    console.error('Erro na IA do WhatsApp:', e);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 FinZap WhatsApp Server rodando na porta ${PORT}`));