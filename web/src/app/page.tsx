import Link from 'next/link';
import Orrery from '@/components/Orrery';
import { Arrow, ChannelCard, CopyButton, CutCalc, Ledger, NavGround, ProviderCard, RequestLine, RouteCard, SealFlow } from '@/components/parts';
import { Mark } from '@/components/Mark';
import FilmReel from '@/components/FilmReel';
import ScrollFX from '@/components/ScrollFX';
import Wire from '@/components/Wire';
import { CA, NAME, NPM_PACKAGE, NPM_URL, PROGRAM_ID, REPO_URL, TICKER, WORKING_TITLE, X_URL } from '@/brand';
import { mainnet, programStatus } from '@/lib/chain';
import { perM, rehearsal, ranAtLabel, ROUTE_WORD, short, usd } from '@/lib/rehearsal';

export const revalidate = 300;

const PROVIDE_CMDS = 'orrery provider register --config provider.json --wallet wallet.json\norrery provider start --config provider.json';
const BUY_URL = CA ? `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${CA}` : null;

function Check() {
  return (
    <svg className="check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.5 11.6 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HolderLadder() {
  const tiers = [
    { k: 'less than 0.1%', v: 'list price', pct: 100, price: '$0.885 · $1.185' },
    { k: '0.1% or more', v: '20% off', pct: 80, price: '$0.708 · $0.948' },
    { k: '1% or more', v: '35% off', pct: 65, price: '$0.575 · $0.770' },
  ];
  return (
    <figure className="ladder" aria-label={`Holder prices at the seed provider: under 0.1% of ${TICKER} supply pays the list price, 0.1% or more pays 20% less, 1% or more pays 35% less.`}>
      <div className="ladder__cols">
        {tiers.map((t, i) => (
          <div key={t.k} className={`ladder__col${i === 2 ? ' is-top' : ''}`}>
            <div className="ladder__well">
              <div className="ladder__bar" style={{ height: `${t.pct}%` }}>
                <span className="num">{t.pct}%</span>
              </div>
            </div>
            <span className="cap">hold {t.k}</span>
            <b className={i ? 'green' : ''}>{t.v}</b>
            <span className="num ladder__p">{t.price}</span>
          </div>
        ))}
      </div>
      <figcaption>llama-3.3-70b at the seed provider, per million tokens in · out. Your router reads your ${TICKER} balance and the supply from chain and pays the lower price; the provider checks the same two numbers.</figcaption>
    </figure>
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
      <defs>
        <linearGradient id="loop-sol" gradientUnits="userSpaceOnUse" x1="72" y1="72" x2="408" y2="408">
          <stop offset="0" stopColor="#9945ff" />
          <stop offset="0.52" stopColor="#4f7bff" />
          <stop offset="1" stopColor="#12c98a" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={R} className="loop__orbit" transform={`rotate(-90 ${C} ${C})`} />
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
      <circle cx={C} cy={C - R} r="5" className="loop__run" />
      {stations.map((s) => {
        const [x, y] = at(s.deg);
        const top = s.deg === -90;
        const anchor = 'middle';
        const dx = 0;
        return (
          <g key={s.k} data-deg={s.deg} className="loop__st">
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="7" className="loop__node" />
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="2.4" className="loop__nodec" />
            <text x={(x + dx).toFixed(2)} y={(top ? y - 34 : y + 30).toFixed(2)} textAnchor={anchor} className="loop__k">{s.k}</text>
            <text x={(x + dx).toFixed(2)} y={(top ? y - 16 : y + 48).toFixed(2)} textAnchor={anchor} className="loop__v">{s.v}</text>
            {s.g && <text x={(x + dx).toFixed(2)} y={(y + 66).toFixed(2)} textAnchor={anchor} className="loop__paidt">{s.g}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default async function Home() {
  const [chain, live] = await Promise.all([programStatus(), mainnet()]);
  const liveStats: { k: string; v: string; green?: boolean }[] = [
    { k: 'providers listed', v: live.checked ? String(live.providers) : '—' },
    { k: 'channels opened', v: live.checked ? String(live.channels) : '—' },
    { k: 'settled on mainnet', v: live.checked ? `$${usd(BigInt(live.settledUnits))}` : '—', green: true },
    { k: 'to the program', v: '$0', green: true },
    { k: 'build', v: live.verified ? 'verified' : live.programHash ? 'deployed' : '—', green: !!live.verified },
  ];
  const passed = rehearsal.checks.filter((c) => c.ok).length;
  const cheap = rehearsal.trips.find((t) => t.route === 'price' && !t.fellThrough)!;
  const cheapP = rehearsal.providers.find((p) => p.name === cheap.provider)!;
  const cheapIn = cheapP.models.find((m) => m.id === cheap.model)?.input ?? 0;
  const sealed = rehearsal.trips.find((t) => t.route === 'privacy' && !t.fellThrough)!;
  const iron = rehearsal.providers.find((p) => p.name === 'Ironbridge Compute')!;
  const ironAnswers = rehearsal.trips.filter((t) => t.provider === iron.name).length;
  const settled = BigInt(rehearsal.settledUnits);
  const stats: { k: string; v: string; green?: boolean; count?: { to: number; fmt?: string; of?: number } }[] = [
    { k: 'requests', v: String(rehearsal.requests), count: { to: rehearsal.requests } },
    { k: 'providers', v: String(rehearsal.providers.length), count: { to: rehearsal.providers.length } },
    { k: 'settled on chain', v: `$${usd(settled)}`, green: true, count: { to: Number(settled), fmt: 'usd6' } },
    { k: 'to the program', v: '$0' },
    { k: 'checks passed', v: `${passed}/${rehearsal.checks.length}`, count: { to: passed, of: rehearsal.checks.length } },
    { k: 'on mainnet', v: chain.checked ? (chain.deployed ? 'live' : 'not yet') : 'unchecked' },
  ];
  return (
    <>
      <NavGround />
      <ScrollFX />
      <header className="nav">
        <Link href="/" className="nav__brand" aria-label={`${NAME} home`}>
          <Mark id="nav" />
          <span className="grad">{NAME}</span>
        </Link>
        <nav className="nav__links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#pay">Payments</a>
          <a href="#provide">Providers</a>
          <a href="#token">${TICKER}</a>
          <Link href="/try">Try it</Link>
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
        <Wire />
        <section className="hero">
          <Orrery />
          <div className="hero__head" data-orrery-clear>
            <h1>
              <span className="lead">AI inference,</span> peer to peer. <span className="lead">Zero cut in between.</span>
            </h1>
            <p className="hero__lede">Your computer sends each request straight to someone else&apos;s machine and pays it directly on Solana. No server in the middle, and the program takes nothing.</p>
            <div className="cta cta--center hero__try">
              <Link href="/try" className="pill">Try it in the browser</Link>
              <Link href="/docs#install" className="ghost">Install the router <Arrow /></Link>
            </div>
          </div>
          <div className="hero__foot" data-orrery-clear>
            <RequestLine />
          </div>
        </section>

        <section className="facts" aria-label="At a glance" data-rule>
          <div>
            <span className="cap">Router</span>
            <p>On your computer, OpenAI-compatible</p>
          </div>
          <div>
            <span className="cap">Payment</span>
            <p>One signature per answer, on Solana</p>
          </div>
          <div>
            <span className="cap">Program fee</span>
            <p className="green num">0%</p>
          </div>
          <div>
            <span className="cap">Providers</span>
            <p>Anyone. No approval, no delisting</p>
          </div>
        </section>

        <div className="body">
          <section className="split" id="how" data-wire-k={`Route ${ROUTE_WORD[cheap.route]}`} data-wire-v={`${cheap.provider} · ${perM(cheapIn)}/M in`}>
            <div className="split__text">
              <h2><span className="lead">Routing.</span> One word decides the trip.</h2>
              <p className="sub">Point anything that takes a base URL at the router: Cursor, Aider, Continue, Open WebUI, the OpenAI SDK. Then add one word after the model name.</p>
              <dl className="words">
                <div><dt className="num">:cheap</dt><dd>lowest price for the model</dd></div>
                <div><dt className="num">:fast</dt><dd>quickest first token this router has seen</dd></div>
                <div><dt className="num">:trusted</dt><dd>most USDC settled on chain, bonded ${TICKER}</dd></div>
                <div><dt className="num">:private</dt><dd>verified enclaves only, the request sealed</dd></div>
              </dl>
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

          <section className="stage" id="pay" data-wire-k="Signed" data-wire-v={`${ironAnswers} running totals, one per answer`}>
            <div className="stage__head">
              <h2><span className="lead">Payments.</span> Sign once, pay per answer.</h2>
              <p className="sub">Your wallet opens a channel with a provider. After every answer the router on your computer signs the new running total, and the provider cashes the latest one on Solana whenever it likes.</p>
            </div>
            <ChannelCard />
            <ol className="steps4" data-rule>
              <li><span className="num">01</span><b>Open</b><p>One wallet signature puts two dollars in a channel.</p></li>
              <li><span className="num">02</span><b>Answer</b><p>A signed total after each. A provider is never owed more than one answer.</p></li>
              <li><span className="num">03</span><b>Redeem</b><p>Many channels in one transaction, for a fraction of a cent.</p></li>
              <li><span className="num">04</span><b>Close</b><p>What is left comes straight back. A lost key spends at most that, under your daily cap.</p></li>
            </ol>
          </section>
        </div>

        <section className="film" data-wire-k="First token" data-wire-v={`${cheap.ttftMs} ms · ${cheapP.region}`}>
          <FilmReel
            reels={[
              ['Kestrel GPU Co-op', 'kestrel'],
              ['Ironbridge Compute', 'ironbridge'],
              ['Vault Nine', 'vault-nine'],
            ].map(([name, slug]) => {
              const p = rehearsal.providers.find((x) => x.name === name)!;
              return { name, src: `/media/${slug}.mp4`, poster: `/media/${slug}.jpg`, region: p.region, from: perM(Math.min(...p.models.map((m) => m.input))) };
            })}
          />
          <div className="film__shade" />
          <div className="film__text">
            <h2><span className="lead">Providers.</span> Every one is someone&apos;s own machine.</h2>
            <p>A GPU running vLLM or Ollama, a llama.cpp box, API capacity you already pay for. List it with one command. No application, no stake required, and nothing in the program can delist you.</p>
            <a href="#provide" className="pill">Run a provider</a>
          </div>
        </section>

        <div className="body">
          <section className="split" id="provide" data-wire-k="Redeemed" data-wire-v={`$${usd(BigInt(iron.cumulative ?? '0'))} to ${iron.name}`} data-wire-money="1">
            <div className="split__text">
              <h2><span className="lead">Light a node.</span> Set your price.</h2>
              <p className="sub">Put a provider node in front of any OpenAI-compatible server. It checks each voucher before it answers and redeems the totals to your wallet.</p>
              <div className="term">
                <div className="term__bar">
                  <span className="label">On the machine that serves the model</span>
                  <CopyButton text={PROVIDE_CMDS} />
                </div>
                <pre className="num">
                  <span className="term__p">$</span> orrery provider register \{'\n'}
                  {'    '}--config provider.json --wallet wallet.json{'\n'}
                  <span className="term__p">$</span> orrery provider start --config provider.json
                </pre>
              </div>
              <p className="aside">Registering puts your endpoint and the hash of your price list on chain. Your wallet stays cold; the node runs on its own key and can never touch what you have earned.</p>
            </div>
            <div className="split__card">
              <ProviderCard />
            </div>
          </section>

          <section className="zero" id="zero" data-wire-k="Taken in between" data-wire-v="$0">
            <h2 className="zero__head">
              <span>The program in the middle takes</span>
              <span className="zero__num grad num">0%</span>
            </h2>
            <p className="zero__sub" data-words>It has no fee field and no third account to send one to. Every unit a provider redeems lands in the provider&apos;s account. Every unit it doesn&apos;t comes back to you.</p>
            <div className="zero__cards">
              <Ledger />
              <CutCalc />
            </div>
          </section>

          <section className="band" id="private" data-wire-k="Sealed" data-wire-v={`${sealed.model}${ROUTE_WORD.privacy} → ${sealed.provider}`}>
            <div className="band__head">
              <h2><span className="lead">Privacy.</span> Sealed when you ask for it.</h2>
              <p className="sub">Add <code>:private</code> and the router only picks providers running inside a hardware enclave. It checks the enclave&apos;s live report against the claim the provider posted on chain, then encrypts your prompt to a key that never leaves it. The operator hosts the machine and still can&apos;t read the request.</p>
            </div>
            <SealFlow />
          </section>

          <section className="token" id="token" data-wire-k={`Hold $${TICKER}`} data-wire-v="up to 35% off every answer">
            <h2><span className="lead">${TICKER}.</span> Hold it, and every answer costs less.</h2>
            <p className="sub">{CA ? 'Live on Meteora.' : 'Launching on Meteora.'} Providers can publish holder prices: hold 0.1% of the supply and the seed provider charges you 20% less, hold 1% and it&apos;s 35% less. Providers also bond it behind their listing, which routers count toward reputation.</p>
            <HolderLadder />
            <TokenLoop />
            <dl className="token__dl" data-rule>
              <div><dt>Holder price</dt><dd>Up to 35% off, checked on chain by both sides</dd></div>
              <div><dt>Bond</dt><dd>Posted on chain behind a provider&apos;s listing</dd></div>
              <div><dt>Reputation</dt><dd>Bonded {TICKER} is 10% of the <code>:trusted</code> score</dd></div>
              <div><dt>Contract</dt><dd className="num">{CA ? short(CA, 6, 6) : 'not launched yet'}</dd></div>
            </dl>
            {CA && (
              <div className="installbar token__ca">
                <code className="num">
                  <span>CA</span> {CA}
                </code>
                <CopyButton text={CA} />
              </div>
            )}
            <div className="cta cta--center">
              {BUY_URL ? (
                <a href={BUY_URL} className="pill" rel="noopener noreferrer" target="_blank">Buy ${TICKER}</a>
              ) : (
                <span className="pill is-off">${TICKER} at launch</span>
              )}
              <Link href="/docs#token" className="ghost">Token in the docs <Arrow /></Link>
            </div>
          </section>

          <section className="ledgerline ledgerline--live" aria-label="Live on mainnet">
            <p className="cap ledgerline__live"><i aria-hidden="true" /> Live on Solana mainnet{live.checked ? '' : ', once the site has an RPC'}</p>
            <dl>
              {liveStats.map((s) => (
                <div key={s.k}>
                  <dd className={`num${s.green ? ' green' : ''}`}>{s.v}</dd>
                  <dt>{s.k}</dt>
                </div>
              ))}
            </dl>
            <p className="ledgerline__note">
              Read from the program&apos;s account every five minutes.{live.programHash ? <> The deployed bytes hash to <span className="num">{live.programHash.slice(0, 8)}…{live.programHash.slice(-4)}</span>, the same as a reproducible build of the repo.</> : null} <Link href="/try">Ask it something</Link>.
            </p>
          </section>

          <section className="ledgerline" aria-label="Rehearsal numbers" data-wire-k="Settled on chain" data-wire-v={`$${usd(settled)} over ${rehearsal.requests} requests`} data-wire-money="1" data-wire-at="30">
            <dl>
              {stats.map((s) => (
                <div key={s.k}>
                  <dd className={`num${s.green ? ' green' : ''}`} data-count={s.count?.to} data-fmt={s.count?.fmt} data-of={s.count?.of}>
                    {s.v}
                  </dd>
                  <dt>{s.k}</dt>
                </div>
              ))}
            </dl>
            <p className="ledgerline__note">
              The program, a router and three provider nodes on a Solana test validator, {ranAtLabel}. Mainnet is read from the chain{chain.checked ? '' : ' once the site has an RPC'}.
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
          <Orrery variant="close" />
          <div className="close__text">
            <h2>
              Point your AI at <span className="grad">the network.</span>
            </h2>
            <div className="installbar">
              <code className="num">
                <span>$</span> npm i -g {NPM_PACKAGE}
              </code>
              <CopyButton text={`npm i -g ${NPM_PACKAGE}`} />
            </div>
            <div className="cta cta--center">
              <Link href="/docs#install" className="pill">Install the router</Link>
              <Link href="/docs" className="ghost">Read the docs <Arrow /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <span className="foot__brand">
          <Mark id="foot" /> <span className="grad">{NAME}</span>
          {WORKING_TITLE && <em>working title</em>}
        </span>
        <nav aria-label="Elsewhere">
          <Link href="/docs">Docs</Link>
          <a href={NPM_URL} rel="noopener noreferrer" target="_blank">npm</a>
          {REPO_URL ? <a href={REPO_URL}>GitHub</a> : <span className="foot__off">GitHub at launch</span>}
          {X_URL ? <a href={X_URL} rel="noopener noreferrer" target="_blank">X</a> : <span className="foot__off">X soon</span>}
        </nav>
        <span className="foot__note">Settles on Solana. Numbers on this page come from the local rehearsal of {ranAtLabel}.</span>
      </footer>
    </>
  );
}
