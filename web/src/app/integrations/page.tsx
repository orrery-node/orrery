import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import IntegrationPicker from '@/components/IntegrationPicker';
import { CopyButton } from '@/components/parts';
import { NAME } from '@/brand';
import { INTEGRATIONS, ROUTER_CMD } from '@/data/integrations';
import '../docs/docs.css';
import './integrations.css';

export const metadata: Metadata = {
  title: `Integrations — ${NAME}`,
  description: `Point Codex, Claude Code, Cursor, Continue, Aider, Open WebUI, LangChain, the OpenAI SDKs or any MCP client at the ${NAME} router on your computer.`,
};

export default function Integrations() {
  return (
    <div className="docs igp">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="integrations" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Integrations</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/try">Try it</Link>
          <Link href="/prices">Prices</Link>
          <Link href="/changelog">Changelog</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <Link href="/docs#install" className="pill d-nav__cta">Install</Link>
      </header>
      <main className="igp__main">
        <h1>
          <span className="lead">Plug it in.</span> {INTEGRATIONS.length} tools, one address on your own computer.
        </h1>
        <p className="d-lead">
          The router speaks the OpenAI, Anthropic and Responses APIs on 127.0.0.1:7171, so the tools you already use only need a new base URL. No account and no API key: your wallet pays each provider per answer.
        </p>
        <div className="igp__start">
          <span className="igp__n num">1</span>
          <span>Start the router</span>
          <div className="installbar">
            <code className="num"><span>$</span> {ROUTER_CMD}</code>
            <CopyButton text={ROUTER_CMD} />
          </div>
        </div>
        <div className="igp__start igp__start--two">
          <span className="igp__n num">2</span>
          <span>Pick your tool</span>
        </div>
        <IntegrationPicker />
      </main>
    </div>
  );
}
