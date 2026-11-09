import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import PriceCalc from '@/components/PriceCalc';
import { NAME, PROGRAM_ID } from '@/brand';
import { prices } from '@/lib/prices';
import '../docs/docs.css';
import './prices.css';

export const revalidate = 300;

export const metadata: Metadata = {
  title: `Prices — ${NAME}`,
  description: `Every price listed on ${NAME}, read from Solana, and what a request costs at each node before you send it.`,
};

export default async function Prices() {
  const p = await prices();
  const models = new Set(p.listings.map((l) => l.model)).size;
  const nodes = new Set(p.listings.map((l) => l.address)).size;
  return (
    <div className="docs pcp">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="prices" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Prices</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/network">Network</Link>
          <Link href="/try">Try it</Link>
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
            {p.checked ? `${nodes} ${nodes === 1 ? 'node' : 'nodes'} · ${models} models · at ${p.at.slice(11, 16)} UTC, again every five minutes` : 'the chain could not be read just now'} · program{' '}
            <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noopener noreferrer">{PROGRAM_ID.slice(0, 4)}…{PROGRAM_ID.slice(-4)}</a>
          </span>
        </p>
        <h1>
          <span className="lead">What it costs.</span> Every listed price, and your request priced at each node.
        </h1>
        <p className="d-lead">
          Nodes publish their prices per million tokens in a list whose hash sits in their account on Solana. This page reads those lists the way your router does and works out what a request costs at each node, before anything is sent. From your terminal: <code>orrery quote &lt;model&gt;</code>.
        </p>
        <PriceCalc listings={p.listings} />
      </main>
    </div>
  );
}
