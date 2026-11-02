'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { emit, on } from '@/lib/bus';
import { costUnits, perM, rehearsal, ROUTE_WORD, short, usd, type RTrip } from '@/lib/rehearsal';

const HERO_ROUTES = ['auto', 'price', 'speed', 'privacy'] as const;

function useInView<T extends HTMLElement>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

export function Arrow({ up = false }: { up?: boolean }) {
  return (
    <svg className="arrow" viewBox="0 0 16 16" aria-hidden="true" style={up ? { transform: 'rotate(-90deg)' } : undefined}>
      <path d="M3 8h9.4M8.6 4.2 12.4 8l-3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The nav gains its ground once the page leaves the top. */
export function NavGround() {
  useEffect(() => {
    const nav = document.querySelector('.nav');
    const f = () => nav?.classList.toggle('nav--solid', window.scrollY > 24);
    f();
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  return null;
}

/** The hero's request line: the router's real interface, one model name and a route word. Sending replays that route's request from the rehearsal on the orrery. */
export function RequestLine() {
  const [route, setRoute] = useState<string>('price');
  const [last, setLast] = useState<{ trip: RTrip; paid: boolean; n: number } | null>(null);
  const count = useRef(0);
  useEffect(() => {
    const a = on('yard:served', ({ trip }) => {
      count.current += 1;
      setLast({ trip, paid: false, n: count.current });
    });
    const b = on('yard:paid', ({ trip }) => setLast((l) => (l && l.trip === trip ? { ...l, paid: true } : l)));
    return () => {
      a();
      b();
    };
  }, []);
  const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough)!;
  return (
    <div className="req">
      <form
        className="req__bar"
        onSubmit={(e) => {
          e.preventDefault();
          emit('yard:fire', { route });
        }}
      >
        <span className="req__line num">
          <span className="req__url">
            <span className="req__verb">POST</span> 127.0.0.1:7171/v1
          </span>
          <span className="req__k">model</span> &quot;{trip.model}
          <span className="req__suffix" key={route}>{route === 'auto' ? '' : ROUTE_WORD[route]}</span>&quot;
        </span>
        <span className="req__routes" role="radiogroup" aria-label="Route word">
          {HERO_ROUTES.map((r) => (
            <button type="button" key={r} role="radio" aria-checked={route === r} className={route === r ? 'is-on' : ''} onClick={() => setRoute(r)}>
              {ROUTE_WORD[r]}
            </button>
          ))}
        </span>
        <button type="submit" className="pill req__send">
          Send <Arrow />
        </button>
      </form>
      <p className="req__log" aria-live="polite">
        {last ? (
          <span className="num">
            <span className="req__n">#{String(((last.n - 1) % 99) + 1).padStart(2, '0')}</span> {ROUTE_WORD[last.trip.route]} → {last.trip.provider} · {last.trip.ttftMs} ms · ${last.trip.cost}
            {last.trip.fellThrough ? ' · fell through' : ''}
            {last.trip.sealed ? ' · sealed' : ''} · <span className={last.paid ? 'green' : ''}>{last.paid ? 'paid' : 'streaming'}</span>
          </span>
        ) : (
          <span className="num">waiting for the first request</span>
        )}
        <span className="req__note">Replay of the local rehearsal. Nothing leaves this page.</span>
      </p>
    </div>
  );
}

type Cand = { name: string; region: string; metric: string; state: 'picked' | 'next' | 'out'; note: string };

function candidates(route: string): { trip: RTrip; rows: Cand[] } {
  const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough)!;
  const model = trip.model;
  const ms = (name: string) => {
    const xs = rehearsal.trips.filter((t) => t.provider === name && t.model === model && !t.fellThrough).map((t) => t.ttftMs);
    return xs.length ? Math.min(...xs) : null;
  };
  const rows = rehearsal.providers.map((p) => {
    const m = p.models.find((x) => x.id === model);
    let metric = '', eligible = !!m, note = '';
    if (!m) note = `no ${model}`;
    else if (route === 'price') metric = `${perM(m.input)} in · ${perM(m.output)} out`;
    else if (route === 'speed') {
      const t = ms(p.name);
      metric = t == null ? 'not measured' : `${t} ms first token`;
    } else if (route === 'privacy') {
      eligible = p.enclave;
      metric = p.enclave ? 'enclave report matches chain' : '';
      if (!p.enclave) note = 'no enclave';
    } else metric = `${perM(m.input)} in · ${ms(p.name) ?? '—'} ms`;
    return { p, m, metric, eligible, note };
  });
  const score = (r: (typeof rows)[number]) => {
    if (!r.m) return Infinity;
    if (route === 'price') return r.m.input;
    if (route === 'speed') return ms(r.p.name) ?? Infinity;
    return 0;
  };
  rows.sort((a, b) => (a.p.name === trip.provider ? -1 : b.p.name === trip.provider ? 1 : Number(b.eligible) - Number(a.eligible) || score(a) - score(b)));
  return {
    trip,
    rows: rows.map((r) => ({ name: r.p.name, region: r.p.region, metric: r.metric, note: r.note, state: r.p.name === trip.provider ? 'picked' : r.eligible ? 'next' : 'out' })),
  };
}

const TABS = [
  ['price', ':cheap'],
  ['speed', ':fast'],
  ['privacy', ':private'],
  ['auto', 'auto'],
] as const;

export function RouteCard() {
  const [route, setRoute] = useState<string>('price');
  const { trip, rows } = useMemo(() => candidates(route), [route]);
  const word = route === 'auto' ? '' : ROUTE_WORD[route];
  return (
    <div className="card route">
      <div className="card__head">
        <span className="label">Router · 127.0.0.1:7171</span>
        <div className="seg seg--sm" role="radiogroup" aria-label="Route">
          {TABS.map(([r, w]) => (
            <button key={r} role="radio" aria-checked={route === r} className={route === r ? 'is-on' : ''} onClick={() => setRoute(r)}>
              {w}
            </button>
          ))}
        </div>
      </div>
      <pre className="code num" aria-label="Your code">
        <span className="c-d">client</span> = OpenAI({'\n'}
        {'    '}base_url=<span className="c-s">&quot;http://127.0.0.1:7171/v1&quot;</span>,{'\n'}
        {'    '}api_key=<span className="c-s">&quot;any&quot;</span>){'\n'}
        client.chat.completions.create({'\n'}
        {'    '}model=<span className="c-s">&quot;{trip.model}<b key={route}>{word}</b>&quot;</span>,{'\n'}
        {'    '}messages=messages)
      </pre>
      <ol className="cands">
        {rows.map((r, i) => (
          <li key={r.name} className={`cand cand--${r.state}`}>
            <span className="cand__n num">0{i + 1}</span>
            <span className="cand__name">
              {r.name}
              <small>{r.region}</small>
            </span>
            <span className="cand__metric num">{r.metric || r.note}</span>
            <span className="cand__state">{r.state === 'picked' ? 'Picked' : r.state === 'next' ? 'next in line' : 'skipped'}</span>
          </li>
        ))}
      </ol>
      <p className="route__out num">
        <span>answered by {trip.provider}</span>
        <span>{trip.ttftMs} ms</span>
        <span>{trip.tokens} tok</span>
        <span>${trip.cost}</span>
        {trip.sealed && <span>sealed</span>}
        <span className="green">paid</span>
      </p>
    </div>
  );
}

function b58decode(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
const hx = (b: number) => b.toString(16).padStart(2, '0');

/** Ironbridge's eight answers from the rehearsal, each a new signed running total, and the real final voucher. */
export function ChannelCard() {
  const p = rehearsal.providers.find((x) => x.name === 'Ironbridge Compute')!;
  const trips = rehearsal.trips.filter((t) => t.provider === p.name);
  const rows = trips.reduce<{ trip: RTrip; units: bigint; total: bigint }[]>((acc, t) => {
    const u = costUnits(t.cost);
    acc.push({ trip: t, units: u, total: (acc.at(-1)?.total ?? 0n) + u });
    return acc;
  }, []);
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setN(rows.length);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= rows.length) clearInterval(id);
    }, 420);
    return () => clearInterval(id);
  }, [seen, rows.length]);
  const total = n ? rows[n - 1].total : 0n;
  const final = BigInt(p.cumulative ?? '0');
  const sig = p.voucher?.split('.')[2] ?? '';
  const prefix = Array.from(new TextEncoder().encode('switchyard/vch/1'));
  const channel = Array.from(b58decode(p.channel!).slice(-32));
  const totalBytes = Array.from({ length: 8 }, (_, i) => Number((final >> BigInt(8 * i)) & 0xffn));
  const usage = (p.usageHash ?? '').match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  const bytes = [...prefix.map((b) => ['pre', b] as const), ...channel.map((b) => ['ch', b] as const), ...totalBytes.map((b) => ['tot', b] as const), ...usage.map((b) => ['use', b] as const)];
  return (
    <div className="card chan" ref={ref}>
      <div className="card__head">
        <span className="label">Channel · {p.name}</span>
        <span className="label num">{short(p.channel!, 4, 4)}</span>
      </div>
      <div className="chan__l">
      <div className="chan__total">
        <span className="chan__k">Signed running total</span>
        <span className="chan__v num">
          {total.toString()} <small>units</small>
        </span>
        <span className="chan__usd num">${usd(total)}</span>
      </div>
      <ol className="chan__rows">
        {rows.map((r, i) => (
          <li key={i} className={i < n ? 'is-on' : ''}>
            <span className="num">#{String(i + 1).padStart(2, '0')}</span>
            <span className="num">{r.trip.model}</span>
            <span className="num">+{r.units.toString()}</span>
            <span className="num">{r.total.toString()}</span>
            <span className="chan__sig num">{i === rows.length - 1 ? short(sig, 5, 5) : r.trip.fellThrough ? 'signed · fell through' : 'signed'}</span>
          </li>
        ))}
      </ol>
      </div>
      <div className="chan__r">
      <span className="label chan__bytes">The last voucher, all 88 bytes</span>
      <div className="vgrid" aria-label="The final voucher, 88 bytes">
        {bytes.map(([k, b], i) => (
          <span key={i} className={`vb vb--${k}`}>
            {hx(b)}
          </span>
        ))}
      </div>
      <div className="vlegend">
        <span className="vb--pre">prefix 16 B</span>
        <span className="vb--ch">channel 32 B</span>
        <span className="vb--tot">total 8 B</span>
        <span className="vb--use">usage hash 32 B</span>
      </div>
      <p className="chan__foot num">
        <span>redeemed in one transaction {short(p.redeemTx ?? '', 4, 6)}</span>
        <span className="green">${usd(final)} → {p.name}</span>
      </p>
      </div>
    </div>
  );
}

