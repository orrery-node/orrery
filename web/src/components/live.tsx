'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { emit, on, type Stage } from '@/lib/bus';
import { costUnits, rehearsal, ranAtLabel, ROUTE_WORD, short, usd, type RTrip } from '@/lib/rehearsal';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Tells the sky which chapter is in the middle of the screen, and how far the reader is through "provide". */
export function StageWatcher() {
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0;
      const mid = window.innerHeight * 0.55;
      let stage: Stage = 'hero', progress = 0, provide = 0;
      for (const s of document.querySelectorAll<HTMLElement>('[data-stage]')) {
        const r = s.getBoundingClientRect();
        if (r.top <= mid && r.bottom > mid) {
          stage = s.dataset.stage as Stage;
          progress = (mid - r.top) / r.height;
        }
        if (s.dataset.stage === 'provide') provide = clamp((window.innerHeight * 0.85 - r.top) / (r.height * 0.85), 0, 1);
      }
      emit('yard:stage', { stage, progress, provide });
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    tick();
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    return () => {
      window.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
      cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}

/** The nav gains its ground and hairline once the page leaves the top. */
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

type Row = { n: number; trip: RTrip; paid: boolean };

/** A dense running log of the rehearsal as the sky replays it. */
export function RehearsalLog() {
  const [rows, setRows] = useState<Row[]>([]);
  const [paid, setPaid] = useState(0n);
  const count = useRef(0);
  useEffect(() => {
    const a = on('yard:sent', ({ trip }) => {
      count.current += 1;
      const n = count.current;
      setRows((r) => [{ n, trip, paid: false }, ...r].slice(0, 4));
    });
    const b = on('yard:paid', ({ trip }) => {
      setPaid((p) => p + costUnits(trip.cost));
      setRows((r) => {
        const i = r.findIndex((x) => x.trip === trip && !x.paid);
        if (i < 0) return r;
        const c = [...r];
        c[i] = { ...c[i], paid: true };
        return c;
      });
    });
    return () => {
      a();
      b();
    };
  }, []);
  return (
    <div className="log" aria-label="Replay of the local rehearsal">
      <div className="log__head">
        <span>Replaying the local rehearsal</span>
        <span>Solana test validator · {ranAtLabel}</span>
        <span>
          {rehearsal.requests} requests · {rehearsal.providers.length} providers · <b className="green">${usd(BigInt(rehearsal.settledUnits))}</b> redeemed · <b className="green">$0</b> to the program
        </span>
      </div>
      <ol className="log__rows">
        {rows.map((r) => (
          <li key={r.n} className={r.paid ? 'is-paid' : ''}>
            <span className="log__n">#{String(((r.n - 1) % rehearsal.trips.length) + 1).padStart(2, '0')}</span>
            <span className="log__route">{ROUTE_WORD[r.trip.route]}</span>
            <span className="log__model">{r.trip.model}</span>
            <span className="log__to">→ {r.trip.provider}</span>
            <span className="log__tok">{r.trip.tokens} tok</span>
            <span className="log__ms">{r.trip.ttftMs} ms</span>
            <span className="log__cost">${r.trip.cost}</span>
            <span className="log__state">{r.trip.fellThrough ? 'fell through · ' : ''}{r.trip.sealed ? 'sealed · ' : ''}{r.paid ? 'paid' : 'streaming'}</span>
          </li>
        ))}
        {!rows.length && <li className="log__empty">waiting for the first request…</li>}
      </ol>
      <span className="sr">Replayed so far: ${usd(paid)}</span>
    </div>
  );
}

const CHIPS = [
  { word: 'auto', route: 'auto', note: 'cost, speed and reputation together' },
  { word: ':cheap', route: 'price', note: 'lowest price for this model' },
  { word: ':fast', route: 'speed', note: 'fastest first token this router has seen' },
  { word: ':private', route: 'privacy', note: 'only providers inside a verified enclave' },
] as const;

/** Pick a route, watch the request take it in the sky, read the rehearsal's real answer. */
export function RoutePicker() {
  const [route, setRoute] = useState<string>('price');
  const trip = useMemo(() => rehearsal.trips.find((t) => t.route === route && !t.fellThrough)!, [route]);
  const [served, setServed] = useState<RTrip | null>(null);
  useEffect(() => on('yard:served', ({ trip: t }) => setServed(t)), []);
  const word = CHIPS.find((c) => c.route === route)!.word;
  const shown = served && served.route === route ? served : null;
  return (
    <div className="picker">
      <pre className="code" aria-label="Your tool's settings">
        <span className="code__k">base_url</span> = <span className="code__s">&quot;http://127.0.0.1:7171/v1&quot;</span>
        {'\n'}
        <span className="code__k">model</span>
        {'    '}= <span className="code__s">&quot;{trip.model}{route === 'auto' ? '' : word}&quot;</span>
      </pre>
      <div className="chips" role="radiogroup" aria-label="Route">
        {CHIPS.map((c) => (
          <button
            key={c.route}
            role="radio"
            aria-checked={route === c.route}
            className={`chip${route === c.route ? ' is-on' : ''}`}
            onClick={() => {
              setRoute(c.route);
              setServed(null);
              emit('yard:fire', { route: c.route });
            }}
          >
            {c.word}
          </button>
        ))}
      </div>
      <p className="picker__note">{CHIPS.find((c) => c.route === route)!.note}. Also <code>:trusted</code>, by settled history.</p>
      <p className={`picker__out${shown ? ' is-live' : ''}`} aria-live="polite">
        <span className="num">→ {trip.provider}</span>
        <span className="num">first token {trip.ttftMs} ms</span>
        <span className="num">${trip.cost}</span>
        {trip.sealed && <span className="num violet">sealed</span>}
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
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0'));

/** Ironbridge's real last voucher from the rehearsal, with the total ticking up as the replay pays it. */
export function VoucherBytes() {
  const p = rehearsal.providers.find((x) => x.name === 'Ironbridge Compute')!;
  const final = BigInt(p.cumulative ?? '0');
  const [total, setTotal] = useState(final);
  useEffect(
    () =>
      on('yard:paid', ({ trip }) => {
        if (trip.provider !== p.name) return;
        setTotal((t) => {
          const next = t + costUnits(trip.cost);
          return next > final ? costUnits(trip.cost) : next;
        });
      }),
    [p.name, final],
  );
  const prefix = Array.from(new TextEncoder().encode('switchyard/vch/1'));
  const channel = hex(b58decode(p.channel!).slice(-32));
  const totalBytes = Array.from({ length: 8 }, (_, i) => Number((total >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0'));
  const usage = (p.usageHash ?? '').match(/../g) ?? [];
  const sig = p.voucher ? short(p.voucher.split('.')[2], 10, 10) : '';
  const seg = (cls: string, bytes: string[], label: string, value: string) => (
    <div className={`vb__seg vb__seg--${cls}`}>
      <div className="vb__bytes">
        {bytes.map((b, i) => (
          <span key={i}>{b}</span>
        ))}
      </div>
      <div className="vb__label">
        <b>{label}</b>
        <span>{value}</span>
      </div>
    </div>
  );
  return (
    <figure className="vb">
      {seg('prefix', prefix.map((x) => x.toString(16).padStart(2, '0')), 'prefix · 16 B', 'switchyard/vch/1')}
      {seg('channel', channel, 'channel · 32 B', short(p.channel!, 6, 6))}
      {seg('total', totalBytes, 'running total · 8 B', `${total} units = $${usd(total)}`)}
      {seg('usage', usage, 'usage hash · 32 B', 'sha-256 chain over every answer')}
      <figcaption>
        <span>Signed by the router&apos;s session key: <code>{sig}</code></span>
        <span>
          Ironbridge Compute&apos;s last voucher in the rehearsal, signed after its 8th answer and redeemed on chain in{' '}
          <code>{short(p.redeemTx ?? '', 6, 6)}</code>.
        </span>
      </figcaption>
    </figure>
  );
}

/** What a cut in the middle costs at the visitor's own spend, and the rehearsal's conservation check. */
export function ZeroCalc() {
  const [monthly, setMonthly] = useState(2000);
  const b = rehearsal.balances;
  const rows: [string, bigint][] = [
    ['back with the user', BigInt(b.user)],
    ['paid to providers', BigInt(b.providers)],
    ['still in open channels', BigInt(b.deposits)],
  ];
  const sum = rows.reduce((s, [, v]) => s + v, 0n);
  return (
    <div className="zero">
      <div className="zero__ledger" role="table" aria-label="Where the rehearsal's 100 USDC ended up">
        {rows.map(([k, v], i) => (
          <div key={k} role="row" className="zero__row">
            <span role="cell" className="num">{i ? '+' : ' '}</span>
            <span role="cell" className="num zero__amt">{usd(v)}</span>
            <span role="cell">{k}</span>
          </div>
        ))}
        <div role="row" className="zero__row zero__row--sum">
          <span role="cell" className="num">=</span>
          <span role="cell" className="num zero__amt">{usd(sum)}</span>
          <span role="cell">USDC the user deposited. There is no fourth line.</span>
        </div>
      </div>
      <label className="zero__calc">
        <span>If you spend</span>
        <span className="zero__input">
          $
          <input
            inputMode="numeric"
            value={monthly.toLocaleString('en-US')}
            onChange={(e) => setMonthly(Math.min(10_000_000, Number(e.target.value.replace(/[^0-9]/g, '')) || 0))}
            aria-label="Monthly spend on AI inference, in dollars"
          />
        </span>
        <span>a month on inference, a 4% cut in the middle is</span>
        <b className="num">${Math.round(monthly * 12 * 0.04).toLocaleString('en-US')}</b>
        <span>a year. Here it is</span>
        <b className="num green">$0</b>
      </label>
    </div>
  );
}

/** Seal whatever the visitor types, in this tab, with the same cipher the router uses. */
export function SealDemo() {
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
      if (live) setBox(btoa(String.fromCharCode(...all)));
    })();
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="seal">
      <label className="seal__side">
        <span className="seal__who">What you send</span>
        <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 600))} rows={4} spellCheck={false} />
      </label>
      <div className="seal__side seal__side--dark">
        <span className="seal__who">What the provider&apos;s machine sees</span>
        <p className="seal__box num" aria-live="polite">{box}</p>
      </div>
      <p className="seal__note">Sealed in this tab with AES-256-GCM, the cipher the router uses. The router agrees the key with the enclave over X25519, so only code inside the enclave can open it.</p>
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
