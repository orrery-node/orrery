import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import { CopyButton } from '@/components/parts';
import { NAME, PROGRAM_ID } from '@/brand';
import { privateState } from '@/lib/private';
import '../docs/docs.css';
import '../prices/prices.css';
import '../burn/burn.css';
import './private.css';

export const revalidate = 300;

export const metadata: Metadata = {
  title: `Private — ${NAME}`,
  description: `Prompts sealed to a hardware enclave, and a router that checks the enclave itself: who can read what on ${NAME}, and the five checks before a prompt leaves your computer.`,
};

const WHO: [string, string, string, 'no' | 'yes' | 'part'][] = [
  ['You', 'Your computer writes the prompt and reads the answer.', 'everything', 'yes'],
  ['The network in between', 'TLS, and inside it a box encrypted to the enclave’s key.', 'ciphertext', 'no'],
  ['The node’s operator', 'Hosts the machine. The key lives inside the enclave, out of the host’s reach.', 'ciphertext', 'no'],
  ['The enclave', 'Decrypts inside CPU-protected memory, runs the model, encrypts the answer back to you.', 'the prompt, in memory only', 'part'],
  [`${NAME}`, 'Runs no server on the path. There is nothing here to send a prompt to.', 'nothing', 'no'],
  ['Solana', 'Deposits, signed totals, and the enclave’s claim: image hash and key.', 'payments, no content', 'no'],
];

const CHECKS: [string, string][] = [
  ['The chip is AMD’s', 'The chip’s certificate chains to AMD’s root for its processor family. The roots are pinned in the code by fingerprint.'],
  ['The chip signed this report', 'An ECDSA P-384 signature over the report, checked with the chip’s key. One changed bit and it fails.'],
  ['The host is locked out', 'The VM’s launch policy has debugging off. With it on, the host could read the VM’s memory, so the router refuses.'],
  ['It runs the image it claims', 'The measurement in the report equals the image hash the node posted on Solana.'],
  ['The key is the enclave’s', 'The report names the exact key your prompt is about to be encrypted to.'],
];

const CMD = 'orrery enclave verify --report report.bin --vcek vcek.der';

export default async function Private() {
  const p = await privateState();
  return (
    <div className="docs pcp brn prv">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="private" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Private</span>
        <nav className="d-nav__links" aria-label="Pages">
          <Link href="/network">Network</Link>
          <Link href="/try">Try it</Link>
          <Link href="/prices">Prices</Link>
          <Link href="/burn">Burn</Link>
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
            {p.checked ? `${p.nodes} ${p.nodes === 1 ? 'node' : 'nodes'} · ${p.claims.length} with an enclave claim · at ${p.at.slice(11, 16)} UTC` : 'the chain could not be read just now'} · program{' '}
            <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noopener noreferrer">{PROGRAM_ID.slice(0, 4)}…{PROGRAM_ID.slice(-4)}</a>
          </span>
        </p>
        <h1>
          <span className="lead">Private, and you can check.</span> Your computer verifies the chip before a prompt leaves it.
        </h1>
        <p className="d-lead">
          Add <code>:private</code> to a model name and your router only uses nodes running inside a hardware enclave. It verifies the enclave itself, against the chip maker’s roots, then encrypts the prompt to a key that never leaves it. No attestation service is asked, and nobody has to be believed.
        </p>

        <p className="brn__stage"><b>Where this stands.</b> The built-in verifier covers AMD SEV-SNP and was run against a real report from an AMD EPYC machine; Intel TDX is next. It is in orrery-node 0.1.8. Nodes with a verified enclave appear below as operators list them.</p>

        <h2 className="brn__h2">Who can read your prompt</h2>
        <div className="brn__wrap">
          <table className="prv__who">
            <thead><tr><th>who</th><th>what they hold</th><th>what they can read</th></tr></thead>
            <tbody>
              {WHO.map(([who, holds, reads, k]) => (
                <tr key={who}><td>{who}</td><td>{holds}</td><td><span className={`prv__tag prv__tag--${k}`}>{reads}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="brn__h2">Five checks, on your machine</h2>
        <ol className="prv__checks">
          {CHECKS.map(([t, d], i) => (
            <li key={t}><span className="num">{i + 1}</span><div><h3>{t}</h3><p>{d}</p></div></li>
          ))}
        </ol>
        <p className="prv__fail">If any check fails, the request stops before the prompt is sent, and the router says which one.</p>

        <h2 className="brn__h2">Check any report yourself</h2>
        <div className="installbar prv__bar">
          <code className="num"><span>$</span> {CMD}</code>
          <CopyButton text={CMD} />
        </div>
        <pre className="prv__out num">{`✗ the VM was launched with debugging allowed,
  so its memory can be read by the host
  chip certificate   chains to AMD’s Milan root (pinned)
  image booted       b07af9620f3b839b47996422ddec6058…
  debugging          allowed by the launch policy
  checked on this computer with AMD’s public roots;
  no attestation service was asked.`}</pre>
        <p className="prv__fail">Real output, on a real report from an AMD EPYC Milan machine (public test data from google/go-sev-guest). Its VM had debugging allowed, and the verifier refused it.</p>

        <h2 className="brn__h2">Nodes claiming an enclave</h2>
        {p.claims.length ? (
          <div className="brn__wrap">
            <table>
              <thead><tr><th>node</th><th>hardware</th><th>image</th></tr></thead>
              <tbody>
                {p.claims.map((c) => (
                  <tr key={c.address}><td><Link href={`/address/${c.address}`}>{c.name}</Link></td><td>{c.kind}</td><td className="num">{c.image.slice(0, 24)}…</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="brn__empty">No node on mainnet has listed an enclave yet. With a SEV-SNP machine it takes one block in provider.json: <code>{'"tee": { "mode": "snp", "report": "report.bin", "vcek": "vcek.der" }'}</code>. The node refuses to start on a report made for another key or on a VM with debugging allowed.</p>}

        <p className="brn__foot">
          The encryption is X25519, HKDF-SHA256 and AES-256-GCM, and answers come back sealed under the same key. An enclave protects against the machine’s operator and host software; it rests on the CPU maker’s hardware and keys. Source: <a href="https://github.com/orrery-node/orrery" target="_blank" rel="noopener noreferrer">node/src/tee/snp.ts and node/src/seal.ts</a>.
        </p>
      </main>
    </div>
  );
}
