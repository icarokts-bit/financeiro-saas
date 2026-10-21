import React, { useState, useEffect } from 'react';
import { 
  Wallet, TrendingUp, TrendingDown, CreditCard, MessageSquare, 
  Plus, Trash2, QrCode, Send, LogOut, Lock, Mail, BarChart2, Calendar, FolderPlus, Target, AlertTriangle, Sparkles 
} from 'lucide-react';
import { db, auth } from './firebaseConfig';
import { 
  collection, addDoc, onSnapshot, deleteDoc, doc, 
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

export default function App() {
  const [user, setUser] = useState(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [emailInput, setEmailInput] = useState('');
  const [senhaInput, setSenhaInput] = useState('');
  const [erroAuth, setErroAuth] = useState('');

  const [abaAtiva, setAbaAtiva] = useState('dashboard');
  const [transacoes, setTransacoes] = useState([]);
  const [cartoes, setCartoes] = useState([
    { id: '1', nome: 'VISA', limite: 5000 },
    { id: '2', nome: 'NUBANK', limite: 3500 }
  ]);
  
  const [categorias, setCategorias] = useState(['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros']);
  const [orcamentos, setOrcamentos] = useState({});
  const [novaCatNome, setNovaCatNome] = useState('');
  const [orcamentoCat, setOrcamentoCat] = useState('');
  const [orcamentoValor, setOrcamentoValor] = useState('');

  const dataAtualObj = new Date();
  const mesAtualStr = `${dataAtualObj.getFullYear()}-${String(dataAtualObj.getMonth() + 1).padStart(2, '0')}`;
  const [filtroMesAno, setFiltroMesAno] = useState(mesAtualStr);

  const [msgWhats, setMsgWhats] = useState('');
  const [historicoChat, setHistoricoChat] = useState([
    { autor: 'bot', texto: 'Olá! Envie seus gastos ou utilize os botões de atalho abaixo para testar.' }
  ]);
  const [processando, setProcessando] = useState(false);

  const [novoCartaoNome, setNovoCartaoNome] = useState('');
  const [novoCartaoLimite, setNovoCartaoLimite] = useState('');

  const CORES_GRAFICO = ['#34d399', '#38bdf8', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf', '#fb7185', '#60a5fa'];

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
        } else {
          await setDoc(userDocRef, { categorias, orcamentos: {} }, { merge: true });
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

    const q = query(
      collection(db, 'users', user.uid, 'transacoes'),
      orderBy('criadoEm', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const lista = snapshot.docs.map(doc => {
        const dataDoc = doc.data();
        let anoMes = dataDoc.anoMes;
        if (!anoMes && dataDoc.criadoEm) {
          const d = dataDoc.criadoEm.toDate ? dataDoc.criadoEm.toDate() : new Date();
          anoMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
        return {
          id: doc.id,
          ...dataDoc,
          anoMes: anoMes || mesAtualStr
        };
      });
      setTransacoes(lista);
    });

    return () => unsubscribe();
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

  const handleLogout = async () => {
    await signOut(auth);
  };

  const adicionarCategoria = async (e) => {
    e.preventDefault();
    if (!novaCatNome.trim() || !user) return;
    const catFormatada = novaCatNome.charAt(0).toUpperCase() + novaCatNome.slice(1).toLowerCase();
    
    if (categorias.includes(catFormatada)) {
      alert('Esta categoria já existe!');
      return;
    }

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
    if (categorias.length <= 1) {
      alert('Você precisa ter pelo menos uma categoria.');
      return;
    }
    const novasCats = categorias.filter(c => c !== catParaExcluir);
    setCategorias(novasCats);
    const novosOrcamentos = { ...orcamentos };
    delete novosOrcamentos[catParaExcluir];
    setOrcamentos(novosOrcamentos);

    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats, orcamentos: novosOrcamentos }, { merge: true });
  };

  const interpretarMensagemWhatsApp = (texto) => {
    const txtLower = texto.toLowerCase();
    const matchParcelas = txtLower.match(/(\d+)\s*(?:x|vezes|parcelas)/);
    const parcelasTotal = matchParcelas ? parseInt(matchParcelas[1]) : 1;

    const matchValor = texto.match(/(\d+[.,]\d{2}|\d+)/);
    if (!matchValor) return null;
    
    let valorTotal = parseFloat(matchValor[0].replace(',', '.'));
    const valorParcela = parcelasTotal > 1 ? Number((valorTotal / parcelasTotal).toFixed(2)) : valorTotal;

    const isReceita = /recebi|ganhei|salário|salario|pix recebido|venda/i.test(txtLower);
    const tipo = isReceita ? 'RECEITA' : 'DESPESA';

    let metodo = 'DINHEIRO/PIX';
    if (/crédito|credito|cartão|cartao/i.test(txtLower)) metodo = 'CREDITO';
    else if (/débito|debito/i.test(txtLower)) metodo = 'DEBITO';
    else if (/pix/i.test(txtLower)) metodo = 'PIX';

    let cartaoIdentificado = null;
    for (const c of cartoes) {
      if (txtLower.includes(c.nome.toLowerCase())) {
        cartaoIdentificado = c.nome;
        metodo = 'CREDITO';
        break;
      }
    }

    let categoria = isReceita ? 'Receita' : 'Outros';
    for (const cat of categorias) {
      if (txtLower.includes(cat.toLowerCase())) {
        categoria = cat;
        break;
      }
    }

    let descricao = texto
      .replace(/fui no|fui na|comprei|gastei|paguei|no cartão de credito|no cartão|no credito|reais|r\$/gi, '')
      .replace(matchValor[0], '')
      .replace(matchParcelas ? matchParcelas[0] : '', '')
      .replace(cartaoIdentificado ? new RegExp(cartaoIdentificado, 'gi') : '', '')
      .trim();

    if (!descricao || descricao.length < 2) descricao = `Compra (${categoria})`;
    descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1);

    return {
      descricao,
      valorTotal,
      valorParcela,
      parcelasTotal,
      tipo,
      metodo,
      cartao_nome: cartaoIdentificado,
      categoria,
      origem: 'WHATSAPP'
    };
  };

  const handleEnviarWhatsApp = async (e) => {
    e.preventDefault();
    if (!msgWhats.trim() || !user) return;

    const textoUsuario = msgWhats;
    setMsgWhats('');
    setHistoricoChat(prev => [...prev, { autor: 'user', texto: textoUsuario }]);
    setProcessando(true);

    try {
      const dados = interpretarMensagemWhatsApp(textoUsuario);

      if (!dados) {
        setHistoricoChat(prev => [...prev, { autor: 'bot', texto: '❌ Não identifiquei o valor. Tente: "Gastei 150 no PIX"' }]);
        setProcessando(false);
        return;
      }

      const hoje = new Date();
      const anoM = hoje.getFullYear();
      const mesM = String(hoje.getMonth() + 1).padStart(2, '0');

      await addDoc(collection(db, 'users', user.uid, 'transacoes'), {
        descricao: dados.descricao,
        valor: dados.valorParcela,
        tipo: dados.tipo,
        metodo: dados.metodo,
        cartao_nome: dados.cartao_nome,
        categoria: dados.categoria,
        anoMes: `${anoM}-${mesM}`,
        mensagem_original: textoUsuario,
        criadoEm: serverTimestamp()
      });

      setHistoricoChat(prev => [...prev, { autor: 'bot', texto: `✅ Lançado: ${dados.descricao} [${dados.categoria}] - R$ ${dados.valorParcela.toFixed(2)}` }]);
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

  const adicionarCartao = (e) => {
    e.preventDefault();
    if (!novoCartaoNome) return;
    setCartoes([...cartoes, { id: Date.now().toString(), nome: novoCartaoNome.toUpperCase(), limite: Number(novoCartaoLimite) || 1000 }]);
    setNovoCartaoNome('');
    setNovoCartaoLimite('');
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

  const transacoesFiltradas = transacoes.filter(t => t.anoMes === filtroMesAno);
  const totalReceitas = transacoesFiltradas.filter(t => t.tipo === 'RECEITA').reduce((acc, t) => acc + Number(t.valor || 0), 0);
  const totalDespesas = transacoesFiltradas.filter(t => t.tipo === 'DESPESA').reduce((acc, t) => acc + Number(t.valor || 0), 0);
  const saldoAtual = totalReceitas - totalDespesas;

  const despesasPorCategoria = categorias.map(cat => {
    const total = transacoesFiltradas
      .filter(t => t.tipo === 'DESPESA' && t.categoria === cat)
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);
    return { name: cat, value: total };
  }).filter(item => item.value > 0);

  const dadosCartoesGrafico = cartoes.map(c => {
    const total = transacoesFiltradas
      .filter(t => t.cartao_nome?.toLowerCase() === c.nome.toLowerCase())
      .reduce((acc, t) => acc + Number(t.valor || 0), 0);
    return { name: c.nome, gasto: total };
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-emerald-500 selection:text-slate-950">
      
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
                <Sparkles className="w-3 h-3" /> WhatsApp Automático
              </span>
            </div>
          </div>

          <nav className="space-y-1.5">
            <button onClick={() => setAbaAtiva('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'dashboard' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <BarChart2 className="w-4 h-4" /> Dashboard & Gráficos
            </button>
            <button onClick={() => setAbaAtiva('categorias')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'categorias' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <FolderPlus className="w-4 h-4" /> Categorias & Orçamentos
            </button>
            <button onClick={() => setAbaAtiva('cartoes')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'cartoes' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <CreditCard className="w-4 h-4" /> Meus Cartões
            </button>
            <button onClick={() => setAbaAtiva('whatsapp')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition ${abaAtiva === 'whatsapp' ? 'bg-emerald-500 text-slate-950 font-semibold shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <QrCode className="w-4 h-4" /> Conexão WhatsApp
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
          
          {abaAtiva === 'dashboard' && (
            <>
              {/* FILTRO DE PERÍODO */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-4.5 rounded-2xl flex flex-col sm:flex-row justify-between items-center gap-4 shadow-xl">
                <div className="flex items-center gap-2.5 text-slate-200 text-sm font-medium">
                  <Calendar className="w-4 h-4 text-emerald-400" />
                  <span>Período de Referência:</span>
                </div>
                <input 
                  type="month" 
                  value={filtroMesAno} 
                  onChange={e => setFiltroMesAno(e.target.value)} 
                  className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-emerald-400 font-semibold focus:outline-none focus:border-emerald-500 transition"
                />
              </div>

              {/* CARDS DE RESUMO */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl shadow-xl relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl"></div>
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

              {/* ORÇAMENTOS E ALERTAS */}
              <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-5 rounded-2xl space-y-4 shadow-xl">
                <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Target className="w-4 h-4 text-emerald-400" /> Limites e Alertas de Gastos ({filtroMesAno})
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
                              className={`h-full transition-all duration-500 ${ultrapassou ? 'bg-rose-500 shadow-lg shadow-rose-500/50' : 'bg-emerald-500 shadow-lg shadow-emerald-500/50'}`} 
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
                    <div className="h-48 flex items-center justify-center text-xs text-slate-500">Sem despesas registradas no mês</div>
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
                  <h2 className="text-sm font-semibold text-slate-200 mb-3 w-full text-left">Gastos por Cartão</h2>
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

              {/* LISTA DE TRANSAÇÕES */}
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
                            <p className="font-medium text-sm text-slate-200">{t.descricao}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{t.categoria} • <span className="text-slate-300 font-medium">{t.cartao_nome || t.metodo}</span></p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className={`font-bold text-sm tracking-tight ${t.tipo === 'RECEITA' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.tipo === 'RECEITA' ? '+' : '-'} R$ {Number(t.valor).toFixed(2)}
                          </span>
                          <button onClick={() => excluirTransacao(t.id)} className="text-slate-600 hover:text-rose-400 transition p-1">
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

          {abaAtiva === 'categorias' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-6 shadow-xl">
              <div>
                <h2 className="text-lg font-bold">Categorias & Orçamentos</h2>
                <p className="text-xs text-slate-400 mt-0.5">Gerencie suas categorias e defina limites mensais para monitorar gastos.</p>
              </div>

              <form onSubmit={adicionarCategoria} className="flex gap-3">
                <input 
                  type="text" placeholder="Nome da Categoria (ex: Pet)" value={novaCatNome} onChange={e => setNovaCatNome(e.target.value)} 
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition" 
                />
                <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-3 rounded-xl font-semibold text-sm transition flex items-center gap-2 shadow-lg shadow-emerald-500/20">
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </form>

              <form onSubmit={definirOrcamento} className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-slate-800/80">
                <select 
                  value={orcamentoCat} onChange={e => setOrcamentoCat(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition"
                >
                  <option value="">Selecione para definir limite</option>
                  {categorias.filter(c => c !== 'Receita').map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input 
                  type="number" placeholder="Limite (R$)" value={orcamentoValor} onChange={e => setOrcamentoValor(e.target.value)} 
                  className="w-full sm:w-44 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 transition" 
                />
                <button type="submit" className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-3 rounded-xl font-semibold text-sm transition shadow-lg shadow-blue-600/20">
                  Salvar Limite
                </button>
              </form>

              <div className="space-y-2.5 pt-2">
                {categorias.map(cat => (
                  <div key={cat} className="flex items-center justify-between bg-slate-950/60 border border-slate-800/80 px-4 py-3.5 rounded-xl text-sm">
                    <div>
                      <span className="font-medium text-slate-200">{cat}</span>
                      <span className="text-xs text-slate-400 ml-3 font-medium">
                        {orcamentos[cat] ? `Limite: R$ ${orcamentos[cat].toFixed(2)}` : 'Sem limite definido'}
                      </span>
                    </div>
                    <button onClick={() => excluirCategoria(cat)} className="text-slate-600 hover:text-rose-400 transition">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {abaAtiva === 'cartoes' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-6 rounded-2xl space-y-6 shadow-xl">
              <div>
                <h2 className="text-lg font-bold">Meus Cartões de Crédito</h2>
                <p className="text-xs text-slate-400 mt-0.5">Cadastre os cartões para o assistente identificar nos lançamentos.</p>
              </div>

              <form onSubmit={adicionarCartao} className="flex gap-3">
                <input type="text" placeholder="Nome (ex: VISA)" value={novoCartaoNome} onChange={e => setNovoCartaoNome(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500" />
                <input type="number" placeholder="Limite" value={novoCartaoLimite} onChange={e => setNovoCartaoLimite(e.target.value)} className="w-36 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-emerald-500" />
                <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-3 rounded-xl font-semibold text-sm transition shadow-lg shadow-emerald-500/20">Adicionar</button>
              </form>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {cartoes.map(c => (
                  <div key={c.id} className="p-5 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex justify-between items-center shadow-xl">
                    <div>
                      <p className="font-bold text-base text-slate-100">{c.nome}</p>
                      <p className="text-xs text-slate-400 mt-1">Limite: R$ {c.limite.toFixed(2)}</p>
                    </div>
                    <CreditCard className="w-8 h-8 text-slate-600" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {abaAtiva === 'whatsapp' && (
            <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-8 rounded-2xl text-center space-y-4 shadow-xl max-w-lg mx-auto">
              <div className="w-16 h-16 bg-emerald-500/10 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto border border-emerald-500/20">
                <QrCode className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold">Conexão WhatsApp (QR Code)</h2>
              <p className="text-sm text-slate-400 leading-relaxed">
                Assim que o servidor do WhatsApp estiver ativo no Railway, o QR Code dinâmico aparecerá automaticamente aqui para leitura.
              </p>
            </div>
          )}

        </div>

        {/* SIMULADOR DE WHATSAPP MODERNO */}
        <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl flex flex-col h-[650px] overflow-hidden shadow-xl">
          <div className="bg-emerald-950/40 border-b border-emerald-900/30 p-4.5 flex items-center gap-3.5">
            <div className="w-9 h-9 bg-emerald-500 text-slate-950 rounded-xl flex items-center justify-center font-bold shadow-lg shadow-emerald-500/20">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-emerald-300">Simulador do WhatsApp</h3>
              <p className="text-xs text-emerald-500/80 font-medium">Testes em tempo real</p>
            </div>
          </div>

          <div className="flex-1 p-4.5 space-y-3.5 overflow-y-auto bg-slate-950/40">
            {historicoChat.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.autor === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-lg ${
                  msg.autor === 'user' 
                    ? 'bg-emerald-500 text-slate-950 font-medium rounded-br-none' 
                    : 'bg-slate-900 text-slate-200 border border-slate-800 rounded-bl-none'
                }`}>
                  {msg.texto}
                </div>
              </div>
            ))}
            {processando && <div className="text-xs text-slate-500 italic px-2">Processando lançamento...</div>}
          </div>

          <div className="p-2.5 bg-slate-900/80 border-t border-slate-800/80 flex gap-2 overflow-x-auto">
            <button type="button" onClick={() => setMsgWhats('Gastei 150 no mercado')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 px-3 py-1.5 rounded-xl whitespace-nowrap transition font-medium">⚡ "mercado 150"</button>
            <button type="button" onClick={() => setMsgWhats('Recebi 4000 de salário')} className="text-[11px] bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 px-3 py-1.5 rounded-xl whitespace-nowrap transition font-medium">⚡ "salário 4000"</button>
          </div>

          <form onSubmit={handleEnviarWhatsApp} className="p-3.5 bg-slate-900/80 border-t border-slate-800/80 flex gap-2.5">
            <input 
              type="text" placeholder="Digite como no WhatsApp..." value={msgWhats} onChange={e => setMsgWhats(e.target.value)} 
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 transition" 
            />
            <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 p-3 rounded-xl transition flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

      </main>
    </div>
  );
}