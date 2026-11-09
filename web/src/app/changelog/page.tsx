import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import ChangelogRail from '@/components/ChangelogRail';
import { CopyButton } from '@/components/parts';
import { NAME } from '@/brand';
import { RELEASES, UNRELEASED, type Change } from '@/data/changelog';
import '../docs/docs.css';
import './changelog.css';

export const metadata: Metadata = {
  title: `Changelog — ${NAME}`,
  description: `Every orrery-node release in plain words: what changed, who it is for, and the one line to upgrade.`,
};

const WHO: Record<Change['who'], string> = { router: 'Router', provider: 'Node', everyone: 'Everyone' };

/** Backticks in the changelog text become code. */
function Text({ s }: { s: string }) {
  return (
    <>
      {s.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const short = (iso: string) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const time = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const gap = (a: string, b: string) => {
  const h = (Date.parse(a) - Date.parse(b)) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`;
};

export default function Changelog() {
  const latest = RELEASES[0];
  const first = RELEASES[RELEASES.length - 1];
  const span = Math.round((Date.parse(latest.at) - Date.parse(first.at)) / 3_600_000);
  const upgrade = `npx -y orrery-node@${latest.version} doctor`;
  return (
    <div className="docs clp">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="changelog" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Changelog</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/network">Network</Link>
          <Link href="/try">Try it</Link>
          <Link href="/prices">Prices</Link>
          <Link href="/integrations">Integrations</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#install" className="pill d-nav__cta">Install</Link>
      </header>

      <main className="clp__main">
        <div className="clp__head">
          <p className="clp__latest">
            <span className="clp__pill num">{latest.version}</span> latest on npm, {day(latest.at)} at {time(latest.at)}
          </p>
          <h1>
            <span className="lead">The changelog.</span> Every release, in plain words.
          </h1>
          <p className="d-lead">
            {RELEASES.length} releases in {span} hours since the first one. What changed, who it is for, and the one line that gets you the newest.
          </p>
          <div className="installbar">
            <code className="num">
              <span>$</span> {upgrade}
            </code>
            <CopyButton text={upgrade} />
          </div>
          <dl className="clp__stats">
            <div><dt>Releases</dt><dd className="num">{RELEASES.length}</dd></div>
            <div><dt>First</dt><dd className="num">{first.version} · {short(first.at)}</dd></div>
            <div><dt>Latest</dt><dd className="num">{latest.version} · {short(latest.at)}</dd></div>
            <div><dt>Hours between them</dt><dd className="num">{span}</dd></div>
          </dl>
        </div>

        {UNRELEASED.length ? (
          <section className="clp__next" aria-label="In main, not yet on npm">
            <p className="clp__nexthead"><span className="clp__dotlive" aria-hidden="true" /> In main, in the next release</p>
            <ul>
              {UNRELEASED.map((c) => (
                <li key={c.text}><span className={`clp__who clp__who--${c.who}`}>{WHO[c.who]}</span><span><Text s={c.text} /></span></li>
              ))}
            </ul>
          </section>
        ) : null}

        <ChangelogRail>
          {RELEASES.map((r, i) => (
            <article key={r.version} className="clp__rel" id={`v${r.version.replace(/\./g, '-')}`}>
              <span className="clp__dot" data-dot aria-hidden="true" />
              <div className="clp__when">
                <a href={`#v${r.version.replace(/\./g, '-')}`} className="clp__ver num">{r.version}</a>
                <span className="clp__date">{day(r.at)} · {time(r.at)}</span>
                {RELEASES[i + 1] ? <span className="clp__gap num">{gap(r.at, RELEASES[i + 1].at)} after {RELEASES[i + 1].version}</span> : <span className="clp__gap">the first one</span>}
              </div>
              <div className="clp__body">
                <h2>{r.headline}</h2>
                <ul>
                  {r.changes.map((c) => (
                    <li key={c.text}>
                      <span className={`clp__who clp__who--${c.who}`}>{WHO[c.who]}</span>
                      <span><Text s={c.text} /></span>
                    </li>
                  ))}
                </ul>
                <p className="clp__get num">
                  <span>$</span> npx -y orrery-node@{r.version}
                </p>
              </div>
            </article>
          ))}
        </ChangelogRail>

        <section className="clp__foot">
          <p>
            The same notes live in <a href="https://github.com/orrery-node/orrery/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">CHANGELOG.md</a>, and every commit behind them is on <a href="https://github.com/orrery-node/orrery/commits/main" target="_blank" rel="noopener noreferrer">GitHub</a>. <code>orrery doctor</code> tells you when a newer release is out.
          </p>
        </section>
      </main>
    </div>
  );
}
