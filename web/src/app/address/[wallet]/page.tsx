import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import WalletLookup from '@/components/WalletLookup';
import { CopyButton } from '@/components/parts';
import { NAME } from '@/brand';
import { usd } from '@/lib/rehearsal';
import { validAddress, wallet, type WalletChannel } from '@/lib/wallet';
import '../../docs/docs.css';
import '../../network/network.css';
import '../address.css';

export const dynamic = 'force-dynamic';

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const day = (s: number) => (s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
const when = (s: number) => (s ? `${new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC` : '—');
const sum = (xs: string[]) => xs.reduce((a, b) => a + BigInt(b), 0n);
const solscan = (a: string) => `https://solscan.io/account/${a}`;
const money = (u: bigint) => {
  const s = usd(u);
  const [w, f] = s.split('.');
  const t = f.replace(/0+$/, '');
  return `$${w}.${t.length < 2 ? t.padEnd(2, '0') : t}`;
};

export async function generateMetadata({ params }: { params: Promise<{ wallet: string }> }): Promise<Metadata> {
  const { wallet: w } = await params;
  return { title: `${short(w)} — ${NAME}`, description: `What ${w} did on ${NAME}, read from the program on Solana: channels it opened, what providers redeemed, and any node it runs.` };
}

function status(c: WalletChannel) {
  if (!c.closingAt) return 'open';
  return c.closingAt * 1000 > Date.now() ? `closing ${when(c.closingAt)}` : 'can close';
}

function ChannelTable({ rows, who }: { rows: WalletChannel[]; who: 'provider' | 'payer' }) {
  return (
    <div className="nt__scroll">
      <table className="nt__table addr__table">
        <thead>
          <tr>
            <th>{who === 'provider' ? 'Paid to' : 'Opened by'}</th>
            <th className="nt__hide-s">Channel</th>
            <th className="r">Deposit</th>
            <th className="r">Redeemed<span className="nt__hide-s"> by the node</span></th>
            <th className="r nt__hide-s">Opened</th>
            <th className="nt__hide-s">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.address}>
              <td>
                {who === 'provider' ? (
                  <Link href={`/address/${c.provider}`} className="addr__who">{c.providerName ?? short(c.provider)}</Link>
                ) : (
                  <Link href={`/address/${c.payer}`} className="addr__who num">{short(c.payer)}</Link>
                )}
              </td>
              <td className="num nt__hide-s"><a href={solscan(c.address)} target="_blank" rel="noopener noreferrer" className="addr__link">{short(c.address)}</a></td>
              <td className="r num">{money(BigInt(c.deposit))}</td>
              <td className="r num green">{money(BigInt(c.redeemed))}</td>
              <td className="r nt__hide-s addr__dim">{when(c.openedAt)}</td>
              <td className="nt__hide-s addr__dim">{status(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Address({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet: raw } = await params;
  const address = validAddress(raw);
  if (!address) notFound();
  const w = await wallet(address);
  const deposited = sum(w.channels.map((c) => c.deposit));
  const redeemed = sum(w.channels.map((c) => c.redeemed));
  const open = w.channels.filter((c) => !c.closingAt).length;
  const nothing = w.checked && !w.channels.length && !w.nodes.length;

  return (
    <div className="docs netp addr">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="addr" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">{w.isNode ? 'Node' : 'Wallet'}</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/network">Network</Link>
          <Link href="/try">Try it</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#provide" className="pill d-nav__cta">Run a node</Link>
      </header>

      <main className="netp__main">
        <div className="netp__head">
          <p className="netp__live">
            <span className="cap"><i aria-hidden="true" /> Read from Solana mainnet</span>
            <span className="num">{w.checked ? `at ${new Date(w.at).toISOString().slice(11, 16)} UTC, again two minutes later` : 'the chain could not be read just now'}</span>
          </p>
          <h1 className="addr__h1">
            <span className="lead">{w.isNode ? `${w.nodes[0]?.name ?? 'A node'}.` : 'A wallet on Orrery.'}</span> <span className="num addr__addr">{short(address)}</span>
          </h1>
          <div className="addr__full">
            <code className="num">{address}</code>
            <CopyButton text={address} />
            <a href={solscan(address)} target="_blank" rel="noopener noreferrer" className="ghost">Solscan</a>
          </div>
        </div>

        {!w.isNode ? (
          <dl className="nt nt__stats addr__stats">
            <div><dt>SOL</dt><dd className="num">{w.sol !== null ? w.sol.toFixed(4) : '—'}</dd></div>
            <div><dt>USDC</dt><dd className="num">{w.usdc !== null ? `$${usd(BigInt(w.usdc), 2)}` : '—'}</dd></div>
            <div><dt>Channels on chain</dt><dd className="num">{w.channels.length}</dd></div>
            <div><dt>Open now</dt><dd className="num">{open}</dd></div>
            <div><dt>Deposited</dt><dd className="num">{money(deposited)}</dd></div>
            <div><dt>Paid out to nodes</dt><dd className="num green">{money(redeemed)}</dd></div>
          </dl>
        ) : null}

        {w.channels.length ? (
          <section className="nt addr__sec">
            <div className="nt__bar"><div className="nt__title"><span className="nt__dot" aria-hidden="true" />As a router: channels it opened</div></div>
            <ChannelTable rows={w.channels} who="provider" />
            <p className="addr__note">Redeemed is what a node has claimed on chain so far. A router signs a running total after every answer; the node redeems it when it likes, so the latest answers can still be waiting. A closed channel leaves the chain, and its payout stays in the node&apos;s total.</p>
          </section>
        ) : null}

        {w.nodes.map((n) => (
          <section key={n.address} className="nt addr__sec">
            <div className="nt__bar">
              <div className="nt__title">
                <span className="nt__dot" aria-hidden="true" />
                {w.isNode ? 'Node account' : 'As a node'}: {n.name ?? short(n.address)}
                {n.enclave ? <span className="nt__tag">enclave</span> : null}
                {!n.active ? <span className="nt__tag">inactive</span> : null}
              </div>
              <a href={solscan(n.address)} target="_blank" rel="noopener noreferrer" className="addr__link num">{short(n.address)}</a>
            </div>
            <dl className="nt__stats addr__nodestats">
              <div><dt>Earned, all time</dt><dd className="num green">{money(BigInt(n.settled))}</dd></div>
              <div><dt>Redeems</dt><dd className="num">{n.redeems}</dd></div>
              <div><dt>Channels opened to it</dt><dd className="num">{n.channels}</dd></div>
              <div><dt>Listed</dt><dd className="num">{day(n.registeredAt)}</dd></div>
              <div><dt>Last redeem</dt><dd className="num">{n.lastSettledAt ? when(n.lastSettledAt) : '—'}</dd></div>
            </dl>
            {n.models.length ? (
              <p className="addr__models">
                <span>Serves</span>
                {n.models.map((m) => <span key={m} className="nt__chip">{m}</span>)}
              </p>
            ) : null}
            {n.routers.length ? <ChannelTable rows={n.routers} who="payer" /> : <p className="addr__note">No open channels to this node right now.</p>}
          </section>
        ))}

        {nothing ? (
          <section className="addr__empty">
            <h2><span className="lead">Nothing here yet.</span> This address hasn&apos;t opened a channel or listed a node.</h2>
            <div className="cta">
              <Link href="/try" className="pill">Ask the network something</Link>
              <Link href="/docs#provide" className="ghost">Run a node</Link>
            </div>
          </section>
        ) : null}

        <section className="addr__look">
          <p>Look up another address</p>
          <WalletLookup />
        </section>
      </main>
    </div>
  );
}
