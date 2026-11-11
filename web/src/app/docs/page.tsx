import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Mark } from '@/components/Mark';
import Elsewhere from '@/components/Elsewhere';
import DocsToc from '@/components/DocsToc';
import P2PDiagram from '@/components/P2PDiagram';
import { CopyButton } from '@/components/parts';
import { CA, NAME, PROGRAM_ID, REPO_URL, ROUTER_URL, TICKER } from '@/brand';
import './docs.css';

export const metadata: Metadata = {
  title: `Docs — ${NAME}`,
  description: `Install the ${NAME} router from npm, point any OpenAI-compatible tool at it, and pay providers directly on Solana. Or run a provider node and set your own prices.`,
};

const PKG = 'orrery-node';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const INSTALL = `node --version          # v22 or newer
npm install -g ${PKG}
orrery help`;

const NPX = `npx -y ${PKG} router --wallet ~/.config/solana/id.json`;

const WALLET = `solana-keygen new -o ~/.config/solana/orrery.json   # or use a wallet file you already have
solana address -k ~/.config/solana/orrery.json      # send USDC and a little SOL here`;

const RUN = `orrery router \\
  --wallet ~/.config/solana/orrery.json \\
  --rpc https://your-rpc.example.com \\
  --daily-cap 5`;

const CODEX = `# writes ~/.codex/orrery.config.toml and leaves your config.toml alone
npx -y orrery-node connect codex --write
codex --profile orrery`;

const CLAUDE = `orrery router --wallet ~/.config/solana/id.json --alias 'claude-*=gpt-oss-120b'

ANTHROPIC_BASE_URL=http://127.0.0.1:7171 ANTHROPIC_API_KEY=orrery claude`;

const MCP = `claude mcp add orrery -- npx -y orrery-node mcp`;

const MORE = `# a backup model: the next one answers when nothing of the first can
curl localhost:7171/v1/chat/completions -d '{"model": "deepseek-v3|qwen3-32b", "messages": [...]}'

orrery spend --since 24h --by model     # what your router paid, from its own log
orrery bench gpt-oss-120b --n 3         # every provider of a model, through your router (paid)`;

const EMBED = `curl localhost:7171/v1/embeddings -d '{"model": "bge-m3", "input": ["first text", "second text"]}'`;

const LIMITS = `orrery router --wallet agent.json --max-price 0.50/1.50 --daily-cap 5
orrery doctor --wallet agent.json`;

const ANTH_PY = `from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:7171", api_key="unused")
msg = client.messages.create(
    model="llama-3.3-70b",
    max_tokens=300,
    messages=[{"role": "user", "content": "Explain a payment channel in two sentences."}],
)
print(msg.content[0].text)`;

const RUN_OUT = `Orrery router on http://127.0.0.1:7171/v1  ·  3 providers  ·  route auto  ·  wallet 7xKXtg…
session key 9WzDXw…AWWM signs vouchers; console at http://127.0.0.1:7171/`;

const PY = `from openai import OpenAI

client = OpenAI(base_url="${ROUTER_URL}", api_key="unused")
reply = client.chat.completions.create(
    model="llama-3.3-70b:cheap",
    messages=[{"role": "user", "content": "Hello from the network"}],
)
print(reply.choices[0].message.content)`;

