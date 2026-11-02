import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import { CopyButton } from '@/components/parts';
import { NAME, PROGRAM_ID, REPO_URL, ROUTER_URL, TICKER } from '@/brand';
import './docs.css';

export const metadata: Metadata = { title: `Docs — ${NAME}` };

const INSTALL = `${REPO_URL ? `git clone ${REPO_URL}.git` : '# the public repository opens at launch'}
cd orrery/node && pnpm install
pnpm orrery router --wallet ~/.config/solana/id.json --rpc <your RPC URL>`;

const PY = `from openai import OpenAI

client = OpenAI(base_url="${ROUTER_URL}", api_key="unused")
reply = client.chat.completions.create(
    model="llama-3.3-70b:cheap",
    messages=[{"role": "user", "content": "Hello from the network"}],
)`;

const CURL = `curl ${ROUTER_URL}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"qwen3-32b:private","messages":[{"role":"user","content":"hi"}]}'`;

const PROVIDER_JSON = `{
  "name": "My GPU",
  "region": "eu-west",
  "listen": 7272,
  "publicUrl": "https://gpu.example.org",
  "rpcUrl": "<your RPC URL>",
  "settleMint": "EPjFWJd5Wm8eUi4wSPdf8qJxQAXnmSeKEr5mVGYLm3CY",
  "wallet": "~/.orrery/provider/wallet.json",
  "upstream": { "baseUrl": "http://127.0.0.1:8000/v1" },
  "models": [
    { "id": "llama-3.3-70b", "upstreamModel": "meta-llama/Llama-3.3-70B-Instruct",
      "context": 131072, "maxOutput": 8192,
      "price": { "input": 120000, "output": 300000 } }
  ],
  "redeem": { "everySecs": 300, "minUnits": 50000 }
}`;

const TOC = [
  ['install', 'Install the router'],
  ['tools', 'Point your tools at it'],
  ['routes', 'Routes'],
  ['pay', 'How you pay'],
  ['provide', 'Run a provider'],
  ['private', 'The private route'],
  ['token', `$${TICKER}`],
  ['program', 'What the program can and cannot do'],
  ['status', 'Status'],
] as const;

function Code({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="d-code">
      <pre>{children}</pre>
      {copy && <CopyButton text={children} />}
    </div>
  );
}

