import React, { useState, useEffect } from 'react';
import { 
  Wallet, TrendingUp, TrendingDown, CreditCard, MessageSquare, 
  Plus, Trash2, QrCode, Send, LogOut, BarChart2, Calendar, 
  FolderPlus, Target, AlertTriangle, Sparkles, CheckCircle2, 
  Clock, Zap, BrainCircuit, RefreshCw, Landmark, 
  Edit3, X, ShieldAlert, Search, FileText, BellRing, 
  ArrowRightLeft, ChevronLeft, ChevronRight
} from 'lucide-react';
import { db, auth } from './firebaseConfig';
import { 
  collection, addDoc, onSnapshot, deleteDoc, updateDoc, doc, 
  query, orderBy, serverTimestamp, setDoc, getDoc,
  writeBatch, where, getDocs 
} from 'firebase/firestore';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, 
  PieChart, Pie, Cell 
} from 'recharts';

const RENDER_API_URL = 'https://financeiro-saas-production-66cc.up.railway.app';
const API_SECRET_KEY = import.meta.env.VITE_API_SECRET_KEY || 'FinZapKey2026';

const formatarDataBR = (isoDate) => {
  if (!isoDate || !isoDate.includes('-')) return isoDate || '-';
  const [a, m, d] = isoDate.split('-');
  return `${d}/${m}/${a}`;
};

