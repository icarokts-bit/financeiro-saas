import express from 'express';
import cors from 'cors';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import * as Baileys from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ============================================================================
// 1. INICIALIZAÇÃO DO FIREBASE E EXPRESS
// ============================================================================
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

// Diretório persistente do Volume no Railway (lê automaticamente o Mount Path configurado)
const AUTH_BASE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), 'wwebjs_auth');
if (!fs.existsSync(AUTH_BASE_DIR)) {
  fs.mkdirSync(AUTH_BASE_DIR, { recursive: true });
}

// ============================================================================
// SEGURANÇA
// ============================================================================
// Origens que podem chamar a API pelo navegador (o Asaas e o cron não passam por navegador).
// Para liberar outro domínio, defina ALLOWED_ORIGINS no servidor (separado por vírgula).
const ORIGENS_PERMITIDAS = (process.env.ALLOWED_ORIGINS || 'https://financeiro-saas-psi.vercel.app,http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Identifica qual versão do servidor está no ar (aparece no log de inicialização e em GET /)
const BUILD_ID = '2026-11-24-wpp-v5';

// Registro de cada chamada (método, rota, status e origem): sem isso, uma chamada recusada
// por CORS, login ou assinatura não deixava nenhum rastro nos logs do Railway
app.use((req, res, next) => {
  if (req.path === '/') return next(); // ping público, não polui o log
  const inicio = Date.now();
  res.on('finish', () => {
    console.log(`🌐 ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - inicio}ms) origem=${req.headers.origin || '-'}`);
  });
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida pelo CORS'));
  },
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100kb' }));

// Comparação de segredos em tempo constante
const compararSegredo = (recebido, esperado) => {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// O site envia o token de login do Firebase; o servidor descobre QUEM é o usuário por ele
// (nunca confia em userId vindo do corpo da requisição).
const autenticarUsuario = async (req, res, next) => {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login necessário.' });

  try {
    const decodificado = await admin.auth().verifyIdToken(token);
    req.uid = decodificado.uid;
    req.userEmail = decodificado.email || null;
    next();
  } catch (e) {
    console.warn('🔒 Token de login recusado:', e.code || e.message);
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
};

// Rotas internas (cron/manutenção): exigem um segredo configurado no servidor, sem valor padrão
const validarChaveInterna = (req, res, next) => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Rota desativada: CRON_SECRET não configurada.' });
  }
  if (!compararSegredo(req.headers['x-cron-key'], process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Acesso negado.' });
  }
  next();
};

const sessions = new Map();
const userJids = new Map();
const sentMessagesCache = new Map();

const tentativasReconexao = new Map(); // userId -> tentativas seguidas sem conseguir abrir a conexão
const tentativas405 = new Map();       // userId -> vezes que o WhatsApp recusou a versão (erro 405)
const geracaoSessao = new Map();       // userId -> número que muda quando o usuário pede nova conexão/desconexão

// Versão do WhatsApp Web usada na conexão. O WhatsApp recusa (erro 405) versões antigas, e a lista do
// Baileys pode estar atrasada. Ordem: manual (WA_VERSION="2,3000,123") -> WhatsApp Web ao vivo -> lista do Baileys -> padrão.
let cacheVersaoWA = { version: null, origem: null, em: 0 };
async function obterVersaoWhatsApp(forcarAtualizar = false) {
  if (process.env.WA_VERSION) {
    const v = process.env.WA_VERSION.split(',').map(n => Number(n.trim()));
    if (v.length === 3 && v.every(Number.isFinite)) return { version: v, origem: 'WA_VERSION (manual)' };
  }
  if (!forcarAtualizar && cacheVersaoWA.version && Date.now() - cacheVersaoWA.em < 30 * 60 * 1000) {
    return cacheVersaoWA;
  }

  const buscarAoVivo = Baileys.fetchLatestWaWebVersion || Baileys.default?.fetchLatestWaWebVersion;
  if (typeof buscarAoVivo === 'function') {
    try {
      const r = await buscarAoVivo();
      if (r?.version && r.isLatest !== false) {
        cacheVersaoWA = { version: r.version, origem: 'WhatsApp Web (ao vivo)', em: Date.now() };
        return cacheVersaoWA;
      }
    } catch (e) { /* tenta a próxima fonte */ }
  }

  try {
    const r = await fetchLatestBaileysVersion();
    if (r?.version) {
      cacheVersaoWA = { version: r.version, origem: 'lista do Baileys', em: Date.now() };
      return cacheVersaoWA;
    }
  } catch (e) { /* usa o padrão da biblioteca */ }

  return { version: undefined, origem: 'padrão da biblioteca' };
}

// Mostra o motivo no site (campo só escrito pelo servidor) e deixa o usuário tentar de novo
const registrarErroWhatsApp = (userId, texto) =>
  db.collection('users').doc(userId).set({
    whatsapp_status: 'DISCONNECTED',
    whatsapp_qrcode: null,
    whatsapp_erro: texto
  }, { merge: true }).catch(() => {});

// Reconexão agendada que é cancelada se o usuário pedir nova conexão/desconexão enquanto espera
const agendarReconexao = (userId, esperaMs, forcarVersaoNova = false) => {
  const geracao = geracaoSessao.get(userId) || 0;
  setTimeout(() => {
    if ((geracaoSessao.get(userId) || 0) !== geracao) return;
    startWhatsAppForUser(userId, forcarVersaoNova);
  }, esperaMs);
};

const semAcento = (str) => str ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';

// Palavras do nome de um cartão (sem acento, sem termos genéricos)
const PALAVRAS_GENERICAS_CARTAO = new Set(['cartao', 'credito', 'banco', 'de', 'do', 'da']);
const tokensDe = (str) =>
  semAcento(str).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !PALAVRAS_GENERICAS_CARTAO.has(t));

// Acha o cartão citado no texto: pelo nome completo ("infiniti rico") ou por partes dele ("infiniti", "c6", "black").
// Partes só valem quando permitirParcial = true (ex.: a pessoa escreveu "cartão"/"crédito"), para "pix c6" não virar cartão.
// Retorna { cartao } quando achou um só, { ambiguo: true } quando mais de um cartão serve, ou {} quando nenhum.
function acharCartaoNoTexto(textoLimpo, cartoes, permitirParcial = true) {
  const texto = ` ${semAcento(textoLimpo).replace(/[^a-z0-9]+/g, ' ')} `;
  let melhor = null;
  let melhorPontos = 0;
  let empate = false;

  for (const c of cartoes) {
    const nomeNorm = semAcento(c.nome).replace(/[^a-z0-9]+/g, ' ').trim();
    let pontos = 0;
    if (nomeNorm && texto.includes(` ${nomeNorm} `)) {
      pontos = 100;
    } else if (permitirParcial) {
      for (const t of tokensDe(c.nome)) {
        if (texto.includes(` ${t} `)) pontos += 10;
      }
    }
    if (pontos > melhorPontos) { melhor = c; melhorPontos = pontos; empate = false; }
    else if (pontos > 0 && pontos === melhorPontos) { empate = true; }
  }

  if (empate) return { ambiguo: true };
  return melhor ? { cartao: melhor } : {};
}

const formatarDataBR = (isoDate) => {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '';
  const [a, m, d] = isoDate.split('-');
  return `${d}/${m}/${a}`;
};

// Função para limpar a pasta local de sessão de um usuário
function limparPastaSessaoLocal(userId) {
  const userAuthDir = path.join(AUTH_BASE_DIR, `session_${userId}`);
  if (fs.existsSync(userAuthDir)) {
    fs.rmSync(userAuthDir, { recursive: true, force: true });
  }
}

// Função matemática avançada para calcular o mês/dia correto da Fatura do Cartão
const calcularDataFaturaCartao = (dataCompraIso, diaFechamento, diaVencimento, parcelaAtual = 1) => {
  diaFechamento = Number(diaFechamento);
  diaVencimento = Number(diaVencimento);
  const dataCompra = new Date(dataCompraIso + 'T12:00:00');
  let anoFatura = dataCompra.getFullYear();
  let mesFatura = dataCompra.getMonth(); 
  const diaCompra = dataCompra.getDate();

  if (diaCompra >= diaFechamento) mesFatura += 1;
  if (diaVencimento < diaFechamento) mesFatura += 1;
  mesFatura += (parcelaAtual - 1);

  const dataVenc = new Date(anoFatura, mesFatura, diaVencimento);
  const anoRes = dataVenc.getFullYear();
  const mesRes = String(dataVenc.getMonth() + 1).padStart(2, '0');
  const diaRes = String(diaVencimento).padStart(2, '0');

  return { anoMes: `${anoRes}-${mesRes}`, dataVencimento: `${anoRes}-${mesRes}-${diaRes}` };
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

// ============================================================================
// ROTAS ASAAS, CONEXÃO E WEBHOOKS
// ============================================================================
let ultimaVerificacaoPorPing = 0;
app.get('/', (req, res) => {
  // Evita que chamadas públicas repetidas disparem leituras no banco sem parar
  const agora = Date.now();
  if (agora - ultimaVerificacaoPorPing > 5 * 60 * 1000) {
    ultimaVerificacaoPorPing = agora;
    verificarAlertasVencimento(false).catch(() => {});
  }
  res.status(200).send(`API FinZap Online (build ${BUILD_ID})`);
});

const ASAAS_API_URL = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

// ============================================================================
// CONTAS: TESTE GRÁTIS, ASSINATURA E PAINEL MASTER (tudo definido NO SERVIDOR)
// ============================================================================
const MASTER_EMAIL = (process.env.MASTER_EMAIL || 'icaro.kts@gmail.com').toLowerCase();
const DIAS_TESTE = Number(process.env.DIAS_TESTE || 14);
const UM_DIA_MS = 24 * 60 * 60 * 1000;

// Data de hoje (AAAA-MM-DD) no horário de Brasília. O servidor roda em UTC, e à noite
// toISOString() já viraria o dia seguinte, jogando a compra na fatura errada.
const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const temAcessoAtivo = (dados) => {
  const ate = dados?.acesso_ate?.toDate ? dados.acesso_ate.toDate() : null;
  return !!ate && ate.getTime() > Date.now();
};

const verificarAcessoAtivo = async (userId) => {
  const snap = await db.collection('users').doc(userId).get();
  return snap.exists && temAcessoAtivo(snap.data());
};

// Chamada pelo site no primeiro login (e em contas antigas sem período definido):
// cria a conta com o teste grátis. O navegador não consegue gravar esses campos (regras do Firestore).
app.post('/conta/iniciar', autenticarUsuario, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.uid);
    const snap = await userRef.get();
    const dados = snap.exists ? snap.data() : {};

    if (dados.acesso_ate) return res.json({ ok: true, criada: false });

    const ehMaster = !!req.userEmail && req.userEmail.toLowerCase() === MASTER_EMAIL;
    let status = 'TESTE';
    let acessoAte = new Date(Date.now() + DIAS_TESTE * UM_DIA_MS);

    if (ehMaster) {
      status = 'ATIVO';
      acessoAte = new Date(Date.now() + 50 * 365 * UM_DIA_MS);
    } else if (dados.plano_validade) {
      // Conta antiga que já tinha pago: respeita a validade que já existia
      const validade = new Date(`${dados.plano_validade}T23:59:59-03:00`);
      if (validade.getTime() > Date.now()) {
        status = 'ATIVO';
        acessoAte = validade;
      }
    }

    await userRef.set({
      email: req.userEmail,
      status_assinatura: status,
      acesso_ate: admin.firestore.Timestamp.fromDate(acessoAte),
      ...(dados.whatsapp_status ? {} : { whatsapp_status: 'DISCONNECTED' }),
      ...(snap.exists ? {} : { criadoEm: admin.firestore.FieldValue.serverTimestamp() })
    }, { merge: true });

    res.json({ ok: true, criada: !snap.exists });
  } catch (error) {
    console.error('Erro em /conta/iniciar:', error);
    res.status(500).json({ error: 'Erro ao iniciar a conta.' });
  }
});

