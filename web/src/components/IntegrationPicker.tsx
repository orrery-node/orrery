'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/parts';
import { INTEGRATIONS } from '@/data/integrations';

export default function IntegrationPicker() {
  const [id, setId] = useState(INTEGRATIONS[0].id);
  const it = INTEGRATIONS.find((x) => x.id === id) ?? INTEGRATIONS[0];
  return (
    <section className="ip" aria-label="Integrations">
      <div className="ip__list" role="tablist" aria-label="Tool">
        {INTEGRATIONS.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === id} className={`ip__tab${x.id === id ? ' is-on' : ''}`} onClick={() => setId(x.id)}>
            <span className="ip__name">{x.name}</span>
            <span className="ip__kind">{x.kind}</span>
          </button>
        ))}
      </div>
      <div className="ip__panel" role="tabpanel">
        <div className="ip__head">
          <h2>{it.name}</h2>
          {it.rehearsed ? <span className="ip__tag">checked in the rehearsal</span> : null}
        </div>
        <ol className="ip__steps">
          {it.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <div className="ip__code">
          <div className="ip__codehead"><span className="num">{it.lang}</span><CopyButton text={it.code} /></div>
          <pre className="num"><code>{it.code}</code></pre>
        </div>
      </div>
    </section>
  );
}
