// Every orrery-node release in plain words. Times are the npm publish times (registry.npmjs.org/orrery-node).
// CHANGELOG.md at the repo root carries the same text; change both together.

export type Change = { who: 'router' | 'provider' | 'everyone'; text: string };
export type Release = { version: string; at: string; headline: string; changes: Change[] };

export const UNRELEASED: Change[] = [
  { who: 'router', text: 'A job’s name and budget can ride in the API key. Most tools let you set a key and nothing else, so the router now reads `orrery/<task>/<budget>` from the key field (`Authorization: Bearer` or `x-api-key`) the way it reads the `x-orrery-task` headers. Put `orrery/refactor/0.25` where Cursor, Continue, aider or an SDK asks for a key and that job stops at a quarter. `orrery run --budget 0.25 -- <any command>` does it for you and prints the bill when the command exits.' },
  { who: 'router', text: '`orrery run` without `--budget` now gives the job a dollar. In 0.1.12 a run started without one had every request refused, because a job needs a budget from its first request; pass `--budget` there.' },
  { who: 'router', text: 'The AMD SEV-SNP verifier checks the firmware level. AMD derives a different chip key for every firmware level, so the level a report states has to be the one its chip certificate was issued for, and the certificate has to be for that very chip. `orrery enclave verify` prints the level (boot loader, trusted OS, SNP firmware, microcode) as its own line, and `--min-firmware 3.0.8.115` (or `ORRERY_SNP_MIN_FIRMWARE` for a router) refuses anything below a floor you choose. AMD publishes no signed list of current levels, so the floor is yours to set.' },
  { who: 'router', text: 'The Intel TDX verifier checks the chip’s patch level. A quote says which microcode and TDX module the platform runs; Intel publishes a signed list of which versions are current for each platform family. Your router fetches that list from Intel, checks its signature against the same pinned root, and refuses an enclave Intel lists as out of date, revoked or unsupported. `orrery enclave verify` prints it as its own line (`--allow-outdated` to look anyway, `--offline` to skip). On the sample quote we test with, it says what Intel says: older than every level Intel supports.' },
  { who: 'router', text: 'An answer says what your router withheld. When a client attached ids (`user`, `metadata`, `safety_identifier`, a cache key), the response carries `x-orrery-withheld` with their names, never their values, and the router’s log line and record of the answer say the same.' },
  { who: 'router', text: 'The router takes its enclave policy as flags. `orrery router --min-firmware 3.0.8.115` refuses AMD enclaves below a firmware level you choose (the environment variable still works; the flag wins), and `--allow-outdated` lets your router seal to an Intel enclave that Intel lists as out of date, which it refuses by default. A level that does not parse stops the router before it starts. `orrery help` now lists `--enclave-images` as well.' },
  { who: 'router', text: 'A node no longer has to learn your address, and neither does your RPC. `orrery router --proxy http://127.0.0.1:8118` (or `ORRERY_PROXY`) sends every request to a node through an HTTP proxy you choose, so the node sees the proxy’s address and not yours. For an https node the router asks the proxy for a tunnel and speaks TLS to the node inside it; requests are already encrypted to the node’s own key, so the proxy learns which node and how many bytes, and nothing of what was said. There is no fallback: with the proxy down a request fails, it does not go out directly, and a router will not start with a proxy that does not answer. The Solana RPC goes the same way: its calls are tunnelled too, and transactions are confirmed by asking for their status because the RPC’s websocket is never opened. So do the chip makers’ certificate lists. On mainnet, a router started this way held connections to the proxy and to nothing else. SOCKS is not spoken yet, and every request opens a new tunnel, so it is slower than going direct.' },
  { who: 'router', text: 'An answer says where its time went. The router times five stages of every answer: choosing the node, making sure a channel is open, sealing the request, the wait for the node’s first event, and signing the payment. They come back in the standard `Server-Timing` header (`route`, `channel`, `seal`, `node`, `sign`) and show with the answer on `/orrery/status`. On mainnet the four stages on your own machine came to between 2.3 and 3.7 ms across five requests in a row; the first request after a start spent about 400 ms reading its channel once. No transaction is in the request path: the router works from listings it already read, and a node re-reads a channel from chain at most once in 30 seconds (that read is part of `node`). The router’s own once-a-minute read of your $OREY balance used to hold up whichever request came next; it now runs in the background and requests use the last reading.' },
];