export default function Docs() {
  return (
    <div className="docs">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark />
          <span>{NAME}</span>
        </Link>
        <span className="d-nav__here">Docs</span>
        <Link href="/" className="d-nav__back">Back to the network</Link>
      </header>
      <div className="d-grid">
        <nav className="d-toc" aria-label="On this page">
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
        </nav>
        <article className="d-body">
          <h1>{NAME} docs</h1>
          <p className="d-lead">
            {NAME} has three parts: a router you run on your own computer, provider nodes anyone can run, and a Solana program that holds payment channels between them. The program takes no fee.
          </p>

          <h2 id="install">Install the router</h2>
          <p>You need Node 22, a Solana wallet file with some USDC and a little SOL for fees, and an RPC URL that allows <code>getProgramAccounts</code> (most paid RPCs do; the public endpoint often does not).</p>
          <Code copy>{INSTALL}</Code>
          <p>The router listens on <code>{ROUTER_URL}</code>, only on this computer. Its console at <code>http://127.0.0.1:7171/</code> shows each request, the provider it went to and what it cost.</p>
          <p className="d-note">The program is not on mainnet yet. Until it is, run the whole network on a local validator: <code>pnpm e2e</code> starts the program, three providers and a router, and checks every payment.</p>

          <h2 id="tools">Point your tools at it</h2>
          <p>Anything that speaks the OpenAI API and lets you set a base URL works unchanged: Cursor, Aider, Continue, Open WebUI, LangChain, the OpenAI SDKs. The API key can be any string; the router pays with your channels, not a key.</p>
          <Code>{PY}</Code>
          <Code>{CURL}</Code>
          <p className="d-note">The Anthropic Messages API (<code>/v1/messages</code>) is not served yet. Tools that only speak it cannot use the router today.</p>

          <h2 id="routes">Routes</h2>
          <p>Add one word after the model name, or send the header <code>x-yard-route</code>. The router tries the top three providers in order, so a slow or failing one is skipped.</p>
          <table className="d-table">
            <thead>
              <tr><th>Suffix</th><th>Route</th><th>Picks</th></tr>
            </thead>
            <tbody>
              <tr><td><code>(none)</code></td><td>auto</td><td>a blend of expected cost, first-token time and reputation, among providers above your reputation floor</td></tr>
              <tr><td><code>:cheap</code></td><td>price</td><td>lowest expected cost for this request</td></tr>
              <tr><td><code>:fast</code></td><td>speed</td><td>fastest first token this router has measured</td></tr>
              <tr><td><code>:trusted</code></td><td>reputation</td><td>highest reputation: USDC settled on chain, number of redemptions, age, bonded ${TICKER}, and this router&apos;s own success rate</td></tr>
              <tr><td><code>:private</code></td><td>privacy</td><td>only providers whose enclave this router verified; the request is sealed</td></tr>
            </tbody>
          </table>
          <p>Pin one provider with the header <code>x-yard-provider: &lt;first characters of its address&gt;</code>.</p>

          <h2 id="pay">How you pay</h2>
          <p>The first request to a provider opens a payment channel: your wallet moves a deposit (two USDC by default, <code>--deposit</code>) into an account only the channel controls. From then on a session key on your computer signs a running total after every answer, an 88-byte voucher: <code>switchyard/vch/1</code>, the channel, the total, and a hash chain over every answer&apos;s usage.</p>
          <ul>
            <li>The provider redeems the highest total whenever it likes. The program pays the difference to the provider&apos;s own token account and nowhere else.</li>
            <li>The router prices every answer itself from the provider&apos;s published price list and pays the smaller of its number and the provider&apos;s.</li>
            <li>A provider serves the next request only once the previous one is paid, so it is never owed more than one answer.</li>
            <li>To leave, request a close. After a one-hour grace period, in which the provider can still redeem, the rest comes back to you. A provider can also release a channel at any time, which returns the rest at once.</li>
            <li><code>--daily-cap</code> (five dollars by default) stops the router spending more in a day.</li>
          </ul>

          <h2 id="provide">Run a provider</h2>
          <p>Put a provider node in front of any OpenAI-compatible server: vLLM, SGLang, Ollama, llama.cpp, or API capacity you hold. Prices are USDC base units per million tokens, so <code>120000</code> is $0.12.</p>
          <Code>{PROVIDER_JSON}</Code>
          <Code copy>{`orrery provider register --config provider.json --wallet wallet.json\norrery provider start --config provider.json`}</Code>
          <p>Registering lists you on chain with your endpoint and the sha-256 of your price list; routers ignore a price list that does not match it. Your wallet stays cold: the node runs on its own key, which can redeem and post enclave claims but never touches what you have earned. Redemptions go straight to your wallet&apos;s USDC account.</p>

          <h2 id="private">The private route</h2>
          <p>A provider running inside a hardware enclave (Intel TDX, AMD SEV-SNP, or TDX with NVIDIA confidential computing) posts a claim on chain: the enclave type, the measured image, the hash of its attestation report, and the key prompts are encrypted to. Claims expire within 30 days.</p>
          <p>Before sealing anything, the router fetches the report and checks that it hashes to the on-chain claim, names the same key, has not expired, and booted an image on your allow list (<code>--enclave-images</code>). Checking the hardware vendor&apos;s signature needs an external verifier; without one the router does not treat an enclave as verified. Development reports are labeled and refused unless you pass <code>--allow-dev-enclaves</code>.</p>

          <h2 id="token">${TICKER}</h2>
          <p>The token launches on Meteora. In the program it has one role: providers can bond it behind their listing, and routers count the bond as 10% of reputation. A bond is never slashed; unbonding returns it after seven days, only to the provider that posted it.</p>

          <h2 id="program">What the program can and cannot do</h2>
          <p>Program <code>{PROGRAM_ID}</code>.</p>
          <ul>
            <li>Anyone can list a provider. Nobody, including the admin, can delist one.</li>
            <li>Money in a channel goes only to its provider, with your signed voucher, or back to you.</li>
            <li>There is no fee field and no third recipient.</li>
            <li>The admin can tune the close grace period (10 minutes to 7 days), the unbonding delay (1 hour to 30 days) and the minimum deposit, and set the bond mint once.</li>
          </ul>

          <h2 id="status">Status</h2>
          <ul>
            <li>Built and tested: the program (13 tests), the router and provider node (12 tests), and a full local rehearsal (14 of 14 checks).</li>
            <li>Not yet: mainnet deployment, the Anthropic Messages API, a built-in hardware attestation verifier.</li>
          </ul>
        </article>
      </div>
    </div>
  );
}
