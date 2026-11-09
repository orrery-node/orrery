'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, nextEvent, rng, sampleNetwork, short, type SampleNode, type TapeEvent } from '@/data/network-sample';

type Sort = 'earned' | 'redeems' | 'fastest' | 'cheapest' | 'newest';
type Row = { id: number; ev: TapeEvent; at: number; fresh: boolean };

const SORTS: { k: Sort; label: string }[] = [
  { k: 'earned', label: 'Earned' },
  { k: 'redeems', label: 'Redeems' },
  { k: 'fastest', label: 'Fastest' },
  { k: 'cheapest', label: 'Cheapest' },
  { k: 'newest', label: 'Newest' },
];

export function money(x: number) {
  if (x >= 100) return `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (x >= 1 || Math.abs(x * 100 - Math.round(x * 100)) < 1e-9) return `$${x.toFixed(2)}`;
  if (x >= 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(6)}`;
}
const perM = (x: number) => `$${x < 0.1 ? x.toFixed(3) : x.toFixed(2)}`;
const age = (s: number) => (s < 60 ? `${Math.max(0, Math.floor(s))}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);
const ago = (min: number) => (min < 1 ? 'just now' : min < 60 ? `${Math.round(min)} min ago` : `${Math.round(min / 60)} h ago`);

function seedTape(nodes: SampleNode[]): Row[] {
  const r = rng(77);
  let t = 0;
  return Array.from({ length: 16 }, (_, i) => {
    t += 2 + Math.floor(r() * 9);
    return { id: -i - 1, ev: nextEvent(r, nodes), at: -t, fresh: false };
  });
}

function TapeLine({ ev }: { ev: TapeEvent }) {
  switch (ev.kind) {
    case 'redeem':
      return (
        <>
          <b>{ev.node}</b> redeemed <span className="green">{money(ev.usd)}</span> from {ev.channels} {ev.channels === 1 ? 'channel' : 'channels'} <span className="nt__sig">{short(ev.sig)}</span>
        </>
      );
    case 'open':
      return (
        <>
          Router <span className="nt__sig">{short(ev.router)}</span> opened a <span className="green">{money(ev.usd)}</span> channel to <b>{ev.node}</b>
        </>
      );
    case 'topup':
      return (
        <>
          Router <span className="nt__sig">{short(ev.router)}</span> topped up <span className="green">{money(ev.usd)}</span> with <b>{ev.node}</b>
        </>
      );
    case 'release':
      return (
        <>
          <b>{ev.node}</b> released a channel and paid out <span className="green">{money(ev.usd)}</span>
        </>
      );
    case 'listing':
      return (
        <>
          <b>{ev.node}</b> listed {ev.model} at {perM(ev.input)} / {perM(ev.output)}
        </>
      );
  }
}

const TAPE_KIND: Record<TapeEvent['kind'], string> = { redeem: 'Redeem', open: 'Open', topup: 'Top up', release: 'Release', listing: 'Listing' };

export default function NetworkTerminal() {
  const [nodes, setNodes] = useState<SampleNode[]>(() => sampleNetwork());
  const [tape, setTape] = useState<Row[]>(() => seedTape(sampleNetwork()));
  const [clock, setClock] = useState(0);
  const [sort, setSort] = useState<Sort>('earned');
  const [model, setModel] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [redeems24, setRedeems24] = useState(() => sampleNetwork().reduce((a, n) => a + Math.round(n.redeems / Math.max(1, n.sinceDays)), 0));
  const [lastAt, setLastAt] = useState<Record<string, number>>({});
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const clockRef = useRef(0);

  useEffect(() => {
    const r = rng(Date.now() & 0xffffffff);
    let id = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = setInterval(() => {
      if (document.hidden) return;
      clockRef.current += 1;
      setClock(clockRef.current);
    }, 1000);
    const step = () => {
      timer = setTimeout(step, 1300 + r() * 2600);
      if (document.hidden) return;
      const ev = nextEvent(r, nodesRef.current);
      const at = clockRef.current;
      const rowId = id++;
      setTape((t) => [{ id: rowId, ev, at, fresh: true }, ...t].slice(0, 40));
      if (ev.kind === 'redeem') {
        setRedeems24((x) => x + 1);
        setLastAt((m) => ({ ...m, [ev.node]: at }));
      }
      setNodes((ns) =>
        ns.map((n) => {
          if (n.name !== ev.node) return n;
          if (ev.kind === 'redeem') return { ...n, earned24: n.earned24 + ev.usd, earnedAll: n.earnedAll + ev.usd, redeems: n.redeems + 1, week: [...n.week.slice(0, 6), n.week[6] + ev.usd] };
          if (ev.kind === 'open') return { ...n, channels: n.channels + 1 };
          if (ev.kind === 'listing') return { ...n, listings: n.listings.map((l) => (l.model === ev.model ? { ...l, input: ev.input, output: ev.output } : l)) };
          return n;
        }),
      );
    };
    timer = setTimeout(step, 1200);
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, []);

  const shown = useMemo(() => {
    const priceOf = (n: SampleNode) => {
      const l = n.listings.find((x) => x.model === model);
      return l ? l.input + l.output : Infinity;
    };
    const list = model ? nodes.filter((n) => n.listings.some((l) => l.model === model)) : [...nodes];
    const by: Record<Sort, (a: SampleNode, b: SampleNode) => number> = {
      earned: (a, b) => b.earned24 - a.earned24,
      redeems: (a, b) => b.redeems - a.redeems,
      fastest: (a, b) => a.ttftMs - b.ttftMs,
      cheapest: (a, b) => (model ? priceOf(a) - priceOf(b) : Math.min(...a.listings.map((l) => l.input + l.output)) - Math.min(...b.listings.map((l) => l.input + l.output))),
      newest: (a, b) => a.sinceDays - b.sinceDays,
    };
    return list.sort(by[sort]);
  }, [nodes, sort, model]);

  const top = Math.max(...nodes.map((n) => n.earned24));
  const paid24 = nodes.reduce((a, n) => a + n.earned24, 0);
  const channels = nodes.reduce((a, n) => a + n.channels, 0);
  const served = new Set(nodes.flatMap((n) => n.listings.map((l) => l.model)));
  const ttfts = nodes.map((n) => n.ttftMs).sort((a, b) => a - b);
  const mid = ttfts.length >> 1;
  const medianTtft = Math.round(ttfts.length % 2 ? ttfts[mid] : (ttfts[mid - 1] + ttfts[mid]) / 2);

  const board = MODELS.map((m) => {
    const ls = nodes.flatMap((n) => n.listings.filter((l) => l.model === m.id).map((l) => ({ ...l, node: n })));
    const low = [...ls].sort((a, b) => a.input + a.output - (b.input + b.output))[0];
    const cached = ls.filter((l) => l.cached !== undefined).map((l) => l.cached!);
    const fast = [...ls].sort((a, b) => a.node.ttftMs - b.node.ttftMs)[0];
    return { ...m, nodes: ls.length, low, cached: cached.length ? Math.min(...cached) : null, fast };
  }).filter((m) => m.nodes > 0);

  return (
    <section className="nt" aria-label="Network terminal, sample data">
      <div className="nt__bar">
        <div className="nt__title">
          <span className="nt__dot" aria-hidden="true" />
          <span>Orrery network</span>
          <span className="nt__sample">Sample data</span>
        </div>
        <div className="nt__controls">
          <div className="nt__tabs" role="tablist" aria-label="Rank nodes by">
            {SORTS.map((s) => (
              <button key={s.k} role="tab" aria-selected={sort === s.k} className={sort === s.k ? 'is-on' : ''} onClick={() => setSort(s.k)}>
                {s.label}
              </button>
            ))}
          </div>
          <label className="nt__select">
            <span className="sr">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">All models</option>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <dl className="nt__stats">
        <div><dt>Nodes listed</dt><dd className="num">{nodes.length}</dd></div>
        <div><dt>Models served</dt><dd className="num">{served.size}</dd></div>
        <div><dt>Paid to nodes, 24h</dt><dd className="num green">{money(paid24)}</dd></div>
        <div><dt>Redeems, 24h</dt><dd className="num">{redeems24.toLocaleString('en-US')}</dd></div>
        <div><dt>Channels open</dt><dd className="num">{channels.toLocaleString('en-US')}</dd></div>
        <div><dt>Median first token</dt><dd className="num">{medianTtft} ms</dd></div>
        <div><dt>Program cut</dt><dd className="num green">0%</dd></div>
      </dl>

      <div className="nt__body">
        <div className="nt__board">
          <div className="nt__scroll">
            <table className="nt__table">
              <thead>
                <tr>
                  <th className="nt__rank">#</th>
                  <th>Node</th>
                  <th className="nt__hide-s">{model ? `${model}, per M in / out` : 'Serves'}</th>
                  <th className="r">Earned, 24h</th>
                  <th className="r nt__hide-m">All time</th>
                  <th className="r nt__hide-m">Redeems</th>
                  <th className="r nt__hide-l">Channels</th>
                  <th className="r nt__hide-s">First token</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((n, i) => {
                  const l = model ? n.listings.find((x) => x.model === model) : null;
                  const isOpen = open === n.name;
                  return (
                    <Fragment key={n.name}>
                      <tr className={isOpen ? 'is-open' : ''} onClick={() => setOpen(isOpen ? null : n.name)}>
                        <td className="nt__rank num">{String(i + 1).padStart(2, '0')}</td>
                        <td>
                          <button className="nt__node" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : n.name); }}>
                            <span className="nt__name">
                              {n.name}
                              {n.enclave ? <span className="nt__tag">enclave</span> : null}
                              {n.sinceDays <= 2 ? <span className="nt__tag">new</span> : null}
                            </span>
                            <span className="nt__meta">{n.region} · {n.hardware}</span>
                          </button>
                        </td>
                        <td className="nt__hide-s nt__serves">
                          {l ? (
                            <span className="num">{perM(l.input)} / {perM(l.output)}</span>
                          ) : (
                            <>
                              <span className="nt__chip">{n.listings[0].model}</span>
                              {n.listings.length > 1 ? <span className="nt__more">+{n.listings.length - 1}</span> : null}
                            </>
                          )}
                        </td>
                        <td className="r nt__earned">
                          <span className="nt__bar-fill" style={{ width: `${(n.earned24 / top) * 100}%` }} aria-hidden="true" />
                          <span key={n.redeems} className="num green nt__up">{money(n.earned24)}</span>
                        </td>
                        <td className="r num nt__hide-m">{money(n.earnedAll)}</td>
                        <td className="r num nt__hide-m">{n.redeems.toLocaleString('en-US')}</td>
                        <td className="r num nt__hide-l">{n.channels.toLocaleString('en-US')}</td>
                        <td className="r num nt__hide-s">{n.ttftMs} ms</td>
                      </tr>
                      {isOpen ? (
                        <tr className="nt__detail">
                          <td colSpan={8}>
                            <div className="nt__detail-grid">
                              <div>
                                <p className="nt__h">Listed on chain, per million tokens</p>
                                <table className="nt__mini">
                                  <thead>
                                    <tr><th>Model</th><th className="r">In</th><th className="r">Cached in</th><th className="r">Out</th></tr>
                                  </thead>
                                  <tbody>
                                    {n.listings.map((x) => (
                                      <tr key={x.model}>
                                        <td>{x.model}</td>
                                        <td className="r num">{perM(x.input)}</td>
                                        <td className="r num">{x.cached !== undefined ? perM(x.cached) : '—'}</td>
                                        <td className="r num">{x.output ? perM(x.output) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div>
                                <p className="nt__h">Earned, last 7 days</p>
                                <div className="nt__week" role="img" aria-label={`Earned per day: ${n.week.map((w) => money(w)).join(', ')}`}>
                                  {n.week.map((w, d) => (
                                    <span key={d} style={{ height: `${Math.max(2, (w / Math.max(...n.week)) * 100)}%` }} />
                                  ))}
                                </div>
                                <p className="nt__weeknote"><span className="num green">{money(n.week.reduce((a, b) => a + b, 0))}</span> this week</p>
                              </div>
                              <dl className="nt__facts">
                                <div><dt>Account</dt><dd className="num">{short(n.address)}</dd></div>
                                <div><dt>Last redeem</dt><dd>{lastAt[n.name] !== undefined ? (clock - lastAt[n.name] < 5 ? 'just now' : `${age(clock - lastAt[n.name])} ago`) : ago(n.lastRedeemMin + clock / 60)}</dd></div>
                                <div><dt>Channels</dt><dd className="num">{n.channels.toLocaleString('en-US')}</dd></div>
                                <div><dt>Bonded</dt><dd className="num">{n.bonded.toLocaleString('en-US')} OREY</dd></div>
                                <div><dt>Listed</dt><dd>{n.sinceDays === 1 ? 'yesterday' : `${n.sinceDays} days ago`}</dd></div>
                                <div><dt>Answered health checks</dt><dd className="num">{n.uptime.toFixed(2)}%</dd></div>
                                <div><dt>Prompts</dt><dd>{n.enclave ? 'sealed to the enclave' : 'TLS to the node'}</dd></div>
                              </dl>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="nt__tape" aria-label="Chain events, sample">
          <div className="nt__tape-head">
            <span>On chain, as it lands</span>
            <span className="nt__sample">Sample</span>
          </div>
          <ol aria-live="off">
            {tape.map((row) => (
              <li key={row.id} className={row.fresh ? 'is-fresh' : ''}>
                <span className={`nt__kind nt__kind--${row.ev.kind}`}>{TAPE_KIND[row.ev.kind]}</span>
                <span className="nt__line"><TapeLine ev={row.ev} /></span>
                <span className="nt__age num">{age(clock - row.at)}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <div className="nt__models">
        <p className="nt__h">Models on the network</p>
        <div className="nt__scroll">
          <table className="nt__table nt__table--models">
            <thead>
              <tr>
                <th>Model</th>
                <th className="r">Nodes</th>
                <th className="r">Lowest, per M in / out</th>
                <th className="r nt__hide-s">Cached in from</th>
                <th className="nt__hide-s">Fastest first token</th>
              </tr>
            </thead>
            <tbody>
              {board.map((m) => (
                <tr key={m.id} className={model === m.id ? 'is-open' : ''} onClick={() => setModel(model === m.id ? '' : m.id)}>
                  <td>
                    <button className="nt__node" onClick={(e) => { e.stopPropagation(); setModel(model === m.id ? '' : m.id); }}>
                      <span className="nt__name">{m.id}{m.kind === 'embedding' ? <span className="nt__tag">embedding</span> : null}</span>
                    </button>
                  </td>
                  <td className="r num">{m.nodes}</td>
                  <td className="r num">{perM(m.low.input)} / {m.low.output ? perM(m.low.output) : '—'}</td>
                  <td className="r num nt__hide-s">{m.cached !== null ? perM(m.cached) : '—'}</td>
                  <td className="nt__hide-s nt__meta-cell">{m.fast.node.name} · <span className="num">{m.fast.node.ttftMs} ms</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