const JS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${ROUTER_URL}', apiKey: 'unused' });
const stream = await client.chat.completions.create({
  model: 'deepseek-v3:fast',
  stream: true,
  messages: [{ role: 'user', content: 'Explain payment channels in two lines' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');`;

const CURL = `curl ${ROUTER_URL}/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"gpt-oss-120b:cheap","messages":[{"role":"user","content":"hi"}]}' -i`;

const CURL_HEAD = `x-orrery-provider: 5Tq7…   (the provider's on-chain listing)
x-orrery-route: price
x-orrery-cost: 0.000009     (USDC, signed into your channel)`;

const MODELS = `$ orrery models
llama-3.3-70b                              2 providers  from $0.12/M in · $0.30/M out
deepseek-v3                                1 providers  from $0.27/M in · $1.10/M out
gpt-oss-120b                               1 providers  from $0.030/M in · $0.11/M out`;

const CHANNELS = `$ orrery channels
5HURjz…  provider CakCxW…  deposit $2.00  you signed $0.000136  redeemed $0.000136  open

$ orrery close 5HURjz… --wallet ~/.config/solana/orrery.json
closing 5HURjz…; the provider has 3600s to redeem, then run: orrery close 5HURjz… --wallet … --finish

$ orrery close 5HURjz… --wallet ~/.config/solana/orrery.json --finish
closed 5HURjz…; $1.999864 and the account rent are back in your wallet`;

const PROVIDER_JSON = `{
  "name": "My GPU",
  "region": "eu-west",
  "listen": 7272,
  "publicUrl": "https://gpu.example.org",
  "rpcUrl": "https://your-rpc.example.com",
  "settleMint": "${USDC}",
  "wallet": "~/.config/solana/provider-wallet.json",
  "upstream": { "baseUrl": "http://127.0.0.1:8000/v1" },
  "models": [
    { "id": "llama-3.3-70b", "upstreamModel": "meta-llama/Llama-3.3-70B-Instruct",
      "context": 131072, "maxOutput": 8192,
      "price": { "input": 120000, "output": 300000 } }
  ],
  "redeem": { "everySecs": 300, "minUnits": 50000 }
}`;

const UPSTREAMS = `vLLM        "baseUrl": "http://127.0.0.1:8000/v1"
SGLang      "baseUrl": "http://127.0.0.1:30000/v1"
Ollama      "baseUrl": "http://127.0.0.1:11434/v1"
llama.cpp   "baseUrl": "http://127.0.0.1:8080/v1"
OpenRouter  "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY"`;

const PROVIDE = `orrery provider register --config provider.json --wallet ~/.config/solana/provider-wallet.json
orrery provider show     --config provider.json      # what the chain now says, including your node key
orrery provider start    --config provider.json`;

const SYSTEMD = `[Unit]
Description=Orrery provider node
After=network-online.target

[Service]
ExecStart=/usr/bin/env orrery provider start --config /etc/orrery/provider.json
Environment=OPENROUTER_API_KEY=...
Restart=always
User=orrery

[Install]
WantedBy=multi-user.target`;

const TOC = [
  ['quickstart', 'Quickstart'],
  ['install', 'Install'],
  ['wallet', 'Fund a wallet'],
  ['router', 'Run the router'],
  ['tools', 'Connect your tools'],
  ['agents', 'Coding agents'],
  ['routes', 'Models and routes'],
  ['pay', 'How you pay'],
  ['channels', 'Your channels'],
  ['provide', 'Run a provider'],
  ['provider-config', 'provider.json'],
  ['private', 'The private route'],
  ['token', `$${TICKER}`],
  ['holders', 'Holder pricing'],
  ['program', 'The program'],
  ['security', 'What can go wrong'],
  ['trouble', 'Troubleshooting'],
  ['status', 'Status'],
] as const;

function Code({ children, lang, copy }: { children: string; lang: string; copy?: boolean }) {
  return (
    <div className="d-code">
      <div className="d-code__bar">
        <span className="cap">{lang}</span>
        {copy && <CopyButton text={children} />}
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function H2({ id, n, children }: { id: string; n: number; children: ReactNode }) {
  return (
    <h2 id={id}>
      <span className="d-n num">{String(n).padStart(2, '0')}</span>
      {children}
    </h2>
  );
}

const n = (id: string) => TOC.findIndex(([x]) => x === id) + 1;

const PARTS = [
  { k: 'Router', at: 'install', v: 'Runs on your computer at 127.0.0.1:7171. Picks a provider for every request and signs what you owe.' },
  { k: 'Provider node', at: 'provide', v: 'Runs in front of any OpenAI-compatible server. Checks each signature, answers, cashes the totals.' },
  { k: 'Program', at: 'program', v: 'Holds the channels on Solana. No fee field, no third account, nobody can delist a provider.' },
] as const;

export default function Docs() {
  return (
    <div className="docs">
      <header className="d-nav">
        <Link href="/" className="nav__brand">
          <Mark id="docs" />
          <span className="grad">{NAME}</span>
        </Link>
        <span className="d-nav__here">Docs</span>
        <nav className="d-nav__links" aria-label="Docs sections">
          <a href="#install">Router</a>
          <a href="#provide">Providers</a>
          <a href="#program">Program</a>
        </nav>
        <Link href="/" className="d-nav__back">Back to the network</Link>
        <Elsewhere />
        <a href="#install" className="pill d-nav__cta">Install</a>
      </header>
      <div className="d-grid">
        <DocsToc items={TOC} />
        <article className="d-body">
          <span className="cap">Docs · Overview</span>
          <h1>
            <span className="lead">{NAME} docs.</span> Run a router, or run a node.
          </h1>
          <p className="d-lead">
            {NAME} is a peer-to-peer AI inference network. A router on your computer sends each request straight to a provider&apos;s machine and pays it through a Solana payment channel. Nothing sits in between, and the program takes no fee.
          </p>
          <P2PDiagram />
          <div className="d-parts">
            {PARTS.map((p) => (
              <a key={p.k} href={`#${p.at}`} className="d-part">
                <span className="cap">{p.k}</span>
                <span className="d-part__v">{p.v}</span>
              </a>
            ))}
          </div>

          <H2 id="quickstart" n={n('quickstart')}>Quickstart</H2>
          <ol className="d-steps">
            <li><b>Install</b> the router from npm: <code>npm install -g {PKG}</code> (Node 22 or newer).</li>
            <li><b>Fund</b> a Solana wallet with a few USDC and a little SOL.</li>
            <li><b>Run</b> <code>orrery router --wallet &lt;keypair.json&gt; --rpc &lt;your RPC&gt;</code>.</li>
            <li><b>Point</b> any OpenAI-compatible tool at <code>{ROUTER_URL}</code> with any API key, and add <code>:cheap</code>, <code>:fast</code>, <code>:trusted</code> or <code>:private</code> to the model name when you care.</li>
          </ol>
          <p>That is the whole setup. There is no account, no sign-up and no API key to buy: your wallet is the account, and each answer is paid to the machine that served it.</p>

          <H2 id="install" n={n('install')}>Install</H2>
          <p>The router and the provider node are one npm package, <code>{PKG}</code>, which installs a single command, <code>orrery</code>. It needs Node.js 22 or newer and runs on macOS, Linux and Windows (WSL).</p>
          <Code lang="bash" copy>{INSTALL}</Code>
          <p>Or run it once without installing:</p>
          <Code lang="bash" copy>{NPX}</Code>
          <p>Everything the router keeps lives in <code>~/.orrery</code> (set <code>ORRERY_HOME</code> to move it): the session key that signs your running totals and the list of your open channels. Updating is <code>npm install -g {PKG}@latest</code>; uninstalling is <code>npm uninstall -g {PKG}</code> after you close your channels.</p>

          <H2 id="wallet" n={n('wallet')}>Fund a wallet</H2>
          <p>The router pays from an ordinary Solana wallet file (the JSON keypair the Solana CLI writes). Use a dedicated wallet with only what you plan to spend.</p>
          <Code lang="bash" copy>{WALLET}</Code>
          <table className="d-table">
            <thead>
              <tr><th>Needs</th><th>How much</th><th>Why</th></tr>
            </thead>
            <tbody>
              <tr><td>USDC</td><td>$2 per provider you use</td><td>each new channel locks a deposit (<code>--deposit</code>, default 2). What you do not spend comes back when the channel closes.</td></tr>
              <tr><td>SOL</td><td>about 0.05</td><td>transaction fees, and the rent for each channel&apos;s accounts, which is returned when the channel closes</td></tr>
              <tr><td>RPC</td><td>one URL</td><td>the router reads the provider list with a filtered <code>getProgramAccounts</code> call; most paid RPCs allow it, the public endpoint is rate limited</td></tr>
            </tbody>
          </table>
          <p className="d-note">Settlement is in mainnet USDC (<code>{USDC.slice(0, 4)}…{USDC.slice(-4)}</code>). Only this wallet signs to open, top up or close a channel; every answer in between is signed by a session key on your computer.</p>

          <H2 id="router" n={n('router')}>Run the router</H2>
          <Code lang="bash" copy>{RUN}</Code>
          <Code lang="output">{RUN_OUT}</Code>
          <p>The router listens on <code>127.0.0.1</code> only, so nothing outside your computer can reach it. Its console at <code>http://127.0.0.1:7171/</code> shows every request, the provider that answered, the tokens and what it cost, plus your providers and channels.</p>
          <table className="d-table">
            <thead>
              <tr><th>Flag</th><th>Default</th><th>What it does</th></tr>
            </thead>
            <tbody>
              <tr><td><code>--wallet</code></td><td>none</td><td>wallet file that opens and tops up channels. Without it the router is read-only. Env <code>ORRERY_WALLET</code>.</td></tr>
              <tr><td><code>--rpc</code></td><td>public mainnet</td><td>Solana RPC URL. Env <code>ORRERY_RPC_URL</code>.</td></tr>
              <tr><td><code>--route</code></td><td><code>auto</code></td><td>default route: <code>auto</code>, <code>price</code>, <code>speed</code>, <code>reputation</code>, <code>privacy</code></td></tr>
              <tr><td><code>--deposit</code></td><td>2</td><td>USDC locked when a channel opens</td></tr>
              <tr><td><code>--top-up-below</code></td><td>0.25</td><td>add to a channel when what is left falls under this</td></tr>
              <tr><td><code>--daily-cap</code></td><td>5</td><td>stop spending for the day after this many USDC</td></tr>
              <tr><td><code>--min-reputation</code></td><td>0.2</td><td>the auto route ignores providers below this score (0 to 1)</td></tr>
              <tr><td><code>--max-price</code></td><td>none</td><td>never route above this price, dollars per million tokens in/out, e.g. <code>0.50/1.50</code>, after holder discounts. Per request: header <code>x-orrery-max-price</code>. Env <code>ORRERY_MAX_PRICE</code>.</td></tr>
              <tr><td><code>--alias</code></td><td>none</td><td>answer other model names with a network model, e.g. <code>'claude-*=gpt-oss-120b'</code>. Env <code>ORRERY_ALIASES</code>.</td></tr>
              <tr><td><code>--port</code></td><td>7171</td><td>local port</td></tr>
              <tr><td><code>--refresh</code></td><td>60</td><td>seconds between re-reading the provider list from the chain</td></tr>
              <tr><td><code>--enclave-images</code></td><td>none</td><td>comma-separated enclave measurements you trust for <code>:private</code></td></tr>
            </tbody>
          </table>

          <H2 id="tools" n={n('tools')}>Connect your tools</H2>
          <p>The router speaks the OpenAI Chat Completions API (<code>/v1/chat/completions</code>, streaming or not, and <code>/v1/models</code>). Anything that lets you set a base URL works unchanged. The API key can be any string.</p>
          <table className="d-table">
            <thead>
              <tr><th>Tool</th><th>Where to set it</th></tr>
            </thead>
            <tbody>
              <tr><td>Cursor</td><td>Settings → Models → OpenAI API key: any string, Override OpenAI Base URL: <code>{ROUTER_URL}</code>, then add a model such as <code>llama-3.3-70b:cheap</code></td></tr>
              <tr><td>Continue</td><td>a model with <code>provider: openai</code>, <code>apiBase: {ROUTER_URL}</code>, <code>model: deepseek-v3</code></td></tr>
              <tr><td>Aider</td><td><code>OPENAI_API_BASE={ROUTER_URL} aider --model openai/llama-3.3-70b:cheap</code></td></tr>
              <tr><td>Open WebUI</td><td>Admin → Connections → OpenAI API: URL <code>{ROUTER_URL}</code>, any key</td></tr>
              <tr><td>LangChain</td><td><code>ChatOpenAI(base_url=&quot;{ROUTER_URL}&quot;, api_key=&quot;unused&quot;, model=&quot;qwen3-235b&quot;)</code></td></tr>
            </tbody>
          </table>
          <Code lang="python" copy>{PY}</Code>
          <Code lang="typescript" copy>{JS}</Code>
          <Code lang="curl" copy>{CURL}</Code>
          <p>Every answer carries three headers so you can see who served it and what you paid:</p>
          <Code lang="response headers">{CURL_HEAD}</Code>
          <p>Since <code>orrery-node</code> 0.1.3 the router also serves the Anthropic Messages API: <code>POST /v1/messages</code>, streamed or not, with tool use, plus <code>/v1/messages/count_tokens</code>. Point an Anthropic client at <code>http://127.0.0.1:7171</code> (the SDK adds <code>/v1/messages</code> itself) and ask for a network model by name. Tool calls become function calls on the way to the provider and come back as <code>tool_use</code> blocks; payment is the same per-answer voucher.</p>
          <Code lang="python" copy>{ANTH_PY}</Code>

          <H2 id="agents" n={n('agents')}>Coding agents</H2>
          <p>Codex speaks the OpenAI Responses API and Claude Code the Anthropic Messages API, and the router serves both from <code>orrery-node</code> 0.1.4. Both were run through the router in our rehearsal, each answer signed for and redeemed. <code>orrery connect codex|claude|openai|anthropic|mcp</code> prints what each client needs.</p>
          <p>Codex: one command writes a profile next to your Codex config, with the model&apos;s context window read from your router.</p>
          <Code lang="bash" copy>{CODEX}</Code>
          <p>Claude Code asks for Claude model names, so give the router an alias and point Claude Code at it. The router has no API key; any value works.</p>
          <Code lang="bash" copy>{CLAUDE}</Code>
          <p>Any MCP client can hand work to the network through <code>orrery mcp</code>, which offers <code>ask</code>, <code>models</code> and <code>status</code> in front of your running router.</p>
          <Code lang="bash" copy>{MCP}</Code>
          <p>Agents resend their context every turn. When a provider lists a cached-input price, those tokens bill at it, and the router keeps the next turns on the provider that holds the cache for five minutes. Parallel requests are fine: each provider gets one lane and a busy one hands the request to the next free provider.</p>
          <p>For an agent you leave running, set a price ceiling and a daily cap, and check the setup first. <code>orrery doctor</code> only reads.</p>
          <Code lang="bash" copy>{LIMITS}</Code>
          <p>From 0.1.5 a request can name fallbacks, as <code>&quot;a|b&quot;</code> or an OpenRouter-style <code>models</code> array, and the router moves to the next model when nothing of the first can answer. Every answer the router pays for is logged on your machine, so <code>orrery spend</code> can sum it, and <code>orrery bench</code> compares the providers of a model from where you sit. <code>doctor</code>, <code>bench</code> and <code>spend</code> take <code>--json</code>.</p>
          <Code lang="bash" copy>{MORE}</Code>
          <p>Embeddings go through the same router at <code>/v1/embeddings</code>, paid from the same channel and priced on input tokens, wherever a provider lists an embedding model. The MCP server has an <code>embed</code> tool for agents, and its <code>ask</code> takes a <code>max_price</code>.</p>
          <Code lang="bash" copy>{EMBED}</Code>

          <H2 id="routes" n={n('routes')}>Models and routes</H2>
          <p>Model names are the ones providers list. <code>orrery models</code> prints every model on the network with its cheapest price and how many providers serve it; <code>orrery providers</code> prints every listing with what the chain says about it and whether its model server answers.</p>
          <Code lang="bash">{MODELS}</Code>
          <p>Add one word after the model name, or send the header <code>x-orrery-route</code>:</p>
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
          <p>The router tries the top three providers in order, so a slow or failing one is skipped without your tool noticing. Pin one provider with the header <code>x-orrery-provider: &lt;first characters of its address&gt;</code>.</p>

          <H2 id="pay" n={n('pay')}>How you pay</H2>
          <p>The first request to a provider opens a payment channel: your wallet moves a deposit into an account only the channel controls. From then on the session key on your computer signs a running total after every answer, an 88-byte voucher: <code>orrery/voucher/1</code>, the channel, the total, and a hash chain over every answer&apos;s usage.</p>
          <ul>
            <li>The router prices every answer itself from the provider&apos;s published price list and pays the smaller of its number and the provider&apos;s.</li>
            <li>A provider serves the next request only once the previous one is paid, so it is never owed more than one answer, and you never pay for an answer you did not get.</li>
            <li>The provider redeems the highest total whenever it likes. The program pays the difference to the provider&apos;s own token account and nowhere else.</li>
            <li>When what is left in a channel falls under <code>--top-up-below</code>, the router asks your wallet to add another deposit. <code>--daily-cap</code> stops all spending for the day.</li>
          </ul>

          <H2 id="channels" n={n('channels')}>Your channels</H2>
          <p>Closing takes two steps so a provider cannot be cheated out of its last answer: you start the close, the provider gets a grace period (one hour) to redeem what you signed, then everything left comes back to you. A provider can also release a channel at any time, which returns the rest at once.</p>
          <Code lang="bash">{CHANNELS}</Code>

          <H2 id="provide" n={n('provide')}>Run a provider</H2>
          <p>Put a provider node in front of any OpenAI-compatible server: vLLM, SGLang, Ollama, llama.cpp, or API capacity you hold. Routers anywhere can then pay you per answer. There is no application, no stake to post and nobody who can delist you.</p>
          <ol className="d-steps">
            <li><b>Serve a model</b> locally with an OpenAI-compatible server, or have an API key.</li>
            <li><b>Make it reachable</b> at a public HTTPS URL (a reverse proxy, a tunnel, or a host with a public IP). Routers call <code>/v1/manifest</code>, <code>/v1/chat/completions</code> and <code>/orrery/voucher</code> on it.</li>
            <li><b>Write</b> <code>provider.json</code> with your prices (next section).</li>
            <li><b>Register</b> with your wallet, then <b>start</b> the node.</li>
          </ol>
          <Code lang="bash" copy>{PROVIDE}</Code>
          <p>Registering lists you on chain with your endpoint and the sha-256 of your price list; routers ignore a price list that does not match it. Your wallet stays cold: the node runs on its own key (created at <code>~/.orrery/provider/node.json</code>), which can redeem and post enclave claims but never touches what you have earned. Send the node key about 0.01 SOL for redemption fees. Redemptions go straight to your wallet&apos;s USDC account. To change prices or the URL, edit the file and run <code>register</code> again; it updates the listing.</p>
          <Code lang="upstreams">{UPSTREAMS}</Code>
          <p>Keep it running with any process manager. A systemd unit:</p>
          <Code lang="/etc/systemd/system/orrery-provider.service" copy>{SYSTEMD}</Code>
          <p className="d-note">Only standard chat fields (messages, sampling settings, tools, response format) reach your upstream. Fields that would let a caller spend your key on something your price list does not cover, such as fallback model lists, plugins or provider routing, are dropped, and so is <code>n</code>.</p>

          <H2 id="provider-config" n={n('provider-config')}>provider.json</H2>
          <Code lang="provider.json" copy>{PROVIDER_JSON}</Code>
          <table className="d-table">
            <thead>
              <tr><th>Field</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>name</code>, <code>region</code></td><td>shown to routers and in <code>orrery providers</code></td></tr>
              <tr><td><code>listen</code>, <code>host</code></td><td>local port (default 7272, or <code>PORT</code>) and bind address (default 0.0.0.0)</td></tr>
              <tr><td><code>publicUrl</code></td><td>the HTTPS address routers use, up to 120 characters, written on chain</td></tr>
              <tr><td><code>rpcUrl</code>, <code>settleMint</code></td><td>Solana RPC and the settlement mint (mainnet USDC)</td></tr>
              <tr><td><code>wallet</code> or <code>authority</code></td><td>the wallet that owns the listing and receives redemptions (a file, or just its address)</td></tr>
              <tr><td><code>nodeKey</code> or <code>nodeKeyEnv</code></td><td>the node&apos;s own key: a file path, or an environment variable holding the JSON key</td></tr>
              <tr><td><code>dataDir</code></td><td>where the node keeps vouchers until it redeems them; keep it on a disk that survives restarts</td></tr>
              <tr><td><code>upstream.baseUrl</code></td><td>your OpenAI-compatible server</td></tr>
              <tr><td><code>upstream.apiKey</code> / <code>apiKeyEnv</code></td><td>the upstream key, inline or (better) from an environment variable</td></tr>
              <tr><td><code>upstream.headers</code>, <code>upstream.body</code></td><td>extra headers, and fixed fields you add to every upstream call yourself</td></tr>
              <tr><td><code>models[].id</code></td><td>the name routers ask for</td></tr>
              <tr><td><code>models[].upstreamModel</code></td><td>the name your upstream knows it by, if different</td></tr>
              <tr><td><code>models[].price</code></td><td>USDC base units per million tokens: <code>120000</code> is $0.12</td></tr>
              <tr><td><code>models[].maxOutput</code>, <code>context</code></td><td>caps per request; the router reserves at most <code>maxOutput</code> tokens of payment</td></tr>
              <tr><td><code>redeem.everySecs</code>, <code>minUnits</code></td><td>how often to cash vouchers, and the smallest amount worth a transaction</td></tr>
              <tr><td><code>holder.tiers</code></td><td>optional holder prices: <code>share</code> of the network token&apos;s supply and <code>off</code> the list price, both in basis points</td></tr>
            </tbody>
          </table>

          <H2 id="private" n={n('private')}>The private route</H2>
          <p>A provider running inside a hardware enclave (Intel TDX, AMD SEV-SNP, or TDX with NVIDIA confidential computing) posts a claim on chain: the enclave type, the measured image, the hash of its attestation report, and the key prompts are encrypted to. Claims expire within 30 days.</p>
          <p>Before sealing anything, the router fetches the report and checks that it hashes to the on-chain claim, names the same key, has not expired, and booted an image on your allow list (<code>--enclave-images</code>). Checking the hardware vendor&apos;s signature needs an external verifier; without one the router does not treat an enclave as verified. Development reports are labeled and refused unless you pass <code>--allow-dev-enclaves</code>.</p>

          <H2 id="token" n={n('token')}>${TICKER}</H2>
          <p>The token is live on Meteora{CA ? <>, contract <code>{CA}</code></> : null}. Holding it lowers your price at every provider that publishes holder prices (next section). In the program it has one role: providers can bond it behind their listing, and routers count the bond as 10% of reputation. A bond is never slashed; unbonding returns it after seven days, only to the provider that posted it.</p>

          <H2 id="holders" n={n('holders')}>Holder pricing</H2>
          <p>A provider can publish holder prices next to its list prices: hold a share of ${TICKER}&apos;s supply and that provider charges you less. The token is the mint the program&apos;s admin sets once as its bond mint, so a tier means the same at every provider. {CA ? 'That mint is set, so holder prices are on.' : 'Holder prices switch on once the token exists and that mint is set.'}</p>
          <table className="d-table">
            <thead>
              <tr><th>You hold</th><th>At the seed provider</th></tr>
            </thead>
            <tbody>
              <tr><td>less than 0.1% of supply</td><td>the list price</td></tr>
              <tr><td>0.1% or more</td><td>20% less</td></tr>
              <tr><td>1% or more</td><td>35% less</td></tr>
            </tbody>
          </table>
          <ul>
            <li>Your router reads your wallet&apos;s ${TICKER} balance (its associated token account) and the token&apos;s supply from chain, ranks providers by the price you will actually pay, and signs at that price.</li>
            <li>The provider reads the same two numbers for the wallet that opened the channel and charges the same. Both use one integer formula: <code>floor(price × (10000 − off) / 10000)</code>.</li>
            <li>The tiers sit inside the provider&apos;s price list, whose sha-256 is on chain. A provider that lists holder prices and does not apply them still gets paid its own number, and your router counts the miss against its success rate.</li>
            <li>The settlement program does not change and still takes 0%. A holder price is a discount the provider gives.</li>
          </ul>
          <Code lang="provider.json" copy>{`"holder": { "tiers": [{ "share": 10, "off": 2000 }, { "share": 100, "off": 3500 }] }`}</Code>
          <p><code>share</code> is basis points of supply (10 = 0.1%), <code>off</code> is basis points of the list price (2000 = 20%). Up to four tiers, each larger than the one before. <code>orrery providers</code> shows each provider&apos;s tiers, and the router prints your share of supply when it starts.</p>

          <H2 id="program" n={n('program')}>The program</H2>
          <p>Program <code>{PROGRAM_ID}</code> on Solana.</p>
          <ul>
            <li>Anyone can list a provider. Nobody, including the admin, can delist one.</li>
            <li>Money in a channel goes only to its provider, with your signed voucher, or back to you.</li>
            <li>There is no fee field and no third recipient.</li>
            <li>The admin can tune the close grace period (10 minutes to 7 days), the unbonding delay (1 hour to 30 days) and the minimum deposit, and set the bond mint once.</li>
          </ul>

          <H2 id="security" n={n('security')}>What can go wrong</H2>
          <table className="d-table">
            <thead>
              <tr><th>If</th><th>The most you lose</th></tr>
            </thead>
            <tbody>
              <tr><td>a provider stops answering</td><td>nothing: the router moves to the next provider, and it signs only after an answer has arrived</td></tr>
              <tr><td>a provider overstates its token counts</td><td>at most what the router reserved for that one answer (the listed price for <code>maxOutput</code> tokens); it pays the smaller of its own calculation and the provider&apos;s, never more than the reservation</td></tr>
              <tr><td>your session key leaks</td><td>what is left in your open channels, which only their providers can redeem; close them</td></tr>
              <tr><td>your router misbehaves</td><td>at most <code>--daily-cap</code> per day</td></tr>
              <tr><td>a provider&apos;s node key leaks</td><td>nothing of the provider&apos;s: redemptions only ever go to the listing wallet</td></tr>
            </tbody>
          </table>

          <H2 id="trouble" n={n('trouble')}>Troubleshooting</H2>
          <table className="d-table">
            <thead>
              <tr><th>You see</th><th>Do this</th></tr>
            </thead>
            <tbody>
              <tr><td><code>No models listed yet.</code> or 0 providers</td><td>your RPC refuses <code>getProgramAccounts</code>; pass an RPC that allows it with <code>--rpc</code></td></tr>
              <tr><td><code>no wallet configured</code></td><td>start the router with <code>--wallet &lt;keypair.json&gt;</code></td></tr>
              <tr><td><code>no provider on the network serves …</code></td><td>check the name with <code>orrery models</code></td></tr>
              <tr><td><code>daily spending cap reached</code></td><td>raise <code>--daily-cap</code> or wait for tomorrow (UTC)</td></tr>
              <tr><td><code>all providers failed</code></td><td>see <code>orrery providers</code>; try another route or model</td></tr>
              <tr><td>a channel will not open</td><td>the wallet needs USDC for the deposit and a little SOL for fees</td></tr>
              <tr><td><code>SyntaxError</code> or <code>Unsupported engine</code></td><td>upgrade to Node.js 22 or newer</td></tr>
              <tr><td>port 7171 in use</td><td><code>--port 7172</code> and use that base URL</td></tr>
            </tbody>
          </table>

          <H2 id="status" n={n('status')}>Status</H2>
          <ul>
            <li>Built and tested: the program (13 tests), the router and provider node (93 tests), and a full local rehearsal of the program, four providers (one with holder prices, one switched off mid-run) and a router: every API including embeddings, fallbacks, resumed streams, cached prices and cache affinity, price ceilings, 400 answers 16 at a time, logs that add up to what was signed, DNS-rebinding refusal, and Codex CLI and Claude Code through the router (52 of 52 checks).</li>
            <li>Package: <code>{PKG}</code> on npm. Source: {REPO_URL ? <a href={REPO_URL}>{REPO_URL.replace('https://', '')}</a> : 'at launch'} (MIT).</li>
            <li>On mainnet: the program is deployed and initialized, and its bytes hash to the same value as a reproducible build of the repo (<code>solana-verify get-program-hash</code>). The first provider, Orrery Seed, is listed and has settled its first answers on chain.</li>
            <li>New in 0.1.9: a built-in verifier for Intel TDX (<code>orrery enclave verify --quote</code>, <code>tee.mode: tdx</code>), enclave verdicts in <code>orrery doctor</code>, task budgets for agents (<code>x-orrery-task</code>, <code>x-orrery-task-budget</code>), <code>orrery provider check</code>, and burn pledges that buy on mainnet through Jupiter (<code>orrery provider burn</code>).</li>
            <li>New in 0.1.8: a built-in verifier for AMD SEV-SNP enclaves (your router checks the chip&apos;s report against AMD&apos;s roots itself; <code>orrery enclave verify</code>), private nodes on SEV-SNP (<code>tee.mode: snp</code>), burn pledges that routers verify on chain with a <code>:burn</code> route and <code>x-orrery-burn</code> on answers, and each node&apos;s model server in the console, <code>/orrery/status</code>, MCP and <code>orrery providers</code>.</li>
            <li>New in 0.1.7: <code>orrery quote</code> prices a request at every provider before anything is sent (also an MCP <code>quote</code> tool and <code>GET /orrery/quote</code>), a dollar budget per request with <code>x-orrery-max-cost</code> or <code>--max-cost</code>, <code>orrery provider compare</code> ranks your price list against every other listing, <code>orrery channels --wallet</code> and <code>doctor</code> read your channels from the chain, and nodes report their model server on <code>/health</code> so routers skip one that is down.</li>
            <li>New in 0.1.6: answers carry the billed usage in OpenAI&apos;s shape with <code>usage.cost</code> in USDC (streams end with it when you set <code>stream_options.include_usage</code>), <code>orrery bench</code> measures embedding models too, and a router that loses its records picks its open channels back up from the node&apos;s last voucher.</li>
            <li>New in 0.1.5: embeddings, model fallbacks, <code>orrery bench</code>, <code>orrery spend</code> and <code>orrery provider earnings</code>, MCP prices with <code>max_price</code> and an <code>embed</code> tool, last-24-hours tables in both consoles, a Host check against DNS rebinding, and <code>--json</code> output.</li>
            <li>New in 0.1.4: the OpenAI Responses API, MCP, model aliases, resumed streams, <code>orrery connect</code> for Codex and Claude Code, cached-input prices and cache affinity, parallel lanes, <code>--max-price</code>, router and provider consoles, <code>orrery doctor</code> and <code>orrery provider init</code>.</li>
            <li>Not yet: revocation lists and firmware status in the built-in verifiers, and NVIDIA GPU attestation.</li>
          </ul>
        </article>
      </div>
    </div>
  );
}
