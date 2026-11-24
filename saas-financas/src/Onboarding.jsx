import React, { useState } from 'react';
import { Landmark, CreditCard, QrCode, Sparkles, CheckCircle2, X } from 'lucide-react';

// Cadastro guiado do primeiro acesso: contas, cartões e WhatsApp.
// Toda a gravação no banco fica no App.jsx (onCriarBanco / onCriarCartao / onConcluir).

const TIPOS_CONTA = [
  { valor: 'Conta Corrente / Débito', rotulo: 'Conta Corrente / Débito' },
  { valor: 'Conta Digital / Pix', rotulo: 'Conta Digital / Pix' },
  { valor: 'Conta PJ / Empresarial', rotulo: 'Conta PJ / Empresarial' },
  { valor: 'Carteira / Dinheiro', rotulo: 'Carteira Física / Dinheiro' }
];

const TITULOS = ['Boas-vindas', 'Contas', 'Cartões', 'WhatsApp'];

const classeInput =
  'w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500';
const classeBotaoPrimario =
  'bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-5 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const classeBotaoSecundario =
  'bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-4 py-2.5 rounded-xl text-sm transition-colors';
const classeBotaoTexto = 'text-xs text-slate-500 hover:text-slate-300 underline';

const moeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function Onboarding({
  bancos,
  cartoes,
  diasTeste,
  hojeIso,
  calcularFatura,
  formatarData,
  onCriarBanco,
  onCriarCartao,
  onConcluir
}) {
  const [passo, setPasso] = useState(0);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  const [banco, setBanco] = useState({ nome: '', tipo: TIPOS_CONTA[0].valor, saldoInicial: '' });
  const [cartao, setCartao] = useState({ nome: '', banco: '', limite: '', diaFechamento: '', diaVencimento: '' });

  const irPara = (n) => {
    setErro('');
    setPasso(n);
  };

  const adicionarBanco = async () => {
    setErro('');
    const nome = banco.nome.trim();
    if (nome.length < 2) return setErro('Dê um nome para a conta (ex.: Nubank, Carteira).');
    if (bancos.some((b) => (b.nome || '').trim().toLowerCase() === nome.toLowerCase())) {
      return setErro('Você já cadastrou uma conta com esse nome.');
    }
    const saldo = banco.saldoInicial === '' ? 0 : Number(banco.saldoInicial);
    if (!Number.isFinite(saldo)) return setErro('Saldo inicial inválido.');

    setSalvando(true);
    try {
      await onCriarBanco({ nome, tipo: banco.tipo, saldoInicial: saldo });
      setBanco({ nome: '', tipo: banco.tipo, saldoInicial: '' });
    } catch (e) {
      console.error('Erro ao salvar conta no cadastro guiado:', e);
      setErro('Não consegui salvar agora. Tente de novo.');
    } finally {
      setSalvando(false);
    }
  };

  const fech = Number(cartao.diaFechamento);
  const venc = Number(cartao.diaVencimento);
  const diasValidos =
    Number.isInteger(fech) && Number.isInteger(venc) && fech >= 1 && fech <= 31 && venc >= 1 && venc <= 31;
  const previa = diasValidos ? calcularFatura(hojeIso, fech, venc) : null;

  const adicionarCartao = async () => {
    setErro('');
    const nome = cartao.nome.trim();
    if (nome.length < 2) return setErro('Dê um nome para o cartão (ex.: Nubank, C6 Black).');
    if (cartoes.some((c) => (c.nome || '').trim().toLowerCase() === nome.toLowerCase())) {
      return setErro('Você já cadastrou um cartão com esse nome.');
    }
    if (!diasValidos) return setErro('Informe os dias de fechamento e de vencimento (de 1 a 31).');
    const limite = cartao.limite === '' ? 0 : Number(cartao.limite);
    if (!Number.isFinite(limite) || limite < 0) return setErro('Limite inválido.');

    setSalvando(true);
    try {
      await onCriarCartao({
        nome,
        banco: cartao.banco.trim(),
        limite,
        diaFechamento: fech,
        diaVencimento: venc
      });
      setCartao({ nome: '', banco: '', limite: '', diaFechamento: '', diaVencimento: '' });
    } catch (e) {
      console.error('Erro ao salvar cartão no cadastro guiado:', e);
      setErro('Não consegui salvar agora. Tente de novo.');
    } finally {
      setSalvando(false);
    }
  };

  const exemploCartao = cartoes[0]?.nome || 'nubank';

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6 shadow-2xl">
        {/* Progresso */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex gap-1.5 flex-1 mr-4">
            {TITULOS.map((titulo, i) => (
              <div
                key={titulo}
                title={titulo}
                className={`h-1.5 flex-1 rounded-full ${i <= passo ? 'bg-emerald-500' : 'bg-slate-800'}`}
              />
            ))}
          </div>
          <button
            onClick={() => onConcluir(false)}
            className="text-slate-500 hover:text-slate-300"
            title="Pular a configuração"
          >
            <X size={18} />
          </button>
        </div>

        {/* PASSO 0: BOAS-VINDAS */}
        {passo === 0 && (
          <div className="space-y-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mx-auto">
              <Sparkles className="text-emerald-400" size={26} />
            </div>
            <h2 className="text-xl font-bold text-white">Bem-vindo ao FinZap!</h2>
            <p className="text-sm text-slate-400">
              Vamos deixar tudo pronto em 3 passos rápidos (uns 2 minutos): suas contas, seus cartões e o WhatsApp.
              É isso que permite ao sistema calcular saldos e faturas certinho.
            </p>
            {diasTeste ? (
              <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                🎁 Você tem {diasTeste} dia(s) de teste grátis para experimentar tudo.
              </p>
            ) : null}
            <div className="flex flex-col gap-3 pt-2 items-center">
              <button onClick={() => irPara(1)} className={`${classeBotaoPrimario} w-full`}>
                Começar
              </button>
              <button onClick={() => onConcluir(false)} className={classeBotaoTexto}>
                Pular, configuro depois
              </button>
            </div>
          </div>
        )}

        {/* PASSO 1: CONTAS BANCÁRIAS */}
        {passo === 1 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Landmark className="text-emerald-400" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Suas contas</h2>
                <p className="text-xs text-slate-400">Passo 1 de 3</p>
              </div>
            </div>
            <p className="text-sm text-slate-400">
              Cadastre onde o seu dinheiro fica: bancos, contas digitais ou carteira. O saldo inicial é quanto você
              tem hoje em cada uma.
            </p>

            <div className="space-y-2.5">
              <input
                type="text"
                placeholder="Nome da conta (ex.: Nubank, C6 Bank, Carteira)"
                value={banco.nome}
                onChange={(e) => setBanco({ ...banco, nome: e.target.value })}
                className={classeInput}
              />
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={banco.tipo}
                  onChange={(e) => setBanco({ ...banco, tipo: e.target.value })}
                  className={classeInput}
                >
                  {TIPOS_CONTA.map((t) => (
                    <option key={t.valor} value={t.valor}>
                      {t.rotulo}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.01"
                  placeholder="Saldo hoje (R$)"
                  value={banco.saldoInicial}
                  onChange={(e) => setBanco({ ...banco, saldoInicial: e.target.value })}
                  className={classeInput}
                />
              </div>
              <button onClick={adicionarBanco} disabled={salvando} className={`${classeBotaoSecundario} w-full`}>
                {salvando ? 'Salvando...' : '+ Adicionar conta'}
              </button>
            </div>

            {bancos.length > 0 && (
              <ul className="space-y-1.5">
                {bancos.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2 text-slate-200">
                      <CheckCircle2 size={14} className="text-emerald-400" />
                      {b.nome}
                    </span>
                    <span className="text-xs text-slate-400">{moeda(b.saldoInicial)}</span>
                  </li>
                ))}
              </ul>
            )}

            {erro && <p className="text-xs text-rose-400">{erro}</p>}

            <div className="flex items-center justify-between pt-1">
              <button onClick={() => irPara(0)} className={classeBotaoSecundario}>
                Voltar
              </button>
              <div className="flex items-center gap-3">
                {bancos.length === 0 && (
                  <button onClick={() => irPara(2)} className={classeBotaoTexto}>
                    Pular
                  </button>
                )}
                <button onClick={() => irPara(2)} disabled={bancos.length === 0} className={classeBotaoPrimario}>
                  Continuar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PASSO 2: CARTÕES */}
        {passo === 2 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <CreditCard className="text-emerald-400" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Seus cartões de crédito</h2>
                <p className="text-xs text-slate-400">Passo 2 de 3</p>
              </div>
            </div>
            <p className="text-sm text-slate-400">
              Os dias de fechamento e de vencimento estão no app do seu banco. É com eles que o sistema sabe em qual
              fatura cada compra cai.
            </p>

            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  placeholder="Nome do cartão (ex.: Nubank)"
                  value={cartao.nome}
                  onChange={(e) => setCartao({ ...cartao, nome: e.target.value })}
                  className={classeInput}
                />
                <input
                  type="text"
                  placeholder="Banco emissor (opcional)"
                  value={cartao.banco}
                  onChange={(e) => setCartao({ ...cartao, banco: e.target.value })}
                  className={classeInput}
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <input
                  type="number"
                  step="0.01"
                  placeholder="Limite (R$)"
                  value={cartao.limite}
                  onChange={(e) => setCartao({ ...cartao, limite: e.target.value })}
                  className={classeInput}
                />
                <input
                  type="number"
                  min="1"
                  max="31"
                  placeholder="Fecha dia"
                  value={cartao.diaFechamento}
                  onChange={(e) => setCartao({ ...cartao, diaFechamento: e.target.value })}
                  className={classeInput}
                />
                <input
                  type="number"
                  min="1"
                  max="31"
                  placeholder="Vence dia"
                  value={cartao.diaVencimento}
                  onChange={(e) => setCartao({ ...cartao, diaVencimento: e.target.value })}
                  className={classeInput}
                />
              </div>

              {previa && (
                <p className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2">
                  Uma compra feita hoje cairia na fatura {previa.anoMes.split('-')[1]}/{previa.anoMes.split('-')[0]},
                  com vencimento em {formatarData(previa.dataVencimento)}.
                </p>
              )}

              <button onClick={adicionarCartao} disabled={salvando} className={`${classeBotaoSecundario} w-full`}>
                {salvando ? 'Salvando...' : '+ Adicionar cartão'}
              </button>
            </div>

            {cartoes.length > 0 && (
              <ul className="space-y-1.5">
                {cartoes.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2 text-slate-200">
                      <CheckCircle2 size={14} className="text-emerald-400" />
                      {c.nome}
                    </span>
                    <span className="text-xs text-slate-400">
                      fecha dia {c.diaFechamento} · vence dia {c.diaVencimento}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {erro && <p className="text-xs text-rose-400">{erro}</p>}

            <div className="flex items-center justify-between pt-1">
              <button onClick={() => irPara(1)} className={classeBotaoSecundario}>
                Voltar
              </button>
              <div className="flex items-center gap-3">
                {cartoes.length === 0 && (
                  <button onClick={() => irPara(3)} className={classeBotaoTexto}>
                    Não uso cartão de crédito
                  </button>
                )}
                <button onClick={() => irPara(3)} disabled={cartoes.length === 0} className={classeBotaoPrimario}>
                  Continuar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PASSO 3: WHATSAPP */}
        {passo === 3 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <QrCode className="text-emerald-400" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Conecte o WhatsApp</h2>
                <p className="text-xs text-slate-400">Passo 3 de 3</p>
              </div>
            </div>
            <p className="text-sm text-slate-400">
              Depois de conectar, é só mandar mensagem para <strong className="text-slate-200">você mesmo</strong> no
              WhatsApp (a conversa "Você") e o robô lança o gasto. Por exemplo:
            </p>
            <ul className="space-y-1.5 text-sm">
              <li className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-slate-300">
                mercado 50 pix
              </li>
              <li className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-slate-300">
                gasolina 100 cartão {exemploCartao}
              </li>
              <li className="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-slate-300">
                salário 3000 recebido
              </li>
            </ul>

            <div className="flex flex-col gap-3 pt-2 items-center">
              <button onClick={() => onConcluir(true)} className={`${classeBotaoPrimario} w-full`}>
                Conectar WhatsApp agora
              </button>
              <button onClick={() => onConcluir(false)} className={classeBotaoTexto}>
                Fazer isso depois e ir para o sistema
              </button>
            </div>

            <div className="flex justify-start pt-1">
              <button onClick={() => irPara(2)} className={classeBotaoSecundario}>
                Voltar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
