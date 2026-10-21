import express from 'express';
import cors from 'cors';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import admin from 'firebase-admin';
import fs from 'fs';

// 1. Inicializa o Firebase Admin via Variável de Ambiente
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

// Rota de Healthcheck (para manter o Render acordado)
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'FinZap WhatsApp Worker', activeSessions: sessions.size });
});

// Rota para o Painel SaaS pedir a geração do QR Code
app.post('/conectar', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  startWhatsAppForUser(userId);
  res.json({ ok: true, message: 'Iniciando geração de QR Code...' });
});

// Rota para desconectar / limpar sessão
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
        await userRef.set({
          whatsapp_status: 'WAITING_QR',
          whatsapp_qrcode: qrBase64
        }, { merge: true });
        console.log(`📱 QR Code atualizado no Firebase para: ${userId}`);
      }

      if (connection === 'open') {
        await userRef.set({
          whatsapp_status: 'CONNECTED',
          whatsapp_qrcode: null
        }, { merge: true });
        console.log(`✅ WhatsApp conectado para: ${userId}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (!loggedOut) {
          setTimeout(() => startWhatsAppForUser(userId), 4000);
        } else {
          fs.rmSync(authFolder, { recursive: true, force: true });
          await userRef.set({
            whatsapp_status: 'DISCONNECTED',
            whatsapp_qrcode: null
          }, { merge: true });
          sessions.delete(userId);
        }
      }
    });

    // Escuta as mensagens enviadas no WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message) return;

      // Lê mensagens que você envia para você mesmo ("Você") ou em qualquer chat se começar com comando
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!texto) return;

      // Evita loop infinito ignorando as respostas do próprio bot
      if (texto.startsWith('✅') || texto.startsWith('📊') || texto.startsWith('💳') || texto.startsWith('🤖')) return;

      // Processa apenas mensagens enviadas pelo próprio usuário conectado (fromMe)
      if (!msg.key.fromMe) return;

      await processarMensagemNoFirebase(userId, texto, sock, msg.key.remoteJid);
    });

  } catch (err) {
    console.error('Erro ao iniciar WhatsApp:', err);
  }
}

async function processarMensagemNoFirebase(userId, textoUsuario, sock, remoteJid) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const cartoes = userData.cartoes || [{ nome: 'VISA', limite: 5000 }, { nome: 'NUBANK', limite: 3500 }];
    const categorias = userData.categorias || ['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros'];
    const orcamentos = userData.orcamentos || {};

    const txtLower = textoUsuario.toLowerCase();
    const hoje = new Date();
    const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

    // 1. Verifica se é uma PERGUNTA de saldo ou fatura
    const isPergunta = /\?|quanto|qual|resumo|saldo|fatura/i.test(txtLower) && !/gastei|comprei|paguei|recebi/i.test(txtLower);
    if (isPergunta) {
      const snap = await db.collection('users').doc(userId).collection('transacoes')
        .where('anoMes', '==', anoMesAtual).get();
      const transMes = snap.docs.map(d => d.data());

      const rec = transMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);

      await sock.sendMessage(remoteJid, {
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Saldo: R$ ${(rec - desp).toFixed(2)}*`
      });
      return;
    }

    // 2. Verifica se é um LANÇAMENTO FINANCEIRO (precisa ter verbo financeiro para não lançar conversas normais!)
    const temGatilhoFinanceiro = /gastei|comprei|paguei|recebi|ganhei|abasteci|almocei|fui no mercado|lançar|lancei/i.test(txtLower);
    if (!temGatilhoFinanceiro) return;

    const partes = textoUsuario.split(/(?:\s+e\s+|\s*;\s*|\n+)/i).map(p => p.trim()).filter(Boolean);
    let respostas = [];

    for (const trecho of partes) {
      const tLow = trecho.toLowerCase();
      const matchParcelas = tLow.match(/(\d+)\s*(?:x|vezes|parcelas)/);
      const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

      const textoSemParcela = matchParcelas ? trecho.replace(matchParcelas[0], '') : trecho;
      const matchValor = textoSemParcela.match(/(\d+[.,]\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0].replace(',', '.'));
      const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
      const isReceita = /recebi|ganhei|salário|salario|venda/i.test(tLow);
      const tipo = isReceita ? 'RECEITA' : 'DESPESA';

      let metodo = 'PIX/DINHEIRO';
      if (/crédito|credito|cartão|cartao/i.test(tLow)) metodo = 'CREDITO';
      else if (/débito|debito/i.test(tLow)) metodo = 'DEBITO';
      else if (/pix/i.test(tLow)) metodo = 'PIX';

      let cartaoIdentificado = null;
      for (const c of cartoes) {
        if (tLow.includes(c.nome.toLowerCase())) {
          cartaoIdentificado = c.nome;
          metodo = 'CREDITO';
          break;
        }
      }
      if (parcelasTotal > 1) metodo = 'CREDITO';

      let categoria = isReceita ? 'Receita' : 'Outros';
      if (/mercado|supermercado|atacadão|compras/i.test(tLow)) categoria = 'Mercado';
      else if (/lanche|restaurante|ifood|padaria|almoço|jantar|burger|pizza/i.test(tLow)) categoria = 'Alimentação';
      else if (/uber|gasolina|combustível|posto|99|estacionamento/i.test(tLow)) categoria = 'Transporte';
      else if (/cinema|passeio|bar|viagem|streaming|netflix/i.test(tLow)) categoria = 'Lazer';
      else if (/luz|água|internet|energia|boleto|aluguel/i.test(tLow)) categoria = 'Contas';

      for (const cat of categorias) {
        if (tLow.includes(cat.toLowerCase())) {
          categoria = cat;
          break;
        }
      }

      let descricao = textoSemParcela
        .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|no cartão de credito|no cartão|no credito|no pix|reais|r\$|de |em /gi, ' ')
        .replace(matchValor[0], '')
        .replace(cartaoIdentificado ? new RegExp(cartaoIdentificado, 'gi') : '', '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!descricao || descricao.length < 2) descricao = `${tipo === 'RECEITA' ? 'Entrada' : 'Gasto'} (${categoria})`;
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
          cartao_nome: cartaoIdentificado,
          categoria,
          anoMes: `${anoM}-${mesM}`,
          origem: 'WHATSAPP_REAL',
          mensagem_original: textoUsuario,
          criadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      respostas.push(`✅ *${descricao}* [${categoria}]\n💰 R$ ${valorParcela.toFixed(2)} ${parcelasTotal > 1 ? `(${parcelasTotal}x)` : ''} • ${cartaoIdentificado || metodo}`);
    }

    if (respostas.length > 0) {
      await sock.sendMessage(remoteJid, { text: respostas.join('\n\n') });
    }
  } catch (e) {
    console.error('Erro ao salvar lançamento do WhatsApp:', e);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 FinZap WhatsApp Server rodando na porta ${PORT}`));