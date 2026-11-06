'use client';

import { useEffect, useRef, useState } from 'react';

type Result = {
  answer: string;
  model: string;
  route: string;
  provider: { address: string; name: string };
  inputTokens: number;
  outputTokens: number;
  cost: string | null;
  ttftMs: number | null;
  totalMs: number;
  holderOff: number;
  channel: { address: string; deposit: string; signed: string } | null;
  payer: string;
  spentToday: string;
};

const MODELS = [
  { id: 'gpt-oss-120b', note: 'cheapest' },
  { id: 'llama-3.3-70b', note: '' },
  { id: 'deepseek-v3', note: '' },
  { id: 'qwen3-235b', note: '' },
];

const SUGGESTIONS = ['How does a payment channel settle on Solana?', 'Explain peer-to-peer inference in two sentences.', 'Write a haiku about a GPU that never sleeps.'];

const short = (s: string, a = 4, b = 4) => `${s.slice(0, a)}…${s.slice(-b)}`;
const solscan = (kind: 'account' | 'tx', id: string) => `https://solscan.io/${kind}/${id}`;

export default function TryBox() {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [status, setStatus] = useState<{ online: boolean; providers?: number; spentToday?: string; cap?: string } | null>(null);
  const t0 = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetch('/api/try').then((r) => r.json()).then(setStatus).catch(() => setStatus({ online: false }));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setElapsed(Date.now() - t0.current), 100);
    return () => clearInterval(id);
  }, [busy]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setRes(null);
    t0.current = Date.now();
    setElapsed(0);
    try {
      const r = await fetch('/api/try', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, model }) });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? `Something went wrong (${r.status}).`);
      else {
        setRes(j);
        setStatus((s) => (s ? { ...s, spentToday: j.spentToday } : s));
      }
    } catch {
      setError('The request did not reach the site. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="try">
      <form className="try__form" onSubmit={ask}>
        <label className="cap" htmlFor="try-prompt">Your question</label>
        <textarea
          id="try-prompt"
          value={prompt}
          maxLength={400}
          rows={3}
          placeholder="Ask anything. A provider on Solana mainnet answers, and gets paid for this one answer."
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
          }}
        />
        <div className="try__suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="try__chip" onClick={() => setPrompt(s)}>{s}</button>
          ))}
        </div>
        <div className="try__row">
          <div className="try__models" role="radiogroup" aria-label="Model">
            {MODELS.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={model === m.id} className={`try__model num${model === m.id ? ' is-on' : ''}`} onClick={() => setModel(m.id)}>
                {m.id}
                {m.note && <span>{m.note}</span>}
              </button>
            ))}
          </div>
          <button className="pill try__go" type="submit" disabled={busy || !prompt.trim() || status?.online === false}>
            {busy ? `Paying a provider… ${(elapsed / 1000).toFixed(1)}s` : 'Ask the network'}
          </button>
        </div>
      </form>

      {error && <p className="try__error">{error}</p>}

      {res && (
        <article className="try__out" aria-live="polite">
          <p className="try__answer">{res.answer}</p>
          <dl className="try__receipt">
            <div><dt>answered by</dt><dd><a href={solscan('account', res.provider.address)} target="_blank" rel="noopener noreferrer">{res.provider.name}</a></dd></div>
            <div><dt>model · route</dt><dd className="num">{res.model} · {res.route}</dd></div>
            <div><dt>tokens</dt><dd className="num">{res.inputTokens} in · {res.outputTokens} out</dd></div>
            <div><dt>first token</dt><dd className="num">{res.ttftMs !== null ? `${res.ttftMs} ms` : '—'}</dd></div>
            <div><dt>this answer cost</dt><dd className="num green">${res.cost}{res.holderOff ? ` · holder −${res.holderOff / 100}%` : ''}</dd></div>
            <div><dt>to the program</dt><dd className="num green">$0</dd></div>
            {res.channel && (
              <div className="wide">
                <dt>paid through channel</dt>
                <dd className="num">
                  <a href={solscan('account', res.channel.address)} target="_blank" rel="noopener noreferrer">{short(res.channel.address, 6, 6)}</a> · signed ${res.channel.signed} of a ${res.channel.deposit} deposit
                </dd>
              </div>
            )}
          </dl>
          <p className="try__note">
            The router signed a voucher for this answer. The provider redeems it on Solana within a couple of minutes; the transaction shows up on its{' '}
            <a href={solscan('account', res.provider.address)} target="_blank" rel="noopener noreferrer">account</a>.
          </p>
        </article>
      )}

      <p className="try__foot num">
        {status?.online === false
          ? 'The demo router is offline right now.'
          : status?.online
            ? `${status.providers} provider${status.providers === 1 ? '' : 's'} on mainnet · the site's wallet has paid $${status.spentToday} of its $${status.cap?.replace(/0+$/, '0')} for today`
            : 'Connecting to mainnet…'}
      </p>
    </div>
  );
}