export function Ledger() {
  const b = rehearsal.balances;
  const rows: [string, bigint][] = [
    ['back with the user', BigInt(b.user)],
    ['paid to the providers', BigInt(b.providers)],
    ['still in open channels', BigInt(b.deposits)],
  ];
  const sum = rows.reduce((s, [, v]) => s + v, 0n);
  return (
    <div className="card ledger">
      <div className="card__head">
        <span className="label">Where the rehearsal&apos;s 100 USDC went</span>
      </div>
      <div role="table" className="ledger__t">
        {rows.map(([k, v], i) => (
          <div role="row" key={k} className="ledger__r">
            <span role="cell" className="num ledger__op">{i ? '+' : ''}</span>
            <span role="cell" className="num ledger__amt">{usd(v)}</span>
            <span role="cell">{k}</span>
          </div>
        ))}
        <div role="row" className="ledger__r ledger__r--sum">
          <span role="cell" className="num ledger__op">=</span>
          <span role="cell" className="num ledger__amt">{usd(sum)}</span>
          <span role="cell">deposited. There is no fourth line.</span>
        </div>
      </div>
    </div>
  );
}

export function CutCalc() {
  const [monthly, setMonthly] = useState(2000);
  const cut = Math.round(monthly * 12 * 0.04);
  return (
    <div className="card calc">
      <div className="card__head">
        <span className="label">What a 4% cut would cost you</span>
      </div>
      <label className="calc__row">
        <span>Your monthly spend on inference</span>
        <span className="calc__field num">
          $
          <input
            inputMode="numeric"
            value={monthly.toLocaleString('en-US')}
            onChange={(e) => setMonthly(Math.min(10_000_000, Number(e.target.value.replace(/[^0-9]/g, '')) || 0))}
            aria-label="Monthly spend on AI inference, in dollars"
          />
        </span>
      </label>
      <div className="calc__row">
        <span>A 4% cut in the middle, per year</span>
        <span className="num calc__v">${cut.toLocaleString('en-US')}</span>
      </div>
      <div className="calc__row calc__row--here">
        <span>Here</span>
        <span className="num calc__v green">$0</span>
      </div>
    </div>
  );
}

