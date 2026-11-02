import Link from 'next/link';
import Orrery from '@/components/Orrery';
import Thread from '@/components/Thread';
import { Arrow, ChannelCard, CopyButton, CutCalc, HeroConsole, Ledger, NavGround, ProviderCard, RouteCard, SealCard } from '@/components/parts';
import { Mark } from '@/components/Mark';
import { CA, NAME, PROGRAM_ID, REPO_URL, TICKER, X_URL } from '@/brand';
import { programStatus } from '@/lib/chain';
import { rehearsal, ranAtLabel, short, usd } from '@/lib/rehearsal';

export const revalidate = 300;

const PROVIDE_CMDS = 'yard provider register --config provider.json --wallet wallet.json\nyard provider start --config provider.json';
const BUY_URL = CA ? `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${CA}` : null;

function Check() {
  return (
    <svg className="check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.5 11.6 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TokenLoop() {
  const C = 240, R = 168;
  const at = (deg: number, r = R) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)] as const;
  const stations = [
    { deg: -90, k: 'Bond', v: `${TICKER} behind a listing`, g: '' },
    { deg: 22, k: 'Reputation', v: 'bond is 10% of the score', g: '' },
    { deg: 158, k: 'Picked', v: 'more :trusted requests', g: 'paid in USDC' },
  ];
  const chevron = (deg: number) => {
    const [x, y] = at(deg);
    return <path key={deg} d="M-5 -5 0 0 -5 5" transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${deg + 90})`} className="loop__chev" />;
  };
  return (
    <svg className="loop" viewBox="0 0 480 480" role="img" aria-label={`Bonded ${TICKER} raises a provider's reputation, which gets it picked more often on the trusted route, where it is paid in USDC.`}>
      <circle cx={C} cy={C} r={R} className="loop__orbit" />
      {Array.from({ length: 120 }, (_, i) => {
        const d = i * 3;
        const [x1, y1] = at(d, R + 26);
        const [x2, y2] = at(d, R + 26 + (i % 10 === 0 ? 12 : 5));
        return <line key={i} x1={x1.toFixed(2)} y1={y1.toFixed(2)} x2={x2.toFixed(2)} y2={y2.toFixed(2)} className={i % 10 === 0 ? 'loop__tick loop__tick--big' : 'loop__tick'} />;
      })}
      {[-34, 90, 214].map(chevron)}
      {Array.from({ length: 220 }, (_, i) => {
        const a = i * 2.39996;
        const r = 54 * Math.sqrt((i + 0.5) / 220);
        return <circle key={i} cx={(C + r * Math.cos(a)).toFixed(2)} cy={(C + r * Math.sin(a)).toFixed(2)} r="1.15" className="loop__dot" />;
      })}
      <text x={C} y={C + 5} textAnchor="middle" className="loop__core">${TICKER}</text>
      {stations.map((s) => {
        const [x, y] = at(s.deg);
        const top = s.deg === -90;
        const anchor = 'middle';
        const dx = 0;
        return (
          <g key={s.k}>
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="7" className="loop__node" />
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="2.4" className="loop__nodec" />
            <text x={(x + dx).toFixed(2)} y={(top ? y - 34 : y + 30).toFixed(2)} textAnchor={anchor} className="loop__k">{s.k.toUpperCase()}</text>
            <text x={(x + dx).toFixed(2)} y={(top ? y - 16 : y + 48).toFixed(2)} textAnchor={anchor} className="loop__v">{s.v}</text>
            {s.g && <text x={(x + dx).toFixed(2)} y={(y + 66).toFixed(2)} textAnchor={anchor} className="loop__paidt">{s.g}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default async function Home() {
  const chain = await programStatus();
  const passed = rehearsal.checks.filter((c) => c.ok).length;
  const stats: { k: string; v: string; u?: string; green?: boolean }[] = [
    { k: 'Requests', v: String(rehearsal.requests) },
    { k: 'Providers', v: String(rehearsal.providers.length) },
    { k: 'Settled on chain', v: `$${usd(BigInt(rehearsal.settledUnits))}`, green: true },
    { k: 'To the program', v: '0', u: 'USDC' },
    { k: 'Checks passed', v: `${passed}/${rehearsal.checks.length}` },
    { k: 'Mainnet', v: chain.checked ? (chain.deployed ? 'live' : 'not live') : 'unchecked' },
  ];
  return (
    <>
      <NavGround />
      <header className="nav">
        <Link href="/" className="nav__brand" aria-label={`${NAME} home`}>
          <Mark />
          <span>{NAME}</span>
        </Link>
        <nav className="nav__links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#pay">Payments</a>
          <a href="#provide">Providers</a>
          <a href="#token">${TICKER}</a>
          <Link href="/docs">Docs</Link>
        </nav>
        <div className="nav__cta">
          {BUY_URL ? (
            <a href={BUY_URL} className="pill pill--gray" rel="noopener noreferrer" target="_blank">Buy ${TICKER}</a>
          ) : (
            <span className="pill pill--gray is-off" title="Not launched yet">${TICKER} soon</span>
          )}
          <Link href="/docs#install" className="pill">Install</Link>
        </div>
      </header>

      <main className="page">
        <section className="hero">
          <Orrery />
          <div className="hero__foot" data-orrery-clear>
            <h1>
              <span className="dim">AI inference, peer to peer.</span> Zero cut in between.
            </h1>
            <HeroConsole />
          </div>
        </section>

        <section className="facts" aria-label="At a glance">
          <div>
            <span className="label">Router</span>
            <p>On your computer, OpenAI-compatible</p>
          </div>
          <div>
            <span className="label">Payment</span>
            <p>One signature per answer, on Solana</p>
          </div>
          <div>
            <span className="label">Program fee</span>
            <p className="green num">0%</p>
          </div>
          <div>
            <span className="label">Providers</span>
            <p>Anyone. No approval, no delisting</p>
          </div>
        </section>

        <div className="body">
          <Thread />

          <section className="split" id="how" data-dock>
            <div className="split__text">
              <h2>
                <span className="dim">Routes.</span> One word decides the trip
              </h2>
              <p className="sub">Point anything that takes a base URL at the router: Cursor, Aider, Continue, Open WebUI, the OpenAI SDK. Then add one word after the model name.</p>
              <ol className="steps">
                <li><span className="num">01</span><b className="num">:cheap</b><span>lowest price for the model</span></li>
                <li><span className="num">02</span><b className="num">:fast</b><span>quickest first token this router has seen</span></li>
                <li><span className="num">03</span><b className="num">:trusted</b><span>most USDC settled on chain, bonded ${TICKER}</span></li>
                <li><span className="num">04</span><b className="num">:private</b><span>verified enclaves only, request sealed</span></li>
              </ol>
              <div className="cta">
                <Link href="/docs#install" className="pill">Install the router</Link>
                <Link href="/docs#routes" className="ghost">How routes rank <Arrow /></Link>
              </div>
              <p className="aside">If a provider stops answering, the next one does. In the rehearsal the cheapest provider was switched off mid-run and the request fell through without the tool noticing.</p>
            </div>
            <div className="split__card">
              <RouteCard />
            </div>
          </section>

          <section className="split split--flip" id="pay" data-dock>
            <div className="split__text">
              <h2>
                <span className="dim">Payments.</span> Sign once, pay per answer
              </h2>
              <p className="sub">Your wallet opens a channel with a provider. After every answer the router on your computer signs the new running total, and the provider cashes the latest one on Solana whenever it likes.</p>
              <ol className="steps">
                <li><span className="num">01</span><b>Open</b><span>one wallet signature puts two dollars in a channel</span></li>
                <li><span className="num">02</span><b>Answer</b><span>a signed total after each, never more than one answer owed</span></li>
                <li><span className="num">03</span><b>Redeem</b><span>many channels in one transaction, a fraction of a cent</span></li>
                <li><span className="num">04</span><b>Close</b><span>what is left comes straight back to you</span></li>
              </ol>
              <p className="aside">A lost session key can spend at most what is left in your open channels, under a daily cap you set.</p>
            </div>
            <div className="split__card">
              <ChannelCard />
            </div>
          </section>
        </div>

        <section className="film">
          <video className="film__media" src="/media/rig.mp4" poster="/media/rig.jpg" autoPlay muted loop playsInline preload="metadata" aria-hidden="true" />
          <div className="film__shade" />
          <div className="film__text">
            <h2>Every provider is someone&apos;s own machine.</h2>
            <p>A GPU running vLLM or Ollama, a llama.cpp box, API capacity you already pay for. List it with one command. No application, no stake required, and nothing in the program can delist you.</p>
            <a href="#provide" className="pill">Run a provider</a>
          </div>
        </section>

        <div className="body">
          <Thread />
          <section className="split" id="provide" data-dock>
            <div className="split__text">
              <h2>
                <span className="dim">Providers.</span> Light a node, set your price
              </h2>
              <p className="sub">Put a provider node in front of any OpenAI-compatible server. It checks each voucher before it answers and redeems the totals to your wallet.</p>
              <div className="term">
                <div className="term__bar">
                  <span className="label">On the machine that serves the model</span>
                  <CopyButton text={PROVIDE_CMDS} />
                </div>
                <pre className="num">
                  <span className="term__p">$</span> yard provider register \{'\n'}
                  {'    '}--config provider.json --wallet wallet.json{'\n'}
                  <span className="term__p">$</span> yard provider start --config provider.json
                </pre>
              </div>
              <ol className="steps steps--tight">
                <li><span className="num">01</span><b>Register</b><span>endpoint and price list hash, on chain</span></li>
                <li><span className="num">02</span><b>Serve</b><span>vouchers checked before every answer</span></li>
                <li><span className="num">03</span><b>Keep it</b><span>redemptions go to your wallet, the program takes nothing</span></li>
              </ol>
            </div>
            <div className="split__card">
              <ProviderCard />
            </div>
          </section>

          <section className="zero" id="zero" data-dock="edge">
            <h2 className="zero__head">
              <span className="dim">The program in the middle takes</span>
              <span className="zero__num green num">0%</span>
            </h2>
            <p className="zero__sub">It has no fee field and no third account to send one to. Every unit a provider redeems lands in the provider&apos;s account. Every unit it doesn&apos;t comes back to you.</p>
            <div className="zero__cards">
              <Ledger />
              <CutCalc />
            </div>
          </section>

          <section className="split split--flip" id="private" data-dock>
            <div className="split__text">
              <h2>
                <span className="dim">Private.</span> Sealed before it leaves
              </h2>
              <p className="sub">Add <code>:private</code> and the router only picks providers running inside a hardware enclave, then encrypts your prompt to a key that never leaves it. The operator hosts the machine and still can&apos;t read the request.</p>
              <ol className="steps">
                <li><span className="num">01</span><b>Claimed</b><span>the enclave&apos;s measurement and key, posted on chain</span></li>
                <li><span className="num">02</span><b>Checked</b><span>the router matches the live report to that claim</span></li>
                <li><span className="num">03</span><b>Sealed</b><span>X25519 and AES-256-GCM, opened only inside</span></li>
              </ol>
              <p className="aside">The card is live: what you type is sealed in this tab with the router&apos;s cipher.</p>
            </div>
            <div className="split__card">
              <SealCard />
            </div>
          </section>

          <section className="split" id="token" data-dock>
            <div className="split__art">
              <TokenLoop />
            </div>
            <div className="split__text">
              <h2>
                <span className="dim">${TICKER}.</span> Backs the providers you trust
              </h2>
              <p className="sub">Launching on Meteora. In the program it has one job: providers bond it behind their listing, and routers count the bond toward reputation.</p>
              <div className="tiles">
                <div className="tile"><span className="num">01</span><b>Bond</b><p>Posted on chain behind a provider&apos;s listing</p></div>
                <div className="tile"><span className="num">02</span><b>Reputation</b><p>Bonded {TICKER} is 10% of the <code>:trusted</code> score</p></div>
                <div className="tile"><span className="num">03</span><b>Never slashed</b><p>Unbonding returns it after seven days</p></div>
                <div className="tile"><span className="num">04</span><b>Contract</b><p className="num">{CA ? short(CA, 6, 6) : 'not launched yet'}</p></div>
              </div>
              <div className="cta">
                {BUY_URL ? (
                  <a href={BUY_URL} className="pill" rel="noopener noreferrer" target="_blank">Buy ${TICKER}</a>
                ) : (
                  <span className="pill is-off">${TICKER} at launch</span>
                )}
                <Link href="/docs#token" className="ghost">Token in the docs <Arrow /></Link>
              </div>
            </div>
          </section>

          <section className="network" aria-label="Rehearsal numbers">
            <div className="network__row">
              {stats.map((s) => (
                <div key={s.k} className="stat">
                  <span className="label">{s.k}</span>
                  <b className={`num${s.green ? ' green' : ''}`}>
                    {s.v}
                    {s.u && <small>{s.u}</small>}
                  </b>
                </div>
              ))}
            </div>
            <p className="network__note">
              The program, a router and three provider nodes on a Solana test validator, {ranAtLabel}. Mainnet status is read from the chain{chain.checked ? '' : ' once the site has an RPC'}.
            </p>
            <details className="proof">
              <summary>All {rehearsal.checks.length} rehearsal checks</summary>
              <ul>
                {rehearsal.checks.map((c) => (
                  <li key={c.name} className={c.ok ? '' : 'is-bad'}>
                    <Check />
                    <span>{c.name}</span>
                    {c.detail && <span className="num proof__d">{c.detail}</span>}
                  </li>
                ))}
              </ul>
              <p className="proof__foot num">program {short(PROGRAM_ID, 4, 4)} · 13 program tests · 12 router tests</p>
            </details>
          </section>
        </div>

        <section className="close">
          <img className="close__media" src="/media/city.jpg" alt="" aria-hidden="true" />
          <div className="close__shade" />
          <div className="close__text">
            <h2>
              <span className="dim">Point your AI</span> at the network.
            </h2>
            <div className="cta cta--center">
              <Link href="/docs#install" className="pill">Install the router</Link>
              <Link href="/docs" className="ghost">Read the docs <Arrow /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <span className="foot__brand">
          <Mark /> {NAME} <em>working title</em>
        </span>
        <nav aria-label="Elsewhere">
          <Link href="/docs">Docs</Link>
          {REPO_URL ? <a href={REPO_URL}>GitHub</a> : <span className="foot__off">GitHub at launch</span>}
          {X_URL ? <a href={X_URL}>X</a> : <span className="foot__off">X soon</span>}
        </nav>
        <span className="foot__note">Settles on Solana. Numbers on this page come from the local rehearsal of {ranAtLabel}.</span>
      </footer>
    </>
  );
}
