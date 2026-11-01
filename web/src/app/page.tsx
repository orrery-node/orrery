import Link from 'next/link';
import Sky from '@/components/Sky';
import { CopyButton, NavGround, RehearsalLog, RoutePicker, SealDemo, StageWatcher, VoucherBytes, ZeroCalc } from '@/components/live';
import { CA, NAME, PROGRAM_ID, REPO_URL, TICKER, X_URL } from '@/brand';
import { rehearsal, ranAtLabel, short } from '@/lib/rehearsal';
import { Mark } from '@/components/Mark';

const PROVIDE_CMDS = 'yard provider register --config provider.json --wallet wallet.json\nyard provider start --config provider.json';

function Check() {
  return (
    <svg className="check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.5 11.6 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <Sky />
      <StageWatcher />
      <NavGround />
      <header className="nav">
        <Link href="/" className="nav__brand" aria-label={`${NAME} home`}>
          <Mark />
          <span>{NAME}</span>
        </Link>
        <nav className="nav__links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#provide">Providers</a>
          <a href="#token">${TICKER}</a>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/docs#install" className="pill pill--sm">Install</Link>
      </header>

      <main className="page">
        <section className="hero" data-stage="hero">
          <div className="hero__text">
            <h1>
              AI inference,
              <br />
              peer to peer.
              <br />
              <span className="green">Zero cut</span>
              <br />
              in between.
            </h1>
            <p className="lead">
              {NAME} is a network of independent AI providers on Solana. A router on your computer sends every request to the provider that suits it and pays that provider directly, a fraction of a cent at a time. The program in the middle takes nothing.
            </p>
            <div className="cta">
              <Link href="/docs#install" className="pill">Install the router</Link>
              <a href="#provide" className="ghost">Run a provider <span aria-hidden="true">→</span></a>
            </div>
            <p className="hint">Drag the network to turn it.</p>
          </div>
          <RehearsalLog />
        </section>

        <section className="chapter" id="how" data-stage="routes">
          <div className="chapter__window" aria-hidden="true" />
          <div className="chapter__text">
            <h2>Change one line. Keep your tools.</h2>
            <p>
              Cursor, Aider, Continue, Open WebUI, the OpenAI SDK: anything that takes a base URL. Point it at the router on your machine, then say how each request should travel with one word after the model name.
            </p>
            <RoutePicker />
            <p className="aside">
              If a provider stops answering, the next one does. In the rehearsal the cheapest provider was switched off mid-run and the request fell through to the next, with the tool none the wiser.
            </p>
          </div>
        </section>

        <section className="chapter" data-stage="voucher">
          <div className="chapter__window" aria-hidden="true" />
          <div className="chapter__text">
            <h2>Pay per answer. Sign once.</h2>
            <p>
              Your wallet opens a channel with a provider and puts a small deposit in it, two dollars by default. After every answer a key on your computer signs the new running total. The provider cashes the latest total on Solana whenever it wants, many channels in one transaction, for a fraction of a cent.
            </p>
            <VoucherBytes />
            <p className="aside">
              A provider is never owed more than one unsigned answer. A lost key can spend at most what is left in your open channels, under a daily cap you set.
            </p>
          </div>
        </section>

        <section className="chapter" data-stage="zero">
          <div className="chapter__window" aria-hidden="true" />
          <div className="chapter__text">
            <h2>There is no fee to raise.</h2>
            <p>
              Every unit a provider redeems lands in the provider&apos;s own account. Every unit it doesn&apos;t goes back to you when the channel closes. The program has no fee field and no third account to send one to. Here is where every dollar of the rehearsal ended up:
            </p>
            <ZeroCalc />
          </div>
        </section>

        <section className="chapter" data-stage="sealed">
          <div className="chapter__window" aria-hidden="true" />
          <div className="chapter__text">
            <h2>Private, when you ask for it.</h2>
            <p>
              Add <code>:private</code> and the router only picks providers running inside a hardware enclave. It fetches the enclave&apos;s report, checks it against the claim the provider posted on chain, and encrypts your prompt to a key that never leaves the enclave. The operator hosts the machine and still can&apos;t read the request.
            </p>
            <SealDemo />
          </div>
        </section>

        <section className="chapter chapter--provide" id="provide" data-stage="provide">
          <div className="chapter__window" aria-hidden="true" />
          <div className="chapter__text">
            <h2>Anyone can light a node.</h2>
            <p>
              A GPU running vLLM or Ollama, a llama.cpp box, or API capacity you already pay for. List it with one command: no application, no approval, no stake required, and the program has no way to delist you. You set the prices. Every router that picks you pays you directly.
            </p>
            <div className="cmd">
              <pre>
                <span className="cmd__p">$</span> yard provider register --config provider.json --wallet wallet.json
                {'\n'}
                <span className="cmd__p">$</span> yard provider start --config provider.json
              </pre>
              <CopyButton text={PROVIDE_CMDS} />
            </div>
            <p className="aside">The dim points in the network are open slots, drawn for illustration. Scrolling lights them the way listings would.</p>
          </div>
        </section>

        <section className="quiet token" id="token" data-stage="quiet">
          <h2>
            <span className="token__tk">${TICKER}</span> backs the providers you trust.
          </h2>
          <div className="token__body">
            <p>
              Launching on Meteora. Providers can bond ${TICKER} behind their listing, and routers count bonded ${TICKER} as one input to reputation, so a bonded provider gets picked more often on the <code>:trusted</code> route. A bond is never slashed. It comes back after a seven-day wait.
            </p>
            <dl className="token__facts">
              <div>
                <dt>Contract address</dt>
                <dd className="num">{CA ?? 'not launched yet'}</dd>
              </div>
              <div>
                <dt>Launch</dt>
                <dd>Meteora</dd>
              </div>
              <div>
                <dt>In the program</dt>
                <dd>bond mint, set once</dd>
              </div>
            </dl>
            <p className="aside">{NAME} and ${TICKER} are working titles.</p>
          </div>
        </section>

        <section className="quiet proof" data-stage="quiet">
          <h2>Run end to end before launch.</h2>
          <p className="proof__lead">
            The program, a router and three provider nodes on a Solana test validator, {ranAtLabel}: every route, a provider going dark mid-run, payments redeemed on chain, a channel released early. {rehearsal.checks.filter((c) => c.ok).length} of {rehearsal.checks.length} checks passed.
          </p>
          <ul className="proof__list">
            {rehearsal.checks.map((c) => (
              <li key={c.name} className={c.ok ? '' : 'is-bad'}>
                <Check />
                <span>{c.name}</span>
                {c.detail && <span className="num proof__d">{c.detail}</span>}
              </li>
            ))}
          </ul>
          <p className="proof__foot num">
            program {short(PROGRAM_ID, 4, 4)} · 13 program tests · 12 router tests · not on mainnet yet
          </p>
        </section>

        <section className="quiet close" data-stage="quiet">
          <h2>Point your AI at the network.</h2>
          <div className="cta">
            <Link href="/docs#install" className="pill">Install the router</Link>
            <Link href="/docs" className="ghost">Read the docs <span aria-hidden="true">→</span></Link>
          </div>
        </section>
      </main>

      <footer className="foot">
        <span className="foot__brand">
          <Mark /> {NAME} <em>working title</em>
        </span>
        <nav aria-label="Elsewhere">
          <Link href="/docs">Docs</Link>
          <a href={REPO_URL}>GitHub</a>
          {X_URL ? <a href={X_URL}>X</a> : <span className="foot__off">X soon</span>}
        </nav>
        <span className="foot__note">Settles on Solana. Every number on this page comes from the local rehearsal of {ranAtLabel}.</span>
      </footer>
    </>
  );
}
