'use client';

import { useEffect, useState } from 'react';

type Paid = { at: number; model: string; provider: string; inputTokens: number; outputTokens: number; cost: string; ttftMs: number; sealed: boolean };

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

/** Answers this site's router paid for on mainnet, newest first. Only the model, the node, the tokens and the price:
 * what people asked stays out of it. */
export default function PaidTape() {
  const [rows, setRows] = useState<Paid[] | null>(null);
  const [spent, setSpent] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch('/api/try')
        .then((r) => r.json())
        .then((j: { recent?: Paid[]; spentToday?: string }) => {
          if (stop) return;
          setRows(j.recent ?? []);
          setSpent(j.spentToday ?? null);
        })
        .catch(() => undefined);
    load();
    const poll = setInterval(() => !document.hidden && load(), 8000);
    const tick = setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  return (
    <section className="paid" aria-label="Answers paid through this site">
      <div className="paid__head">
        <span className="paid__live"><i aria-hidden="true" /> Paid through this site, on mainnet</span>
        {spent ? <span className="num paid__spent">today <span className="green">${spent}</span></span> : null}
      </div>
      {rows === null ? (
        <p className="paid__empty">Reading the router…</p>
      ) : rows.length ? (
        <ol>
          {rows.map((r) => (
            <li key={`${r.at}-${r.cost}`}>
              <span className="paid__ago num">{ago(now - r.at)}</span>
              <span className="paid__what">
                <b>{r.model}</b> → {r.provider}
                {r.sealed ? <span className="paid__tag">sealed</span> : null}
              </span>
              <span className="num paid__tok">{r.inputTokens}+{r.outputTokens} tok</span>
              <span className="num paid__ms">{r.ttftMs} ms</span>
              <span className="num green paid__cost">${r.cost}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="paid__empty">No answers since the router last started. Ask one above and it lands here.</p>
      )}
      <p className="paid__note">The model, the node, the tokens, the first-token time and the price. What was asked never leaves the request.</p>
    </section>
  );
}
