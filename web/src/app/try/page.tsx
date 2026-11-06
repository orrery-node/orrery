import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import TryBox from '@/components/TryBox';
import { CopyButton } from '@/components/parts';
import { NAME, PROGRAM_ID } from '@/brand';
import '../docs/docs.css';
import './try.css';

export const metadata: Metadata = {
  title: `Try it — ${NAME}`,
  description: `Ask a question and watch a provider on Solana mainnet answer it and get paid for that one answer. The same ${NAME} router you install from npm, running on this site with a small wallet of its own.`,
};

const STEPS = [
  { k: 'Pick', v: 'The router reads every provider listed on chain and ranks them for this model by price, first-token speed and reputation.' },
  { k: 'Ask', v: 'Your question goes straight to that provider over HTTPS, with the channel address and the total signed so far.' },
  { k: 'Check', v: 'The provider confirms on chain that the channel is real and funded, and that everything before this answer is signed. Then it streams.' },
  { k: 'Pay', v: 'The router works out the cost from the provider’s published prices and signs a new 88-byte running total. The provider redeems it on Solana when it likes.' },
];

export default function Try() {
  return (
    <div className="docs tryp">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="try" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Try it</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#install" className="pill d-nav__cta">Install</Link>
      </header>

      <main className="tryp__main">
        <span className="cap tryp__live"><i aria-hidden="true" /> Live on Solana mainnet</span>
        <h1>
          <span className="lead">Ask the network.</span> A provider answers, and gets paid for that one answer.
        </h1>
        <p className="d-lead">
          This page runs the same router you get from npm, on the site&apos;s server, with a small wallet of its own. It opens a payment channel to a provider listed on chain and signs a running total after every answer. Nothing sits in between, and the program takes 0%.
        </p>

        <TryBox />

        <section className="tryp__how" aria-label="What happens">
          <h2>
            <span className="lead">What just happened.</span> Four steps, two machines.
          </h2>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.k}>
                <span className="num tryp__n">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <span className="cap">{s.k}</span>
                  <p>{s.v}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="tryp__prog num">
            program <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noopener noreferrer">{PROGRAM_ID}</a>
          </p>
        </section>

        <section className="tryp__own">
          <h2>
            <span className="lead">Run it yourself.</span> Same router, your wallet, any tool.
          </h2>
          <div className="installbar">
            <code className="num">
              <span>$</span> npx -y orrery-node router --wallet ~/.config/solana/id.json
            </code>
            <CopyButton text="npx -y orrery-node router --wallet ~/.config/solana/id.json" />
          </div>
          <p className="d-lead">Then point Cursor, Aider or any OpenAI SDK at http://127.0.0.1:7171/v1. Your own router has no daily limit but the one you set.</p>
          <div className="cta">
            <Link href="/docs#quickstart" className="pill">Quickstart</Link>
            <Link href="/docs#provide" className="ghost">Sell inference instead</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