// Lista de clientes para o painel master: só o servidor lê todos os usuários e só devolve dados de conta
app.post('/admin/clientes', autenticarUsuario, async (req, res) => {
  if (!req.userEmail || req.userEmail.toLowerCase() !== MASTER_EMAIL) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  try {
    const snap = await db.collection('users').limit(500).get();
    const clientes = snap.docs.map(d => {
      const x = d.data();
      return {
        id: d.id,
        email: x.email || null,
        status_assinatura: x.status_assinatura || null,
        plano_validade: x.plano_validade || null,
        acesso_ate: x.acesso_ate?.toDate ? x.acesso_ate.toDate().toISOString() : null,
        whatsapp_status: x.whatsapp_status || null
      };
    });
    res.json({ clientes });
  } catch (error) {
    console.error('Erro em /admin/clientes:', error);
    res.status(500).json({ error: 'Erro ao listar clientes.' });
  }
});

// Preço da assinatura definido NO SERVIDOR (o site não decide quanto cobrar)
const VALOR_PLANO = Number(process.env.PLANO_VALOR || 49.9);
const STATUS_PAGAMENTO_OK = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

app.post('/asaas/gerar-cobranca', autenticarUsuario, async (req, res) => {
  const userId = req.uid;
  const email = req.userEmail;
  const nome = typeof req.body?.nome === 'string' ? req.body.nome.slice(0, 100) : '';

  if (!ASAAS_API_KEY) {
    return res.status(503).json({ error: 'Pagamentos indisponíveis no momento.' });
  }

  try {
    const clienteRes = await fetch(`${ASAAS_API_URL}/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
      body: JSON.stringify({ name: nome || 'Cliente FinZap', email, externalReference: userId })
    });
    const cliente = await clienteRes.json();
    if (!cliente.id) {
      console.error('Asaas: falha ao criar cliente', cliente);
      return res.status(502).json({ error: 'Erro ao gerar cobrança no Asaas' });
    }

    const cobrancaRes = await fetch(`${ASAAS_API_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
      body: JSON.stringify({
        customer: cliente.id,
        billingType: 'PIX',
        value: VALOR_PLANO,
        dueDate: hojeBR(),
        description: 'Assinatura Mensal FinZap SaaS',
        externalReference: userId
      })
    });

    const cobranca = await cobrancaRes.json();
    if (!cobranca.invoiceUrl) {
      console.error('Asaas: falha ao criar cobrança', cobranca);
      return res.status(502).json({ error: 'Erro ao gerar cobrança no Asaas' });
    }
    res.json({ invoiceUrl: cobranca.invoiceUrl, id: cobranca.id });
  } catch (error) {
    console.error('Erro em /asaas/gerar-cobranca:', error);
    res.status(500).json({ error: 'Erro ao gerar cobrança no Asaas' });
  }
});