const classificarCategoriaLocal = (texto, isReceita, categorias, subcategoriasMap) => {
  const pLimpo = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (isReceita) return { categoria: 'Receita', subcategoria: 'Salário / Vendas', reconhecida: true };

  // PRIORIDADE 1: Compras Online e E-commerce (Impede conflito com a palavra "mercado")
  if (/mercado livre|shopee|amazon|shein|aliexpress|magalu|magazine|americanas/i.test(pLimpo)) {
    return { categoria: 'Outros', subcategoria: 'Compras Online', reconhecida: true };
  }

  // PRIORIDADE 2: Mercado e Alimentação
  if (/mercado|supermercado|atacadao|compras|feira|acougue|hortifruti|maca|banana|fruta|verdura|legume|cebola|alho|tomate|batata|arroz|feijao|macarrao|carne|frango|ovo|leite|pao|queijo|sabao|detergente/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Mercado', reconhecida: true };
  }
  if (/lanche|hamburguer|burger|pizza|restaurante|ifood|padaria|almoco|jantar|cafe|sorvete|acai|pastel|barzinho|cerveja|refrigerante|bolo|chocolate/i.test(pLimpo)) {
    return { categoria: 'Alimentação', subcategoria: 'Lazer', reconhecida: true };
  }
  if (/uber|99|taxi|onibus|estacionamento|pedagio/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Apps / Pedágio', reconhecida: true };
  }
  if (/gasolina|etanol|diesel|combustivel|posto/i.test(pLimpo)) {
    return { categoria: 'Transporte', subcategoria: 'Combustível', reconhecida: true };
  }
  if (/cinema|passeio|show|viagem|shopping|netflix|spotify|streaming/i.test(pLimpo)) {
    return { categoria: 'Lazer', subcategoria: 'Passeios / Streaming', reconhecida: true };
  }
  if (/luz|energia|agua|gas|internet|telefone|aluguel|condominio|boleto|farmacia|remedio|medico/i.test(pLimpo)) {
    return { categoria: 'Contas', subcategoria: 'Casa / Fixas', reconhecida: true };
  }

  for (const cat of categorias) {
    const subs = subcategoriasMap[cat] || [];
    for (const sub of subs) {
      if (pLimpo.includes(sub.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) {
        return { categoria: cat, subcategoria: sub, reconhecida: true };
      }
    }
    if (pLimpo.includes(cat.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) {
      return { categoria: cat, subcategoria: subs[0] || 'Geral', reconhecida: true };
    }
  }

  return { categoria: null, subcategoria: null, reconhecida: false };
};

export default function App() {
  const [user, setUser] = useState(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [emailInput, setEmailInput] = useState('');
  const [senhaInput, setSenhaInput] = useState('');
  const [erroAuth, setErroAuth] = useState('');

  const [abaAtiva, setAbaAtiva] = useState('dashboard');
  const [transacoes, setTransacoes] = useState([]);

  // Cartões de Crédito
  const [cartoes, setCartoes] = useState([
    { id: '1', nome: 'VISA', limite: 5000, diaFechamento: 5, diaVencimento: 12, banco: 'Itaú' },
    { id: '2', nome: 'NUBANK', limite: 3500, diaFechamento: 10, diaVencimento: 17, banco: 'Nubank Conta' }
  ]);

  // Bancos e Contas (Saldos Individuais)
  const [bancos, setBancos] = useState([
    { id: 'b1', nome: 'Itaú', tipo: 'Conta Corrente / Débito', saldoInicial: 1500 },
    { id: 'b2', nome: 'Nubank Conta', tipo: 'Conta Digital / Pix', saldoInicial: 800 }
  ]);
  
  // Categorias e Subcategorias
  const [categorias, setCategorias] = useState(['Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros']);
  const [subcategorias, setSubcategorias] = useState({
    'Alimentação': ['Mercado', 'Lazer', 'Restaurante', 'Padaria'],
    'Transporte': ['Combustível', 'Apps / Pedágio', 'Manutenção'],
    'Lazer': ['Passeios', 'Streaming', 'Viagens'],
    'Contas': ['Casa / Fixas', 'Saúde / Farmácia', 'Fatura Cartão'],
    'Receita': ['Salário', 'Vendas / Extras'],
    'Outros': ['Geral']
  });
  const [orcamentos, setOrcamentos] = useState({});
  const [contasFixas, setContasFixas] = useState([
    { id: 'f1', nome: 'Energia Elétrica', valorPadrao: 180, diaVencimento: 15, categoria: 'Contas' },
    { id: 'f2', nome: 'Internet Fibra', valorPadrao: 120, diaVencimento: 10, categoria: 'Contas' }
  ]);

  const [whatsappStatus, setWhatsappStatus] = useState('DISCONNECTED');
  const [whatsappQrCode, setWhatsappQrCode] = useState(null);
  const [carregandoQr, setCarregandoQr] = useState(false);

  const dataAtualObj = new Date();
  const diaHoje = dataAtualObj.getDate();
  const hojeIso = dataAtualObj.toISOString().split('T')[0];
  const mesAtualStr = `${dataAtualObj.getFullYear()}-${String(dataAtualObj.getMonth() + 1).padStart(2, '0')}`;
  const [filtroMesAno, setFiltroMesAno] = useState(mesAtualStr);

  // Estados de Formulários
  const [novaCatNome, setNovaCatNome] = useState('');
  const [catSelecionadaParaSub, setCatSelecionadaParaSub] = useState('Alimentação');
  const [novaSubNome, setNovaSubNome] = useState('');
  const [orcamentoCat, setOrcamentoCat] = useState('');
  const [orcamentoValor, setOrcamentoValor] = useState('');
  const [fixaNome, setFixaNome] = useState('');
  const [fixaValor, setFixaValor] = useState('');
  const [fixaDia, setFixaDia] = useState('');

  const [cartaoForm, setCartaoForm] = useState({ id: null, nome: '', limite: '', diaFechamento: '5', diaVencimento: '12', banco: '' });
  const [bancoForm, setBancoForm] = useState({ id: null, nome: '', tipo: 'Conta Corrente / Débito', saldoInicial: '' });

  const [formTransferencia, setFormTransferencia] = useState({
    bancoOrigem: 'Itaú',
    bancoDestino: 'Nubank Conta',
    valor: '',
    data: hojeIso
  });

  const [formAgendamento, setFormAgendamento] = useState({
    descricao: '',
    valor: '',
    data_vencimento: hojeIso,
    tipo: 'DESPESA',
    categoria: 'Contas',
    subcategoria: 'Casa / Fixas',
    banco_nome: 'Itaú',
    pago: false
  });
  const [filtroVencNome, setFiltroVencNome] = useState('');
  const [filtroVencCat, setFiltroVencCat] = useState('TODAS');
  const [filtroVencStatus, setFiltroVencStatus] = useState('ABERTO');
  const [filtroVencData, setFiltroVencData] = useState('TODOS');

  const [modalBaixaConta, setModalBaixaConta] = useState(null);

  const [pesquisaExtrato, setPesquisaExtrato] = useState('');
  const [filtroTipoExtrato, setFiltroTipoExtrato] = useState('TODOS');

  // Controle do Gráfico Drill-down
  const [categoriaSelecionadaGrafico, setCategoriaSelecionadaGrafico] = useState(null);

  // Estados para Lançamento Flexível
  const [cartaoSelecionadoFatura, setCartaoSelecionadoFatura] = useState('TODOS');
  const [novaCompraCartao, setNovaCompraCartao] = useState({
    descricao: '',
    valorTotal: '',
    parcelas: '1',
    metodo: 'CREDITO', 
    cartaoNome: 'VISA',
    bancoNome: 'Itaú',
    categoria: 'Alimentação',
    subcategoria: 'Lazer'
  });
  
  const [modalPagarFatura, setModalPagarFatura] = useState(null);
  const [transacaoEditando, setTransacaoEditando] = useState(null);
  const [aplicarFuturasEdicao, setAplicarFuturasEdicao] = useState(false);
  
  const [transacaoExcluindo, setTransacaoExcluindo] = useState(null);
  const [aplicarFuturasExclusao, setAplicarFuturasExclusao] = useState(false);

  // Simulador de WhatsApp
  const [msgWhats, setMsgWhats] = useState('');
  const [pendenteSimulador, setPendenteSimulador] = useState(null);
  const [historicoChat, setHistoricoChat] = useState([
    { 
      autor: 'bot', 
      texto: '🤖 Olá! Sou seu Assistente Financeiro IA.\n\nNovidades integradas:\n1️⃣ "comprei maçã 5,00 no débito" -> Reconhece Alimentação > Mercado e pergunta de qual banco saiu!\n2️⃣ "comprei lanche 35,00" -> Vai para Alimentação > Lazer.\n3️⃣ "transferir 200 do Itaú para Nubank"\n4️⃣ "paguei a água" -> Dá baixa pelo WhatsApp.\n5️⃣ Envie "teste" para checar a conexão.' 
    }
  ]);
  const [processando, setProcessando] = useState(false);

  const CORES_GRAFICO = ['#34d399', '#38bdf8', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf', '#fb7185', '#60a5fa', '#94a3b8', '#c084fc'];

  const alterarMesCompetencia = (delta) => {
    const [ano, mes] = filtroMesAno.split('-').map(Number);
    const novaData = new Date(ano, (mes - 1) + delta, 15);
    const novoAno = novaData.getFullYear();
    const novoMes = String(novaData.getMonth() + 1).padStart(2, '0');
    setFiltroMesAno(`${novoAno}-${novoMes}`);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists()) {
          const dados = userSnap.data();
          if (dados.categorias) setCategorias(dados.categorias);
          if (dados.subcategorias) setSubcategorias(dados.subcategorias);
          if (dados.orcamentos) setOrcamentos(dados.orcamentos);
          if (dados.cartoes) setCartoes(dados.cartoes);
          if (dados.bancos) setBancos(dados.bancos);
          if (dados.contasFixas) setContasFixas(dados.contasFixas);
          if (dados.whatsapp_status) setWhatsappStatus(dados.whatsapp_status);
          if (dados.whatsapp_qrcode) setWhatsappQrCode(dados.whatsapp_qrcode);
        } else {
          await setDoc(userDocRef, { 
            categorias, 
            subcategorias,
            orcamentos: {}, 
            cartoes, 
            bancos,
            contasFixas,
            whatsapp_status: 'DISCONNECTED' 
          }, { merge: true });
        }
      }
      setCarregandoAuth(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setTransacoes([]);
      return;
    }

    const userDocRef = doc(db, 'users', user.uid);
    const unsubUser = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.whatsapp_status) setWhatsappStatus(data.whatsapp_status);
        if (data.whatsapp_qrcode !== undefined) setWhatsappQrCode(data.whatsapp_qrcode);
        if (data.cartoes) setCartoes(data.cartoes);
        if (data.bancos) setBancos(data.bancos);
        if (data.contasFixas) setContasFixas(data.contasFixas);
        if (data.subcategorias) setSubcategorias(data.subcategorias);
      }
    });

    const q = query(
      collection(db, 'users', user.uid, 'transacoes'),
      orderBy('criadoEm', 'desc')
    );

    const unsubTrans = onSnapshot(q, (snapshot) => {
      const lista = snapshot.docs.map(docSnap => {
        const dataDoc = docSnap.data();
        let anoMes = dataDoc.anoMes;
        let dataIso = dataDoc.data_vencimento;
        if (!anoMes && dataDoc.criadoEm) {
          const d = dataDoc.criadoEm.toDate ? dataDoc.criadoEm.toDate() : new Date();
          anoMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (!dataIso) dataIso = d.toISOString().split('T')[0];
        }
        return {
          id: docSnap.id,
          ...dataDoc,
          subcategoria: dataDoc.subcategoria || 'Geral',
          pago: dataDoc.pago !== undefined ? dataDoc.pago : true,
          data_vencimento: dataIso || `${anoMes || mesAtualStr}-10`,
          anoMes: anoMes || mesAtualStr
        };
      });
      setTransacoes(lista);
    });

    return () => {
      unsubUser();
      unsubTrans();
    };
  }, [user]);

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setErroAuth('');
    try {
      if (isLoginMode) {
        await signInWithEmailAndPassword(auth, emailInput, senhaInput);
      } else {
        await createUserWithEmailAndPassword(auth, emailInput, senhaInput);
      }
    } catch (error) {
      if (error.code === 'auth/invalid-credential') setErroAuth('E-mail ou senha incorretos.');
      else if (error.code === 'auth/email-already-in-use') setErroAuth('Este e-mail já está cadastrado.');
      else setErroAuth('Ocorreu um erro. Verifique os dados.');
    }
  };

  const handleLogout = async () => await signOut(auth);

  const solicitarConexaoWhatsApp = async () => {
    if (!user) return;
    setCarregandoQr(true);
    try {
      await fetch(`${RENDER_API_URL}/conectar`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-api-key': API_SECRET_KEY 
        },
        body: JSON.stringify({ userId: user.uid })
      });
    } catch (e) {
      alert('O servidor pode estar acordando. Aguarde 15 segundos e tente novamente.');
    } finally {
      setCarregandoQr(false);
    }
  };

  const desconectarWhatsApp = async () => {
    if (!user) return;
    try {
      await fetch(`${RENDER_API_URL}/desconectar`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-api-key': API_SECRET_KEY 
        },
        body: JSON.stringify({ userId: user.uid })
      });
      setWhatsappStatus('DISCONNECTED');
      setWhatsappQrCode(null);
    } catch (e) {
      alert('Erro ao desconectar aparelho.');
    }
  };

  const dispararTesteAlertaWhatsApp = async () => {
    try {
      await fetch(`${RENDER_API_URL}/verificar-alertas`, {
        method: 'GET',
        headers: {
          'x-api-key': API_SECRET_KEY
        }
      });
      alert('🔔 O comando de verificação de alertas foi acionado!');
    } catch (e) {
      alert('Erro ao acionar verificação no servidor.');
    }
  };

  const realizarTransferenciaEntreContas = async (e) => {
    e.preventDefault();
    if (!user || !formTransferencia.valor) return;
    if (formTransferencia.bancoOrigem === formTransferencia.bancoDestino) {
      return alert('Selecione contas diferentes para a origem e o destino da transferência.');
    }

    const valorNum = parseFloat(formTransferencia.valor);
    if (isNaN(valorNum) || valorNum <= 0) return alert('Informe um valor válido.');

    const dataTransf = formTransferencia.data || hojeIso;
    const anoMesTransf = dataTransf.slice(0, 7);

    await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
      descricao: `Transferência enviada para ${formTransferencia.bancoDestino}`,
      valor: valorNum,
      tipo: 'DESPESA',
      metodo: 'TRANSFERENCIA',
      cartao_nome: null,
      banco_nome: formTransferencia.bancoOrigem,
      categoria: 'Transferência',
      subcategoria: 'Entre Contas',
      pago: true,
      data_vencimento: dataTransf,
      anoMes: anoMesTransf,
      criadoEm: serverTimestamp()
    });

    await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
      descricao: `Transferência recebida de ${formTransferencia.bancoOrigem}`,
      valor: valorNum,
      tipo: 'RECEITA',
      metodo: 'TRANSFERENCIA',
      cartao_nome: null,
      banco_nome: formTransferencia.bancoDestino,
      categoria: 'Transferência',
      subcategoria: 'Entre Contas',
      pago: true,
      data_vencimento: dataTransf,
      anoMes: anoMesTransf,
      criadoEm: serverTimestamp()
    });

    setFormTransferencia({ ...formTransferencia, valor: '' });
    alert(`🔄 Transferência de R$ ${valorNum.toFixed(2)} de ${formTransferencia.bancoOrigem} para ${formTransferencia.bancoDestino} registrada!`);
  };

  const salvarCartao = async (e) => {
    e.preventDefault();
    if (!cartaoForm.nome.trim() || !user) return;

    const novoObjeto = {
      id: cartaoForm.id || Date.now().toString(),
      nome: cartaoForm.nome.toUpperCase().trim(),
      limite: Number(cartaoForm.limite) || 1000,
      diaFechamento: Number(cartaoForm.diaFechamento) || 5,
      diaVencimento: Number(cartaoForm.diaVencimento) || 12,
      banco: cartaoForm.banco || 'Outro'
    };

    const novaLista = cartaoForm.id
      ? cartoes.map(c => c.id === cartaoForm.id ? novoObjeto : c)
      : [...cartoes, novoObjeto];

    setCartoes(novaLista);
    setCartaoForm({ id: null, nome: '', limite: '', diaFechamento: '5', diaVencimento: '12', banco: '' });
    await setDoc(doc(db, 'users', user.uid), { cartoes: novaLista }, { merge: true });
  };

  const editarCartao = (c) => {
    setCartaoForm({
      id: c.id,
      nome: c.nome,
      limite: c.limite,
      diaFechamento: c.diaFechamento || 5,
      diaVencimento: c.diaVencimento || 12,
      banco: c.banco || ''
    });
  };

  const excluirCartao = async (id) => {
    const novaLista = cartoes.filter(c => c.id !== id);
    setCartoes(novaLista);
    await setDoc(doc(db, 'users', user.uid), { cartoes: novaLista }, { merge: true });
  };

  const salvarBanco = async (e) => {
    e.preventDefault();
    if (!bancoForm.nome.trim() || !user) return;

    const novoBanco = {
      id: bancoForm.id || Date.now().toString(),
      nome: bancoForm.nome.trim(),
      tipo: bancoForm.tipo || 'Conta Corrente / Débito',
      saldoInicial: Number(bancoForm.saldoInicial) || 0
    };

    const novaLista = bancoForm.id
      ? bancos.map(b => b.id === bancoForm.id ? novoBanco : b)
      : [...bancos, novoBanco];

    setBancos(novaLista);
    setBancoForm({ id: null, nome: '', tipo: 'Conta Corrente / Débito', saldoInicial: '' });
    await setDoc(doc(db, 'users', user.uid), { bancos: novaLista }, { merge: true });
  };

  const editarBanco = (b) => {
    setBancoForm({
      id: b.id,
      nome: b.nome,
      tipo: b.tipo,
      saldoInicial: b.saldoInicial || 0
    });
  };

  const excluirBanco = async (id) => {
    const novaLista = bancos.filter(b => b.id !== id);
    setBancos(novaLista);
    await setDoc(doc(db, 'users', user.uid), { bancos: novaLista }, { merge: true });
  };

  const lancarContaAgendada = async (e) => {
    e.preventDefault();
    if (!formAgendamento.descricao || !formAgendamento.valor || !user) return;

    const anoMesVenc = formAgendamento.data_vencimento ? formAgendamento.data_vencimento.slice(0, 7) : filtroMesAno;

    await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
      descricao: formAgendamento.descricao,
      valor: Number(formAgendamento.valor),
      tipo: formAgendamento.tipo,
      metodo: formAgendamento.pago ? 'PIX/BOLETO' : 'BOLETO / AGENDADO',
      cartao_nome: null,
      banco_nome: formAgendamento.banco_nome || bancos[0]?.nome || null,
      categoria: formAgendamento.categoria,
      subcategoria: formAgendamento.subcategoria || 'Geral',
      pago: Boolean(formAgendamento.pago),
      data_vencimento: formAgendamento.data_vencimento || hojeIso,
      anoMes: anoMesVenc,
      mensagem_original: `Agendamento manual: ${formAgendamento.descricao}`,
      criadoEm: serverTimestamp()
    });

    setFormAgendamento({ ...formAgendamento, descricao: '', valor: '', pago: false });
  };

  const clicarDarBaixaConta = (transacao) => {
    if (transacao.pago) {
      updateDoc(doc(db, 'users', user.uid, 'transacoes', transacao.id), { pago: false });
    } else {
      setModalBaixaConta({
        transacao,
        bancoEscolhido: transacao.banco_nome || bancos[0]?.nome || 'Itaú',
        metodoEscolhido: 'PIX'
      });
    }
  };

  const confirmarBaixaContaModal = async (e) => {
    e.preventDefault();
    if (!modalBaixaConta || !user) return;
    const { transacao, bancoEscolhido, metodoEscolhido } = modalBaixaConta;
    await updateDoc(doc(db, 'users', user.uid, 'transacoes', transacao.id), {
      pago: true,
      metodo: metodoEscolhido,
      banco_nome: bancoEscolhido
    });
    setModalBaixaConta(null);
  };

  const adicionarContaFixa = async (e) => {
    e.preventDefault();
    if (!fixaNome || !fixaValor || !user) return;
    const novas = [...contasFixas, {
      id: Date.now().toString(),
      nome: fixaNome,
      valorPadrao: Number(fixaValor),
      diaVencimento: Number(fixaDia) || 10,
      categoria: 'Contas'
    }];
    setContasFixas(novas);
    setFixaNome('');
    setFixaValor('');
    setFixaDia('');
    await setDoc(doc(db, 'users', user.uid), { contasFixas: novas }, { merge: true });
  };

  const excluirContaFixa = async (id) => {
    const novas = contasFixas.filter(c => c.id !== id);
    setContasFixas(novas);
    await setDoc(doc(db, 'users', user.uid), { contasFixas: novas }, { merge: true });
  };

  const pagarContaFixaRapido = async (conta) => {
    if (!user) return;
    const diaStr = String(conta.diaVencimento || 10).padStart(2, '0');
    await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
      descricao: conta.nome,
      valor: Number(conta.valorPadrao),
      tipo: 'DESPESA',
      metodo: 'PIX',
      cartao_nome: null,
      banco_nome: bancos[0]?.nome || null,
      categoria: conta.categoria || 'Contas',
      subcategoria: 'Casa / Fixas',
      pago: true,
      data_vencimento: `${filtroMesAno}-${diaStr}`,
      anoMes: filtroMesAno,
      conta_fixa_id: conta.id,
      mensagem_original: `Baixa de conta fixa recorrente: ${conta.nome}`,
      criadoEm: serverTimestamp()
    });
  };

  // Lógica Flexível de Lançamento (Cartão, PIX, Dinheiro, Carnê)
  const lancarCompraCartaoManual = async (e) => {
    e.preventDefault();
    if (!novaCompraCartao.descricao || !novaCompraCartao.valorTotal || !user) return;

    const parcelasTotal = Math.max(parseInt(novaCompraCartao.parcelas) || 1, 1);
    const valorTotal = parseFloat(novaCompraCartao.valorTotal);
    const valorParcela = Number((valorTotal / parcelasTotal).toFixed(2));
    const [anoBase, mesBase] = filtroMesAno.split('-').map(Number);
    const grupoId = `compra_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const isCredito = novaCompraCartao.metodo === 'CREDITO';

    for (let i = 0; i < parcelasTotal; i++) {
      const dParc = new Date(anoBase, (mesBase - 1) + i, 15);
      const anoM = dParc.getFullYear();
      const mesM = String(dParc.getMonth() + 1).padStart(2, '0');

      // NOVA LÓGICA: Se for parcelado e NÃO for crédito, só a 1ª parcela fica paga.
      let statusPago = true;
      if (parcelasTotal > 1 && !isCredito) {
        statusPago = (i === 0); 
      }

      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: parcelasTotal > 1 ? `${novaCompraCartao.descricao} (${i + 1}/${parcelasTotal})` : novaCompraCartao.descricao,
        valor: valorParcela,
        tipo: 'DESPESA',
        metodo: novaCompraCartao.metodo,
        cartao_nome: isCredito ? novaCompraCartao.cartaoNome : null,
        banco_nome: !isCredito ? novaCompraCartao.bancoNome : null,
        categoria: novaCompraCartao.categoria,
        subcategoria: novaCompraCartao.subcategoria || 'Geral',
        parcela_atual: i + 1,
        parcelas_total: parcelasTotal,
        grupo_id: parcelasTotal > 1 ? grupoId : null,
        fatura_paga: false,
        pago: isCredito ? true : statusPago, 
        data_vencimento: `${anoM}-${mesM}-15`,
        anoMes: `${anoM}-${mesM}`,
        mensagem_original: `Lançamento manual parcelado`,
        criadoEm: serverTimestamp()
      });
    }

    setNovaCompraCartao({ ...novaCompraCartao, descricao: '', valorTotal: '', parcelas: '1', metodo: 'CREDITO' });
  };

  const abrirModalPagamentoFatura = (cartaoObj) => {
    if (cartaoObj.faturaMes <= 0) {
      return alert(`A fatura do cartão ${cartaoObj.nome} em ${filtroMesAno} já está zerada ou paga!`);
    }
    setModalPagarFatura({
      cartaoNome: cartaoObj.nome,
      valorFatura: cartaoObj.faturaMes,
      tipoPagamento: 'TOTAL',
      valorPago: cartaoObj.faturaMes.toFixed(2),
      bancoSaida: bancos[0]?.nome || 'Itaú'
    });
  };

  const confirmarPagamentoFatura = async (e) => {
    e.preventDefault();
    if (!modalPagarFatura || !user) return;

    const valorPagarNum = parseFloat(modalPagarFatura.valorPago);
    if (isNaN(valorPagarNum) || valorPagarNum <= 0) return alert('Informe um valor válido.');

    const { cartaoNome, tipoPagamento, bancoSaida } = modalPagarFatura;

    if (tipoPagamento === 'TOTAL' || valorPagarNum >= modalPagarFatura.valorFatura) {
      const comprasDaFatura = transacoes.filter(
        t => t.anoMes === filtroMesAno && t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === cartaoNome.toLowerCase() && !t.fatura_paga
      );
      for (const item of comprasDaFatura) {
        await updateDoc(doc(db, 'users', user.uid, 'transacoes', item.id), {
          fatura_paga: true
        });
      }
      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: `Pagamento Total Fatura Cartão ${cartaoNome}`,
        valor: modalPagarFatura.valorFatura,
        tipo: 'DESPESA',
        metodo: 'PAGAMENTO_FATURA',
        cartao_nome: null,
        banco_nome: bancoSaida,
        categoria: 'Contas',
        subcategoria: 'Fatura Cartão',
        pago: true,
        data_vencimento: hojeIso,
        anoMes: filtroMesAno,
        criadoEm: serverTimestamp()
      });
    } else {
      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: `Abatimento Parcial na Fatura (${cartaoNome})`,
        valor: -Math.abs(valorPagarNum),
        tipo: 'DESPESA',
        metodo: 'CREDITO',
        cartao_nome: cartaoNome,
        categoria: 'Contas',
        subcategoria: 'Fatura Cartão',
        fatura_paga: false,
        pago: true,
        data_vencimento: hojeIso,
        anoMes: filtroMesAno,
        criadoEm: serverTimestamp()
      });

      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: `Pagamento Parcial Fatura Cartão ${cartaoNome}`,
        valor: valorPagarNum,
        tipo: 'DESPESA',
        metodo: 'PAGAMENTO_FATURA',
        cartao_nome: null,
        banco_nome: bancoSaida,
        categoria: 'Contas',
        subcategoria: 'Fatura Cartão',
        pago: true,
        data_vencimento: hojeIso,
        anoMes: filtroMesAno,
        criadoEm: serverTimestamp()
      });
    }

    setModalPagarFatura(null);
  };

  const iniciarEdicaoTransacao = (t) => {
    setTransacaoEditando(t);
    setAplicarFuturasEdicao(false);
  };

  const salvarEdicaoTransacao = async (e) => {
    e.preventDefault();
    if (!transacaoEditando || !user) return;

    const baseDescricao = transacaoEditando.descricao.replace(/\s\(\d+\/\d+\)$/, ''); 

    if (aplicarFuturasEdicao && transacaoEditando.grupo_id) {
      const batch = writeBatch(db);
      const q = query(
        collection(db, 'users', user.uid, 'transacoes'),
        where('grupo_id', '==', transacaoEditando.grupo_id),
        where('parcela_atual', '>=', transacaoEditando.parcela_atual)
      );
      
      const snaps = await getDocs(q);
      snaps.forEach(documento => {
        const docData = documento.data();
        batch.update(documento.ref, {
          descricao: `${baseDescricao} (${docData.parcela_atual}/${docData.parcelas_total})`,
          valor: Number(transacaoEditando.valor),
          categoria: transacaoEditando.categoria,
          subcategoria: transacaoEditando.subcategoria || 'Geral',
          metodo: transacaoEditando.metodo,
          pago: Boolean(transacaoEditando.pago),
          banco_nome: transacaoEditando.banco_nome || null,
          cartao_nome: transacaoEditando.metodo === 'CREDITO' ? transacaoEditando.cartao_nome : null
        });
      });
      await batch.commit();
    } else {
      await updateDoc(doc(db, 'users', user.uid, 'transacoes', transacaoEditando.id), {
        descricao: transacaoEditando.descricao,
        valor: Number(transacaoEditando.valor),
        categoria: transacaoEditando.categoria,
        subcategoria: transacaoEditando.subcategoria || 'Geral',
        metodo: transacaoEditando.metodo,
        data_vencimento: transacaoEditando.data_vencimento || hojeIso,
        pago: Boolean(transacaoEditando.pago),
        banco_nome: transacaoEditando.banco_nome || null,
        cartao_nome: transacaoEditando.metodo === 'CREDITO' ? transacaoEditando.cartao_nome : null
      });
    }
    setTransacaoEditando(null);
  };

  const iniciarExclusaoTransacao = (t) => {
    if (t.grupo_id && t.parcelas_total > 1) {
      setTransacaoExcluindo(t);
      setAplicarFuturasExclusao(false);
    } else {
      if(window.confirm('Tem certeza que deseja excluir este lançamento?')) {
         deleteDoc(doc(db, 'users', user.uid, 'transacoes', t.id));
      }
    }
  };

  const confirmarExclusaoLote = async (e) => {
    e.preventDefault();
    if (!transacaoExcluindo || !user) return;
    
    if (aplicarFuturasExclusao && transacaoExcluindo.grupo_id) {
      const batch = writeBatch(db);
      const q = query(
        collection(db, 'users', user.uid, 'transacoes'),
        where('grupo_id', '==', transacaoExcluindo.grupo_id),
        where('parcela_atual', '>=', transacaoExcluindo.parcela_atual)
      );
      const snaps = await getDocs(q);
      snaps.forEach(documento => {
        batch.delete(documento.ref);
      });
      await batch.commit();
    } else {
      await deleteDoc(doc(db, 'users', user.uid, 'transacoes', transacaoExcluindo.id));
    }
    setTransacaoExcluindo(null);
  };

  const adicionarCategoria = async (e) => {
    e.preventDefault();
    if (!novaCatNome.trim() || !user) return;
    const catFormatada = novaCatNome.charAt(0).toUpperCase() + novaCatNome.slice(1).toLowerCase();
    if (categorias.includes(catFormatada)) return alert('Esta categoria já existe!');
    const novasCats = [...categorias, catFormatada];
    const novasSubs = { ...subcategorias, [catFormatada]: ['Geral'] };
    setCategorias(novasCats);
    setSubcategorias(novasSubs);
    setNovaCatNome('');
    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats, subcategorias: novasSubs }, { merge: true });
  };

  const adicionarSubcategoria = async (e) => {
    e.preventDefault();
    if (!novaSubNome.trim() || !catSelecionadaParaSub || !user) return;
    const subFormatada = novaSubNome.charAt(0).toUpperCase() + novaSubNome.slice(1);
    const atuais = subcategorias[catSelecionadaParaSub] || [];
    if (atuais.includes(subFormatada)) return alert('Esta subcategoria já existe!');
    const novasSubs = { ...subcategorias, [catSelecionadaParaSub]: [...atuais, subFormatada] };
    setSubcategorias(novasSubs);
    setNovaSubNome('');
    await setDoc(doc(db, 'users', user.uid), { subcategorias: novasSubs }, { merge: true });
  };

  const definirOrcamento = async (e) => {
    e.preventDefault();
    if (!orcamentoCat || !orcamentoValor || !user) return;
    const novosOrcamentos = { ...orcamentos, [orcamentoCat]: Number(orcamentoValor) };
    setOrcamentos(novosOrcamentos);
    setOrcamentoValor('');
    await setDoc(doc(db, 'users', user.uid), { orcamentos: novosOrcamentos }, { merge: true });
  };

  const excluirCategoria = async (catParaExcluir) => {
    if (categorias.length <= 1) return alert('Mantenha pelo menos uma categoria.');
    const novasCats = categorias.filter(c => c !== catParaExcluir);
    setCategorias(novasCats);
    const novosOrcamentos = { ...orcamentos };
    delete novosOrcamentos[catParaExcluir];
    setOrcamentos(novosOrcamentos);
    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats, orcamentos: novosOrcamentos }, { merge: true });
  };

  const extrairDataTextoSimulador = (texto) => {
    const anoAtual = dataAtualObj.getFullYear();
    const mesAtual = dataAtualObj.getMonth() + 1;
    const matchData = texto.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (matchData) {
      const dia = String(matchData[1]).padStart(2, '0');
      const mes = String(matchData[2]).padStart(2, '0');
      let ano = matchData[3] ? String(matchData[3]) : String(anoAtual);
      if (ano.length === 2) ano = `20${ano}`;
      return { dataVencimento: `${ano}-${mes}-${dia}`, anoMes: `${ano}-${mes}`, trecho: matchData[0] };
    }
    const matchDia = texto.match(/(?:vence|vencimento|dia)\s+(\d{1,2})\b/i);
    if (matchDia) {
      const dia = String(matchDia[1]).padStart(2, '0');
      const mes = String(mesAtual).padStart(2, '0');
      return { dataVencimento: `${anoAtual}-${mes}-${dia}`, anoMes: `${anoAtual}-${mes}`, trecho: matchDia[0] };
    }
    return null;
  };

  const interpretarItemUnico = (trecho) => {
    const txtLower = trecho.toLowerCase();
    const infoVenc = extrairDataTextoSimulador(trecho);
    const isAgendado = Boolean(infoVenc) || /vence|vencimento|a pagar|a receber/i.test(txtLower);

    const trechoSemData = infoVenc ? trecho.replace(infoVenc.trecho, ' ') : trecho;
    const matchParcelas = trechoSemData.toLowerCase().match(/(\d+)\s*(?:x|vezes|parcelas)/);
    const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

    const textoSemParcela = matchParcelas ? trechoSemData.replace(matchParcelas[0], '') : trechoSemData;
    const matchValor = textoSemParcela.match(/(\d+\.\d{2}|\d+)/);
    if (!matchValor) return null;
    
    let valorTotal = parseFloat(matchValor[0]);
    if (isNaN(valorTotal) || valorTotal <= 0) return null;

    const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
    const isReceita = /recebi|ganhei|salário|salario|pix recebido|venda|cliente|a receber/i.test(txtLower);
    const tipo = isReceita ? 'RECEITA' : 'DESPESA';

    let metodo = null;
    let cartaoIdentificado = null;
    let bancoIdentificado = null;

    for (const c of cartoes) {
      const nCartao = c.nome.toLowerCase();
      if (txtLower.includes(nCartao) || nCartao.includes(txtLower)) {
        cartaoIdentificado = c.nome;
        metodo = 'CREDITO';
        break;
      }
    }

    for (const b of bancos) {
      const nBanco = b.nome.toLowerCase();
      if (txtLower.includes(nBanco) || nBanco.includes(txtLower)) {
        bancoIdentificado = b.nome;
        if (!metodo) metodo = /débito|debito/i.test(txtLower) ? 'DEBITO' : 'PIX';
        break;
      }
    }

    if (!metodo) {
      if (/crédito|credito|cartão|cartao/i.test(txtLower)) {
        metodo = 'CREDITO';
        cartaoIdentificado = cartoes[0]?.nome || 'CREDITO';
      } else if (/débito|debito/i.test(txtLower)) {
        metodo = 'DEBITO';
      } else if (/pix/i.test(txtLower)) {
        metodo = 'PIX';
      } else if (/dinheiro|espécie|especie/i.test(txtLower)) {
        metodo = 'DINHEIRO';
      } else if (isAgendado) {
        metodo = 'BOLETO / AGENDADO';
      } else if (isReceita) {
        metodo = 'PIX';
      }
    }

    const classif = classificarCategoriaLocal(trecho, isReceita, categorias, subcategorias);

    let descricao = textoSemParcela
      .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|vence|vencimento|valor|dia|no cartão de credito|no cartão|no credito|no pix|no débito|no debito|credito|crédito|debito|débito|pix|dinheiro|reais|r\$|de |em /gi, ' ')
      .replace(matchValor[0], '')
      .replace(cartaoIdentificado ? new RegExp(cartaoIdentificado, 'gi') : '', '')
      .replace(bancoIdentificado ? new RegExp(bancoIdentificado, 'gi') : '', '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!descricao || descricao.length < 2) descricao = classif.subcategoria || classif.categoria || 'Gasto';
    descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

    return {
      descricao,
      valorTotal,
      valorParcela,
      parcelasTotal,
      tipo,
      metodo,
      cartao_nome: cartaoIdentificado,
      banco_nome: bancoIdentificado,
      categoria: classif.categoria,
      subcategoria: classif.subcategoria,
      precisaPerguntarCategoria: !classif.reconhecida,
      precisaPerguntarData: (parcelasTotal > 1 || isAgendado) && !infoVenc,
      pago: !isAgendado,
      data_vencimento: infoVenc ? infoVenc.dataVencimento : hojeIso,
      anoMes: infoVenc ? infoVenc.anoMes : filtroMesAno
    };
  };

  const gravarItensSimulador = async (itens, textoOriginal) => {
    const hoje = new Date();
    let resumoRespostas = [];

    for (const dados of itens) {
      const pTotal = dados.parcelasTotal || 1;
      const catFinal = dados.categoria || 'Outros';
      const subFinal = dados.subcategoria || 'Geral';
      const grupoId = `compra_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const dataReferencia = new Date((dados.data_vencimento || hojeIso) + 'T12:00:00');
      let diaVenc = dataReferencia.getDate();
      let mesVenc = dataReferencia.getMonth();
      let anoVenc = dataReferencia.getFullYear();

      const dataHojeLocal = new Date();
      if (dataReferencia < new Date(dataHojeLocal.getFullYear(), dataHojeLocal.getMonth(), dataHojeLocal.getDate()) && dados.metodo !== 'CREDITO') {
        mesVenc += 1;
      }

      for (let i = 0; i < pTotal; i++) {
        let anoMesItem = dados.anoMes || filtroMesAno;
        let dataVencItem = dados.data_vencimento || hojeIso;

        if (pTotal > 1) {
          const dataParcela = new Date(anoVenc, mesVenc + i, diaVenc);
          const anoM = dataParcela.getFullYear();
          const mesM = String(dataParcela.getMonth() + 1).padStart(2, '0');
          const diaM = String(dataParcela.getDate()).padStart(2, '0');
          
          anoMesItem = `${anoM}-${mesM}`;
          dataVencItem = `${anoM}-${mesM}-${diaM}`;
        }
        
        const isCredito = dados.metodo === 'CREDITO';
        let statusPago = dados.pago !== undefined ? dados.pago : true;
        if (pTotal > 1 && !isCredito) {
          statusPago = false; 
        }

        await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
          descricao: pTotal > 1 ? `${dados.descricao} (${i + 1}/${pTotal})` : dados.descricao,
          valor: dados.valorParcela,
          tipo: dados.tipo,
          metodo: dados.metodo,
          cartao_nome: dados.cartao_nome,
          banco_nome: dados.banco_nome || null,
          categoria: catFinal,
          subcategoria: subFinal,
          parcela_atual: i + 1,
          parcelas_total: pTotal,
          grupo_id: pTotal > 1 ? grupoId : null,
          fatura_paga: false,
          pago: statusPago,
          data_vencimento: dataVencItem,
          anoMes: anoMesItem,
          mensagem_original: textoOriginal,
          criadoEm: serverTimestamp()
        });
      }

      if (dados.pago === false || (pTotal > 1 && dados.metodo !== 'CREDITO')) {
        resumoRespostas.push(
          `📅 *Conta Agendada (${dados.tipo === 'RECEITA' ? 'A Receber' : 'A Vencer'})*\n• *${dados.descricao}* [${catFinal} > ${subFinal}] — R$ ${dados.valorParcela.toFixed(2)}\n• Primeiro Vencimento: *${diaVenc}/${String(mesVenc + 1).padStart(2, '0')}/${anoVenc}*`
        );
      } else {
        const origem = dados.metodo === 'CREDITO' ? `Cartão ${dados.cartao_nome}` : `${dados.metodo} (${dados.banco_nome || 'Geral'})`;
        resumoRespostas.push(
          `✅ *${dados.descricao}* [${catFinal} > ${subFinal}]: R$ ${dados.valorParcela.toFixed(2)} ${pTotal > 1 ? `(${pTotal}x)` : ''} • ${origem}`
        );
      }
    }

    return resumoRespostas;
  };

  const verificarPendenciasSimulador = async (itens, textoOriginal) => {
    const prontos = [];
    const pendentes = [];

    for (const item of itens) {
      const faltaMetodo = !item.metodo && item.pago !== false;
      const faltaBanco = (item.metodo === 'PIX' || item.metodo === 'DEBITO') && !item.banco_nome && item.pago !== false;
      const faltaCat = !item.categoria || item.precisaPerguntarCategoria;
      const faltaData = item.precisaPerguntarData;

      if (!faltaMetodo && !faltaBanco && !faltaCat && !faltaData) prontos.push(item);
      else pendentes.push(item);
    }

    let msgs = [];
    if (prontos.length > 0) {
      const r = await gravarItensSimulador(prontos, textoOriginal);
      msgs.push(...r);
    }

    if (pendentes.length > 0) {
      const prim = pendentes[0];
      const listaStr = pendentes.map(i => `• *${i.descricao}* — R$ ${i.valorTotal.toFixed(2)}`).join('\n');

      if (prim.precisaPerguntarData) {
        setPendenteSimulador({ etapa: 'DATA', itens: pendentes, textoOriginal });
        msgs.push(`📅 *Qual a data do primeiro vencimento?*\n${listaStr}\n\nResponda com o dia (ex: *dia 20*) ou a data (ex: *20/11*).`);
      } else if (!prim.metodo && prim.pago !== false) {
        setPendenteSimulador({ etapa: 'METODO', itens: pendentes, textoOriginal });
        msgs.push(`❓ *Qual foi a forma de pagamento?*\n${listaStr}\n\nResponda com: *Pix*, *Débito*, *Dinheiro* ou o cartão (*${cartoes.map(c => c.nome).join(', ')}*).`);
      } else if ((prim.metodo === 'PIX' || prim.metodo === 'DEBITO') && !prim.banco_nome && prim.pago !== false) {
        setPendenteSimulador({ etapa: 'BANCO', itens: pendentes, textoOriginal });
        msgs.push(`🏦 *De qual conta bancária vai sair esse ${prim.metodo}?*\n${listaStr}\n\nResponda com: *${bancos.map(b => b.nome).join(' ou ')}*.`);
      } else {
        setPendenteSimulador({ etapa: 'CATEGORIA', itens: pendentes, textoOriginal });
        msgs.push(`📂 *Em qual Categoria e Subcategoria deseja lançar?*\n${listaStr}\n\nResponda por exemplo: *Mercado*, *Lazer*, *Transporte* ou *Contas*.`);
      }
    } else {
      setPendenteSimulador(null);
    }

    setHistoricoChat(prev => [...prev, { autor: 'bot', texto: msgs.join('\n\n') }]);
  };

  const handleEnviarWhatsApp = async (e) => {
    e.preventDefault();
    if (!msgWhats.trim() || !user) return;

    const textoUsuario = msgWhats.trim();
    const txtLower = textoUsuario.toLowerCase();
    setMsgWhats('');
    setHistoricoChat(prev => [...prev, { autor: 'user', texto: textoUsuario }]);
    setProcessando(true);

    try {
      if (/^(teste|ping|status)$/i.test(txtLower)) {
        setHistoricoChat(prev => [...prev, { 
          autor: 'bot', 
          texto: `🟢 *Conexão FinZap 100% Online!*\n• Status WhatsApp: *${whatsappStatus}*\n• Competência Ativa: *${filtroMesAno}*` 
        }]);
        setProcessando(false);
        return;
      }

      if (pendenteSimulador && pendenteSimulador.itens) {
        let atualizados = [...pendenteSimulador.itens];

        if (pendenteSimulador.etapa === 'DATA') {
          const infoVenc = extrairDataTextoSimulador(textoUsuario) || extrairDataTextoSimulador(`dia ${textoUsuario.replace(/\D/g, '')}`);
          if (infoVenc && infoVenc.dataVencimento) {
            atualizados = atualizados.map(it => ({
              ...it,
              data_vencimento: infoVenc.dataVencimento,
              anoMes: infoVenc.anoMes,
              precisaPerguntarData: false
            }));
            await verificarPendenciasSimulador(atualizados, pendenteSimulador.textoOriginal);
            setProcessando(false);
            return;
          }
        } else if (pendenteSimulador.etapa === 'METODO') {
          let metodoResp = null;
          let cartaoResp = null;
          let bancoResp = null;

          for (const c of cartoes) {
            const nCartao = c.nome.toLowerCase();
            if (txtLower.includes(nCartao) || nCartao.includes(txtLower)) { metodoResp = 'CREDITO'; cartaoResp = c.nome; break; }
          }
          for (const b of bancos) {
            const nBanco = b.nome.toLowerCase();
            if (txtLower.includes(nBanco) || nBanco.includes(txtLower)) {
              bancoResp = b.nome;
              if (!metodoResp) metodoResp = /débito|debito/i.test(txtLower) ? 'DEBITO' : 'PIX';
              break;
            }
          }
          if (!metodoResp) {
            if (/crédito|credito|cartão|cartao/i.test(txtLower)) { metodoResp = 'CREDITO'; cartaoResp = cartoes[0]?.nome || 'CREDITO'; }
            else if (/débito|debito/i.test(txtLower)) metodoResp = 'DEBITO';
            else if (/pix/i.test(txtLower)) metodoResp = 'PIX';
            else if (/dinheiro/i.test(txtLower)) metodoResp = 'DINHEIRO';
          }

          if (metodoResp) {
            atualizados = atualizados.map(it => ({
              ...it,
              metodo: metodoResp,
              cartao_nome: cartaoResp,
              banco_nome: bancoResp || it.banco_nome,
              pago: true
            }));
            await verificarPendenciasSimulador(atualizados, pendenteSimulador.textoOriginal);
            setProcessando(false);
            return;
          }
        } else if (pendenteSimulador.etapa === 'BANCO') {
          const bEnc = bancos.find(b => {
            const nBanco = b.nome.toLowerCase();
            return txtLower.includes(nBanco) || nBanco.includes(txtLower);
          }) || bancos[0];
          if (bEnc) {
            atualizados = atualizados.map(it => ({ ...it, banco_nome: bEnc.nome }));
            await verificarPendenciasSimulador(atualizados, pendenteSimulador.textoOriginal);
            setProcessando(false);
            return;
          }
        } else if (pendenteSimulador.etapa === 'CATEGORIA') {
          const cl = classificarCategoriaLocal(textoUsuario, false, categorias, subcategorias);
          atualizados = atualizados.map(it => ({
            ...it,
            categoria: cl.categoria || textoUsuario,
            subcategoria: cl.subcategoria || 'Geral',
            precisaPerguntarCategoria: false
          }));
          await verificarPendenciasSimulador(atualizados, pendenteSimulador.textoOriginal);
          setProcessando(false);
          return;
        }
        setPendenteSimulador(null);
      }

      if (/^(apagar|excluir|deletar|desfazer)/i.test(txtLower)) {
        if (transacoes.length === 0) {
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: '⚠️ Nenhum lançamento para apagar.' }]);
          setProcessando(false);
          return;
        }
        const ultima = transacoes[0];
        await deleteDoc(doc(db, 'users', user.uid, 'transacoes', ultima.id));
        setHistoricoChat(prev => [...prev, { 
          autor: 'bot', 
          texto: `🗑️ *Removido:* ${ultima.descricao} (R$ ${Number(ultima.valor).toFixed(2)})` 
        }]);
        setProcessando(false);
        return;
      }

      if (/proxima|proximas|5 dias/i.test(txtLower) && /conta|vencimento|vencer/i.test(txtLower)) {
        const hojeZero = new Date(hojeIso + 'T00:00:00');
        const limite5 = new Date(hojeZero.getTime() + 5 * 24 * 60 * 60 * 1000);
        const prox = transacoes.filter(t => {
          if (t.pago !== false || !t.data_vencimento) return false;
          const dt = new Date(t.data_vencimento + 'T00:00:00');
          return dt <= limite5;
        });

        if (prox.length === 0) {
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: '⏳ *Contas Próximas (Até 5 dias)*\n\n🎉 Nenhuma conta em aberto vencendo nos próximos 5 dias!' }]);
        } else {
          const linhas = prox.map(t => `• *${t.descricao}*: R$ ${Number(t.valor).toFixed(2)} (Vence: ${formatarDataBR(t.data_vencimento)})`).join('\n');
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: `⏳ *Contas Próximas do Vencimento (5 dias)*\n\n${linhas}` }]);
        }
        setProcessando(false);
        return;
      }

      if (/contas a vencer|contas em aberto|o que vence/i.test(txtLower)) {
        const abertas = transacoes.filter(t => t.anoMes === filtroMesAno && t.pago === false);
        if (abertas.length === 0) {
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: `📅 *Contas a Vencer (${filtroMesAno})*\n\n✅ Nenhuma conta em aberto neste mês!` }]);
        } else {
          const totalAb = abertas.reduce((a, b) => a + Number(b.valor || 0), 0);
          const linhas = abertas.map(t => `• *${t.descricao}*: R$ ${Number(t.valor).toFixed(2)} — Vence: *${formatarDataBR(t.data_vencimento)}*`).join('\n');
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: `📅 *Contas em Aberto (${filtroMesAno})*\n\n${linhas}\n\n📌 *Total em aberto:* R$ ${totalAb.toFixed(2)}` }]);
        }
        setProcessando(false);
        return;
      }

      const textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
      const partes = textoNormalizado.split(/(?:,|\s+e\s+|\s*;\s*|\n+)/i).map(p => p.trim()).filter(Boolean);
      const itensExtraidos = partes.map(interpretarItemUnico).filter(Boolean);

      if (itensExtraidos.length === 0) {
        setHistoricoChat(prev => [...prev, { 
          autor: 'bot', 
          texto: '🤔 Não identifiquei valores. Tente:\n• "comprei maçã 5,00 no débito"\n• "comprei lanche 35,00"\n• "teste"' 
        }]);
        setProcessando(false);
        return;
      }

      await verificarPendenciasSimulador(itensExtraidos, textoUsuario);

    } catch (error) {
      console.error(error);
    } finally {
      setProcessando(false);
    }
  };

  // Função para exportar CSV (Botão adicionado à Aba de Movimentação)
  const exportarParaExcel = () => {
    if (listaMovimentacaoExtrato.length === 0) return alert('Não há dados para exportar.');
    const cabecalho = 'Data,Descrição,Categoria,Subcategoria,Valor,Tipo,Método/Origem,Status\n';
    const linhas = listaMovimentacaoExtrato.map(t => {
      const origem = t.isLinhaFatura ? 'FATURA MENSAL' : t.cartao_nome ? `Cartão ${t.cartao_nome}` : t.banco_nome || t.metodo || '';
      return `${formatarDataBR(t.data_vencimento)},"${t.descricao}","${t.categoria}","${t.subcategoria || ''}",${t.valor},${t.tipo},"${origem}",${t.pago ? 'Pago' : 'Aberto'}`;
    }).join('\n');
    const blob = new Blob([cabecalho + linhas], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Extrato_FinZap_${filtroMesAno}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (carregandoAuth) {
    return (
      <div className="min-h-screen bg-slate-950 text-emerald-400 flex items-center justify-center font-medium">
        <div className="flex items-center gap-3 animate-pulse">
          <Wallet className="w-6 h-6 animate-spin" /> Carregando FinZap SaaS...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 p-8 rounded-3xl w-full max-w-md shadow-2xl shadow-emerald-500/5">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-gradient-to-tr from-emerald-500 to-teal-400 rounded-2xl flex items-center justify-center mx-auto text-slate-950 shadow-lg shadow-emerald-500/20 mb-4">
              <Wallet className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">FinZap SaaS</h1>
            <p className="text-xs text-slate-400 mt-1">Gestão financeira inteligente via WhatsApp</p>
          </div>

          {erroAuth && (
            <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-xs text-center font-medium">
              {erroAuth}
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">E-mail</label>
              <input 
                type="email" required placeholder="seu@email.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} 
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Senha</label>
              <input 
                type="password" required placeholder="••••••••" value={senhaInput} onChange={e => setSenhaInput(e.target.value)} 
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition"
              />
            </div>
            <button type="submit" className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-3.5 rounded-xl text-sm transition shadow-lg shadow-emerald-500/20">
              {isLoginMode ? 'Acessar Painel' : 'Criar Conta Gratuita'}
            </button>
          </form>

          <button onClick={() => setIsLoginMode(!isLoginMode)} className="mt-6 text-xs text-emerald-400 hover:text-emerald-300 w-full text-center block transition font-medium">
            {isLoginMode ? 'Não tem uma conta? Cadastre-se' : 'Já tem uma conta? Faça login'}
          </button>
        </div>
      </div>
    );
  }

  // ==========================================================================
  // CÁLCULOS GERAIS E DADOS DO GRÁFICO (COM DRILL-DOWN)
  // ==========================================================================
  const transacoesFiltradas = transacoes.filter(t => t.anoMes === filtroMesAno);
  
  const totalReceitas = transacoesFiltradas
    .filter(t => t.tipo === 'RECEITA' && t.pago !== false && t.metodo !== 'TRANSFERENCIA')
    .reduce((acc, t) => acc + Number(t.valor || 0), 0);

  const totalDespesas = transacoesFiltradas
    .filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
    .reduce((acc, t) => acc + Number(t.valor || 0), 0);

  const saldoAtual = totalReceitas - totalDespesas;

  const [anoSel, mesSel] = filtroMesAno.split('-').map(Number);
  const totalDiasNoMes = new Date(anoSel, mesSel, 0).getDate();
  const isMesAtual = filtroMesAno === mesAtualStr;
  const diasDecorridos = isMesAtual ? Math.max(dataAtualObj.getDate(), 1) : totalDiasNoMes;
  const gastoMedioDiario = totalDespesas / diasDecorridos;
  const projecaoDespesasMes = isMesAtual ? gastoMedioDiario * totalDiasNoMes : totalDespesas;
  const projecaoSaldoFimMes = totalReceitas - projecaoDespesasMes;

  const saldosPorBanco = bancos.map((b, index) => {
    const entradasBanco = transacoes
      .filter(t => t.tipo === 'RECEITA' && t.pago !== false && (t.banco_nome?.toLowerCase() === b.nome.toLowerCase() || (!t.banco_nome && index === 0)))
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);

    const saidasBanco = transacoes
      .filter(t => t.tipo === 'DESPESA' && t.pago !== false && t.metodo !== 'CREDITO' && (t.banco_nome?.toLowerCase() === b.nome.toLowerCase() || (!t.banco_nome && index === 0)))
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);

    const saldoAtualConta = Number(b.saldoInicial || 0) + entradasBanco - saidasBanco;
    return {
      ...b,
      entradasBanco,
      saidasBanco,
      saldoAtualConta,
      emChequeEspecial: saldoAtualConta < 0
    };
  });

  const saldoTotalBancos = saldosPorBanco.reduce((acc, b) => acc + b.saldoAtualConta, 0);

  const resumoCartoes = cartoes.map(c => {
    const faturaMes = transacoesFiltradas
      .filter(t => t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === c.nome.toLowerCase() && !t.fatura_paga)
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);

    const comprometidoTotal = transacoes
      .filter(t => t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === c.nome.toLowerCase() && !t.fatura_paga && t.anoMes >= mesAtualStr)
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);

    const limite = Number(c.limite || 0);
    const disponivel = limite - comprometidoTotal;
    const pctUso = limite > 0 ? Math.min(Math.round((comprometidoTotal / limite) * 100), 100) : 0;
    const isMelhorDiaHoje = diaHoje >= Number(c.diaFechamento || 5) && diaHoje < Number(c.diaVencimento || 12);

    return {
      ...c,
      faturaMes: Math.max(faturaMes, 0),
      comprometidoTotal: Math.max(comprometidoTotal, 0),
      disponivel,
      pctUso: Math.max(pctUso, 0),
      estourado: comprometidoTotal > limite,
      alerta80: pctUso >= 80,
      isMelhorDiaHoje
    };
  });

  const faturasConsolidadasNoExtrato = resumoCartoes
    .filter(c => c.faturaMes > 0)
    .map(c => {
      const diaVencStr = String(c.diaVencimento || 12).padStart(2, '0');
      return {
        id: `fatura-${c.id}-${filtroMesAno}`,
        descricao: `Fatura Consolidada Cartão ${c.nome} (Em Aberto no Vencimento)`,
        valor: c.faturaMes,
        tipo: 'FATURA_CARTAO',
        metodo: 'FATURA DO MÊS',
        cartao_nome: c.nome,
        categoria: 'Contas',
        subcategoria: 'Fatura Cartão',
        data_vencimento: `${filtroMesAno}-${diaVencStr}`,
        anoMes: filtroMesAno,
        pago: false,
        isLinhaFatura: true
      };
    });

  const listaMovimentacaoExtrato = [...transacoesFiltradas, ...faturasConsolidadasNoExtrato]
    .filter(item => {
      if (pesquisaExtrato && !item.descricao?.toLowerCase().includes(pesquisaExtrato.toLowerCase()) && !item.categoria?.toLowerCase().includes(pesquisaExtrato.toLowerCase()) && !item.subcategoria?.toLowerCase().includes(pesquisaExtrato.toLowerCase())) {
        return false;
      }
      if (filtroTipoExtrato === 'RECEITA') return item.tipo === 'RECEITA';
      if (filtroTipoExtrato === 'DESPESA') return item.tipo === 'DESPESA' && item.metodo !== 'CREDITO';
      if (filtroTipoExtrato === 'CREDITO') return item.metodo === 'CREDITO';
      if (filtroTipoExtrato === 'FATURA') return item.isLinhaFatura || item.metodo === 'PAGAMENTO_FATURA';
      return true;
    })
    .sort((a, b) => (b.data_vencimento || '').localeCompare(a.data_vencimento || ''));

  const hojeZeroData = new Date(hojeIso + 'T00:00:00');
  const limite5Dias = new Date(hojeZeroData.getTime() + 5 * 24 * 60 * 60 * 1000);

  const listaContasVencerReceber = transacoesFiltradas
    .filter(t => {
      if (t.metodo === 'CREDITO' || t.metodo === 'TRANSFERENCIA') return false;
      if (filtroVencNome && !t.descricao?.toLowerCase().includes(filtroVencNome.toLowerCase())) return false;
      if (filtroVencCat !== 'TODAS' && t.categoria !== filtroVencCat) return false;
      if (filtroVencStatus === 'ABERTO' && t.pago !== false) return false;
      if (filtroVencStatus === 'PAGO' && t.pago === false) return false;
      if (filtroVencData === 'PROXIMOS_5_DIAS') {
        const dt = new Date((t.data_vencimento || hojeIso) + 'T00:00:00');
        return dt >= hojeZeroData && dt <= limite5Dias;
      }
      if (filtroVencData === 'VENCIDOS') {
        const dt = new Date((t.data_vencimento || hojeIso) + 'T00:00:00');
        return dt < hojeZeroData && t.pago === false;
      }
      return true;
    })
    .sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || ''));

  let dadosGraficoDespesas = [];
  if (!categoriaSelecionadaGrafico) {
    dadosGraficoDespesas = categorias.map(cat => {
      const total = transacoesFiltradas
        .filter(t => t.tipo === 'DESPESA' && t.categoria === cat && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
        .reduce((acc, t) => acc + Number(t.valor || 0), 0);
      return { name: cat, value: total };
    }).filter(item => item.value > 0);
  } else {
    const transacoesDaCategoria = transacoesFiltradas
      .filter(t => t.tipo === 'DESPESA' && t.categoria === categoriaSelecionadaGrafico && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA');
    
    const subsMap = {};
    transacoesDaCategoria.forEach(t => {
      const sub = t.subcategoria || 'Geral';
      subsMap[sub] = (subsMap[sub] || 0) + Number(t.valor || 0);
    });
    
    dadosGraficoDespesas = Object.keys(subsMap).map(sub => ({
      name: sub,
      value: subsMap[sub]
    })).filter(item => item.value > 0);
  }

  const dadosCartoesGrafico = resumoCartoes.map(c => ({
    name: c.nome,
    gasto: c.faturaMes
  }));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-emerald-500 selection:text-slate-950">
      
      {/* MODAL DE DAR BAIXA EM CONTA ESCOLHENDO O BANCO */}
      {modalBaixaConta && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" /> Confirmar Baixa de Conta
              </h3>
              <button onClick={() => setModalBaixaConta(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={confirmarBaixaContaModal} className="space-y-4">
              <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-xl">
                <p className="text-sm font-bold text-slate-200">{modalBaixaConta.transacao.descricao}</p>
                <p className="text-xs text-emerald-400 font-semibold mt-0.5">Valor: R$ {Number(modalBaixaConta.transacao.valor).toFixed(2)}</p>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Forma de Pagamento</label>
                <select
                  value={modalBaixaConta.metodoEscolhido}
                  onChange={e => setModalBaixaConta({ ...modalBaixaConta, metodoEscolhido: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                >
                  <option value="PIX">PIX</option>
                  <option value="DEBITO">Cartão de Débito</option>
                  <option value="DINHEIRO">Dinheiro</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">De qual Conta Bancária vai sair/entrar?</label>
                <select
                  value={modalBaixaConta.bancoEscolhido}
                  onChange={e => setModalBaixaConta({ ...modalBaixaConta, bancoEscolhido: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                >
                  {saldosPorBanco.map(b => (
                    <option key={b.id} value={b.nome}>{b.nome} (Saldo: R$ {b.saldoAtualConta.toFixed(2)})</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs">
                  Confirmar e Dar Baixa
                </button>
                <button type="button" onClick={() => setModalBaixaConta(null)} className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DE PAGAMENTO TOTAL OU PARCIAL DA FATURA */}
      {modalPagarFatura && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-emerald-400" /> Pagar Fatura — {modalPagarFatura.cartaoNome}
              </h3>
              <button onClick={() => setModalPagarFatura(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={confirmarPagamentoFatura} className="space-y-4">
              <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-xl flex justify-between items-center">
                <span className="text-xs text-slate-400">Total da Fatura ({filtroMesAno}):</span>
                <strong className="text-base text-rose-400">R$ {modalPagarFatura.valorFatura.toFixed(2)}</strong>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setModalPagarFatura({ ...modalPagarFatura, tipoPagamento: 'TOTAL', valorPago: modalPagarFatura.valorFatura.toFixed(2) })}
                  className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition ${modalPagarFatura.tipoPagamento === 'TOTAL' ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-slate-950 text-slate-400 border-slate-800'}`}
                >
                  Pagar Valor Total
                </button>
                <button
                  type="button"
                  onClick={() => setModalPagarFatura({ ...modalPagarFatura, tipoPagamento: 'PARCIAL', valorPago: '' })}
                  className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition ${modalPagarFatura.tipoPagamento === 'PARCIAL' ? 'bg-amber-500 text-slate-950 border-amber-400' : 'bg-slate-950 text-slate-400 border-slate-800'}`}
                >
                  Pagar Valor Parcial
                </button>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Valor a Pagar (R$)</label>
                <input 
                  type="number" step="0.01" required
                  disabled={modalPagarFatura.tipoPagamento === 'TOTAL'}
                  value={modalPagarFatura.valorPago}
                  onChange={e => setModalPagarFatura({ ...modalPagarFatura, valorPago: e.target.value })}
                  placeholder="Digite o valor parcial..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="text-xs text-emerald-400 font-semibold block mb-1">
                  🏦 De qual conta bancária vai debitar o pagamento?
                </label>
                <select
                  value={modalPagarFatura.bancoSaida}
                  onChange={e => setModalPagarFatura({ ...modalPagarFatura, bancoSaida: e.target.value })}
                  className="w-full bg-slate-950 border border-emerald-500/40 rounded-xl px-3.5 py-2.5 text-sm text-slate-100"
                >
                  {saldosPorBanco.map(b => (
                    <option key={b.id} value={b.nome}>
                      {b.nome} (Saldo atual: R$ {b.saldoAtualConta.toFixed(2)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs">
                  Confirmar e Lançar no Extrato
                </button>
                <button type="button" onClick={() => setModalPagarFatura(null)} className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DE EDIÇÃO DE LANÇAMENTO */}
      {transacaoEditando && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md space-y-4 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-emerald-400" /> Editar Lançamento
              </h3>
              <button onClick={() => setTransacaoEditando(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* CHECKBOX: APLICAR EM PARCELAS FUTURAS */}
            {transacaoEditando.grupo_id && (
              <div className="flex items-center gap-3 mt-2 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <input 
                  type="checkbox" 
                  id="aplicarFuturas"
                  checked={aplicarFuturasEdicao} 
                  onChange={e => setAplicarFuturasEdicao(e.target.checked)}
                  className="w-4 h-4 accent-amber-500 rounded cursor-pointer shrink-0"
                />
                <label htmlFor="aplicarFuturas" className="text-xs font-semibold text-amber-400 cursor-pointer">
                  Alterar valor e categorias também nesta e em TODAS as parcelas futuras desta compra.
                </label>
              </div>
            )}

            <form onSubmit={salvarEdicaoTransacao} className="space-y-3.5">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Descrição</label>
                <input 
                  type="text" value={transacaoEditando.descricao} 
                  onChange={e => setTransacaoEditando({ ...transacaoEditando, descricao: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Valor (R$)</label>
                  <input 
                    type="number" step="0.01" value={transacaoEditando.valor} 
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, valor: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Data / Vencimento</label>
                  <input 
                    type="date" value={transacaoEditando.data_vencimento || hojeIso} 
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, data_vencimento: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Categoria</label>
                  <select 
                    value={transacaoEditando.categoria}
                    onChange={e => {
                      const novaC = e.target.value;
                      const subsDaNova = subcategorias[novaC] || ['Geral'];
                      setTransacaoEditando({ ...transacaoEditando, categoria: novaC, subcategoria: subsDaNova[0] });
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  >
                    {categorias.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Subcategoria</label>
                  <select 
                    value={transacaoEditando.subcategoria || 'Geral'}
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, subcategoria: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  >
                    {(subcategorias[transacaoEditando.categoria] || ['Geral']).map(sub => (
                      <option key={sub} value={sub}>{sub}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Forma Pagamento</label>
                  <select 
                    value={transacaoEditando.metodo}
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, metodo: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  >
                    <option value="PIX">PIX</option>
                    <option value="DEBITO">Débito</option>
                    <option value="CREDITO">Cartão de Crédito</option>
                    <option value="DINHEIRO">Dinheiro</option>
                    <option value="BOLETO / AGENDADO">Boleto / Agendado</option>
                  </select>
                </div>
                {transacaoEditando.metodo === 'CREDITO' ? (
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Cartão</label>
                    <select 
                      value={transacaoEditando.cartao_nome || cartoes[0]?.nome}
                      onChange={e => setTransacaoEditando({ ...transacaoEditando, cartao_nome: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                    >
                      {cartoes.map(c => <option key={c.id} value={c.nome}>{c.nome}</option>)}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Conta Bancária</label>
                    <select 
                      value={transacaoEditando.banco_nome || bancos[0]?.nome}
                      onChange={e => setTransacaoEditando({ ...transacaoEditando, banco_nome: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                    >
                      {bancos.map(b => <option key={b.id} value={b.nome}>{b.nome}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-2">
                <button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs">
                  Salvar Alterações
                </button>
                <button type="button" onClick={() => setTransacaoEditando(null)} className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL DE EXCLUSÃO DE PARCELAS EM LOTE */}
      {transacaoExcluindo && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-rose-500/30 rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base text-rose-400 flex items-center gap-2">
                <Trash2 className="w-5 h-5" /> Excluir Compra Parcelada
              </h3>
              <button onClick={() => setTransacaoExcluindo(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-xl text-center">
              <p className="text-sm font-bold text-slate-200">{transacaoExcluindo.descricao}</p>
              <p className="text-xs text-slate-400 mt-1">Parcela atual: {transacaoExcluindo.parcela_atual} de {transacaoExcluindo.parcelas_total}</p>
            </div>
            
            <form onSubmit={confirmarExclusaoLote} className="space-y-4">
              <div className="space-y-2">
                <label className="flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition bg-slate-950 border-slate-800 hover:border-slate-700">
                  <input 
                    type="radio" 
                    name="tipoExclusao" 
                    checked={!aplicarFuturasExclusao} 
                    onChange={() => setAplicarFuturasExclusao(false)}
                    className="accent-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-xs text-slate-300 font-medium">Excluir APENAS esta parcela</span>
                </label>
                <label className="flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition bg-rose-500/10 border-rose-500/30 hover:border-rose-500/50">
                  <input 
                    type="radio" 
                    name="tipoExclusao" 
                    checked={aplicarFuturasExclusao} 
                    onChange={() => setAplicarFuturasExclusao(true)}
                    className="accent-rose-500 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-xs text-rose-300 font-medium">Excluir esta e TODAS AS FUTURAS</span>
                </label>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="submit" className="flex-1 bg-rose-500 hover:bg-rose-400 text-white font-semibold py-2.5 rounded-xl text-xs transition">
                  Confirmar Exclusão
                </button>
                <button type="button" onClick={() => setTransacaoExcluindo(null)} className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs transition">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SIDEBAR MODERNA */}
      <aside className="w-full md:w-72 bg-slate-900/50 backdrop-blur-xl border-r border-slate-800/80 p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3.5 mb-8">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-bold text-base leading-tight tracking-tight">FinZap SaaS</h1>
              <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> IA Financeira Ativa
              </span>
            </div>
          </div>

          <nav className="space-y-1">
            <button onClick={() => setAbaAtiva('dashboard')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'dashboard' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <BarChart2 className="w-4 h-4" /> Dashboard & IA
            </button>
            <button onClick={() => setAbaAtiva('movimentacao')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'movimentacao' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <FileText className="w-4 h-4" /> Movimentação (Extrato)
            </button>
            <button onClick={() => setAbaAtiva('vencimentos')} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'vencimentos' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-3">
                <Clock className="w-4 h-4" /> A Vencer & Receber
              </span>
              {transacoesFiltradas.some(t => t.pago === false) && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold">
                  {transacoesFiltradas.filter(t => t.pago === false).length}
                </span>
              )}
            </button>
            <button onClick={() => setAbaAtiva('saldos')} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'saldos' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-3">
                <Wallet className="w-4 h-4" /> Saldos & Transferências
              </span>
              {saldosPorBanco.some(b => b.emChequeEspecial) && (
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" title="Conta em Cheque Especial!"></span>
              )}
            </button>
            <button onClick={() => setAbaAtiva('cartoes')} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'cartoes' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-3">
                <CreditCard className="w-4 h-4" /> Cartões de Crédito
              </span>
              {resumoCartoes.some(c => c.alerta80) && (
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
              )}
            </button>
            <button onClick={() => setAbaAtiva('bancos')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'bancos' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Landmark className="w-4 h-4" /> Cadastro Bancos/Cartões
            </button>
            <button onClick={() => setAbaAtiva('categorias')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'categorias' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <FolderPlus className="w-4 h-4" /> Categorias & Subcategorias
            </button>
            <button onClick={() => setAbaAtiva('whatsapp')} className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-medium transition ${abaAtiva === 'whatsapp' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-3">
                <QrCode className="w-4 h-4" /> Conexão WhatsApp
              </span>
              <span className={`w-2.5 h-2.5 rounded-full ${whatsappStatus === 'CONNECTED' ? 'bg-emerald-400 shadow-sm shadow-emerald-400' : 'bg-amber-400 animate-pulse'}`}></span>
            </button>
          </nav>
        </div>

        <div className="pt-6 border-t border-slate-800/80 space-y-3">
          <div className="px-3.5 py-2.5 bg-slate-950/60 rounded-xl border border-slate-800/60 text-xs text-slate-300 truncate">
            <span className="block text-[10px] text-slate-500 uppercase font-semibold mb-0.5">Conta Logada</span>
            {user.email}
          </div>
          <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition border border-rose-500/20">
            <LogOut className="w-3.5 h-3.5" /> Sair do Sistema
          </button>
        </div>
      </aside>

      {/* CONTEÚDO PRINCIPAL */}
      <main className="flex-1 p-6 md:p-8 overflow-y-auto grid grid-cols-1 lg:grid-cols-3 gap-8 bg-slate-950">
        
        <div className="lg:col-span-2 space-y-6">

          {/* SELETOR GLOBAL DE MÊS VISÍVEL EM TODAS AS ABAS */}
          <div className="bg-slate-900/70 backdrop-blur-xl border border-slate-800/80 p-3.5 rounded-2xl flex flex-col sm:flex-row justify-between items-center gap-3 shadow-xl">
            <div className="flex items-center gap-2 text-slate-200 text-xs font-semibold">
              <Calendar className="w-4 h-4 text-emerald-400" />
              <span>Competência Financeira Ativa:</span>
            </div>
            <div className="flex items-center gap-2">
              <button 
                type="button" onClick={() => alterarMesCompetencia(-1)}
                className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-slate-300 transition"
                title="Mês Anterior"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input 
                type="month" 
                value={filtroMesAno} 
                onChange={e => setFiltroMesAno(e.target.value)} 
                className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-1.5 text-xs text-emerald-400 font-bold focus:outline-none focus:border-emerald-500 transition"
              />
              <button 
                type="button" onClick={() => alterarMesCompetencia(1)}
                className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-slate-300 transition"
                title="Próximo Mês"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {filtroMesAno !== mesAtualStr && (
                <button 
                  type="button" onClick={() => setFiltroMesAno(mesAtualStr)}
                  className="text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1.5 rounded-xl font-semibold"
                >
                  Mês Atual
                </button>
              )}
            </div>
          </div>

          {/* BANNER DE ALERTA: WHATSAPP DESCONECTADO */}
          {whatsappStatus !== 'CONNECTED' && (
            <div className="bg-amber-500/10 border border-amber-500/30 p-4 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-xl">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 bg-amber-500/20 text-amber-400 rounded-xl flex items-center justify-center shrink-0 border border-amber-500/30">
                  <AlertTriangle className="w-5 h-5 animate-bounce" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-amber-300 flex items-center gap-2">
                    WhatsApp Desconectado
                  </h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Conecte o QR Code para receber alertas de vencimento e lançar gastos pelo celular.
                  </p>
                </div>
              </div>
              {abaAtiva !== 'whatsapp' && (
                <button 
                  onClick={() => setAbaAtiva('whatsapp')}
                  className="w-full sm:w-auto bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs px-4 py-2.5 rounded-xl transition whitespace-nowrap"
                >
                  Conectar Agora
                </button>
              )}
            </div>
          )}

          {/* BANNER DE ALERTA DE USO DO CHEQUE ESPECIAL */}
          {saldosPorBanco.filter(b => b.emChequeEspecial).map(b => (
            <div key={b.id} className="p-4 rounded-2xl border bg-rose-500/15 border-rose-500/50 flex items-center justify-between gap-4 shadow-xl">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 animate-pulse" />
                <div>
                  <h4 className="text-xs font-bold uppercase text-rose-300">
                    🚨 Alerta de Cheque Especial — Conta {b.nome}
                  </h4>
                  <p className="text-xs text-slate-200 mt-0.5">
                    O saldo da conta <strong>{b.nome}</strong> está negativo em <strong className="text-rose-400">R$ {b.saldoAtualConta.toFixed(2)}</strong>. Faça uma transferência para cobrir a conta!
                  </p>
                </div>
              </div>
              <button onClick={() => setAbaAtiva('saldos')} className="text-xs font-semibold underline text-rose-200 whitespace-nowrap">
                Transferir Saldo
              </button>
            </div>
          ))}

          {/* BANNER DE ALERTA DE LIMITE DE CARTÃO DE CRÉDITO */}
          {resumoCartoes.filter(c => c.alerta80).map(c => (
            <div key={c.id} className={`p-4 rounded-2xl border flex items-center justify-between gap-4 shadow-xl ${c.estourado ? 'bg-rose-500/10 border-rose-500/40' : 'bg-amber-500/10 border-amber-500/30'}`}>
              <div className="flex items-center gap-3">
                <ShieldAlert className={`w-5 h-5 shrink-0 ${c.estourado ? 'text-rose-400' : 'text-amber-400'}`} />
                <div>
                  <h4 className={`text-xs font-bold uppercase ${c.estourado ? 'text-rose-300' : 'text-amber-300'}`}>
                    {c.estourado ? `Limite do Cartão ${c.nome} Estourado!` : `Atenção ao Limite do Cartão ${c.nome} (${c.pctUso}%)`}
                  </h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Comprometido: <strong>R$ {c.comprometidoTotal.toFixed(2)}</strong> de R$ {Number(c.limite).toFixed(2)} • Disponível: <strong>R$ {c.disponivel.toFixed(2)}</strong>
                  </p>
                </div>
              </div>
              <button onClick={() => setAbaAtiva('cartoes')} className="text-xs font-semibold underline text-slate-200 whitespace-nowrap">
                Ver Fatura
              </button>
            </div>
          ))}
          
          {/* ================================================================
              ABA 1: DASHBOARD & IA
          ================================================================ */}
          {abaAtiva === 'dashboard' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Resultado de {filtroMesAno}</span>
                  <p className={`text-2xl font-bold mt-1.5 tracking-tight ${saldoAtual >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    R$ {saldoAtual.toFixed(2)}
                  </p>
                </div>
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Receitas Efetivadas
                  </span>
                  <p className="text-2xl font-bold mt-1.5 text-slate-100 tracking-tight">R$ {totalReceitas.toFixed(2)}</p>
                </div>
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-rose-400" /> Despesas Totais
                  </span>
                  <p className="text-2xl font-bold mt-1.5 text-slate-100 tracking-tight">R$ {totalDespesas.toFixed(2)}</p>
                </div>
              </div>

              {/* PAINEL PREDITIVO */}
              <div className="bg-gradient-to-br from-emerald-950/30 via-slate-900/80 to-slate-900/80 border border-emerald-500/20 p-5 rounded-2xl space-y-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-emerald-400" /> Diagnóstico & Saldos Rápidos
                  </h2>
                  <button onClick={() => setAbaAtiva('saldos')} className="text-xs text-emerald-400 hover:underline">
                    Transferir / Ver Saldos →
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Saldo Geral em Contas</span>
                    <p className={`text-lg font-bold mt-1 ${saldoTotalBancos >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      R$ {saldoTotalBancos.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Soma de {bancos.length} conta(s) bancária(s)
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Ritmo Diário (Burn Rate)</span>
                    <p className="text-lg font-bold text-slate-100 mt-1">R$ {gastoMedioDiario.toFixed(2)} <span className="text-xs font-normal text-slate-400">/dia</span></p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Projeção fim do mês: <strong className={projecaoSaldoFimMes >= 0 ? 'text-emerald-400' : 'text-rose-400'}>R$ {projecaoDespesasMes.toFixed(2)}</strong>
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Contas a Vencer ({filtroMesAno})</span>
                    <p className="text-lg font-bold text-amber-400 mt-1">
                      R$ {transacoesFiltradas.filter(t => t.pago === false && t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0).toFixed(2)}
                    </p>
                    <button onClick={() => setAbaAtiva('vencimentos')} className="text-[11px] text-emerald-400 hover:underline mt-1.5 block">
                      Gerenciar vencimentos →
                    </button>
                  </div>
                </div>
              </div>

              {/* LIMITES POR CATEGORIA */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Target className="w-4 h-4 text-emerald-400" /> Limites por Categoria ({filtroMesAno})
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {categorias.filter(cat => cat !== 'Receita').map(cat => {
                    const gastoCat = transacoesFiltradas
                      .filter(t => t.tipo === 'DESPESA' && t.categoria === cat && t.metodo !== 'PAGAMENTO_FATURA' && t.metodo !== 'TRANSFERENCIA')
                      .reduce((acc, t) => acc + Number(t.valor || 0), 0);
                    
                    const limite = orcamentos[cat] || 0;
                    const ultrapassou = limite > 0 && gastoCat > limite;
                    const porcentagem = limite > 0 ? Math.min(Math.round((gastoCat / limite) * 100), 100) : 0;

                    return (
                      <div key={cat} className={`p-4 rounded-xl border transition ${ultrapassou ? 'bg-rose-950/20 border-rose-500/40' : 'bg-slate-950/60 border-slate-800/80'}`}>
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-medium text-sm text-slate-200">{cat}</span>
                          {ultrapassou ? (
                            <span className="flex items-center gap-1 text-[11px] text-rose-400 font-bold bg-rose-500/10 px-2.5 py-0.5 rounded-full border border-rose-500/20">
                              <AlertTriangle className="w-3 h-3" /> Estourado!
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-400 font-medium">
                              {limite > 0 ? `Limite: R$ ${limite.toFixed(2)}` : 'Sem limite'}
                            </span>
                          )}
                        </div>

                        <div className="flex justify-between items-center text-xs mb-1.5">
                          <span className="text-slate-400">Gasto: <strong className="text-slate-200">R$ {gastoCat.toFixed(2)}</strong></span>
                          {limite > 0 && <span className="text-slate-400 font-medium">{porcentagem}%</span>}
                        </div>

                        {limite > 0 && (
                          <div className="w-full bg-slate-800/80 h-2 rounded-full overflow-hidden">
                            <div 
                              className={`h-full transition-all duration-500 ${ultrapassou ? 'bg-rose-500' : 'bg-emerald-500'}`} 
                              style={{ width: `${porcentagem}%` }}
                            ></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* GRÁFICOS (COM DRILL-DOWN CATEGORIA > SUBCATEGORIA) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl flex flex-col items-center shadow-xl">
                  <div className="w-full flex justify-between items-center mb-3">
                    <h2 className="text-sm font-semibold text-slate-200">
                      {categoriaSelecionadaGrafico ? `Detalhes: ${categoriaSelecionadaGrafico}` : 'Despesas por Categoria'}
                    </h2>
                    {categoriaSelecionadaGrafico && (
                      <button 
                        onClick={() => setCategoriaSelecionadaGrafico(null)}
                        className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg transition font-bold"
                      >
                        ← Voltar
                      </button>
                    )}
                  </div>
                  
                  {dadosGraficoDespesas.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-slate-500">Sem despesas registradas</div>
                  ) : (
                    <div className="w-full h-48 relative">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie 
                            data={dadosGraficoDespesas} 
                            dataKey="value" 
                            nameKey="name" 
                            cx="50%" cy="50%" outerRadius={60} 
                            label 
                            onClick={(data) => {
                              if (!categoriaSelecionadaGrafico) setCategoriaSelecionadaGrafico(data.name);
                            }}
                            style={{ cursor: !categoriaSelecionadaGrafico ? 'pointer' : 'default' }}
                          >
                            {dadosGraficoDespesas.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={CORES_GRAFICO[index % CORES_GRAFICO.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ backgroundColor: '#090d16', borderColor: '#1e293b', borderRadius: '12px', fontSize: '12px', color: '#f8fafc' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {!categoriaSelecionadaGrafico && dadosGraficoDespesas.length > 0 && (
                    <p className="text-[10px] text-emerald-500/70 mt-2 animate-pulse font-medium">💡 Clique numa fatia para ver os detalhes</p>
                  )}
                </div>

                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl flex flex-col items-center shadow-xl">
                  <h2 className="text-sm font-semibold text-slate-200 mb-3 w-full text-left">Fatura Atual por Cartão</h2>
                  <div className="w-full h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dadosCartoesGrafico}>
                        <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
                        <YAxis stroke="#64748b" fontSize={12} />
                        <Tooltip contentStyle={{ backgroundColor: '#090d16', borderColor: '#1e293b', borderRadius: '12px', fontSize: '12px', color: '#f8fafc' }} />
                        <Bar dataKey="gasto" fill="#34d399" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ================================================================
              ABA 2: MOVIMENTAÇÃO (EXTRATO)
          ================================================================ */}
          {abaAtiva === 'movimentacao' && (
            <div className="space-y-6">
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                <div className="flex justify-between items-center flex-wrap gap-4">
                  <div>
                    <h2 className="text-lg font-bold flex items-center gap-2">
                      <FileText className="w-5 h-5 text-emerald-400" /> Extrato de Movimentação ({filtroMesAno})
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Entradas, saídas, transferências, pagamentos de fatura e a projeção da fatura no dia do vencimento.
                    </p>
                  </div>
                  <button 
                    onClick={exportarParaExcel}
                    className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition"
                  >
                    📥 Exportar para Excel
                  </button>
                </div>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-4 rounded-2xl space-y-3 shadow-xl">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input 
                    type="text" placeholder="Pesquisar por descrição, categoria ou subcategoria..."
                    value={pesquisaExtrato} onChange={e => setPesquisaExtrato(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { id: 'TODOS', label: 'Todos' },
                    { id: 'RECEITA', label: '🟢 Entradas' },
                    { id: 'DESPESA', label: '🔴 Saídas (Pix/Débito)' },
                    { id: 'CREDITO', label: '💳 Compras no Crédito' },
                    { id: 'FATURA', label: '📅 Faturas & Pagamentos' }
                  ].map(f => (
                    <button
                      key={f.id} onClick={() => setFiltroTipoExtrato(f.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${filtroTipoExtrato === f.id ? 'bg-emerald-500 text-slate-950' : 'bg-slate-950 text-slate-400 border border-slate-800'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-3 shadow-xl">
                {listaMovimentacaoExtrato.length === 0 ? (
                  <p className="text-sm text-slate-500 py-8 text-center">Nenhuma movimentação encontrada para este filtro.</p>
                ) : (
                  listaMovimentacaoExtrato.map(item => (
                    <div 
                      key={item.id} 
                      className={`flex items-center justify-between p-4 rounded-xl border transition ${
                        item.isLinhaFatura 
                          ? 'bg-amber-500/10 border-amber-500/40' 
                          : item.metodo === 'PAGAMENTO_FATURA'
                            ? 'bg-sky-500/10 border-sky-500/40'
                            : 'bg-slate-950/70 border-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center gap-3.5">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                          item.isLinhaFatura 
                            ? 'bg-amber-500/20 text-amber-400' 
                            : item.metodo === 'PAGAMENTO_FATURA'
                              ? 'bg-sky-500/20 text-sky-400'
                              : item.tipo === 'RECEITA' 
                                ? 'bg-emerald-500/10 text-emerald-400' 
                                : 'bg-rose-500/10 text-rose-400'
                        }`}>
                          {item.isLinhaFatura || item.metodo === 'PAGAMENTO_FATURA' ? <CreditCard className="w-4 h-4" /> : item.tipo === 'RECEITA' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-slate-100 flex items-center gap-2 flex-wrap">
                            {item.descricao}
                            {item.isLinhaFatura && (
                              <span className="text-[10px] bg-amber-500 text-slate-950 font-bold px-2 py-0.5 rounded-full">
                                TOTAL DA FATURA NO VENCIMENTO
                              </span>
                            )}
                            {item.metodo === 'PAGAMENTO_FATURA' && (
                              <span className="text-[10px] bg-sky-500 text-slate-950 font-bold px-2 py-0.5 rounded-full">
                                PAGAMENTO DE FATURA
                              </span>
                            )}
                            {!item.isLinhaFatura && item.pago === false && (
                              <span className="text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded-full">
                                Em Aberto
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            Data: <strong>{formatarDataBR(item.data_vencimento)}</strong> • <span className="text-emerald-400 font-medium">{item.categoria} &gt; {item.subcategoria || 'Geral'}</span> • <span className="text-slate-300">{item.cartao_nome ? `Cartão ${item.cartao_nome}` : `${item.metodo} (${item.banco_nome || 'Geral'})`}</span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`font-bold text-sm ${item.isLinhaFatura ? 'text-amber-400' : item.tipo === 'RECEITA' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {item.tipo === 'RECEITA' ? '+' : '-'} R$ {Number(item.valor || 0).toFixed(2)}
                        </span>
                        {!item.isLinhaFatura && (
                          <>
                            <button onClick={() => iniciarEdicaoTransacao(item)} className="text-slate-400 hover:text-sky-400 p-1">
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button onClick={() => iniciarExclusaoTransacao(item)} className="text-slate-500 hover:text-rose-400 p-1">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 3: CONTAS A VENCER & A RECEBER
          ================================================================ */}
          {abaAtiva === 'vencimentos' && (
            <div className="space-y-6">
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-4 shadow-xl">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <h2 className="text-lg font-bold flex items-center gap-2">
                      <Clock className="w-5 h-5 text-amber-400" /> Lançar Conta a Vencer ou Valor a Receber
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Pelo WhatsApp envie: <em>"Água vence 25/10 valor 80,00"</em> ou dê baixa enviando <em>"paguei a água no pix Itaú"</em>.
                    </p>
                  </div>
                  <button 
                    onClick={dispararTesteAlertaWhatsApp}
                    className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition"
                  >
                    <BellRing className="w-3.5 h-3.5" /> Testar Alerta
                  </button>
                </div>

                <form onSubmit={lancarContaAgendada} className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                  <input 
                    type="text" required placeholder="Descrição (ex: Conta de Água)" value={formAgendamento.descricao}
                    onChange={e => setFormAgendamento({ ...formAgendamento, descricao: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" step="0.01" required placeholder="Valor (R$)" value={formAgendamento.valor}
                    onChange={e => setFormAgendamento({ ...formAgendamento, valor: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="date" required value={formAgendamento.data_vencimento}
                    onChange={e => setFormAgendamento({ ...formAgendamento, data_vencimento: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <select 
                    value={formAgendamento.tipo}
                    onChange={e => setFormAgendamento({ ...formAgendamento, tipo: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    <option value="DESPESA">🔴 Conta a Pagar</option>
                    <option value="RECEITA">🟢 Valor a Receber</option>
                  </select>
                  <select 
                    value={formAgendamento.categoria}
                    onChange={e => {
                      const c = e.target.value;
                      setFormAgendamento({ ...formAgendamento, categoria: c, subcategoria: (subcategorias[c] || ['Geral'])[0] });
                    }}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {categorias.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                  <button type="submit" className="sm:col-span-6 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                    + Agendar Conta com Vencimento
                  </button>
                </form>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-4 rounded-2xl grid grid-cols-1 sm:grid-cols-4 gap-3 shadow-xl">
                <input 
                  type="text" placeholder="🔍 Filtrar por nome..." value={filtroVencNome}
                  onChange={e => setFiltroVencNome(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200"
                />
                <select 
                  value={filtroVencCat} onChange={e => setFiltroVencCat(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200"
                >
                  <option value="TODAS">Todas as Categorias</option>
                  {categorias.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
                <select 
                  value={filtroVencStatus} onChange={e => setFiltroVencStatus(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200"
                >
                  <option value="TODOS">Status: Todos</option>
                  <option value="ABERTO">⏳ Em Aberto (A Vencer)</option>
                  <option value="PAGO">✅ Pago / Recebido</option>
                </select>
                <select 
                  value={filtroVencData} onChange={e => setFiltroVencData(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200"
                >
                  <option value="TODOS">Vencimento: Todo o Mês</option>
                  <option value="PROXIMOS_5_DIAS">🔥 Próximos 5 Dias</option>
                  <option value="VENCIDOS">🚨 Atrasados / Vencidos</option>
                </select>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-3 shadow-xl">
                {listaContasVencerReceber.length === 0 ? (
                  <p className="text-sm text-slate-500 py-8 text-center">Nenhuma conta encontrada para os filtros selecionados.</p>
                ) : (
                  listaContasVencerReceber.map(t => (
                    <div key={t.id} className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${t.pago ? 'bg-emerald-950/10 border-emerald-500/20' : 'bg-slate-950/80 border-amber-500/30'}`}>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${t.tipo === 'RECEITA' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                            {t.tipo === 'RECEITA' ? 'A RECEBER' : 'A PAGAR'}
                          </span>
                          <p className="font-semibold text-sm text-slate-100">{t.descricao}</p>
                          <span className="text-xs text-emerald-400">({t.categoria} &gt; {t.subcategoria || 'Geral'})</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          Vencimento: <strong className="text-amber-300">{formatarDataBR(t.data_vencimento)}</strong> • Status: <strong>{t.pago ? `Pago (${t.banco_nome || t.metodo})` : 'Em Aberto'}</strong>
                        </p>
                      </div>

                      <div className="flex items-center gap-3 self-end sm:self-center">
                        <span className={`font-bold text-sm ${t.tipo === 'RECEITA' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          R$ {Number(t.valor || 0).toFixed(2)}
                        </span>
                        <button
                          onClick={() => clicarDarBaixaConta(t)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition ${
                            t.pago 
                              ? 'bg-slate-800 text-emerald-400 hover:bg-slate-700' 
                              : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                          }`}
                        >
                          {t.pago ? <><CheckCircle2 className="w-3.5 h-3.5" /> Pago</> : <><Zap className="w-3.5 h-3.5" /> Dar Baixa</>}
                        </button>
                        <button onClick={() => iniciarEdicaoTransacao(t)} className="text-slate-400 hover:text-sky-400 p-1">
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button onClick={() => iniciarExclusaoTransacao(t)} className="text-slate-500 hover:text-rose-400 p-1">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <div>
                  <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <BellRing className="w-4 h-4 text-emerald-400" /> Lembretes Fixos Mensais no WhatsApp
                  </h3>
                </div>
                <form onSubmit={adicionarContaFixa} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <input type="text" placeholder="Nome (ex: Energia)" value={fixaNome} onChange={e => setFixaNome(e.target.value)} className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200" />
                  <input type="number" placeholder="Valor Padrão (R$)" value={fixaValor} onChange={e => setFixaValor(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200" />
                  <input type="number" min="1" max="31" placeholder="Dia Venc. (ex: 15)" value={fixaDia} onChange={e => setFixaDia(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200" />
                  <button type="submit" className="sm:col-span-4 bg-slate-800 hover:bg-slate-700 text-emerald-400 py-2.5 rounded-xl font-semibold text-xs transition">+ Adicionar Lembrete Fixo Mensal</button>
                </form>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {contasFixas.map(cf => {
                    const jaPaga = transacoesFiltradas.some(
                      t => (t.conta_fixa_id === cf.id || t.descricao?.toLowerCase().includes(cf.nome.toLowerCase())) && t.pago !== false
                    );
                    return (
                      <div key={cf.id} className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-200">{cf.nome}</p>
                          <p className="text-[11px] text-slate-400">Todo dia {cf.diaVencimento} • R$ {Number(cf.valorPadrao).toFixed(2)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {jaPaga ? (
                            <span className="text-[11px] text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-1 rounded-lg">Pago no mês</span>
                          ) : (
                            <button onClick={() => pagarContaFixaRapido(cf)} className="text-[11px] bg-amber-500 text-slate-950 font-semibold px-2.5 py-1 rounded-lg">Dar Baixa</button>
                          )}
                          <button onClick={() => excluirContaFixa(cf.id)} className="text-slate-500 hover:text-rose-400 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 4: SALDOS & TRANSFERÊNCIAS
          ================================================================ */}
          {abaAtiva === 'saldos' && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-500/30 p-6 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-xl">
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-emerald-400">Patrimônio Líquido Disponível</span>
                  <h2 className={`text-3xl font-bold mt-1 ${saldoTotalBancos >= 0 ? 'text-slate-100' : 'text-rose-400'}`}>
                    R$ {saldoTotalBancos.toFixed(2)}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Calculado a partir do Saldo Inicial + Entradas - Saídas (incluindo transferências e faturas pagas).
                  </p>
                </div>
                <button 
                  onClick={() => setAbaAtiva('bancos')}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl text-xs font-semibold transition"
                >
                  + Editar Contas / Saldo Inicial
                </button>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4 text-sky-400" /> Transferência entre Contas Bancárias
                </h3>
                <form onSubmit={realizarTransferenciaEntreContas} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1">Saiu de (Origem)</label>
                    <select
                      value={formTransferencia.bancoOrigem}
                      onChange={e => setFormTransferencia({ ...formTransferencia, bancoOrigem: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                    >
                      {bancos.map(b => <option key={b.id} value={b.nome}>{b.nome}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1">Entrou em (Destino)</label>
                    <select
                      value={formTransferencia.bancoDestino}
                      onChange={e => setFormTransferencia({ ...formTransferencia, bancoDestino: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                    >
                      {bancos.map(b => <option key={b.id} value={b.nome}>{b.nome}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 block mb-1">Valor (R$)</label>
                    <input
                      type="number" step="0.01" required placeholder="0,00"
                      value={formTransferencia.valor}
                      onChange={e => setFormTransferencia({ ...formTransferencia, valor: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                    />
                  </div>
                  <div className="flex items-end">
                    <button type="submit" className="w-full bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                      🔄 Transferir Agora
                    </button>
                  </div>
                </form>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {saldosPorBanco.map(b => (
                  <div key={b.id} className={`backdrop-blur-xl border p-5 rounded-2xl space-y-4 shadow-xl ${b.emChequeEspecial ? 'bg-rose-950/20 border-rose-500/50' : 'bg-slate-900/60 border-slate-800/80'}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-sky-400">{b.tipo}</span>
                        <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                          {b.nome}
                          {b.emChequeEspecial && (
                            <span className="text-[10px] bg-rose-500 text-slate-950 font-bold px-2 py-0.5 rounded-full">
                              CHEQUE ESPECIAL
                            </span>
                          )}
                        </h3>
                      </div>
                      <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center">
                        <Landmark className="w-5 h-5" />
                      </div>
                    </div>

                    <div className="bg-slate-950/80 border border-slate-800/80 p-4 rounded-xl">
                      <span className="text-xs text-slate-400 block">Saldo Atual Disponível</span>
                      <strong className={`text-2xl font-bold ${b.saldoAtualConta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        R$ {b.saldoAtualConta.toFixed(2)}
                      </strong>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-xs bg-slate-950/50 p-3 rounded-xl border border-slate-800/50">
                      <div>
                        <span className="block text-[10px] text-slate-500">Saldo Inicial</span>
                        <strong className="text-slate-300">R$ {Number(b.saldoInicial || 0).toFixed(2)}</strong>
                      </div>
                      <div className="border-x border-slate-800">
                        <span className="block text-[10px] text-slate-500">Entradas</span>
                        <strong className="text-emerald-400">+ R$ {b.entradasBanco.toFixed(2)}</strong>
                      </div>
                      <div>
                        <span className="block text-[10px] text-slate-500">Saídas</span>
                        <strong className="text-rose-400">- R$ {b.saidasBanco.toFixed(2)}</strong>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 5: CARTÃO DE CRÉDITO & LANÇAMENTOS FLEXÍVEIS
          ================================================================ */}
          {abaAtiva === 'cartoes' && (
            <div className="space-y-6">
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <CreditCard className="w-5 h-5 text-emerald-400" /> Cartões de Crédito & Faturas ({filtroMesAno})
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Pague o valor total ou parcial escolhendo de qual banco debitar, acompanhe o melhor dia de compra e o limite real.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {resumoCartoes.map(c => (
                  <div key={c.id} className={`p-5 rounded-2xl border space-y-4 shadow-xl transition ${c.estourado ? 'bg-rose-950/20 border-rose-500/40' : c.alerta80 ? 'bg-amber-950/15 border-amber-500/40' : 'bg-slate-900/60 border-slate-800/80'}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">{c.banco || 'Cartão de Crédito'}</span>
                        <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                          {c.nome}
                          {c.isMelhorDiaHoje && (
                            <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-semibold">
                              ⭐ Melhor Dia
                            </span>
                          )}
                        </h3>
                      </div>
                      <button 
                        onClick={() => abrirModalPagamentoFatura(c)}
                        className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs px-3.5 py-2 rounded-xl transition shadow-md shadow-emerald-500/10"
                      >
                        Pagar Fatura
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2 bg-slate-950/70 p-3 rounded-xl border border-slate-800/70 text-center">
                      <div>
                        <span className="block text-[10px] text-slate-400 uppercase">Fechamento</span>
                        <strong className="text-xs text-slate-200">Dia {c.diaFechamento || 5}</strong>
                      </div>
                      <div className="border-x border-slate-800">
                        <span className="block text-[10px] text-slate-400 uppercase">Vencimento</span>
                        <strong className="text-xs text-amber-400">Dia {c.diaVencimento || 12}</strong>
                      </div>
                      <div>
                        <span className="block text-[10px] text-emerald-400 uppercase font-semibold">Melhor Dia</span>
                        <strong className="text-xs text-emerald-300">Dia {c.diaFechamento || 5}</strong>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-400">Fatura ({filtroMesAno}): <strong className="text-rose-400">R$ {c.faturaMes.toFixed(2)}</strong></span>
                        <span className="text-slate-400">Disponível: <strong className="text-emerald-400">R$ {c.disponivel.toFixed(2)}</strong></span>
                      </div>
                      <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-500 ${c.estourado ? 'bg-rose-500' : c.alerta80 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                          style={{ width: `${c.pctUso}%` }}
                        ></div>
                      </div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Total preso (c/ parcelas): R$ {c.comprometidoTotal.toFixed(2)} ({c.pctUso}%)</span>
                        <span>Limite: R$ {Number(c.limite).toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* FORMULÁRIO DE LANÇAMENTO FLEXÍVEL (CARTÃO, PIX, BOLETO, DINHEIRO) */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-emerald-400" /> Lançar Compra (À Vista ou Parcelada)
                </h3>
                <form onSubmit={lancarCompraCartaoManual} className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                  <input 
                    type="text" required placeholder="Descrição (ex: Micro-ondas)" value={novaCompraCartao.descricao}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, descricao: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" step="0.01" required placeholder="Valor Total (R$)" value={novaCompraCartao.valorTotal}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, valorTotal: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <select 
                    value={novaCompraCartao.parcelas}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, parcelas: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {[1,2,3,4,5,6,7,8,9,10,12,18,24].map(n => (
                      <option key={n} value={n}>{n}x {n === 1 ? '(À vista)' : 'parcelas'}</option>
                    ))}
                  </select>

                  <select 
                    value={novaCompraCartao.metodo}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, metodo: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    <option value="CREDITO">💳 Cartão de Crédito</option>
                    <option value="PIX">💠 Parcelamento no PIX</option>
                    <option value="DINHEIRO">💵 Dinheiro</option>
                    <option value="BOLETO / AGENDADO">📄 Carnê / Boleto</option>
                  </select>

                  {novaCompraCartao.metodo === 'CREDITO' ? (
                    <select 
                      value={novaCompraCartao.cartaoNome}
                      onChange={e => setNovaCompraCartao({ ...novaCompraCartao, cartaoNome: e.target.value })}
                      className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                    >
                      {cartoes.map(c => <option key={c.id} value={c.nome}>{c.nome}</option>)}
                    </select>
                  ) : (
                    <select 
                      value={novaCompraCartao.bancoNome}
                      onChange={e => setNovaCompraCartao({ ...novaCompraCartao, bancoNome: e.target.value })}
                      className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                    >
                      {bancos.map(b => <option key={b.id} value={b.nome}>{b.nome}</option>)}
                    </select>
                  )}

                  <select 
                    value={novaCompraCartao.categoria}
                    onChange={e => {
                      const cat = e.target.value;
                      setNovaCompraCartao({ ...novaCompraCartao, categoria: cat, subcategoria: (subcategorias[cat] || ['Geral'])[0] });
                    }}
                    className="sm:col-span-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {categorias.filter(c => c !== 'Receita').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                  <select 
                    value={novaCompraCartao.subcategoria}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, subcategoria: e.target.value })}
                    className="sm:col-span-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {(subcategorias[novaCompraCartao.categoria] || ['Geral']).map(sub => (
                      <option key={sub} value={sub}>{sub}</option>
                    ))}
                  </select>
                  
                  <button type="submit" className="sm:col-span-6 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                    {novaCompraCartao.metodo === 'CREDITO' ? 'Lançar na Fatura' : 'Agendar Parcelas (A Vencer)'}
                  </button>
                </form>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <h3 className="text-sm font-bold text-slate-200">
                    Fatura Detalhada ({filtroMesAno})
                  </h3>
                  <div className="flex gap-2 flex-wrap">
                    <button 
                      onClick={() => setCartaoSelecionadoFatura('TODOS')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${cartaoSelecionadoFatura === 'TODOS' ? 'bg-emerald-500 text-slate-950' : 'bg-slate-950 text-slate-400 border border-slate-800'}`}
                    >
                      Todos os Cartões
                    </button>
                    {cartoes.map(c => (
                      <button 
                        key={c.id} onClick={() => setCartaoSelecionadoFatura(c.nome)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${cartaoSelecionadoFatura === c.nome ? 'bg-emerald-500 text-slate-950' : 'bg-slate-950 text-slate-400 border border-slate-800'}`}
                      >
                        {c.nome}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2.5">
                  {transacoesFiltradas
                    .filter(t => t.metodo === 'CREDITO' && (cartaoSelecionadoFatura === 'TODOS' || t.cartao_nome?.toLowerCase() === cartaoSelecionadoFatura.toLowerCase()))
                    .map(t => (
                      <div key={t.id} className="flex items-center justify-between bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80">
                        <div>
                          <p className="text-sm font-medium text-slate-200 flex items-center gap-2">
                            {t.descricao}
                            <span className="text-[10px] bg-slate-800 text-emerald-400 px-2 py-0.5 rounded-md font-bold">{t.cartao_nome}</span>
                            {t.fatura_paga && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full">Fatura Quitada</span>}
                          </p>
                          <p className="text-xs text-slate-400">{t.categoria} &gt; {t.subcategoria || 'Geral'}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`font-bold text-sm ${Number(t.valor) < 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            R$ {Number(t.valor).toFixed(2)}
                          </span>
                          <button onClick={() => iniciarEdicaoTransacao(t)} className="text-slate-400 hover:text-sky-400 p-1">
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button onClick={() => iniciarExclusaoTransacao(t)} className="text-slate-500 hover:text-rose-400 p-1">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 6: CADASTRO DE BANCOS E CARTÕES
          ================================================================ */}
          {abaAtiva === 'bancos' && (
            <div className="space-y-6">
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-5 shadow-xl">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-emerald-400" /> {cartaoForm.id ? 'Editar Cartão de Crédito' : 'Cadastrar Cartão de Crédito'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Configure múltiplos cartões, limites, dia de fechamento e dia de vencimento.
                  </p>
                </div>

                <form onSubmit={salvarCartao} className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                  <input 
                    type="text" required placeholder="Nome (ex: VISA)" value={cartaoForm.nome}
                    onChange={e => setCartaoForm({ ...cartaoForm, nome: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" required placeholder="Limite Total (R$)" value={cartaoForm.limite}
                    onChange={e => setCartaoForm({ ...cartaoForm, limite: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" min="1" max="31" required placeholder="Dia Fechamento" value={cartaoForm.diaFechamento}
                    onChange={e => setCartaoForm({ ...cartaoForm, diaFechamento: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" min="1" max="31" required placeholder="Dia Vencimento" value={cartaoForm.diaVencimento}
                    onChange={e => setCartaoForm({ ...cartaoForm, diaVencimento: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="text" placeholder="Banco Emissor (ex: Itaú, C6)" value={cartaoForm.banco}
                    onChange={e => setCartaoForm({ ...cartaoForm, banco: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <div className="sm:col-span-3 flex gap-2">
                    <button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                      {cartaoForm.id ? 'Salvar Alterações do Cartão' : '+ Adicionar Cartão de Crédito'}
                    </button>
                    {cartaoForm.id && (
                      <button 
                        type="button" 
                        onClick={() => setCartaoForm({ id: null, nome: '', limite: '', diaFechamento: '5', diaVencimento: '12', banco: '' })}
                        className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs"
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </form>

                <div className="space-y-2.5">
                  {cartoes.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-slate-950/70 border border-slate-800 px-4 py-3.5 rounded-xl">
                      <div>
                        <p className="font-bold text-sm text-slate-100">{c.nome} <span className="text-xs font-normal text-slate-400">({c.banco || 'Crédito'})</span></p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Limite: <strong className="text-emerald-400">R$ {Number(c.limite).toFixed(2)}</strong> • Fecha dia <strong>{c.diaFechamento || 5}</strong> • Vence dia <strong>{c.diaVencimento || 12}</strong>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => editarCartao(c)} className="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 px-3 py-1.5 rounded-lg flex items-center gap-1">
                          <Edit3 className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button onClick={() => excluirCartao(c.id)} className="text-slate-500 hover:text-rose-400 p-1.5">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-5 shadow-xl">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <Landmark className="w-5 h-5 text-sky-400" /> {bancoForm.id ? 'Editar Conta Bancária' : 'Cadastrar Bancos & Contas'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Defina o nome da conta e o saldo inicial para acompanhar na aba "Saldos & Transferências".
                  </p>
                </div>

                <form onSubmit={salvarBanco} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <input 
                    type="text" required placeholder="Nome (ex: Itaú, Nubank)" value={bancoForm.nome}
                    onChange={e => setBancoForm({ ...bancoForm, nome: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <select 
                    value={bancoForm.tipo}
                    onChange={e => setBancoForm({ ...bancoForm, tipo: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  >
                    <option value="Conta Corrente / Débito">Conta Corrente / Débito</option>
                    <option value="Conta Digital / Pix">Conta Digital / Pix</option>
                    <option value="Conta PJ / Empresarial">Conta PJ / Empresarial</option>
                    <option value="Carteira / Dinheiro">Carteira Física / Dinheiro</option>
                  </select>
                  <input 
                    type="number" step="0.01" placeholder="Saldo Inicial (R$)" value={bancoForm.saldoInicial}
                    onChange={e => setBancoForm({ ...bancoForm, saldoInicial: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                      {bancoForm.id ? 'Salvar' : '+ Adicionar'}
                    </button>
                    {bancoForm.id && (
                      <button 
                        type="button" 
                        onClick={() => setBancoForm({ id: null, nome: '', tipo: 'Conta Corrente / Débito', saldoInicial: '' })}
                        className="px-3 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs"
                      >
                        X
                      </button>
                    )}
                  </div>
                </form>

                <div className="space-y-2.5">
                  {bancos.map(b => (
                    <div key={b.id} className="flex items-center justify-between bg-slate-950/70 border border-slate-800 px-4 py-3.5 rounded-xl">
                      <div>
                        <p className="font-bold text-sm text-slate-100">{b.nome}</p>
                        <p className="text-xs text-slate-400">{b.tipo} • Saldo Inicial: <strong>R$ {Number(b.saldoInicial || 0).toFixed(2)}</strong></p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => editarBanco(b)} className="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 px-3 py-1.5 rounded-lg flex items-center gap-1">
                          <Edit3 className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button onClick={() => excluirBanco(b.id)} className="text-slate-500 hover:text-rose-400 p-1.5">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 7: CATEGORIAS, SUBCATEGORIAS & LIMITES
          ================================================================ */}
          {abaAtiva === 'categorias' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-6 shadow-xl">
              <div>
                <h2 className="text-lg font-bold">Categorias, Subcategorias & Orçamentos</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  O robô classifica automaticamente itens como <em>"maçã"</em> em <strong>Alimentação &gt; Mercado</strong> e <em>"lanche"</em> em <strong>Alimentação &gt; Lazer</strong>.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <form onSubmit={adicionarCategoria} className="flex gap-2">
                  <input type="text" placeholder="Nova Categoria (ex: Educação)" value={novaCatNome} onChange={e => setNovaCatNome(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200" />
                  <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-4 py-2.5 rounded-xl font-semibold text-xs">+ Categoria</button>
                </form>

                <form onSubmit={adicionarSubcategoria} className="flex gap-2">
                  <select 
                    value={catSelecionadaParaSub} onChange={e => setCatSelecionadaParaSub(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-slate-200"
                  >
                    {categorias.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input type="text" placeholder="Nova Subcategoria" value={novaSubNome} onChange={e => setNovaSubNome(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200" />
                  <button type="submit" className="bg-sky-500 hover:bg-sky-400 text-slate-950 px-4 py-2.5 rounded-xl font-semibold text-xs">+ Sub</button>
                </form>
              </div>

              <form onSubmit={definirOrcamento} className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-800/80">
                <select 
                  value={orcamentoCat} onChange={e => setOrcamentoCat(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                >
                  <option value="">Selecione a Categoria para definir limite mensal</option>
                  {categorias.filter(c => c !== 'Receita').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input 
                  type="number" placeholder="Limite Mensal (R$)" value={orcamentoValor} onChange={e => setOrcamentoValor(e.target.value)} 
                  className="w-full sm:w-44 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200" 
                />
                <button type="submit" className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-xl font-semibold text-xs transition">
                  Salvar Limite
                </button>
              </form>

              <div className="space-y-3">
                {categorias.map(cat => (
                  <div key={cat} className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-bold text-sm text-slate-100">{cat}</span>
                        <span className="text-xs text-emerald-400 ml-3 font-medium">
                          {orcamentos[cat] ? `Limite: R$ ${orcamentos[cat].toFixed(2)}` : 'Sem limite definido'}
                        </span>
                      </div>
                      <button onClick={() => excluirCategoria(cat)} className="text-slate-600 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {(subcategorias[cat] || ['Geral']).map(sub => (
                        <span key={sub} className="text-[11px] bg-slate-900 border border-slate-800 text-slate-300 px-2.5 py-1 rounded-lg">
                          {cat} &gt; <strong>{sub}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 8: CONEXÃO WHATSAPP
          ================================================================ */}
          {abaAtiva === 'whatsapp' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-8 rounded-2xl text-center space-y-6 shadow-xl max-w-lg mx-auto">
              <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto border border-emerald-500/20">
                <QrCode className="w-8 h-8" />
              </div>
              
              <div>
                <h2 className="text-xl font-bold">Conexão WhatsApp</h2>
                <p className="text-xs text-slate-400 mt-1">
                  O robô responde exclusivamente quando você envia mensagens para o seu próprio número (conversa "Você mesmo"). Envie <strong>"teste"</strong> no seu WhatsApp para validar!
                </p>
              </div>

              <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl flex flex-col items-center justify-center min-h-[260px]">
                {whatsappStatus === 'CONNECTED' ? (
                  <div className="space-y-3 py-8">
                    <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-6 h-6" />
                    </div>
                    <p className="text-sm font-bold text-emerald-400">WhatsApp Conectado com Sucesso!</p>
                    <button onClick={desconectarWhatsApp} className="text-xs text-rose-400 hover:underline">Desconectar Aparelho</button>
                  </div>
                ) : whatsappQrCode ? (
                  <div className="space-y-4">
                    <img src={whatsappQrCode} alt="QR Code WhatsApp" className="w-48 h-48 mx-auto bg-white p-2 rounded-xl" />
                    <p className="text-xs text-slate-400 animate-pulse">Abra o WhatsApp &gt; Aparelhos Conectados &gt; Conectar Aparelho</p>
                  </div>
                ) : (
                  <div className="space-y-4 py-6">
                    <p className="text-xs text-slate-400">Nenhum QR Code ativo no momento.</p>
                    <button 
                      onClick={solicitarConexaoWhatsApp} 
                      disabled={carregandoQr}
                      className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-6 py-3 rounded-xl text-xs transition flex items-center gap-2 mx-auto shadow-lg shadow-emerald-500/20"
                    >
                      {carregandoQr ? <RefreshCw className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                      Gerar QR Code do WhatsApp
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* SIMULADOR DE WHATSAPP */}
        <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl flex flex-col h-[680px] overflow-hidden shadow-xl">
          <div className="bg-emerald-950/40 border-b border-emerald-900/30 p-4 flex items-center gap-3.5">
            <div className="w-9 h-9 bg-emerald-500 text-slate-950 rounded-xl flex items-center justify-center font-bold shadow-lg shadow-emerald-500/20">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-emerald-300">Simulador do WhatsApp</h3>
              <p className="text-xs text-emerald-500/80 font-medium">Subcategorias, Bancos & Comandos</p>
            </div>
          </div>

          <div className="flex-1 p-4 space-y-3.5 overflow-y-auto bg-slate-950/40">
            {historicoChat.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.autor === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-lg whitespace-pre-line ${
                  msg.autor === 'user' 
                    ? 'bg-emerald-500 text-slate-950 font-medium rounded-br-none' 
                    : 'bg-slate-900 text-slate-200 border border-slate-800 rounded-bl-none'
                }`}>
                  {msg.texto}
                </div>
              </div>
            ))}
            {processando && <div className="text-xs text-slate-500 italic px-2">Processando...</div>}
          </div>

          <div className="p-2.5 bg-slate-900/80 border-t border-slate-800/80 flex gap-2 overflow-x-auto">
            <button type="button" onClick={() => setMsgWhats('comprei maçã 5,00 no débito')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded-xl whitespace-nowrap">🍎 "maçã 5 no débito"</button>
            <button type="button" onClick={() => setMsgWhats('comprei um lanche 35,00 no pix Itaú')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded-xl whitespace-nowrap">🍔 "lanche 35 pix Itaú"</button>
            <button type="button" onClick={() => setMsgWhats('teste')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-sky-400 border border-slate-800 px-3 py-1.5 rounded-xl whitespace-nowrap">🟢 "teste"</button>
          </div>

          <form onSubmit={handleEnviarWhatsApp} className="p-3.5 bg-slate-900/80 border-t border-slate-800/80 flex gap-2.5">
            <input 
              type="text" placeholder="Ex: comprei maçã 5,00 no débito..." value={msgWhats} onChange={e => setMsgWhats(e.target.value)} 
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-200 focus:outline-none focus:border-emerald-500" 
            />
            <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 p-3 rounded-xl transition flex items-center justify-center">
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

      </main>
    </div>
  );
}