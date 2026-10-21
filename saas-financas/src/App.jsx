import React, { useState, useEffect } from 'react';
import { 
  Wallet, TrendingUp, TrendingDown, CreditCard, MessageSquare, 
  Plus, Trash2, QrCode, Send, LogOut, Lock, Mail, BarChart2, Calendar, FolderPlus 
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
    { id: '2', nome: 'Nubank', limite: 3500 }
  ]);
  
  // Categorias agora vindas do Firestore do usuário (com padrão caso não existam)
  const [categorias, setCategorias] = useState(['Mercado', 'Alimentação', 'Transporte', 'Lazer', 'Contas', 'Receita', 'Outros']);
  const [novaCatNome, setNovaCatNome] = useState('');

  const dataAtualObj = new Date();
  const mesAtualStr = `${dataAtualObj.getFullYear()}-${String(dataAtualObj.getMonth() + 1).padStart(2, '0')}`;
  const [filtroMesAno, setFiltroMesAno] = useState(mesAtualStr);

  const [msgWhats, setMsgWhats] = useState('');
  const [historicoChat, setHistoricoChat] = useState([
    { autor: 'bot', texto: 'Olá! Envie seus gastos ou utilize os botões de atalho abaixo.' }
  ]);
  const [processando, setProcessando] = useState(false);

  const [novoCartaoNome, setNovoCartaoNome] = useState('');
  const [novoCartaoLimite, setNovoCartaoLimite] = useState('');

  const CORES_GRAFICO = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#06b6d4', '#e11d48'];

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Carrega as categorias customizadas do usuário no Firestore
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists() && userSnap.data().categorias) {
          setCategorias(userSnap.data().categorias);
        } else {
          // Cria o documento inicial com categorias padrão se não existir
          await setDoc(userDocRef, { categorias }, { merge: true });
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

  // Adicionar Nova Categoria e salvar no Firestore
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

    // Salva no Firestore
    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats }, { merge: true });
  };

  // Excluir Categoria
  const excluirCategoria = async (catParaExcluir) => {
    if (categorias.length <= 1) {
      alert('Você precisa ter pelo menos uma categoria.');
      return;
    }
    const novasCats = categorias.filter(c => c !== catParaExcluir);
    setCategorias(novasCats);
    await setDoc(doc(db, 'users', user.uid), { categorias: novasCats }, { merge: true });
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

    // Identificação dinâmica baseada nas categorias cadastradas pelo usuário
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
        setHistoricoChat(prev => [...prev, { autor: 'bot', texto: '❌ Não consegui identificar o valor. Tente: "Gastei 150 no PIX"' }]);
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

      setHistoricoChat(prev => [...prev, { autor: 'bot', texto: `✅ Lançado: ${dados.descricao} [${dados.categoria}] (R$ ${dados.valorParcela.toFixed(2)})` }]);
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

  if (carregandoAuth) return <div className="min-h-screen bg-slate-950 text-emerald-400 flex items-center justify-center">Carregando...</div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl w-full max-w-md">
          <h1 className="text-xl font-bold mb-6 text-center">FinZap SaaS - Login</h1>
          {erroAuth && <p className="text-rose-400 text-xs mb-4 text-center">{erroAuth}</p>}
          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <input type="email" required placeholder="E-mail" value={emailInput} onChange={e => setEmailInput(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm" />
            <input type="password" required placeholder="Senha" value={senhaInput} onChange={e => setSenhaInput(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm" />
            <button type="submit" className="w-full bg-emerald-500 text-slate-950 font-semibold py-3 rounded-xl text-sm">Entrar</button>
          </form>
          <button onClick={() => setIsLoginMode(!isLoginMode)} className="mt-4 text-xs text-emerald-400 w-full text-center block">
            {isLoginMode ? 'Criar conta' : 'Já tenho conta'}
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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans">
      
      <aside className="w-full md:w-64 bg-slate-900 border-r border-slate-800 p-5 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-8">
            <div className="bg-emerald-500 p-2 rounded-xl text-slate-950 font-bold"><Wallet size={24} /></div>
            <div>
              <h1 className="font-bold text-lg leading-none">FinZap SaaS</h1>
              <span className="text-xs text-emerald-400">Categorias Customizadas</span>
            </div>
          </div>
          <nav className="space-y-2">
            <button onClick={() => setAbaAtiva('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${abaAtiva === 'dashboard' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400'}`}>
              <BarChart2 size={18} /> Dashboard & Gráficos
            </button>
            <button onClick={() => setAbaAtiva('categorias')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${abaAtiva === 'categorias' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400'}`}>
              <FolderPlus size={18} /> Gerenciar Categorias
            </button>
            <button onClick={() => setAbaAtiva('cartoes')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${abaAtiva === 'cartoes' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400'}`}>
              <CreditCard size={18} /> Meus Cartões
            </button>
            <button onClick={() => setAbaAtiva('whatsapp')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium ${abaAtiva === 'whatsapp' ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400'}`}>
              <QrCode size={18} /> Conexão WhatsApp
            </button>
          </nav>
        </div>
        <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
          <LogOut size={14} /> Sair
        </button>
      </aside>

      <main className="flex-1 p-6 md:p-8 overflow-y-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        <div className="lg:col-span-2 space-y-6">
          
          {abaAtiva === 'dashboard' && (
            <>
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex items-center gap-2 text-slate-300 text-sm font-medium">
                  <Calendar size={18} className="text-emerald-400" />
                  <span>Filtrar Período:</span>
                </div>
                <input 
                  type="month" 
                  value={filtroMesAno} 
                  onChange={e => setFiltroMesAno(e.target.value)} 
                  className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-emerald-400 font-semibold focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                  <span className="text-xs text-slate-400 uppercase">Saldo do Mês</span>
                  <p className={`text-2xl font-bold mt-1 ${saldoAtual >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>R$ {saldoAtual.toFixed(2)}</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                  <span className="text-xs text-slate-400 uppercase flex items-center gap-1"><TrendingUp size={14} className="text-emerald-400" /> Receitas</span>
                  <p className="text-2xl font-bold mt-1">R$ {totalReceitas.toFixed(2)}</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                  <span className="text-xs text-slate-400 uppercase flex items-center gap-1"><TrendingDown size={14} className="text-rose-400" /> Despesas</span>
                  <p className="text-2xl font-bold mt-1">R$ {totalDespesas.toFixed(2)}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col items-center">
                  <h2 className="text-sm font-semibold text-slate-300 mb-2 w-full text-left">Despesas por Categoria</h2>
                  {despesasPorCategoria.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-slate-500">Sem dados neste mês</div>
                  ) : (
                    <div className="w-full h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={despesasPorCategoria} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label>
                            {despesasPorCategoria.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={CORES_GRAFICO[index % CORES_GRAFICO.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col items-center">
                  <h2 className="text-sm font-semibold text-slate-300 mb-2 w-full text-left">Gastos por Cartão</h2>
                  <div className="w-full h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dadosCartoesGrafico}>
                        <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
                        <YAxis stroke="#64748b" fontSize={12} />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '12px' }} />
                        <Bar dataKey="gasto" fill="#10b981" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                <h2 className="text-sm font-semibold text-slate-300 mb-4">Lançamentos de {filtroMesAno}</h2>
                {transacoesFiltradas.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">Nenhum lançamento encontrado para este mês.</p>
                ) : (
                  <div className="space-y-3">
                    {transacoesFiltradas.map(t => (
                      <div key={t.id} className="flex items-center justify-between bg-slate-950 p-3.5 rounded-xl border border-slate-800/80">
                        <div>
                          <p className="font-medium text-sm text-slate-200">{t.descricao}</p>
                          <p className="text-xs text-slate-400">{t.categoria} • {t.cartao_nome || t.metodo}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className={`font-bold ${t.tipo === 'RECEITA' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.tipo === 'RECEITA' ? '+' : '-'} R$ {Number(t.valor).toFixed(2)}
                          </span>
                          <button onClick={() => excluirTransacao(t.id)} className="text-slate-600 hover:text-rose-400"><Trash2 size={16} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {abaAtiva === 'categorias' && (
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6">
              <div>
                <h2 className="text-lg font-bold">Gerenciar Categorias</h2>
                <p className="text-xs text-slate-400">Adicione categorias personalizadas. O simulador e o WhatsApp irão reconhecê-las automaticamente.</p>
              </div>

              <form onSubmit={adicionarCategoria} className="flex gap-3">
                <input 
                  type="text" 
                  placeholder="Nova Categoria (ex: Pet, Viagem)" 
                  value={novaCatNome} 
                  onChange={e => setNovaCatNome(e.target.value)} 
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-emerald-500" 
                />
                <button type="submit" className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2">
                  <Plus size={16} /> Adicionar
                </button>
              </form>

              <div className="flex flex-wrap gap-2 pt-2">
                {categorias.map(cat => (
                  <div key={cat} className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-xl text-sm">
                    <span>{cat}</span>
                    <button onClick={() => excluirCategoria(cat)} className="text-slate-500 hover:text-rose-400 transition">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {abaAtiva === 'cartoes' && (
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-6">
              <h2 className="text-lg font-bold">Meus Cartões</h2>
              <form onSubmit={adicionarCartao} className="flex gap-3">
                <input type="text" placeholder="Nome do Cartão" value={novoCartaoNome} onChange={e => setNovoCartaoNome(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm" />
                <input type="number" placeholder="Limite" value={novoCartaoLimite} onChange={e => setNovoCartaoLimite(e.target.value)} className="w-32 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm" />
                <button type="submit" className="bg-emerald-500 text-slate-950 px-5 py-2.5 rounded-xl font-semibold text-sm">Adicionar</button>
              </form>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {cartoes.map(c => (
                  <div key={c.id} className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                    <p className="font-bold">{c.nome}</p>
                    <p className="text-xs text-slate-500">Limite: R$ {c.limite.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {abaAtiva === 'whatsapp' && (
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl text-center space-y-4">
              <QrCode size={32} className="mx-auto text-emerald-400" />
              <h2 className="text-xl font-bold">Conexão WhatsApp (QR Code)</h2>
              <p className="text-sm text-slate-400">Aguardando o Railway para gerar o QR code dinâmico.</p>
            </div>
          )}

        </div>

        {/* SIMULADOR DE WHATSAPP */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl flex flex-col h-[600px] overflow-hidden">
          <div className="bg-emerald-950/60 border-b border-emerald-900/50 p-4 flex items-center gap-3">
            <div className="bg-emerald-500 text-slate-950 p-2 rounded-full"><MessageSquare size={18} /></div>
            <div>
              <h3 className="font-bold text-sm text-emerald-300">Simulador do WhatsApp</h3>
              <p className="text-xs text-emerald-500">Reconhece suas categorias customizadas</p>
            </div>
          </div>

          <div className="flex-1 p-4 space-y-3 overflow-y-auto bg-slate-950/50">
            {historicoChat.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.autor === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs ${msg.autor === 'user' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-200 border border-slate-700'}`}>
                  {msg.texto}
                </div>
              </div>
            ))}
            {processando && <div className="text-xs text-slate-500 italic">Processando...</div>}
          </div>

          <div className="p-2 bg-slate-900 border-t border-slate-800 flex gap-1.5 overflow-x-auto">
            <button type="button" onClick={() => setMsgWhats('Gastei 90 na categoria Pet')} className="text-[11px] bg-slate-800 text-slate-300 px-2 py-1 rounded-lg">⚡ "Pet 90"</button>
            <button type="button" onClick={() => setMsgWhats('Gastei 150 no mercado')} className="text-[11px] bg-slate-800 text-slate-300 px-2 py-1 rounded-lg">⚡ "mercado 150"</button>
          </div>

          <form onSubmit={handleEnviarWhatsApp} className="p-3 bg-slate-900 border-t border-slate-800 flex gap-2">
            <input type="text" placeholder="Digite..." value={msgWhats} onChange={e => setMsgWhats(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs focus:outline-none focus:border-emerald-500" />
            <button type="submit" className="bg-emerald-500 text-slate-950 p-2.5 rounded-xl"><Send size={16} /></button>
          </form>
        </div>

      </main>
    </div>
  );
}