app.post('/webhook/asaas', async (req, res) => {
  // 1) Só o Asaas conhece este token (configure o mesmo valor no painel do Asaas, em Webhooks)
  if (!process.env.ASAAS_WEBHOOK_TOKEN) {
    console.error('❌ ASAAS_WEBHOOK_TOKEN não configurado: webhook recusado.');
    return res.status(503).send('Webhook indisponível');
  }
  if (!compararSegredo(req.headers['asaas-access-token'], process.env.ASAAS_WEBHOOK_TOKEN)) {
    return res.status(401).send('Não autorizado');
  }

  try {
    const { event, payment } = req.body || {};

    if ((event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') && payment?.id) {
      // 2) Não confia no corpo do webhook: confirma o pagamento direto na API do Asaas
      const confirmRes = await fetch(`${ASAAS_API_URL}/payments/${encodeURIComponent(payment.id)}`, {
        headers: { 'access_token': ASAAS_API_KEY }
      });
      if (!confirmRes.ok) {
        console.error('Asaas: não foi possível confirmar o pagamento', payment.id, confirmRes.status);
        return res.status(502).send('Falha ao confirmar pagamento');
      }
      const pagamento = await confirmRes.json();

      const userId = pagamento.externalReference;
      const statusOk = STATUS_PAGAMENTO_OK.includes(pagamento.status);
      const valorOk = Number(pagamento.value) >= VALOR_PLANO;

      if (userId && statusOk && valorOk) {
        const userRef = db.collection('users').doc(userId);
        await db.runTransaction(async (t) => {
          const userSnap = await t.get(userRef);
          if (!userSnap.exists) return;
          const dados = userSnap.data();

          // O Asaas pode avisar duas vezes o mesmo pagamento (confirmado e recebido): conta só uma vez
          if (dados.ultimo_pagamento_id === pagamento.id) return;

          // Soma 30 dias a partir do fim do acesso atual (se ainda válido) ou de hoje
          const atual = dados.acesso_ate?.toDate ? dados.acesso_ate.toDate() : null;
          const base = atual && atual.getTime() > Date.now() ? atual : new Date();
          const novoFim = new Date(base.getTime() + 30 * UM_DIA_MS);

          t.set(userRef, {
            status_assinatura: 'ATIVO',
            acesso_ate: admin.firestore.Timestamp.fromDate(novoFim),
            plano_validade: novoFim.toISOString().split('T')[0],
            ultimo_pagamento_id: pagamento.id
          }, { merge: true });
        });
      } else {
        console.warn('Webhook Asaas ignorado (dados não conferem):', pagamento.id, pagamento.status);
      }
    }

    res.status(200).send('Webhook processado com sucesso');
  } catch (error) {
    console.error('Erro no webhook do Asaas:', error);
    res.status(500).send('Erro ao processar webhook');
  }
});

// Dispara para TODOS os usuários: só para uso interno (cron), nunca pelo navegador
app.get('/verificar-alertas', validarChaveInterna, async (req, res) => {
  await verificarAlertasVencimento(true);
  res.status(200).send('OK - Alertas verificados');
});

// Teste de alerta: só para o próprio usuário logado
app.post('/whatsapp/testar-alerta', autenticarUsuario, async (req, res) => {
  await verificarAlertasVencimento(true, req.uid);
  res.json({ ok: true });
});

app.post(['/conectar', '/whatsapp/iniciar'], autenticarUsuario, async (req, res) => {
  const userId = req.uid;
  if (!(await verificarAcessoAtivo(userId))) {
    return res.status(402).json({ error: 'Assinatura necessária para conectar o WhatsApp.' });
  }

  try {
    // Tira a conexão antiga do mapa ANTES de encerrá-la, para o evento de "fechou" dela ser ignorado
    const sockAntigo = sessions.get(userId);
    sessions.delete(userId);
    geracaoSessao.set(userId, (geracaoSessao.get(userId) || 0) + 1);
    tentativasReconexao.delete(userId);
    tentativas405.delete(userId);
    if (sockAntigo) {
      try { sockAntigo.end(undefined); } catch (e) {}
    }

    limparPastaSessaoLocal(userId);
    await db.collection('users').doc(userId).set({ whatsapp_erro: null, whatsapp_qrcode: null, whatsapp_qr_em: null }, { merge: true }).catch(() => {});
    startWhatsAppForUser(userId, true);
    res.json({ ok: true, message: 'Gerando novo QR Code...' });
  } catch (err) {
    console.error('Erro na rota /conectar:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post(['/desconectar', '/whatsapp/desconectar'], autenticarUsuario, async (req, res) => {
  const userId = req.uid;

  const sock = sessions.get(userId);
  sessions.delete(userId);
  geracaoSessao.set(userId, (geracaoSessao.get(userId) || 0) + 1);
  tentativasReconexao.delete(userId);
  tentativas405.delete(userId);
  if (sock) {
    try { await sock.logout(); } catch (e) {}
  }

  limparPastaSessaoLocal(userId);

  await db.collection('users').doc(userId).set({
    whatsapp_status: 'DISCONNECTED',
    whatsapp_qrcode: null,
    whatsapp_erro: null
  }, { merge: true }).catch(() => {});

  res.json({ ok: true });
});

// ============================================================================
// 2. INICIALIZAÇÃO DO SOCKET DO WHATSAPP (COM VOLUME LOCAL - ZERO FIRESTORE)
// ============================================================================
async function startWhatsAppForUser(userId, forcarVersaoNova = false) {
  try {
    console.log(`⚡ A iniciar instância WhatsApp (Volume Local) para userId: ${userId}`);
    
    const userAuthDir = path.join(AUTH_BASE_DIR, `session_${userId}`);
    if (!fs.existsSync(userAuthDir)) {
      fs.mkdirSync(userAuthDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(userAuthDir);
    const { version, origem: origemVersao } = await obterVersaoWhatsApp(forcarVersaoNova);
    console.log(`📦 Versão do WhatsApp para ${userId}: ${version ? version.join('.') : 'padrão'} (${origemVersao})`);
    const sessaoPareada = !!state.creds?.registered;

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: process.env.WA_LOG_LEVEL || 'warn' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
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

    const anterior = sessions.get(userId);
    sessions.set(userId, sock);
    if (anterior && anterior !== sock) {
      try { anterior.end(undefined); } catch (e) {}
    }
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const userRef = db.collection('users').doc(userId);

      if (qr) {
        console.log(`📱 QR Code gerado para ${userId}`);
        const qrBase64 = await QRCode.toDataURL(qr);
        await userRef.set({
          whatsapp_status: 'WAITING_QR',
          whatsapp_qrcode: qrBase64,
          whatsapp_qr_em: Date.now(),
          whatsapp_erro: null
        }, { merge: true }).catch(() => {});
      }

      if (connection === 'open') {
        const meJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (meJid) userJids.set(userId, meJid);

        await userRef.set({
          whatsapp_status: 'CONNECTED',
          whatsapp_qrcode: null,
          whatsapp_qr_em: null,
          whatsapp_jid: meJid,
          whatsapp_erro: null
        }, { merge: true }).catch(() => {});
        tentativasReconexao.delete(userId);
        tentativas405.delete(userId);
        console.log(`✅ WhatsApp CONECTADO para: ${userId} (${meJid})`);
      }

      if (connection === 'close') {
        // Conexão antiga ou substituída (ex.: o usuário pediu um novo QR): ignora, quem vale é a atual
        if (sessions.get(userId) !== sock) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const detalhe = lastDisconnect?.error?.message || '';
        console.log(`🔌 Conexão de ${userId} fechou (código ${statusCode ?? 'sem código'}${detalhe ? `: ${detalhe}` : ''})`);
        const foiDeslogado = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        // A conexão que gerou o QR da tela morreu: tira o QR para ninguém escanear um QR "morto"
        // (o celular responde "Não foi possível conectar o dispositivo")
        if (!foiDeslogado) {
          await userRef.set({ whatsapp_qrcode: null, whatsapp_qr_em: null }, { merge: true }).catch(() => {});
        }

        if (foiDeslogado) {
          console.log(`🛑 Sessão encerrada/deslogada para ${userId}. Limpando arquivos.`);
          limparPastaSessaoLocal(userId);
          sessions.delete(userId);
          tentativasReconexao.delete(userId);
          await userRef.set({
            whatsapp_status: 'DISCONNECTED',
            whatsapp_qrcode: null,
            whatsapp_erro: null
          }, { merge: true }).catch(() => {});

        } else if (statusCode === DisconnectReason.connectionReplaced) {
          // Outra instância/aparelho assumiu a sessão: reconectar só criaria uma briga entre as duas
          console.warn(`⚠️ Sessão de ${userId} foi aberta em outro lugar (440).`);
          sessions.delete(userId);
          await registrarErroWhatsApp(userId, 'O WhatsApp foi aberto em outro lugar e esta conexão foi encerrada. Gere um novo QR Code para reconectar.');

        } else if (statusCode === 405) {
          // WhatsApp recusou a versão: tenta uma vez com a versão buscada ao vivo; depois desiste (sem martelar o servidor deles)
          const n = (tentativas405.get(userId) || 0) + 1;
          tentativas405.set(userId, n);
          if (n <= 1) {
            console.warn(`⚠️ WhatsApp recusou a versão (405) para ${userId}. Nova tentativa com a versão atual em 3s...`);
            agendarReconexao(userId, 3000, true);
          } else {
            console.error(`❌ Erro 405 persistente para ${userId} (${detalhe}). Atualize o Baileys ou defina WA_VERSION no servidor.`);
            sessions.delete(userId);
            await registrarErroWhatsApp(userId, 'O WhatsApp recusou a conexão agora (erro 405). Tente novamente em alguns minutos.');
          }

        } else if (statusCode === DisconnectReason.restartRequired) {
          // Normal logo depois de ler o QR: a conexão precisa reiniciar
          agendarReconexao(userId, 1000);

        } else {
          const n = (tentativasReconexao.get(userId) || 0) + 1;
          tentativasReconexao.set(userId, n);

          if (!sessaoPareada && n > 6) {
            console.warn(`⚠️ Desistindo de conectar ${userId} após ${n - 1} tentativas (Código: ${statusCode}).`);
            sessions.delete(userId);
            await registrarErroWhatsApp(userId, 'Não foi possível concluir a conexão. Clique em "Gerar QR Code" para tentar de novo.');
          } else {
            // Aparelho já pareado: continua tentando para sempre, com espera crescente (máx. 60s)
            const espera = Math.min(5000 * 2 ** (n - 1), 60000);
            console.log(`🔄 Reconectando WhatsApp de ${userId} em ${Math.round(espera / 1000)}s (Código: ${statusCode}, tentativa ${n})...`);
            agendarReconexao(userId, espera);
          }
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

      if (!(await verificarAcessoAtivo(userId))) {
        await sock.sendMessage(remoteJid, {
          text: '⏳ Seu período de teste terminou. Assine o FinZap Pro no site para continuar lançando pelo WhatsApp.'
        });
        return;
      }

      await processarMensagemInteligente(userId, texto, sock, remoteJid);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp:', err);
  }
}

// ============================================================================
// 3. ALERTA AUTOMÁTICO NO WHATSAPP
// ============================================================================
async function verificarAlertasVencimento(forcarDisparoManual = false, apenasUserId = null) {
  try {
    const agora = new Date();
    const brTime = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
    const diaHoje = brTime.getUTCDate();
    const horaAtual = brTime.getUTCHours();
    const dataHojeStr = brTime.toISOString().split('T')[0];
    const anoMesAtual = dataHojeStr.slice(0, 7);

    if (!forcarDisparoManual && horaAtual < 8) return;

    let docsUsuarios;
    if (apenasUserId) {
      const unico = await db.collection('users').doc(apenasUserId).get();
      docsUsuarios = unico.exists && unico.data().whatsapp_status === 'CONNECTED' ? [unico] : [];
    } else {
      const usersSnap = await db.collection('users')
        .where('whatsapp_status', '==', 'CONNECTED')
        .get();
      docsUsuarios = usersSnap.docs;
    }

    docsUsuarios = docsUsuarios.filter(d => temAcessoAtivo(d.data()));

    for (const userDoc of docsUsuarios) {
      const userId = userDoc.id;
      const userData = userDoc.data();

      if (!forcarDisparoManual && userData.ultimo_alerta_data === dataHojeStr) continue;

      const sock = sessions.get(userId);
      const remoteJid = userJids.get(userId) || userData.whatsapp_jid;
      if (!sock || !remoteJid) continue;

      const contasFixas = userData.contas_fixas || userData.contasFixas || [];
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
            avisos.push(`• *${cf.nome} (Conta Fixa) — R$ ${Number(cf.valorPadrao || 0).toFixed(2)}*`);
          }
        }
      }

      const agendadasHoje = transMes.filter(
        t => t.pago === false && t.data_vencimento === dataHojeStr
      );
      for (const ag of agendadasHoje) {
        avisos.push(`• *${ag.descricao} (${ag.tipo === 'RECEITA' ? 'A Receber' : 'A Pagar'}) — R$ ${Number(ag.valor || 0).toFixed(2)}*`);
      }

      for (const c of cartoes) {
        if (Number(c.diaVencimento) === diaHoje) {
          const faturaMes = transMes
            .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(c.nome) && !t.fatura_paga)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          if (faturaMes > 0) {
            avisos.push(`• *Fatura Cartão ${c.nome} — R$ ${faturaMes.toFixed(2)}*`);
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
// 4. EXTRAÇÃO INTELIGENTE DE DADOS
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

  // PRIORIDADE 1: Compras Online e E-commerce
  if (/mercado livre|shopee|amazon|shein|aliexpress|magalu|magazine|americanas/i.test(pLimpo)) {
    return { categoria: 'Outros', subcategoria: 'Compras Online', reconhecida: true };
  }

  // PRIORIDADE 2: Alimentação
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
// 5. GRAVAÇÃO NO FIRESTORE COM GRUPO DE PARCELAS E DATAS AVANÇADAS
// ============================================================================
async function gravarItensNoBanco(userId, itens, cartoes, bancos, orcamentos, anoMesPadrao, textoOriginal) {
  const hojeStr = hojeBR();
  let respostas = [];

  const snapAll = await db.collection('users').doc(userId).collection('transacoes').get();
  const todasTransacoes = snapAll.docs.map(d => d.data());

  for (const item of itens) {
    const parcelasTotal = item.parcelasTotal || 1;
    const valorParcela = Number(item.valorParcela);
    const isAgendado = item.pago === false;
    const catFinal = item.categoria || 'Outros';
    const subFinal = item.subcategoria || 'Geral';
    const grupoId = `compra_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    await salvarRegraAprendida(userId, item.descricao, catFinal, subFinal);

    const isCredito = item.metodo === 'CREDITO';
    const cartaoObj = isCredito ? cartoes.find(c => semAcento(c.nome) === semAcento(item.cartao_nome || '')) : null;
    const diaFech = cartaoObj ? (cartaoObj.diaFechamento || 5) : 5;
    const diaVencCartao = cartaoObj ? (cartaoObj.diaVencimento || 12) : 12;

    const dataReferencia = new Date((item.data_vencimento || hojeStr) + 'T12:00:00');
    let diaVenc = dataReferencia.getDate();
    let mesVenc = dataReferencia.getMonth();
    let anoVenc = dataReferencia.getFullYear();

    if (dataReferencia < new Date(hojeStr + 'T00:00:00') && !isCredito) {
      mesVenc += 1;
    }

    let primeiraFatura = null;
    for (let i = 0; i < parcelasTotal; i++) {
      let anoMesItem = item.anoMes || anoMesPadrao;
      let dataVencItem = item.data_vencimento || hojeStr;

      if (isCredito) {
        const fatura = calcularDataFaturaCartao(item.data_vencimento || hojeStr, diaFech, diaVencCartao, i + 1);
        anoMesItem = fatura.anoMes;
        dataVencItem = fatura.dataVencimento;
        if (i === 0) primeiraFatura = fatura;
      } else if (parcelasTotal > 1) {
        const dataParcela = new Date(anoVenc, mesVenc + i, diaVenc);
        anoMesItem = `${dataParcela.getFullYear()}-${String(dataParcela.getMonth() + 1).padStart(2, '0')}`;
        dataVencItem = `${anoMesItem}-${String(dataParcela.getDate()).padStart(2, '0')}`;
      }

      let statusPago = item.pago !== undefined ? item.pago : true;
      if (parcelasTotal > 1 && !isCredito) {
        statusPago = false; 
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
        grupo_id: parcelasTotal > 1 ? grupoId : null,
        fatura_paga: false,
        pago: statusPago,
        data_vencimento: dataVencItem,
        anoMes: anoMesItem,
        // Data da compra no crédito: o site usa este campo para recalcular a fatura
        ...(isCredito ? { data_compra: item.data_vencimento || hojeStr } : {}),
        origem: 'WHATSAPP_IA',
        mensagem_original: textoOriginal,
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('users').doc(userId).collection('transacoes').add(novoDoc);
      todasTransacoes.push(novoDoc);
    }

    if (isAgendado || (parcelasTotal > 1 && !isCredito)) {
      respostas.push(
        `📅 *Conta Lançada (${item.tipo === 'RECEITA' ? 'A Receber' : 'A Vencer'})*\n` +
        `• *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
        `• Valor: *R$ ${valorParcela.toFixed(2)}*\n` +
        `• Primeiro Vencimento: *${diaVenc}/${String(mesVenc + 1).padStart(2, '0')}/${anoVenc}*`
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

    if (isCredito && cartaoObj) {
      if (Number(cartaoObj.limite) > 0) {
        const gastoAcumuladoCartao = todasTransacoes
          .filter(t => t.tipo === 'DESPESA' && semAcento(t.cartao_nome) === semAcento(cartaoObj.nome) && !t.fatura_paga && t.anoMes >= anoMesPadrao)
          .reduce((a, b) => a + Number(b.valor || 0), 0);

        const limiteTotal = Number(cartaoObj.limite);
        const disponivel = limiteTotal - gastoAcumuladoCartao;
        const pctCartao = Math.round((gastoAcumuladoCartao / limiteTotal) * 100);

        if (pctCartao >= 100) alertasExtras += `\n🚨 *ALERTA:* O limite do *${cartaoObj.nome}* estourou!`;
        else if (pctCartao >= 80) alertasExtras += `\n⚠️ *Alerta de Limite (${cartaoObj.nome}):* ${pctCartao}% comprometido!`;
        else alertasExtras += `\n💳 _Disponível no ${cartaoObj.nome}: R$ ${disponivel.toFixed(2)}_`;
      }
    }

    if (!isCredito && item.banco_nome) {
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

    const origemPagamento = isCredito ? `Cartão ${item.cartao_nome}` : item.banco_nome ? `${item.metodo} (${item.banco_nome})` : item.metodo;

    const infoFatura = isCredito && primeiraFatura
      ? `\n🧾 _${parcelasTotal > 1 ? `1ª parcela na fatura` : 'Fatura'} ${primeiraFatura.anoMes.split('-')[1]}/${primeiraFatura.anoMes.split('-')[0]} · vence em ${formatarDataBR(primeiraFatura.dataVencimento)}_`
      : '';

    respostas.push(
      `🧠 *[Aprendido]* ✅ *${item.descricao}* [${catFinal} > ${subFinal}]\n` +
      `💰 R$ ${valorParcela.toFixed(2)} - ${origemPagamento}${infoFatura}${alertasExtras}`
    );
  }

  return respostas;
}

// ============================================================================
// 6. FILA DE PENDÊNCIAS COM PERGUNTA DE DATA
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
    const precisaData = item.precisaPerguntarData;

    if (!precisaMetodo && !precisaBanco && !precisaCategoria && !precisaData) {
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

    if (primeiro.precisaPerguntarData) {
      etapa = 'DATA';
      textoPergunta = `📅 *Qual a data do primeiro vencimento?*\n${resumoPendentes}\n\nResponda com o dia (ex: *dia 20*) ou a data (ex: *20/11*).`;
    } else if (!primeiro.metodo && primeiro.pago !== false) {
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
// 7. MOTOR DE INTELIGÊNCIA FINANCEIRA COMPLETO
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

    const txtLimpo = semAcento(textoUsuario).trim().toLowerCase();
    const hoje = new Date();
    const hojeStr = hojeBR();
    const anoMesAtual = hojeStr.slice(0, 7);

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
        const bancoEscolhido = bancos.find(b => {
          const nBanco = semAcento(b.nome).toLowerCase();
          return txtLimpo.includes(nBanco) || nBanco.includes(txtLimpo);
        }) || bancos[0];
        
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

        if (pendente.etapa === 'DATA') {
          const infoVenc = extrairDataVencimento(textoUsuario) || extrairDataVencimento(`dia ${textoUsuario.replace(/\D/g, '')}`);
          if (infoVenc && infoVenc.dataVencimento) {
            itensAtualizados = itensAtualizados.map(it => ({
              ...it,
              data_vencimento: infoVenc.dataVencimento,
              anoMes: infoVenc.anoMes,
              precisaPerguntarData: false
            }));
            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, pendente.textoOriginal, sock, remoteJid);
            return;
          }
        } else if (pendente.etapa === 'METODO') {
          let metodoResp = null;
          let cartaoResp = null;
          let bancoResp = null;

          // Aceita o nome completo ou parte dele ("cartão infiniti", "c6"), sem confundir com "pix c6"
          const citouOutroMetodo = /\b(pix|debito|dinheiro)\b/.test(txtLimpo);
          const achadoCartaoResp = acharCartaoNoTexto(txtLimpo, cartoes, !citouOutroMetodo || /cartao|credito/.test(txtLimpo));
          if (achadoCartaoResp.cartao) { metodoResp = 'CREDITO'; cartaoResp = achadoCartaoResp.cartao.nome; }
          for (const b of bancos) {
            const nBanco = semAcento(b.nome).toLowerCase();
            if (txtLimpo.includes(nBanco) || nBanco.includes(txtLimpo)) {
              bancoResp = b.nome;
              if (!metodoResp) metodoResp = /debito/i.test(txtLimpo) ? 'DEBITO' : 'PIX';
              break;
            }
          }
          if (!metodoResp) {
            if (/credito|cartao/i.test(txtLimpo)) {
              if (cartoes.length <= 1) { metodoResp = 'CREDITO'; cartaoResp = cartoes[0]?.nome || 'CREDITO'; }
            }
            else if (/debito/i.test(txtLimpo)) metodoResp = 'DEBITO';
            else if (/pix/i.test(txtLimpo)) metodoResp = 'PIX';
            else if (/dinheiro/i.test(txtLimpo)) metodoResp = 'DINHEIRO';
          }

          if (metodoResp) {
            // A pessoa pode responder junto a categoria: "Cartão infiniti. Categoria Sistema"
            const matchCatMsg = textoUsuario.match(/categoria\s*[:\-]?\s*([^.\n]+)/i);
            let catMsg = null;
            if (matchCatMsg) {
              const catTxt = matchCatMsg[1].trim();
              const existente = (categorias || []).find(c => semAcento(String(c)) === semAcento(catTxt));
              catMsg = existente ? String(existente) : catTxt.charAt(0).toUpperCase() + catTxt.slice(1);
            }

            itensAtualizados = itensAtualizados.map(it => ({
              ...it,
              metodo: metodoResp,
              cartao_nome: cartaoResp,
              banco_nome: metodoResp === 'CREDITO' ? null : (bancoResp || it.banco_nome || null),
              ...(catMsg ? { categoria: catMsg, subcategoria: 'Geral', precisaPerguntarCategoria: false } : {}),
              pago: true
            }));
            await processarFilaDePendencias(userId, itensAtualizados, cartoes, bancos, orcamentos, anoMesAtual, `${pendente.textoOriginal} (${textoUsuario})`, sock, remoteJid);
            return;
          }

          // Resposta sem número que não deu para entender: pergunta de novo em vez de ficar em silêncio
          if (!/\d/.test(txtLimpo)) {
            await enviarMensagemSegura(sock, remoteJid, {
              text: `🤔 Não entendi a forma de pagamento. Responda com *Pix*, *Débito*, *Dinheiro* ou o nome do cartão (*${cartoes.map(c => c.nome).join(', ')}*).`
            });
            return;
          }
        } else if (pendente.etapa === 'BANCO') {
          const bEnc = bancos.find(b => {
            const nBanco = semAcento(b.nome).toLowerCase();
            return txtLimpo.includes(nBanco) || nBanco.includes(txtLimpo);
          }) || bancos[0];
          
          if (bEnc) {
            itensAtualizados = itensAtualizados.map(it => ({ ...it, banco_nome: bEnc.nome }));
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
          const encontrados = bancos.filter(b => txtLimpo.includes(semAcento(b.nome).toLowerCase()));
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

    // Dar baixa em contas
    const isComandoBaixa = /^(paguei|dar baixa|baixa|quitei|pagar fatura)/i.test(txtLimpo) && !/\b\d+[,\.]\d{2}\b/.test(textoUsuario);
    if (isComandoBaixa) {
      const snapMes = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
      const transMes = snapMes.docs.map(d => ({ id: d.id, ...d.data() }));
      const bancoInformado = bancos.find(b => txtLimpo.includes(semAcento(b.nome).toLowerCase()));

      if (/fatura/i.test(txtLimpo)) {
        const cartaoAlvo = acharCartaoNoTexto(txtLimpo, cartoes, true).cartao || cartoes[0];
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
      const contaEncontrada = contasAbertas.find(t => txtLimpo.includes(semAcento(t.descricao).toLowerCase()));
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

    const snapMesGeral = await db.collection('users').doc(userId).collection('transacoes').where('anoMes', '==', anoMesAtual).get();
    const transacoesFiltradas = snapMesGeral.docs.map(d => d.data());

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

    const isPergunta = /\?|quanto|qual|resumo|saldo|saldos|fatura|limite/i.test(txtLimpo) && !/gastei|comprei|paguei|recebi|vence/i.test(txtLimpo);
    if (isPergunta) {
      const transMes = transacoesFiltradas;
      const rec = transMes.filter(t => t.tipo === 'RECEITA' && t.pago !== false).reduce((a, b) => a + Number(b.valor || 0), 0);
      const desp = transMes.filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'PAGAMENTO_FATURA').reduce((a, b) => a + Number(b.valor || 0), 0);
      const resultadoFinal = rec - desp;
      await enviarMensagemSegura(sock, remoteJid, { 
        text: `📊 *Resumo FinZap (${anoMesAtual})*\n🟢 Receitas: R$ ${rec.toFixed(2)}\n🔴 Despesas: R$ ${desp.toFixed(2)}\n💰 *Resultado: R$ ${resultadoFinal.toFixed(2)}*` 
      });
      return;
    }

    // Lançamentos normais com aprendizado
    let textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
    const partes = textoNormalizado.split(/(?:,|\s+e\s+)/gi).map(p => p.trim()).filter(Boolean);
    let itensExtraidos = [];

    for (const parte of partes) {
      const pLimpo = semAcento(parte).toLowerCase();
      const infoVenc = extrairDataVencimento(parte);
      const vencimentoExplicito = /\b(vence|vencimento|a pagar|a receber)\b/i.test(pLimpo);
      let isAgendado = Boolean(infoVenc) || vencimentoExplicito;
      const parteSemData = infoVenc ? parte.replace(infoVenc.trechoRemovido, ' ') : parte;
      const matchValor = parteSemData.match(/(\d+\.\d{2}|\d+)/);
      if (!matchValor) continue;

      const valorTotal = parseFloat(matchValor[0]);
      if (isNaN(valorTotal) || valorTotal <= 0) continue;

      const isReceita = /\b(recebi|ganhei|salario|venda|a receber)\b/i.test(pLimpo);
      let metodo = null;
      let cartaoNome = null;
      let bancoNome = null;

      // Reconhece o cartão pelo nome completo ou por partes dele ("cartão infiniti", "c6")
      const falouCartao = /cartao|credito/.test(pLimpo);
      const achadoCartao = acharCartaoNoTexto(pLimpo, cartoes, falouCartao);
      if (achadoCartao.cartao) { metodo = 'CREDITO'; cartaoNome = achadoCartao.cartao.nome; }

      if (metodo !== 'CREDITO') {
        for (const b of bancos) {
          const nBanco = semAcento(b.nome).toLowerCase();
          if (pLimpo.includes(nBanco) || nBanco.includes(pLimpo)) { bancoNome = b.nome; if (!metodo) metodo = /debito/i.test(pLimpo) ? 'DEBITO' : 'PIX'; break; }
        }
      }

      if (!metodo) {
        if (/credito|cartao/i.test(pLimpo)) {
          // Com vários cartões e nenhum identificado, deixa em branco: o robô pergunta qual
          if (cartoes.length <= 1) { metodo = 'CREDITO'; cartaoNome = cartoes[0]?.nome || 'CREDITO'; }
        }
        else if (/debito/i.test(pLimpo)) metodo = 'DEBITO';
        else if (/pix/i.test(pLimpo)) metodo = 'PIX';
        else if (/dinheiro/i.test(pLimpo)) metodo = 'DINHEIRO';
      }

      let descricao = parteSemData.replace(/\b(comprei|gastei|paguei|no pix|no debito|pix|debito|reais|r\$|de|do|da|no|na|em)\b/gi, ' ').replace(matchValor[0], '').trim();
      descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

      // No cartão de crédito a data informada é a data da COMPRA (a fatura sai do fechamento do cartão),
      // a menos que a pessoa diga "vence"/"a pagar"
      if (metodo === 'CREDITO' && !vencimentoExplicito) isAgendado = false;

      if (metodo === 'CREDITO') {
        // Tira "cartão", "crédito" e o nome do cartão da descrição ("Gasolina cartão infiniti" -> "Gasolina")
        const palavrasCartao = new Set(['cartao', 'credito', ...tokensDe(cartaoNome || '')]);
        const semPalavras = descricao
          .split(/\s+/)
          .filter(w => !palavrasCartao.has(semAcento(w).replace(/[^a-z0-9]/g, '')))
          .join(' ')
          .trim();
        if (semPalavras) descricao = semPalavras.charAt(0).toUpperCase() + semPalavras.slice(1);
      }

      const regraSalva = await consultarRegraAprendida(userId, descricao);
      let cat = regraSalva ? regraSalva.categoria : null;
      let sub = regraSalva ? regraSalva.subcategoria : null;

      if (!cat) {
        const classif = classificarCategoriaESubcategoria(pLimpo, isReceita, categorias, subcategorias);
        cat = classif.categoria;
        sub = classif.subcategoria;
      }

      const matchParcelas = pLimpo.match(/(\d+)\s*(?:x|vezes|parcelas)/);
      const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;
      const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;

      itensExtraidos.push({
        descricao,
        valorTotal,
        valorParcela: valorParcela,
        parcelasTotal: parcelasTotal,
        tipo: isReceita ? 'RECEITA' : 'DESPESA',
        metodo,
        cartao_nome: cartaoNome,
        banco_nome: bancoNome,
        categoria: cat,
        subcategoria: sub,
        precisaPerguntarCategoria: !cat,
        precisaPerguntarData: ((parcelasTotal > 1 && metodo !== 'CREDITO') || isAgendado) && !infoVenc,
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
    const orfaos = await db.collection('users').where('whatsapp_status', '==', 'WAITING_QR').get();
    orfaos.forEach(doc => {
      doc.ref.set({ whatsapp_status: 'DISCONNECTED', whatsapp_qrcode: null, whatsapp_qr_em: null }, { merge: true }).catch(() => {});
    });

    const usersSnap = await db.collection('users').where('whatsapp_status', '==', 'CONNECTED').get();
    usersSnap.forEach(doc => {
      const userAuthDir = path.join(AUTH_BASE_DIR, `session_${doc.id}`);
      if (fs.existsSync(userAuthDir)) {
        startWhatsAppForUser(doc.id);
      } else {
        doc.ref.set({ whatsapp_status: 'DISCONNECTED', whatsapp_qrcode: null }, { merge: true }).catch(() => {});
      }
    });
  } catch (err) {
    console.error('Erro ao restaurar sessões ativas:', err);
  }
}

app.use((err, req, res, next) => {
  if (err?.message === 'Origem não permitida pelo CORS') {
    return res.status(403).json({ error: 'Origem não permitida.' });
  }
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT} | Auth Dir: ${AUTH_BASE_DIR} | build ${BUILD_ID}`);
  if (!process.env.ASAAS_WEBHOOK_TOKEN) console.warn('⚠️ ASAAS_WEBHOOK_TOKEN não definido: o webhook do Asaas será recusado.');
  if (!process.env.ASAAS_API_KEY) console.warn('⚠️ ASAAS_API_KEY não definido: cobranças ficam indisponíveis.');
  restaurarSessoesAtivas();
});