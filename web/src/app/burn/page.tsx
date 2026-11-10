import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import { CA, NAME, PROGRAM_ID, TICKER } from '@/brand';
import { burnState } from '@/lib/burn';
import '../docs/docs.css';
import '../prices/prices.css';
import './burn.css';

export const revalidate = 300;

export const metadata: Metadata = {
  title: `Burn — ${NAME}`,
  description: `Every answer burns: nodes pledge a share of what they earn, buy ${TICKER} with it and burn it, and routers check every burn on chain.`,
};

const STEPS = [
  ['A node pledges', 'A share of every USDC it redeems, written in the price list whose hash sits in its account on Solana.'],
  ['It gets paid', 'Routers pay it per answer. When it redeems, the pledge comes due on exactly that amount.'],
  [`It buys ${TICKER} and burns it`, 'Its own software buys on the market with the pledged share and burns what it bought. Nobody presses a button.'],
  ['Routers check, then prefer it', 'Each router reads the buy and the burn from chain itself. Nodes that keep their pledge rank higher and serve the :burn route.'],
];

const n = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const tx = (s: string) => `https://solscan.io/tx/${s}`;

export default async function Burn() {
  const b = await burnState();
  return (
    <div className="docs pcp brn">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="burn" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Burn</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/network">Network</Link>
          <Link href="/try">Try it</Link>
          <Link href="/private">Private</Link>
          <Link href="/prices">Prices</Link>
          <Link href="/changelog">Changelog</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#install" className="pill d-nav__cta">Install</Link>
      </header>
      <main className="pcp__main">
        <p className="pcp__live">
          <span className="cap"><i aria-hidden="true" /> Read from Solana mainnet</span>
          <span className="num">
            {b.checked ? `at ${b.at.slice(11, 16)} UTC, again every five minutes` : 'the chain could not be read just now'} · program{' '}
            <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noopener noreferrer">{PROGRAM_ID.slice(0, 4)}…{PROGRAM_ID.slice(-4)}</a>
          </span>
        </p>
        <h1>
          <span className="lead">Every answer burns.</span> Nodes buy {TICKER} with what they earn and burn it.
        </h1>
        <p className="d-lead">
          No treasury and no team wallet sits in this loop, and the settlement program still has no fee. A node chooses to pledge a share of what it earns; routers verify every burn on chain and send more work to the nodes that keep their word. The more the network is used, the more is burned.
        </p>

        <p className="brn__stage"><b>Where this stands.</b> The whole loop runs in the rehearsal on the real settlement program, 50 of 50 checks. Routers verify pledges and serve the :burn route as of orrery-node 0.1.8; the market buy that lets a node keep a pledge on mainnet comes next, then the seed node pledges first. This page reads mainnet and fills in as they do.</p>

        <dl className="brn__stats">
          <div><dt>{TICKER} supply now</dt><dd className="num">{b.supply === null ? '—' : n(b.supply)}</dd></div>
          <div><dt>Burned, verified</dt><dd className="num">{n(b.burned, 2)}</dd></div>
          <div><dt>Nodes pledging</dt><dd className="num">{b.pledgers.length}</dd></div>
          <div><dt>Burns verified</dt><dd className="num">{b.rows.length}</dd></div>
        </dl>

        <h2 className="brn__h2">How it works</h2>
        <ol className="brn__steps">
          {STEPS.map(([t, d], i) => (
            <li key={t}><span className="num">{i + 1}</span><div><h3>{t}</h3><p>{d}</p></div></li>
          ))}
        </ol>

        <h2 className="brn__h2">Nodes that pledged</h2>
        {b.pledgers.length ? (
        <div className="brn__wrap">
          <table>
            <thead><tr><th>node</th><th>pledge</th><th>redeemed</th><th>spent on burns</th><th>burned</th><th>pledge kept</th></tr></thead>
            <tbody>
              {b.pledgers.map((p) => (
                <tr key={p.address}>
                  <td><Link href={`/address/${p.address}`}>{p.name}</Link></td>
                  <td className="num">{p.share / 100}%</td>
                  <td className="num">${n(p.redeemed, 6)}</td>
                  <td className="num">${n(p.spent, 6)}</td>
                  <td className="num">{n(p.burned, 2)}</td>
                  <td className="num">{Math.round(p.kept * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : <p className="brn__empty">No node on mainnet has pledged yet. The first pledge appears here the moment it is pinned on chain.</p>}

        <h2 className="brn__h2">Every burn</h2>
        {b.rows.length ? (
        <div className="brn__wrap">
          <table>
            <thead><tr><th>when (UTC)</th><th>node</th><th>USDC spent</th><th>{TICKER} burned</th><th>buy</th><th>burn</th></tr></thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.burnTx}>
                  <td className="num">{r.at ? new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
                  <td>{r.node}</td>
                  <td className="num">${n(r.usdc, 6)}</td>
                  <td className="num">{n(r.burned, 2)}</td>
                  <td className="num"><a href={tx(r.swapTx)} target="_blank" rel="noopener noreferrer">{short(r.swapTx)}</a></td>
                  <td className="num"><a href={tx(r.burnTx)} target="_blank" rel="noopener noreferrer">{short(r.burnTx)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : <p className="brn__empty">Burns are listed here once this page has checked both transactions on chain: the node’s wallet bought, and the node’s wallet burned.</p>}

        <p className="brn__foot">
          Holder prices are set by a wallet’s share of {TICKER}’s supply, read from chain, so every burn moves every holder toward the next tier. Token: <a href={`https://solscan.io/token/${CA}`} target="_blank" rel="noopener noreferrer" className="num">{CA ? short(CA) : ''}</a>. Ask only burning nodes by adding <code>:burn</code> to a model name.
        </p>
      </main>
    </div>
  );
}
