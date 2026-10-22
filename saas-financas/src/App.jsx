import React, { useState, useEffect } from 'react';
import { 
  Wallet, TrendingUp, TrendingDown, CreditCard, MessageSquare, 
  Plus, Trash2, QrCode, Send, LogOut, BarChart2, Calendar, 
  FolderPlus, Target, AlertTriangle, Sparkles, CheckCircle2, 
  Clock, Zap, BrainCircuit, Receipt, RefreshCw, Landmark, 
  Edit3, Check, X, ShieldAlert, BellRing
} from 'lucide-react';
import { db, auth } from './firebaseConfig';
import { 
  collection, addDoc, onSnapshot, deleteDoc, updateDoc, doc, 
  query, orderBy, serverTimestamp, setDoc, getDoc 
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

const RENDER_API_URL = 'https://finzap-whatsapp-api.onrender.com';

export default function App() {
  const [user, setUser] = useState(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [emailInput, setEmailInput] = useState('');
  const [senhaInput, setSenhaInput] = useState('');
  const [erroAuth, setErroAuth] = useState('');

  const [abaAtiva, setAbaAtiva] = useState('dashboard');
  const [transacoes, setTransacoes] = useState([]);

  // Cartões com limite, dia de fechamento e dia de vencimento
  const [cartoes, setCartoes] = useState([
    { id: '1', nome: 'VISA', limite: 5000, diaFechamento: 5, diaVencimento: 12, banco: 'Itaú' },
    { id: '2', nome: 'NUBANK', limite: 3500, diaFechamento: 10, diaVencimento: 17, banco: 'Nubank' }
  ]);

  // Bancos e Contas de Débito/Pix
  const [bancos, setBancos] = useState([
    { id: 'b1', nome: 'Itaú', tipo: 'Conta Corrente / Débito', saldoInicial: 0 },
    { id: 'b2', nome: 'Nubank Conta', tipo: 'Conta Digital / Pix', saldoInicial: 0 }
  ]);
  
  const [categorias, setCategorias] = useState(['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros']);
  const [orcamentos, setOrcamentos] = useState({});
  const [contasFixas, setContasFixas] = useState([
    { id: 'f1', nome: 'Energia Elétrica', valorPadrao: 180, diaVencimento: 15, categoria: 'Contas' },
    { id: 'f2', nome: 'Internet Fibra', valorPadrao: 120, diaVencimento: 10, categoria: 'Contas' }
  ]);

  const [whatsappStatus, setWhatsappStatus] = useState('DISCONNECTED');
  const [whatsappQrCode, setWhatsappQrCode] = useState(null);
  const [carregandoQr, setCarregandoQr] = useState(false);

  // Estados de Formulários - Categorias & Contas Fixas
  const [novaCatNome, setNovaCatNome] = useState('');
  const [orcamentoCat, setOrcamentoCat] = useState('');
  const [orcamentoValor, setOrcamentoValor] = useState('');
  const [fixaNome, setFixaNome] = useState('');
  const [fixaValor, setFixaValor] = useState('');
  const [fixaDia, setFixaDia] = useState('');

  // Estados de Formulários - Cadastro e Edição de Cartões e Bancos
  const [cartaoForm, setCartaoForm] = useState({ id: null, nome: '', limite: '', diaFechamento: '5', diaVencimento: '12', banco: '' });
  const [bancoForm, setBancoForm] = useState({ id: null, nome: '', tipo: 'Conta Corrente / Débito', saldoInicial: '' });

  // Estados da Aba Cartão de Crédito (Fatura Detalhada, Lançamento Parcelado e Edição de Compra)
  const [cartaoSelecionadoFatura, setCartaoSelecionadoFatura] = useState('TODOS');
  const [novaCompraCartao, setNovaCompraCartao] = useState({
    descricao: '',
    valorTotal: '',
    parcelas: '1',
    cartaoNome: 'VISA',
    categoria: 'Alimentação'
  });
  const [transacaoEditando, setTransacaoEditando] = useState(null);

  const dataAtualObj = new Date();
  const diaHoje = dataAtualObj.getDate();
  const mesAtualStr = `${dataAtualObj.getFullYear()}-${String(dataAtualObj.getMonth() + 1).padStart(2, '0')}`;
  const [filtroMesAno, setFiltroMesAno] = useState(mesAtualStr);

  // Estados do Simulador de WhatsApp (com suporte a pergunta de forma de pagamento pendente)
  const [msgWhats, setMsgWhats] = useState('');
  const [pendenteSimulador, setPendenteSimulador] = useState(null);
  const [historicoChat, setHistoricoChat] = useState([
    { 
      autor: 'bot', 
      texto: '🤖 Olá! Sou seu Assistente Financeiro IA.\n\nNovidades:\n1️⃣ Se você esquecer a forma de pagamento (ex: "Gastei 50 na padaria"), eu pergunto qual foi!\n2️⃣ Alertas de limite de cartão (80% e 100%).\n3️⃣ Comandos: "Qual meu saldo?", "Fatura do VISA" ou "desfazer".' 
    }
  ]);
  const [processando, setProcessando] = useState(false);

  const CORES_GRAFICO = ['#34d399', '#38bdf8', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf', '#fb7185', '#60a5fa'];

  // 1. Autenticação e Carregamento Inicial
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists()) {
          const dados = userSnap.data();
          if (dados.categorias) setCategorias(dados.categorias);
          if (dados.orcamentos) setOrcamentos(dados.orcamentos);
          if (dados.cartoes) setCartoes(dados.cartoes);
          if (dados.bancos) setBancos(dados.bancos);
          if (dados.contasFixas) setContasFixas(dados.contasFixas);
          if (dados.whatsapp_status) setWhatsappStatus(dados.whatsapp_status);
          if (dados.whatsapp_qrcode) setWhatsappQrCode(dados.whatsapp_qrcode);
        } else {
          await setDoc(userDocRef, { 
            categorias, 
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

  // 2. Listeners em Tempo Real
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
        if (!anoMes && dataDoc.criadoEm) {
          const d = dataDoc.criadoEm.toDate ? dataDoc.criadoEm.toDate() : new Date();
          anoMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
        return {
          id: docSnap.id,
          ...dataDoc,
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

  // Conexão com Servidor WhatsApp na Render
  const solicitarConexaoWhatsApp = async () => {
    if (!user) return;
    setCarregandoQr(true);
    try {
      await fetch(`${RENDER_API_URL}/conectar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid })
      });
    } catch (e) {
      alert('O servidor na Render pode estar acordando. Aguarde 15 segundos e tente novamente.');
    } finally {
      setCarregandoQr(false);
    }
  };

  const desconectarWhatsApp = async () => {
    if (!user) return;
    try {
      await fetch(`${RENDER_API_URL}/desconectar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      await fetch(`${RENDER_API_URL}/verificar-alertas`);
      alert('Verificação de alertas de vencimento enviada para o servidor do WhatsApp!');
    } catch (e) {
      alert('Erro ao acionar verificação no servidor.');
    }
  };

  // ==========================================================================
  // GESTÃO DE BANCOS E CARTÕES (CADASTRO E EDIÇÃO)
  // ==========================================================================
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

  // ==========================================================================
  // FUNÇÕES DA ABA CARTÃO DE CRÉDITO (LANÇAR PARCELADO, PAGAR FATURA, EDITAR)
  // ==========================================================================
  const lancarCompraCartaoManual = async (e) => {
    e.preventDefault();
    if (!novaCompraCartao.descricao || !novaCompraCartao.valorTotal || !user) return;

    const parcelasTotal = Math.max(parseInt(novaCompraCartao.parcelas) || 1, 1);
    const valorTotal = parseFloat(novaCompraCartao.valorTotal);
    const valorParcela = Number((valorTotal / parcelasTotal).toFixed(2));
    const [anoBase, mesBase] = filtroMesAno.split('-').map(Number);

    for (let i = 0; i < parcelasTotal; i++) {
      const dParc = new Date(anoBase, (mesBase - 1) + i, 15);
      const anoM = dParc.getFullYear();
      const mesM = String(dParc.getMonth() + 1).padStart(2, '0');

      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: parcelasTotal > 1 ? `${novaCompraCartao.descricao} (${i + 1}/${parcelasTotal})` : novaCompraCartao.descricao,
        valor: valorParcela,
        tipo: 'DESPESA',
        metodo: 'CREDITO',
        cartao_nome: novaCompraCartao.cartaoNome,
        categoria: novaCompraCartao.categoria,
        parcela_atual: i + 1,
        parcelas_total: parcelasTotal,
        fatura_paga: false,
        anoMes: `${anoM}-${mesM}`,
        mensagem_original: `Lançamento manual no cartão ${novaCompraCartao.cartaoNome}`,
        criadoEm: serverTimestamp()
      });
    }

    setNovaCompraCartao({ ...novaCompraCartao, descricao: '', valorTotal: '', parcelas: '1' });
  };

  const pagarFaturaCartao = async (nomeCartao) => {
    if (!user) return;
    const comprasDaFatura = transacoes.filter(
      t => t.anoMes === filtroMesAno && t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === nomeCartao.toLowerCase() && !t.fatura_paga
    );

    if (comprasDaFatura.length === 0) {
      return alert(`A fatura do cartão ${nomeCartao} em ${filtroMesAno} já está paga ou sem lançamentos!`);
    }

    for (const item of comprasDaFatura) {
      await updateDoc(doc(db, 'users', user.uid, 'transacoes', item.id), {
        fatura_paga: true
      });
    }
    alert(`✅ Fatura de ${nomeCartao} (${filtroMesAno}) marcada como PAGA! O limite do cartão foi liberado.`);
  };

  const salvarEdicaoTransacao = async (e) => {
    e.preventDefault();
    if (!transacaoEditando || !user) return;

    await updateDoc(doc(db, 'users', user.uid, 'transacoes', transacaoEditando.id), {
      descricao: transacaoEditando.descricao,
      valor: Number(transacaoEditando.valor),
      categoria: transacaoEditando.categoria,
      metodo: transacaoEditando.metodo,
      cartao_nome: transacaoEditando.metodo === 'CREDITO' ? transacaoEditando.cartao_nome : null
    });
    setTransacaoEditando(null);
  };

  // ==========================================================================
  // CATEGORIAS E CONTAS FIXAS
  // ==========================================================================
  const adicionarCategoria = async (e) => {
    e.preventDefault();
    if (!novaCatNome.trim() || !user) return;
    const catFormatada = novaCatNome.charAt(0).toUpperCase() + novaCatNome.slice(1).toLowerCase();
    if (categorias.includes(catFormatada)) return alert('Esta categoria já existe!');
    const novasCats = [...categorias, catFormatada];
    setCategorias(novasCats);
    setNovaCatNome('');
    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats }, { merge: true });
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
    await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
      descricao: conta.nome,
      valor: Number(conta.valorPadrao),
      tipo: 'DESPESA',
      metodo: 'PIX/BOLETO',
      cartao_nome: null,
      categoria: conta.categoria || 'Contas',
      anoMes: filtroMesAno,
      conta_fixa_id: conta.id,
      mensagem_original: `Baixa automática de conta fixa: ${conta.nome}`,
      criadoEm: serverTimestamp()
    });
  };

  // ==========================================================================
  // SIMULADOR INTELIGENTE NO PAINEL (COM PERGUNTA DE FORMA DE PAGAMENTO)
  // ==========================================================================
  const interpretarItemUnico = (trecho) => {
    const txtLower = trecho.toLowerCase();
    const matchParcelas = txtLower.match(/(\d+)\s*(?:x|vezes|parcelas)/);
    const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

    const textoSemParcela = matchParcelas ? trecho.replace(matchParcelas[0], '') : trecho;
    const matchValor = textoSemParcela.match(/(\d+\.\d{2}|\d+)/);
    if (!matchValor) return null;
    
    let valorTotal = parseFloat(matchValor[0]);
    if (isNaN(valorTotal) || valorTotal <= 0) return null;

    const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;
    const isReceita = /recebi|ganhei|salário|salario|pix recebido|venda|cliente/i.test(txtLower);
    const tipo = isReceita ? 'RECEITA' : 'DESPESA';

    let metodo = null;
    let cartaoIdentificado = null;

    for (const c of cartoes) {
      if (txtLower.includes(c.nome.toLowerCase())) {
        cartaoIdentificado = c.nome;
        metodo = 'CREDITO';
        break;
      }
    }

    if (!metodo) {
      if (/crédito|credito|cartão|cartao/i.test(txtLower) || parcelasTotal > 1) {
        metodo = 'CREDITO';
        cartaoIdentificado = cartoes[0]?.nome || 'CREDITO';
      } else if (/débito|debito/i.test(txtLower)) {
        metodo = 'DEBITO';
      } else if (/pix/i.test(txtLower)) {
        metodo = 'PIX';
      } else if (/dinheiro|espécie|especie/i.test(txtLower)) {
        metodo = 'DINHEIRO';
      } else if (isReceita) {
        metodo = 'PIX';
      }
    }

    let categoria = isReceita ? 'Receita' : 'Outros';
    if (/mercado|supermercado|atacadão|compras|açougue|hortifruti|cebola/i.test(txtLower)) categoria = 'Mercado';
    else if (/lanche|restaurante|ifood|padaria|almoço|jantar|burger|pizza|café/i.test(txtLower)) categoria = 'Alimentação';
    else if (/uber|gasolina|combustível|posto|99|estacionamento|pedágio/i.test(txtLower)) categoria = 'Transporte';
    else if (/cinema|passeio|bar|viagem|streaming|netflix|jogo|shopping/i.test(txtLower)) categoria = 'Lazer';
    else if (/luz|água|internet|energia|boleto|aluguel|condomínio/i.test(txtLower)) categoria = 'Contas';

    for (const cat of categorias) {
      if (txtLower.includes(cat.toLowerCase())) {
        categoria = cat;
        break;
      }
    }

    let descricao = textoSemParcela
      .replace(/fui no|fui na|comprei|gastei|paguei|recebi|ganhei|no cartão de credito|no cartão|no credito|no pix|no débito|credito|debito|pix|dinheiro|reais|r\$|de |em /gi, ' ')
      .replace(matchValor[0], '')
      .replace(cartaoIdentificado ? new RegExp(cartaoIdentificado, 'gi') : '', '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!descricao || descricao.length < 2) descricao = `${tipo === 'RECEITA' ? 'Entrada' : 'Gasto'} (${categoria})`;
    descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

    return {
      descricao,
      valorTotal,
      valorParcela,
      parcelasTotal,
      tipo,
      metodo,
      cartao_nome: cartaoIdentificado,
      categoria
    };
  };

  const gravarItensSimulador = async (itens, textoOriginal) => {
    const hoje = new Date();
    let resumoRespostas = [];

    for (const dados of itens) {
      const pTotal = dados.parcelasTotal || 1;
      for (let i = 0; i < pTotal; i++) {
        const dataParcela = new Date(hoje.getFullYear(), hoje.getMonth() + i, 15);
        const anoM = dataParcela.getFullYear();
        const mesM = String(dataParcela.getMonth() + 1).padStart(2, '0');

        await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
          descricao: pTotal > 1 ? `${dados.descricao} (${i + 1}/${pTotal})` : dados.descricao,
          valor: dados.valorParcela,
          tipo: dados.tipo,
          metodo: dados.metodo,
          cartao_nome: dados.cartao_nome,
          categoria: dados.categoria,
          parcela_atual: i + 1,
          parcelas_total: pTotal,
          fatura_paga: false,
          anoMes: `${anoM}-${mesM}`,
          mensagem_original: textoOriginal,
          criadoEm: serverTimestamp()
        });
      }

      let alertaExtra = '';
      if (dados.metodo === 'CREDITO' && dados.cartao_nome) {
        const cObj = cartoes.find(c => c.nome.toLowerCase() === dados.cartao_nome.toLowerCase());
        if (cObj && cObj.limite > 0) {
          const compAtual = transacoes
            .filter(t => t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === cObj.nome.toLowerCase() && !t.fatura_paga && t.anoMes >= mesAtualStr)
            .reduce((a, b) => a + Number(b.valor || 0), 0) + (dados.valorParcela * pTotal);
          const pct = Math.round((compAtual / cObj.limite) * 100);
          const disp = cObj.limite - compAtual;
          if (pct >= 100) alertaExtra += `\n🚨 *ALERTA:* Limite do cartão ${cObj.nome} estourado! (${pct}%)`;
          else if (pct >= 80) alertaExtra += `\n⚠️ *Atenção:* ${pct}% do limite do ${cObj.nome} comprometido! Restam R$ ${disp.toFixed(2)}`;
        }
      }

      resumoRespostas.push(
        `✅ *${dados.descricao}* [${dados.categoria}]: R$ ${dados.valorParcela.toFixed(2)} ${pTotal > 1 ? `(${pTotal}x)` : ''} (${dados.cartao_nome || dados.metodo})${alertaExtra}`
      );
    }

    return resumoRespostas;
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
      // 1. Verifica se havia pergunta de forma de pagamento pendente no Simulador
      if (pendenteSimulador && pendenteSimulador.length > 0) {
        let metodoResp = null;
        let cartaoResp = null;

        for (const c of cartoes) {
          if (txtLower.includes(c.nome.toLowerCase())) {
            metodoResp = 'CREDITO';
            cartaoResp = c.nome;
            break;
          }
        }
        if (!metodoResp) {
          if (/crédito|credito|cartão|cartao/i.test(txtLower)) {
            metodoResp = 'CREDITO';
            cartaoResp = cartoes[0]?.nome || 'CREDITO';
          } else if (/débito|debito/i.test(txtLower)) {
            metodoResp = 'DEBITO';
          } else if (/pix/i.test(txtLower)) {
            metodoResp = 'PIX';
          } else if (/dinheiro/i.test(txtLower)) {
            metodoResp = 'DINHEIRO';
          }
        }

        if (metodoResp) {
          const itensProntos = pendenteSimulador.map(it => ({
            ...it,
            metodo: metodoResp,
            cartao_nome: cartaoResp
          }));
          setPendenteSimulador(null);
          const resps = await gravarItensSimulador(itensProntos, textoUsuario);
          setHistoricoChat(prev => [...prev, { autor: 'bot', texto: resps.join('\n\n') }]);
          setProcessando(false);
          return;
        }
        setPendenteSimulador(null);
      }

      // 2. Comando Desfazer
      if (/^(apagar|excluir|deletar|desfazer)/i.test(txtLower.trim())) {
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

      // 3. Consultas
      const isPergunta = /\?|quanto|qual|resumo|saldo|fatura|posso gastar/i.test(txtLower) && !/gastei|comprei|paguei|recebi/i.test(txtLower);
      if (isPergunta) {
        const transMes = transacoes.filter(t => t.anoMes === filtroMesAno);
        const rec = transMes.filter(t => t.tipo === 'RECEITA').reduce((a, b) => a + Number(b.valor || 0), 0);
        const desp = transMes.filter(t => t.tipo === 'DESPESA').reduce((a, b) => a + Number(b.valor || 0), 0);
        const sld = rec - desp;

        const cartaoPerguntado = cartoes.find(c => txtLower.includes(c.nome.toLowerCase()));
        if (cartaoPerguntado) {
          const faturaMes = transMes
            .filter(t => t.cartao_nome?.toLowerCase() === cartaoPerguntado.nome.toLowerCase() && !t.fatura_paga)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          const compTotal = transacoes
            .filter(t => t.tipo === 'DESPESA' && t.cartao_nome?.toLowerCase() === cartaoPerguntado.nome.toLowerCase() && !t.fatura_paga && t.anoMes >= mesAtualStr)
            .reduce((a, b) => a + Number(b.valor || 0), 0);
          const disp = cartaoPerguntado.limite - compTotal;

          setHistoricoChat(prev => [...prev, {
            autor: 'bot',
            texto: `💳 *Cartão ${cartaoPerguntado.nome} (${filtroMesAno})*\n\n` +
                   `• Fatura do mês: *R$ ${faturaMes.toFixed(2)}*\n` +
                   `• Limite disponível real: *R$ ${disp.toFixed(2)}*\n` +
                   `• Melhor dia de compra: *Dia ${cartaoPerguntado.diaFechamento || 5}*`
          }]);
          setProcessando(false);
          return;
        }

        setHistoricoChat(prev => [...prev, {
          autor: 'bot',
          texto: `📊 *Resumo Inteligente (${filtroMesAno})*\n\n` +
                 `🟢 Receitas: R$ ${rec.toFixed(2)}\n` +
                 `🔴 Despesas: R$ ${desp.toFixed(2)}\n` +
                 `💰 *Saldo Atual: R$ ${sld.toFixed(2)}*`
        }]);
        setProcessando(false);
        return;
      }

      // 4. Lançamentos
      const textoNormalizado = textoUsuario.replace(/(\d+),(\d{2})/g, '$1.$2');
      const partes = textoNormalizado.split(/(?:,|\s+e\s+|\s*;\s*|\n+)/i).map(p => p.trim()).filter(Boolean);
      const itensExtraidos = partes.map(interpretarItemUnico).filter(Boolean);

      if (itensExtraidos.length === 0) {
        setHistoricoChat(prev => [...prev, { 
          autor: 'bot', 
          texto: '🤔 Não identifiquei valores. Tente:\n• "Gastei 45 na padaria"\n• "Qual meu saldo?"\n• "desfazer"' 
        }]);
        setProcessando(false);
        return;
      }

      const comMetodo = itensExtraidos.filter(i => i.metodo);
      const semMetodo = itensExtraidos.filter(i => !i.metodo);

      let respostasFinais = [];

      if (comMetodo.length > 0) {
        const r = await gravarItensSimulador(comMetodo, textoUsuario);
        respostasFinais.push(...r);
      }

      if (semMetodo.length > 0) {
        setPendenteSimulador(semMetodo);
        const listaStr = semMetodo.map(i => `• *${i.descricao}* [${i.categoria}] — R$ ${i.valorTotal.toFixed(2)}`).join('\n');
        const nomesCartoes = cartoes.map(c => c.nome).join(', ');
        respostasFinais.push(
          `❓ *Qual foi a forma de pagamento?*\n${listaStr}\n\nResponda com: *Pix*, *Débito*, *Dinheiro* ou o cartão (*${nomesCartoes}*).`
        );
      }

      setHistoricoChat(prev => [...prev, { autor: 'bot', texto: respostasFinais.join('\n\n') }]);

    } catch (error) {
      console.error(error);
    } finally {
      setProcessando(false);
    }
  };

  const excluirTransacao = async (id) => {
    if (!user) return;
    await deleteDoc(doc(db, 'users', user.uid, 'transacoes', id));
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
  // CÁLCULOS PREDITIVOS, CARTÕES E ALERTAS DE VENCIMENTO
  // ==========================================================================
  const transacoesFiltradas = transacoes.filter(t => t.anoMes === filtroMesAno);
  const totalReceitas = transacoesFiltradas.filter(t => t.tipo === 'RECEITA').reduce((acc, t) => acc + Number(t.valor || 0), 0);
  const totalDespesas = transacoesFiltradas.filter(t => t.tipo === 'DESPESA').reduce((acc, t) => acc + Number(t.valor || 0), 0);
  const saldoAtual = totalReceitas - totalDespesas;

  const [anoSel, mesSel] = filtroMesAno.split('-').map(Number);
  const totalDiasNoMes = new Date(anoSel, mesSel, 0).getDate();
  const isMesAtual = filtroMesAno === mesAtualStr;
  const diasDecorridos = isMesAtual ? Math.max(dataAtualObj.getDate(), 1) : totalDiasNoMes;
  const gastoMedioDiario = totalDespesas / diasDecorridos;
  const projecaoDespesasMes = isMesAtual ? gastoMedioDiario * totalDiasNoMes : totalDespesas;
  const projecaoSaldoFimMes = totalReceitas - projecaoDespesasMes;

  const metaAporte = totalReceitas * 0.20;
  const taxaPoupancaAtual = totalReceitas > 0 ? Math.max(Math.round(((totalReceitas - totalDespesas) / totalReceitas) * 100), 0) : 0;

  const dataProxMes = new Date(anoSel, mesSel, 1);
  const proxMesStr = `${dataProxMes.getFullYear()}-${String(dataProxMes.getMonth() + 1).padStart(2, '0')}`;
  const comprometidoProxMes = transacoes
    .filter(t => t.anoMes === proxMesStr && t.tipo === 'DESPESA')
    .reduce((acc, t) => acc + Number(t.valor || 0), 0);

  // Cálculo detalhado de cada cartão (Fatura do Mês + Limite Total Comprometido com Parcelas Futuras)
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
      faturaMes,
      comprometidoTotal,
      disponivel,
      pctUso,
      estourado: comprometidoTotal > limite,
      alerta80: pctUso >= 80,
      isMelhorDiaHoje
    };
  });

  const despesasPorCategoria = categorias.map(cat => {
    const total = transacoesFiltradas
      .filter(t => t.tipo === 'DESPESA' && t.categoria === cat)
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);
    return { name: cat, value: total };
  }).filter(item => item.value > 0);

  const dadosCartoesGrafico = resumoCartoes.map(c => ({
    name: c.nome,
    gasto: c.faturaMes
  }));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-emerald-500 selection:text-slate-950">
      
      {/* MODAL DE EDIÇÃO DE COMPRA / TRANSAÇÃO */}
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
                  <label className="text-xs text-slate-400 block mb-1">Categoria</label>
                  <select 
                    value={transacaoEditando.categoria}
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, categoria: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  >
                    {categorias.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Forma de Pagamento</label>
                  <select 
                    value={transacaoEditando.metodo}
                    onChange={e => setTransacaoEditando({ ...transacaoEditando, metodo: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200"
                  >
                    <option value="PIX">PIX</option>
                    <option value="DEBITO">Débito</option>
                    <option value="CREDITO">Cartão de Crédito</option>
                    <option value="DINHEIRO">Dinheiro</option>
                  </select>
                </div>
                {transacaoEditando.metodo === 'CREDITO' && (
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

      {/* SIDEBAR MODERNA */}
      <aside className="w-full md:w-72 bg-slate-900/50 backdrop-blur-xl border-r border-slate-800/80 p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3.5 mb-10">
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

          <nav className="space-y-1.5">
            <button onClick={() => setAbaAtiva('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'dashboard' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <BarChart2 className="w-4 h-4" /> Dashboard & IA
            </button>
            <button onClick={() => setAbaAtiva('cartoes')} className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'cartoes' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <span className="flex items-center gap-3">
                <CreditCard className="w-4 h-4" /> Cartões & Faturas
              </span>
              {resumoCartoes.some(c => c.alerta80) && (
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" title="Alerta de limite de cartão!"></span>
              )}
            </button>
            <button onClick={() => setAbaAtiva('bancos')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'bancos' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Landmark className="w-4 h-4" /> Cadastro Bancos/Cartões
            </button>
            <button onClick={() => setAbaAtiva('fixas')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'fixas' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Receipt className="w-4 h-4" /> Contas Fixas & Alertas
            </button>
            <button onClick={() => setAbaAtiva('categorias')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'categorias' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <FolderPlus className="w-4 h-4" /> Categorias & Limites
            </button>
            <button onClick={() => setAbaAtiva('whatsapp')} className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'whatsapp' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
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
                    <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full uppercase">Ação Necessária</span>
                  </h4>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Conecte o QR Code para receber alertas de vencimento e lançar gastos pelo celular.
                  </p>
                </div>
              </div>
              {abaAtiva !== 'whatsapp' && (
                <button 
                  onClick={() => setAbaAtiva('whatsapp')}
                  className="w-full sm:w-auto bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs px-4 py-2.5 rounded-xl transition whitespace-nowrap shadow-lg shadow-amber-500/20"
                >
                  Conectar Agora
                </button>
              )}
            </div>
          )}

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
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-4 rounded-2xl flex flex-col sm:flex-row justify-between items-center gap-4 shadow-xl">
                <div className="flex items-center gap-2.5 text-slate-200 text-sm font-medium">
                  <Calendar className="w-4 h-4 text-emerald-400" />
                  <span>Competência Financeira:</span>
                </div>
                <input 
                  type="month" 
                  value={filtroMesAno} 
                  onChange={e => setFiltroMesAno(e.target.value)} 
                  className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-emerald-400 font-semibold focus:outline-none focus:border-emerald-500 transition"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Saldo do Mês</span>
                  <p className={`text-2xl font-bold mt-1.5 tracking-tight ${saldoAtual >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    R$ {saldoAtual.toFixed(2)}
                  </p>
                </div>
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Receitas
                  </span>
                  <p className="text-2xl font-bold mt-1.5 text-slate-100 tracking-tight">R$ {totalReceitas.toFixed(2)}</p>
                </div>
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-rose-400" /> Despesas
                  </span>
                  <p className="text-2xl font-bold mt-1.5 text-slate-100 tracking-tight">R$ {totalDespesas.toFixed(2)}</p>
                </div>
              </div>

              {/* PAINEL PREDITIVO */}
              <div className="bg-gradient-to-br from-emerald-950/30 via-slate-900/80 to-slate-900/80 border border-emerald-500/20 p-5 rounded-2xl space-y-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-emerald-400" /> Diagnóstico & Inteligência Preditiva
                  </h2>
                  <span className="text-[11px] bg-emerald-500/10 text-emerald-400 px-2.5 py-0.5 rounded-full border border-emerald-500/20 font-medium">
                    Tempo Real
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Ritmo Diário (Burn Rate)</span>
                    <p className="text-lg font-bold text-slate-100 mt-1">R$ {gastoMedioDiario.toFixed(2)} <span className="text-xs font-normal text-slate-400">/dia</span></p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Projeção até dia {totalDiasNoMes}: <strong className={projecaoSaldoFimMes >= 0 ? 'text-emerald-400' : 'text-rose-400'}>R$ {projecaoDespesasMes.toFixed(2)}</strong>
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Potencial de Aporte (20%)</span>
                    <p className="text-lg font-bold text-emerald-400 mt-1">R$ {metaAporte.toFixed(2)}</p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Taxa de poupança atual: <strong className="text-slate-200">{taxaPoupancaAtual}%</strong> da renda
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800/80 p-4 rounded-xl">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold">Faturas Mês Seguinte</span>
                    <p className="text-lg font-bold text-amber-400 mt-1">R$ {comprometidoProxMes.toFixed(2)}</p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      Já comprometido em {proxMesStr}
                    </p>
                  </div>
                </div>
              </div>

              {/* CHECKLIST DE CONTAS FIXAS */}
              {contasFixas.length > 0 && (
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-3.5 shadow-xl">
                  <div className="flex justify-between items-center">
                    <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-amber-400" /> Checklist de Contas Fixas ({filtroMesAno})
                    </h2>
                    <button onClick={() => setAbaAtiva('fixas')} className="text-xs text-emerald-400 hover:underline">
                      + Configurar alertas
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {contasFixas.map(cf => {
                      const jaPaga = transacoesFiltradas.some(
                        t => t.conta_fixa_id === cf.id || t.descricao?.toLowerCase().includes(cf.nome.toLowerCase())
                      );
                      const venceHoje = Number(cf.diaVencimento) === diaHoje && !jaPaga;
                      return (
                        <div key={cf.id} className={`p-3.5 rounded-xl border flex items-center justify-between ${jaPaga ? 'bg-emerald-950/15 border-emerald-500/30' : venceHoje ? 'bg-rose-950/20 border-rose-500/40' : 'bg-slate-950/70 border-slate-800'}`}>
                          <div>
                            <p className="text-sm font-medium text-slate-200 flex items-center gap-1.5">
                              {cf.nome}
                              {venceHoje && <span className="text-[10px] bg-rose-500 text-slate-950 font-bold px-2 py-0.5 rounded-full">VENCE HOJE</span>}
                            </p>
                            <p className="text-xs text-slate-400">Todo dia {cf.diaVencimento} • R$ {Number(cf.valorPadrao).toFixed(2)}</p>
                          </div>
                          {jaPaga ? (
                            <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Pago
                            </span>
                          ) : (
                            <button 
                              onClick={() => pagarContaFixaRapido(cf)}
                              className="text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold px-3 py-1.5 rounded-lg transition flex items-center gap-1"
                            >
                              <Zap className="w-3 h-3" /> Dar Baixa
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* LIMITES POR CATEGORIA */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Target className="w-4 h-4 text-emerald-400" /> Limites por Categoria ({filtroMesAno})
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {categorias.filter(cat => cat !== 'Receita').map(cat => {
                    const gastoCat = transacoesFiltradas
                      .filter(t => t.tipo === 'DESPESA' && t.categoria === cat)
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

              {/* GRÁFICOS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl flex flex-col items-center shadow-xl">
                  <h2 className="text-sm font-semibold text-slate-200 mb-3 w-full text-left">Despesas por Categoria</h2>
                  {despesasPorCategoria.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-slate-500">Sem despesas registradas</div>
                  ) : (
                    <div className="w-full h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={despesasPorCategoria} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label>
                            {despesasPorCategoria.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={CORES_GRAFICO[index % CORES_GRAFICO.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ backgroundColor: '#090d16', borderColor: '#1e293b', borderRadius: '12px', fontSize: '12px', color: '#f8fafc' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
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

              {/* LISTA DE TRANSAÇÕES COM BOTÃO EDITAR */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl">
                <h2 className="text-sm font-semibold text-slate-200 mb-4">Lançamentos de {filtroMesAno}</h2>
                {transacoesFiltradas.length === 0 ? (
                  <p className="text-sm text-slate-500 py-6 text-center">Nenhum lançamento encontrado neste período.</p>
                ) : (
                  <div className="space-y-3">
                    {transacoesFiltradas.map(t => (
                      <div key={t.id} className="flex items-center justify-between bg-slate-950/60 p-4 rounded-xl border border-slate-800/60 hover:border-slate-700/80 transition">
                        <div className="flex items-center gap-3.5">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${t.tipo === 'RECEITA' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                            {t.tipo === 'RECEITA' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                          </div>
                          <div>
                            <p className="font-medium text-sm text-slate-200 flex items-center gap-2">
                              {t.descricao}
                              {t.fatura_paga && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full">Fatura Paga</span>}
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">{t.categoria} • <span className="text-slate-300 font-medium">{t.cartao_nome || t.metodo}</span></p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`font-bold text-sm tracking-tight ${t.tipo === 'RECEITA' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.tipo === 'RECEITA' ? '+' : '-'} R$ {Number(t.valor).toFixed(2)}
                          </span>
                          <button onClick={() => setTransacaoEditando(t)} className="text-slate-500 hover:text-sky-400 transition p-1" title="Editar lançamento">
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button onClick={() => excluirTransacao(t.id)} className="text-slate-500 hover:text-rose-400 transition p-1" title="Excluir">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ================================================================
              ABA 2: CARTÃO DE CRÉDITO COMPLETA (FATURAS, MELHOR DIA, PARCELADO)
          ================================================================ */}
          {abaAtiva === 'cartoes' && (
            <div className="space-y-6">
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-xl">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-emerald-400" /> Gestão de Cartões de Crédito & Faturas
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    O limite disponível deduz automaticamente compras à vista e parcelas futuras em aberto.
                  </p>
                </div>
                <input 
                  type="month" value={filtroMesAno} onChange={e => setFiltroMesAno(e.target.value)} 
                  className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-emerald-400 font-semibold"
                />
              </div>

              {/* CARDS INDIVIDUAIS DE CADA CARTÃO DE CRÉDITO */}
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
                              ⭐ Ótimo dia p/ compra
                            </span>
                          )}
                        </h3>
                      </div>
                      <button 
                        onClick={() => pagarFaturaCartao(c.nome)}
                        className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs px-3 py-2 rounded-xl transition shadow-md shadow-emerald-500/10"
                      >
                        Pagar / Antecipar Fatura
                      </button>
                    </div>

                    {/* DATAS: FECHAMENTO, VENCIMENTO E MELHOR DIA */}
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

                    {/* VALORES E BARRA DE LIMITE */}
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-400">Fatura de {filtroMesAno}: <strong className="text-rose-400">R$ {c.faturaMes.toFixed(2)}</strong></span>
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
                        <span>Limite Total: R$ {Number(c.limite).toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* LANÇAR COMPRA PARCELADA DIRETO NA ABA DE CARTÃO */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Plus className="w-4 h-4 text-emerald-400" /> Novo Lançamento / Compra Parcelada no Cartão
                </h3>
                <form onSubmit={lancarCompraCartaoManual} className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                  <input 
                    type="text" required placeholder="Descrição (ex: Geladeira)" value={novaCompraCartao.descricao}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, descricao: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <input 
                    type="number" step="0.01" required placeholder="Valor Total (R$)" value={novaCompraCartao.valorTotal}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, valorTotal: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  />
                  <select 
                    value={novaCompraCartao.parcelas}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, parcelas: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {[1,2,3,4,5,6,7,8,9,10,12,18,24].map(n => (
                      <option key={n} value={n}>{n}x {n === 1 ? '(À vista)' : 'parcelas'}</option>
                    ))}
                  </select>
                  <select 
                    value={novaCompraCartao.cartaoNome}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, cartaoNome: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {cartoes.map(c => <option key={c.id} value={c.nome}>{c.nome}</option>)}
                  </select>
                  <select 
                    value={novaCompraCartao.categoria}
                    onChange={e => setNovaCompraCartao({ ...novaCompraCartao, categoria: e.target.value })}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                  >
                    {categorias.filter(c => c !== 'Receita').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                  <button type="submit" className="sm:col-span-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                    Lançar na Fatura
                  </button>
                </form>
              </div>

              {/* FATURA DETALHADA POR CARTÃO COM OPÇÃO DE EDITAR COMPRAS */}
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
                            {t.fatura_paga && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full">Paga / Antecipada</span>}
                          </p>
                          <p className="text-xs text-slate-400">{t.categoria}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-bold text-sm text-rose-400">R$ {Number(t.valor).toFixed(2)}</span>
                          <button onClick={() => setTransacaoEditando(t)} className="text-slate-400 hover:text-sky-400 p-1" title="Editar compra">
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button onClick={() => excluirTransacao(t.id)} className="text-slate-500 hover:text-rose-400 p-1" title="Excluir compra">
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
              ABA 3: CADASTRO DE BANCOS E CARTÕES (COM EDIÇÃO)
          ================================================================ */}
          {abaAtiva === 'bancos' && (
            <div className="space-y-6">
              {/* CADASTRO / EDIÇÃO DE CARTÕES DE CRÉDITO */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-5 shadow-xl">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-emerald-400" /> {cartaoForm.id ? 'Editar Cartão de Crédito' : 'Cadastrar Cartão de Crédito'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Configure múltiplos cartões, limites, dia de fechamento (melhor dia de compra) e vencimento.
                  </p>
                </div>

                <form onSubmit={salvarCartao} className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                  <input 
                    type="text" required placeholder="Nome (ex: VISA INFINITE)" value={cartaoForm.nome}
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
                    title="Dia de Fechamento da Fatura"
                  />
                  <input 
                    type="number" min="1" max="31" required placeholder="Dia Vencimento" value={cartaoForm.diaVencimento}
                    onChange={e => setCartaoForm({ ...cartaoForm, diaVencimento: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                    title="Dia de Vencimento da Fatura"
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

              {/* CADASTRO / EDIÇÃO DE BANCOS & CARTÕES DE DÉBITO */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-5 shadow-xl">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <Landmark className="w-5 h-5 text-sky-400" /> {bancoForm.id ? 'Editar Conta Bancária / Débito' : 'Cadastrar Bancos & Cartões de Débito'}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Cadastre suas contas bancárias para movimentações no Débito, Pix e Transferências.
                  </p>
                </div>

                <form onSubmit={salvarBanco} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input 
                    type="text" required placeholder="Nome do Banco (ex: Itaú, Bradesco, C6)" value={bancoForm.nome}
                    onChange={e => setBancoForm({ ...bancoForm, nome: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  />
                  <select 
                    value={bancoForm.tipo}
                    onChange={e => setBancoForm({ ...bancoForm, tipo: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200"
                  >
                    <option value="Conta Corrente / Débito">Conta Corrente / Cartão de Débito</option>
                    <option value="Conta Digital / Pix">Conta Digital / Pix</option>
                    <option value="Conta PJ / Empresarial">Conta PJ / Empresarial</option>
                    <option value="Carteira / Dinheiro">Carteira Física / Dinheiro</option>
                  </select>
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold py-2.5 rounded-xl text-xs transition">
                      {bancoForm.id ? 'Salvar Banco' : '+ Adicionar Banco'}
                    </button>
                    {bancoForm.id && (
                      <button 
                        type="button" 
                        onClick={() => setBancoForm({ id: null, nome: '', tipo: 'Conta Corrente / Débito', saldoInicial: '' })}
                        className="px-3 py-2.5 bg-slate-800 text-slate-300 rounded-xl text-xs"
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </form>

                <div className="space-y-2.5">
                  {bancos.map(b => (
                    <div key={b.id} className="flex items-center justify-between bg-slate-950/70 border border-slate-800 px-4 py-3.5 rounded-xl">
                      <div>
                        <p className="font-bold text-sm text-slate-100">{b.nome}</p>
                        <p className="text-xs text-slate-400">{b.tipo}</p>
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
              ABA 4: CONTAS FIXAS & ALERTAS NO WHATSAPP
          ================================================================ */}
          {abaAtiva === 'fixas' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-6 shadow-xl">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2">
                    <BellRing className="w-5 h-5 text-amber-400" /> Contas Fixas & Alertas no WhatsApp
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    No dia do vencimento de cada conta abaixo, o bot envia um lembrete automático no seu WhatsApp!
                  </p>
                </div>
                <button 
                  onClick={dispararTesteAlertaWhatsApp}
                  className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 px-4 py-2 rounded-xl text-xs font-semibold transition"
                >
                  🔔 Testar Alerta de Hoje no WhatsApp
                </button>
              </div>

              <form onSubmit={adicionarContaFixa} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <input type="text" placeholder="Nome (ex: Energia Elétrica)" value={fixaNome} onChange={e => setFixaNome(e.target.value)} className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200" />
                <input type="number" placeholder="Valor (R$)" value={fixaValor} onChange={e => setFixaValor(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200" />
                <input type="number" min="1" max="31" placeholder="Dia Venc. (ex: 15)" value={fixaDia} onChange={e => setFixaDia(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200" />
                <button type="submit" className="sm:col-span-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-xl font-semibold text-sm transition">+ Cadastrar Conta com Alerta no WhatsApp</button>
              </form>

              <div className="space-y-2.5">
                {contasFixas.map(cf => (
                  <div key={cf.id} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 px-4 py-3.5 rounded-xl">
                    <div>
                      <p className="font-medium text-sm text-slate-200">{cf.nome}</p>
                      <p className="text-xs text-slate-400"> Alerta WhatsApp todo dia <strong>{cf.diaVencimento}</strong> • R$ {Number(cf.valorPadrao).toFixed(2)}</p>
                    </div>
                    <button onClick={() => excluirContaFixa(cf.id)} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 5: CATEGORIAS & LIMITES
          ================================================================ */}
          {abaAtiva === 'categorias' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-6 shadow-xl">
              <div>
                <h2 className="text-lg font-bold">Categorias & Orçamentos</h2>
                <p className="text-xs text-slate-400 mt-0.5">Gerencie categorias e defina limites mensais para receber alertas.</p>
              </div>
              <form onSubmit={adicionarCategoria} className="flex gap-3">
                <input type="text" placeholder="Nome da Categoria (ex: Pet)" value={novaCatNome} onChange={e => setNovaCatNome(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200" />
                <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-3 rounded-xl font-semibold text-sm flex items-center gap-2"><Plus className="w-4 h-4" /> Adicionar</button>
              </form>

              <form onSubmit={definirOrcamento} className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-800/80">
                <select 
                  value={orcamentoCat} onChange={e => setOrcamentoCat(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200"
                >
                  <option value="">Selecione para definir limite</option>
                  {categorias.filter(c => c !== 'Receita').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input 
                  type="number" placeholder="Limite (R$)" value={orcamentoValor} onChange={e => setOrcamentoValor(e.target.value)} 
                  className="w-full sm:w-44 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200" 
                />
                <button type="submit" className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-3 rounded-xl font-semibold text-sm transition">
                  Salvar Limite
                </button>
              </form>

              <div className="space-y-2.5">
                {categorias.map(cat => (
                  <div key={cat} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 px-4 py-3.5 rounded-xl text-sm">
                    <div>
                      <span className="font-medium text-slate-200">{cat}</span>
                      <span className="text-xs text-slate-400 ml-3">
                        {orcamentos[cat] ? `Limite: R$ ${orcamentos[cat].toFixed(2)}` : 'Sem limite definido'}
                      </span>
                    </div>
                    <button onClick={() => excluirCategoria(cat)} className="text-slate-600 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              ABA 6: CONEXÃO WHATSAPP
          ================================================================ */}
          {abaAtiva === 'whatsapp' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-8 rounded-2xl text-center space-y-6 shadow-xl max-w-lg mx-auto">
              <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto border border-emerald-500/20">
                <QrCode className="w-8 h-8" />
              </div>
              
              <div>
                <h2 className="text-xl font-bold">Conexão WhatsApp</h2>
                <p className="text-xs text-slate-400 mt-1">Leia o QR Code abaixo com o seu WhatsApp para ativar os lançamentos e alertas automáticos.</p>
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
              <p className="text-xs text-emerald-500/80 font-medium">Testar Perguntas & Gastos sem Método</p>
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
            <button type="button" onClick={() => setMsgWhats('Comprei um lanche de 45,00')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded-xl whitespace-nowrap">❓ Testar Sem Pagamento</button>
            <button type="button" onClick={() => setMsgWhats('Fatura do VISA')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-emerald-400 border border-slate-800 px-3 py-1.5 rounded-xl whitespace-nowrap">💳 "Fatura VISA"</button>
            <button type="button" onClick={() => setMsgWhats('desfazer')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-rose-400 border border-slate-800 px-3 py-1.5 rounded-xl whitespace-nowrap">🗑️ "desfazer"</button>
          </div>

          <form onSubmit={handleEnviarWhatsApp} className="p-3.5 bg-slate-900/80 border-t border-slate-800/80 flex gap-2.5">
            <input 
              type="text" placeholder="Digite como no WhatsApp..." value={msgWhats} onChange={e => setMsgWhats(e.target.value)} 
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