export const RELEASES: Release[] = [
  {
    version: '0.1.12',
    at: '2026-11-11T13:03:46Z',
    headline: 'Who is asking stays on your machine, and one command runs Claude Code on the network with a bill at the end.',
    changes: [
      { who: 'everyone', text: 'Who is asking stays on your machine. Clients attach ids to their requests for an API company’s abuse checks: OpenAI’s `user` and `safety_identifier`, a cache key, and Anthropic’s `metadata.user_id`, which Claude Code fills with an account, device and session id. Your router now drops them before a request leaves, and a node no longer passes `user` on to its model server, whichever router sent it. The wallet is the account; a node is paid either way and has no use for a name.' },
      { who: 'router', text: '`orrery run claude` starts Claude Code on your router as one job. It names the network model outright, tags every request with the job and the budget you give it (`--budget 0.25`), and prints the job’s bill when Claude Code exits: answers, tokens, dollars. A key or token already in your environment is not passed on.' },
    ],
  },
  {
    version: '0.1.11',
    at: '2026-11-11T09:19:38Z',
    headline: 'Every request is encrypted to the node itself, and the verifiers read the chip makers’ revocation lists.',
    changes: [
      { who: 'everyone', text: 'Wire sealing. Every node now holds an encryption key of its own, signed by the node key on its listing, and routers encrypt each request to it (the answer comes back the same way). The operator can still read the prompt, which only an enclave prevents, but nothing between the two machines can: not the node’s hosting platform, a load balancer or a firewall in front of it. This also stops such firewalls from refusing requests whose text looks like an attack, which coding agents send all the time. Answers carry `x-orrery-wire: 1`; older nodes and routers keep working in plain JSON.' },
      { who: 'router', text: 'The built-in verifiers read the chip makers’ revocation lists. AMD and Intel publish signed lists of certificates they have withdrawn; your router now fetches them straight from the chip maker, checks each list’s signature against the same pinned roots, and refuses an enclave whose chip or platform certificate is on one. Lists are kept in `~/.orrery/crl` for twelve hours, and `orrery enclave verify` prints the result as its own line (`--offline` skips it).' },
    ],
  },
  {
    version: '0.1.10',
    at: '2026-11-11T07:21:55Z',
    headline: 'Private answers come with a receipt, a router can be locked to private only, and an agent’s bill adds up per job.',
    changes: [
      { who: 'router', text: 'Private only: start the router with `--private-only` and every request is sealed to an enclave it verified, or refused. A route suffix or header cannot turn it off, so a tool pointed at that router cannot send a prompt in the clear.' },
      { who: 'router', text: 'A sealed answer says where it ran. On `:private`, the response carries `x-orrery-enclave` (the hardware), `x-orrery-enclave-image` (the image it booted) and `x-orrery-enclave-verdict` (what your router verified before it encrypted the prompt). The router’s log on disk keeps the same record for every sealed request, and `orrery sealed` reads it back: when, which model, which node, which enclave, which image, what was verified.' },
      { who: 'everyone', text: 'Audit any private node yourself: `orrery enclave verify --node <listing>` reads the node’s enclave claim from Solana, asks the node for the report its CPU signed, and prints every check a router runs, one line each. `--report` and `--quote` print the same check-by-check result, and `--json` gives it to scripts.' },
      { who: 'router', text: 'An agent’s bill per job: the router’s log now carries the task each answer belonged to, so `orrery spend --by task` (and `GET /orrery/spend?by=task`) adds up what every job cost. Task budgets are kept on disk, so a restarted router still knows what a job has spent.' },
      { who: 'provider', text: '`orrery provider price --config provider.json` reprices your node against the open market: for each model it finds the cheapest other listing on chain and goes a margin under it (`--beat 5`), never below your own floor (`--floor 0.03/0.12`) and never upward. It shows the plan first and saves it with `--write`.' },
    ],
  },
  {
    version: '0.1.9',
    at: '2026-11-11T01:17:12Z',
    headline: 'Intel TDX joins AMD in the built-in verifier, agents get a budget per job, and node operators get a readiness check.',
    changes: [
      { who: 'router', text: 'A built-in verifier for Intel TDX, next to the one for AMD SEV-SNP. Your router checks a TDX quote itself: the platform’s certificate chains to Intel’s root (pinned), Intel’s quoting enclave vouches for the key that signed the quote, the quote carries that signature, debugging is off, and the image and encryption key match. `orrery enclave verify --quote` runs it on any quote, and `"tee": { "mode": "tdx", "quote" }` lists a TDX node.' },
      { who: 'router', text: '`orrery doctor` adds a line for every node that claims an enclave: the hardware, whether this computer verified it, and if not, the check that stopped it.' },
      { who: 'router', text: 'When `:private` has nowhere to go, the answer names each node that claims an enclave and the check that stopped it.' },
      { who: 'router', text: 'Task budgets for agents: name a job with `x-orrery-task` and give it a budget once with `x-orrery-task-budget: 0.05` (or `task` and `task_budget` over MCP). Every request under that name draws from it, each answer says what is left, and when it is spent the router refuses the next request before anything is sent. `GET /orrery/tasks` lists them.' },
      { who: 'provider', text: '`orrery provider check --config provider.json` tells you whether your node is ready to earn: the model server answers, routers can reach your address, the listing on chain matches your price list, the node key has SOL for redeem fees, what you have earned and redeemed, and whether a router would accept your enclave.' },
      { who: 'provider', text: 'Burn pledges work on mainnet: a node with `"burn": { "share": … }` in provider.json buys the network token through Jupiter from its own wallet after each redeem and burns it. `orrery provider burn --config provider.json` shows what the pledge owes and whether the market has a route, and sends nothing without `--yes`. A buy that would move the price more than 5% waits for the next redeem.' },
      { who: 'everyone', text: '`orrery providers` shows each node’s burn pledge next to its prices.' },
    ],
  },
  {
    version: '0.1.8',
    at: '2026-11-10T15:20:32Z',
    headline: 'Your computer checks the chip: a built-in enclave verifier, and burns your router verifies itself.',
    changes: [
      { who: 'router', text: 'A built-in hardware verifier for AMD SEV-SNP. On the `:private` route your router now checks an enclave’s report itself: the chip’s key chains to AMD’s root (pinned), the report carries the chip’s signature, the VM was not launched in debug mode, it booted the image claimed on chain, and it names the key your prompt is sealed to. No attestation service is asked. `orrery enclave verify --report --vcek` runs the same check on any report.' },
      { who: 'provider', text: 'Run a private node on AMD SEV-SNP: `"tee": { "mode": "snp", "report", "vcek" }` in provider.json serves the report your CPU signed for the node’s encryption key and the chip’s certificate. The node refuses a report made for another key or a VM with debugging allowed.' },
      { who: 'provider', text: 'Burn on every answer: a node can pledge, in the price list it pins on chain, a share of every USDC it redeems (`burn: { share }`). After redeeming it buys the network token with that share, burns it, and lists every buy-and-burn with its transactions at `GET /orrery/burns`. The settlement program is not involved and still takes nothing.' },
      { who: 'router', text: 'Routers check a node’s burns themselves: each buy and each burn is read from chain, a receipt counts only for what the chain shows, and the pledge is scored against the USDC the node’s account says it redeemed. `GET /orrery/status` shows it per node.' },
      { who: 'router', text: 'A `:burn` route (`model:burn`) sends a request only to nodes whose burns your router has verified, largest pledge first. Their answers carry `x-orrery-burn`, the USDC this answer sends to the burn, and a verified pledge raises a node’s reputation on every route.' },
      { who: 'everyone', text: '`orrery providers` asks every listed node whether its model server answers and prints up with the time it took, or down.' },
      { who: 'router', text: 'The router’s status (`GET /orrery/status`) and its console show each node’s model server: up with the time its `/health` took, or down and skipped.' },
      { who: 'router', text: 'The MCP `status` tool tells an agent the same thing, node by node, so it knows why a model has nowhere to go before it asks.' },
    ],
  },
  {
    version: '0.1.7',
    at: '2026-11-10T04:38:29Z',
    headline: 'Know the price before you ask, cap what each call can cost, and route around a dead model server.',
    changes: [
      { who: 'router', text: '`orrery quote <model>` shows what one request costs at every provider that lists the model, from the prices on chain, with the cached rate where there is one. Nothing is sent or paid.' },
      { who: 'router', text: 'Agents get the same quote over MCP (a `quote` tool) and from the router at `GET /orrery/quote`, so they can price a job before they spend on it.' },
      { who: 'router', text: 'A dollar budget per request: send `x-orrery-max-cost: 0.001` (or `max_cost` from MCP), or start the router with `--max-cost` to give every request one, and only providers whose worst case fits are used; if none fits, the router says what the cheapest could cost.' },
      { who: 'provider', text: 'A node’s `/health` now says whether its model server answers (`upstream: up` or `down`, checked at most every 15 seconds), `orrery doctor` flags a node that is up while its model server is down, and routers ask every 30 seconds and skip such a node before sending or paying anything.' },
      { who: 'provider', text: '`orrery provider compare` puts your price list next to every other listing of the same models and says where each would stand: cheapest of N and by how much, how many are cheaper, or that nobody else lists it. `provider init` shows the same table for the prices it drafts.' },
      { who: 'router', text: '`orrery channels --wallet` lists every channel your wallet has on chain, including ones your router has no record of, and says which it will pick back up and which to close.' },
      { who: 'router', text: '`orrery doctor --wallet` now lists the wallet’s channels on chain: how many are open, what is still on deposit, and how many this computer’s router will pick back up.' },
    ],
  },
  {
    version: '0.1.6',
    at: '2026-11-09T07:39:36Z',
    headline: 'A router that loses its records picks its channels back up.',
    changes: [
      { who: 'router', text: 'Lose `~/.orrery/router/channels.json` (new machine, wiped folder, restarted server) and keep the session key: on first contact the router finds its open channel on chain, checks the node’s last voucher carries its own signature, and carries on. No new deposit, no hour of waiting.' },
      { who: 'router', text: 'Every answer’s `usage` now has `cost` in USDC, the field OpenRouter calls `usage.cost`. Streams end with it when you ask with `stream_options.include_usage`, and have no usage chunk otherwise.' },
      { who: 'router', text: '`orrery bench` measures embedding models too, through `/v1/embeddings`.' },
      { who: 'provider', text: 'Nodes answer `GET /orrery/channel?address=` with the last voucher they hold, which is what lets routers recover.' },
    ],
  },
  {
    version: '0.1.5',
    at: '2026-11-09T01:10:34Z',
    headline: 'Embeddings, backup models, and your bill from your own disk.',
    changes: [
      { who: 'everyone', text: '`/v1/embeddings`: routed, paid from the same channel as chat and priced on input tokens. `provider init` spots embedding models on your server and lists them that way.' },
      { who: 'router', text: 'Backup models: send `"a|b"` or an OpenRouter-style `models` array, and the next model answers when nothing of the first one can.' },
      { who: 'router', text: '`orrery spend` adds up what your router paid, by model or provider, from its own log. `orrery bench` compares every provider of a model from where you sit.' },
      { who: 'router', text: 'The MCP server shows agents the lowest listed price per model and refuses to pay past a `max_price`. A new `embed` tool.' },
      { who: 'provider', text: '`orrery provider earnings` adds up what your node billed; the node console has a last-24-hours table.' },
      { who: 'everyone', text: 'The router and the node console only answer requests addressed to this computer (a Host check against DNS rebinding). `--json` on doctor, bench and spend.' },
    ],
  },
  {
    version: '0.1.4',
    at: '2026-11-08T01:08:36Z',
    headline: 'Built for coding agents.',
    changes: [
      { who: 'router', text: 'Codex (OpenAI Responses API) and Claude Code (Anthropic Messages API) through your own router. `orrery connect codex --write` sets Codex up; `orrery connect claude` prints the two variables Claude Code needs.' },
      { who: 'router', text: 'An MCP server (`orrery mcp`) so any agent can ask the network, see models and check its spend.' },
      { who: 'router', text: 'Prompts an agent resends every turn pay the provider’s cached-input price, and the router keeps those turns on the machine that holds the cache.' },
      { who: 'router', text: 'Requests run in parallel, one lane per provider; a busy provider hands the next request to a free one. Limits for agents left running: `--max-price`, `--daily-cap`, and the deposit itself.' },
      { who: 'router', text: 'Model aliases (`claude-*=llama-3.3-70b`), streams that resume on another provider when one drops, a local console, and `orrery doctor` to check a setup against mainnet.' },
      { who: 'provider', text: '`orrery provider init` finds Ollama, vLLM, llama.cpp, LM Studio or SGLang on your machine and writes a price list, cached-input prices included. Nodes get a console of their own.' },
    ],
  },
  {
    version: '0.1.3',
    at: '2026-11-07T01:25:32Z',
    headline: 'Anthropic’s API, and steadier payments on mainnet.',
    changes: [
      { who: 'router', text: '`/v1/messages` in Anthropic’s shape, tool use included, next to the OpenAI endpoints.' },
      { who: 'everyone', text: 'Channel transactions retry through the RPC’s brief failures instead of giving up.' },
      { who: 'provider', text: 'Redeems pack as many channels as fit in one Solana transaction and skip channels that have closed, so a node gets paid in one go.' },
    ],
  },
  {
    version: '0.1.2',
    at: '2026-11-06T08:39:06Z',
    headline: 'Live on Solana mainnet, with holder prices.',
    changes: [
      { who: 'everyone', text: 'Settles in mainnet USDC against the program deployed and verified on chain.' },
      { who: 'everyone', text: 'Holder prices: providers publish discounts by share of the network token’s supply, and routers rank and pay at the price your wallet qualifies for.' },
    ],
  },
  {
    version: '0.1.1',
    at: '2026-11-06T06:42:13Z',
    headline: 'A proper npm page.',
    changes: [{ who: 'everyone', text: 'Quick start, routes, payments, a provider guide and every command, on the package page.' }],
  },
  {
    version: '0.1.0',
    at: '2026-11-06T05:46:08Z',
    headline: 'The first release: a router on your computer, providers on chain, payment per answer.',
    changes: [
      { who: 'router', text: 'An OpenAI-compatible router on 127.0.0.1 that picks a provider listed on Solana by price, speed, reputation or privacy (`:cheap`, `:fast`, `:trusted`, `:private`), and falls through to the next one if it fails.' },
      { who: 'router', text: 'Payment channels: one deposit, then a signed running total after every answer. The program takes 0%.' },
      { who: 'provider', text: 'A provider node in front of any OpenAI-compatible model server, with prompts sealed to an enclave when it runs in one.' },
    ],
  },
];
