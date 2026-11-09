'use client';

import { useMemo, useState } from 'react';
import type { Listing } from '@/lib/prices';

// The integer formula the router and the provider settle with: base units per million tokens, rounded up.
const cost = (l: Listing, inTok: number, outTok: number, cachedShare: number) => {
  const cached = l.cachedInput === null ? 0 : Math.round(inTok * cachedShare);
  const raw = (inTok - cached) * l.input + cached * (l.cachedInput ?? l.input) + outTok * l.output;
  return Math.ceil(raw / 1_000_000);
};
const usd = (units: number, digits = 6) => `$${(units / 1e6).toFixed(digits)}`;
const perM = (units: number) => `$${(units / 1e6).toFixed(units < 100_000 ? 3 : 2)}`;
const PRESETS = [
  { label: 'A chat reply', inTok: 600, outTok: 300, cached: 0 },
  { label: 'A coding-agent turn', inTok: 12_000, outTok: 800, cached: 0.8 },
  { label: 'Summarize a long doc', inTok: 40_000, outTok: 1_200, cached: 0 },
];

export default function PriceCalc({ listings }: { listings: Listing[] }) {
  const models = useMemo(() => [...new Set(listings.map((l) => l.model))].sort(), [listings]);
  const [model, setModel] = useState(models.includes('gpt-oss-120b') ? 'gpt-oss-120b' : models[0] ?? '');
  const [inTok, setIn] = useState(12_000);
  const [outTok, setOut] = useState(800);
  const [cached, setCached] = useState(0.8);
  const [sell, setSell] = useState(false);
  const [myIn, setMyIn] = useState('0.030');
  const [myOut, setMyOut] = useState('0.12');
  const mine: Listing | null = sell && Number(myIn) >= 0 && Number(myOut) >= 0
    ? { provider: 'You', address: 'you', model, input: Math.round(Number(myIn) * 1e6), output: Math.round(Number(myOut) * 1e6), cachedInput: null, context: 0, enclave: false }
    : null;
  const rows = [...listings.filter((l) => l.model === model), ...(mine ? [mine] : [])]
    .map((l) => ({ l, one: cost(l, inTok, outTok, cached) }))
    .sort((a, b) => a.one - b.one || (a.l.address === 'you' ? -1 : b.l.address === 'you' ? 1 : 0));
  const myRank = mine ? rows.findIndex((r) => r.l.address === 'you') + 1 : 0;
  const n = (x: number) => x.toLocaleString('en-US');

  if (!listings.length) return <p className="pc__empty">The chain could not be read just now. Try again in a minute.</p>;
  return (
    <section className="pc" aria-label="Price calculator">
      <div className="pc__models" role="radiogroup" aria-label="Model">
        {models.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={m === model} className={`pc__model num${m === model ? ' is-on' : ''}`} onClick={() => setModel(m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="pc__sell">
        <button type="button" className={`pc__preset${sell ? ' is-on' : ''}`} aria-pressed={sell} onClick={() => setSell(!sell)}>
          {sell ? 'Selling on Orrery: on' : 'I run a node: price mine'}
        </button>
        {sell ? (
          <span className="pc__mine">
            <label>in $<input className="num" inputMode="decimal" value={myIn} onChange={(e) => setMyIn(e.target.value)} aria-label="Your input price per million tokens" /></label>
            <label>out $<input className="num" inputMode="decimal" value={myOut} onChange={(e) => setMyOut(e.target.value)} aria-label="Your output price per million tokens" /></label>
            <span>per million</span>
            {mine ? <b className="pc__rank num">{myRank === 1 ? `cheapest of ${rows.length}` : `#${myRank} of ${rows.length}`}</b> : null}
          </span>
        ) : null}
      </div>
      <div className="pc__presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="pc__preset" onClick={() => { setIn(p.inTok); setOut(p.outTok); setCached(p.cached); }}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="pc__knobs">
        <label>
          <span>Tokens in <b className="num">{n(inTok)}</b></span>
          <input type="range" min={100} max={100_000} step={100} value={inTok} onChange={(e) => setIn(Number(e.target.value))} />
        </label>
        <label>
          <span>Tokens out <b className="num">{n(outTok)}</b></span>
          <input type="range" min={10} max={8_000} step={10} value={outTok} onChange={(e) => setOut(Number(e.target.value))} />
        </label>
        <label>
          <span>Resent from cache <b className="num">{Math.round(cached * 100)}%</b></span>
          <input type="range" min={0} max={0.95} step={0.05} value={cached} onChange={(e) => setCached(Number(e.target.value))} />
        </label>
      </div>
      <div className="pc__scroll">
        <table className="pc__table">
          <thead>
            <tr>
              <th>Node</th>
              <th className="r">Listed in / out, per M</th>
              <th className="r">Cached in</th>
              <th className="r">This request</th>
              <th className="r">A thousand like it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ l, one }) => (
              <tr key={l.address + l.model} className={l.address === 'you' ? 'pc__you' : undefined}>
                <td>
                  <span className="pc__node">{l.provider}</span>
                  {l.enclave ? <span className="pc__tag">enclave</span> : null}
                </td>
                <td className="r num">{perM(l.input)} / {perM(l.output)}</td>
                <td className="r num">{l.cachedInput === null ? '—' : perM(l.cachedInput)}</td>
                <td className="r num green pc__one">{usd(one)}</td>
                <td className="r num">{usd(one * 1000, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pc__note">
        Same math the router settles with: base units per million tokens, rounded up to the next millionth of a dollar, before any holder discount. The program adds 0%.
      </p>
    </section>
  );
}