function Enclave() {
  return (
    <svg viewBox="0 0 160 160" className="enc" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} x={20 + i * 6} y={20 + i * 6} width={120 - i * 12} height={120 - i * 12} rx={14 - i * 1.6} className={i === 6 ? 'enc__in' : 'enc__wall'} />
      ))}
      {Array.from({ length: 49 }, (_, i) => (
        <circle key={i} cx={62 + (i % 7) * 6} cy={62 + Math.floor(i / 7) * 6} r="1.05" className="enc__dot" />
      ))}
    </svg>
  );
}

/** Seals whatever the visitor types, in this tab, with the cipher the router uses, and follows it into the enclave. */
export function SealFlow() {
  const vault = rehearsal.providers.find((p) => p.enclave);
  const [text, setText] = useState('Summarize this contract before I sign it.');
  const [box, setBox] = useState('');
  const key = useRef<CryptoKey | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      if (!crypto?.subtle) return setBox('(this browser has no WebCrypto)');
      if (!key.current) key.current = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.current, new TextEncoder().encode(text)));
      const all = new Uint8Array(iv.length + ct.length);
      all.set(iv);
      all.set(ct, iv.length);
      if (live) setBox(Array.from(all, hx).join(''));
    })();
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="flow">
      <label className="flow__step">
        <span className="flow__k">On your computer</span>
        <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 300))} rows={3} spellCheck={false} aria-label="Text to seal" />
        <span className="flow__note">Type anything. It is sealed in this tab.</span>
      </label>
      <span className="flow__wire" aria-hidden="true" />
      <div className="flow__step">
        <span className="flow__k">On the wire and on the operator&apos;s disk</span>
        <p className="flow__cipher num" aria-live="polite">{box}</p>
        <span className="flow__note">AES-256-GCM, key agreed with the enclave over X25519</span>
      </div>
      <span className="flow__wire" aria-hidden="true" />
      <div className="flow__step flow__step--enc">
        <Enclave />
        <span className="flow__k">Inside {vault?.name ?? 'the enclave'}</span>
        <span className="flow__note">Opened only by the code the router checked against the provider&apos;s claim on chain</span>
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** A provider's own view, from Ironbridge's numbers in the rehearsal. */
export function ProviderCard() {
  const p = rehearsal.providers.find((x) => x.name === 'Ironbridge Compute')!;
  const answers = rehearsal.trips.filter((t) => t.provider === p.name).length;
  return (
    <div className="card prov">
      <div className="card__head">
        <span className="label">Provider node · {p.name}</span>
        <span className="label prov__live">
          <i /> serving
        </span>
      </div>
      <dl className="prov__sum">
        <div>
          <dt>Redeemed to its wallet</dt>
          <dd className="num green">${usd(BigInt(p.cumulative ?? '0'))}</dd>
        </div>
        <div>
          <dt>Answers served</dt>
          <dd className="num">{answers}</dd>
        </div>
        <div>
          <dt>Taken by the program</dt>
          <dd className="num">$0</dd>
        </div>
      </dl>
      <table className="prov__t">
        <thead>
          <tr>
            <th>Model</th>
            <th>In / M</th>
            <th>Out / M</th>
          </tr>
        </thead>
        <tbody>
          {p.models.map((m) => (
            <tr key={m.id}>
              <td className="num">{m.id}</td>
              <td className="num">{perM(m.input)}</td>
              <td className="num">{perM(m.output)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="prov__foot">Prices are yours. The price list&apos;s hash is on chain, so routers ignore any list that doesn&apos;t match it.</p>
    </div>
  );
}
