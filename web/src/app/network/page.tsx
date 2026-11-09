import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import NetworkTerminal from '@/components/NetworkTerminal';
import WalletLookup from '@/components/WalletLookup';
import { CopyButton } from '@/components/parts';
import { NAME, PROGRAM_ID } from '@/brand';
import { mainnet } from '@/lib/chain';
import { usd } from '@/lib/rehearsal';
import '../docs/docs.css';
import './network.css';
import '../address/address.css';

export const revalidate = 300;

export const metadata: Metadata = {
  title: `Network — ${NAME}`,
  description: `Every node on ${NAME}, ranked by what it earned on Solana: redeems, channels, prices and first-token time, with chain events as they land. A preview with sample data.`,
};

const INIT = 'npx -y orrery-node provider init';

export default async function Network() {
  const live = await mainnet();
  return (
    <div className="docs netp">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="network" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Network</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/try">Try it</Link>
          <Link href="/prices">Prices</Link>
          <Link href="/changelog">Changelog</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#provide" className="pill d-nav__cta">Run a node</Link>
      </header>

      <main className="netp__main">
        <div className="netp__head">
          <p className="netp__flag">
            <span className="netp__pill">Preview</span>
            The board below runs on sample data. Names, addresses and amounts are made up.
          </p>
          <h1>
            <span className="lead">The network terminal.</span> Every node, ranked by what it earned on chain.
          </h1>
          <p className="d-lead">
            A node&apos;s earnings, redeems, channels, bond and listing date sit in its own account on Solana, so nobody keeps this board but the chain. Requests stay between a router and a node; what lands on chain is the money.
          </p>
          <p className="netp__live">
            <span className="cap"><i aria-hidden="true" /> Solana mainnet right now</span>
            {live.checked ? (
              <span className="num">
                {live.providers} {live.providers === 1 ? 'node' : 'nodes'} · {live.channels} channels · <span className="green">${usd(BigInt(live.settledUnits))}</span> settled · program{' '}
                <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noopener noreferrer">{PROGRAM_ID.slice(0, 4)}…{PROGRAM_ID.slice(-4)}</a>
              </span>
            ) : (
              <span className="num">read from the program every five minutes</span>
            )}
          </p>
          <div className="netp__look">
            <WalletLookup />
            <p>
              Real accounts on mainnet, read live: the site&apos;s <Link href="/address/A8umk6FF7TgWyAG4GdX8PgEsBL5WhhiTYve9YKzBJqvK">demo router</Link> and the <Link href="/address/76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8">seed node</Link>.
            </p>
          </div>
        </div>

        <NetworkTerminal />

        <section className="netp__own">
          <h2>
            <span className="lead">Your row goes here.</span> List a GPU, a Mac or a rack in one command.
          </h2>
          <div className="installbar">
            <code className="num">
              <span>$</span> {INIT}
            </code>
            <CopyButton text={INIT} />
          </div>
          <p className="d-lead">
            It finds the models on your vLLM, SGLang or Ollama server, drafts a price list with cached-input prices, and registers the node on Solana. Routers pay you per answer, and you redeem whenever you like with nothing taken out.
          </p>
          <div className="cta">
            <Link href="/docs#provide" className="pill">Run a node</Link>
            <Link href="/try" className="ghost">Ask the network something</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
