# Changelog

Every orrery-node release in plain words, newest first. Times are when the release went up on npm. The same notes, easier on the eyes: [orrerynode.com/changelog](https://orrerynode.com/changelog).

Get the newest: `npx -y orrery-node@latest doctor`. `orrery doctor` also tells you when a newer release is out.

## 0.1.8 · 2026-11-10 15:20 UTC

**Your computer checks the chip: a built-in enclave verifier, and burns your router verifies itself.**

- **Router** · A built-in hardware verifier for AMD SEV-SNP. On the `:private` route your router now checks an enclave’s report itself: the chip’s key chains to AMD’s root (pinned), the report carries the chip’s signature, the VM was not launched in debug mode, it booted the image claimed on chain, and it names the key your prompt is sealed to. No attestation service is asked. `orrery enclave verify --report --vcek` runs the same check on any report.
- **Node** · Run a private node on AMD SEV-SNP: `"tee": { "mode": "snp", "report", "vcek" }` in provider.json serves the report your CPU signed for the node’s encryption key and the chip’s certificate. The node refuses a report made for another key or a VM with debugging allowed.
- **Node** · Burn on every answer: a node can pledge, in the price list it pins on chain, a share of every USDC it redeems (`burn: { share }`). After redeeming it buys the network token with that share, burns it, and lists every buy-and-burn with its transactions at `GET /orrery/burns`. The settlement program is not involved and still takes nothing.
- **Router** · Routers check a node’s burns themselves: each buy and each burn is read from chain, a receipt counts only for what the chain shows, and the pledge is scored against the USDC the node’s account says it redeemed. `GET /orrery/status` shows it per node.
- **Router** · A `:burn` route (`model:burn`) sends a request only to nodes whose burns your router has verified, largest pledge first. Their answers carry `x-orrery-burn`, the USDC this answer sends to the burn, and a verified pledge raises a node’s reputation on every route.
- **Everyone** · `orrery providers` asks every listed node whether its model server answers and prints up with the time it took, or down.
- **Router** · The router’s status (`GET /orrery/status`) and its console show each node’s model server: up with the time its `/health` took, or down and skipped.
- **Router** · The MCP `status` tool tells an agent the same thing, node by node, so it knows why a model has nowhere to go before it asks.

`npx -y orrery-node@0.1.8`

## 0.1.7 · 2026-11-10 04:38 UTC

**Know the price before you ask, cap what each call can cost, and route around a dead model server.**

- **Router** · `orrery quote <model>` shows what one request costs at every provider that lists the model, from the prices on chain, with the cached rate where there is one. Nothing is sent or paid.
- **Router** · Agents get the same quote over MCP (a `quote` tool) and from the router at `GET /orrery/quote`, so they can price a job before they spend on it.
- **Router** · A dollar budget per request: send `x-orrery-max-cost: 0.001` (or `max_cost` from MCP), or start the router with `--max-cost` to give every request one, and only providers whose worst case fits are used; if none fits, the router says what the cheapest could cost.
- **Node** · A node’s `/health` now says whether its model server answers (`upstream: up` or `down`, checked at most every 15 seconds), `orrery doctor` flags a node that is up while its model server is down, and routers ask every 30 seconds and skip such a node before sending or paying anything.
- **Node** · `orrery provider compare` puts your price list next to every other listing of the same models and says where each would stand: cheapest of N and by how much, how many are cheaper, or that nobody else lists it. `provider init` shows the same table for the prices it drafts.
- **Router** · `orrery channels --wallet` lists every channel your wallet has on chain, including ones your router has no record of, and says which it will pick back up and which to close.
- **Router** · `orrery doctor --wallet` now lists the wallet’s channels on chain: how many are open, what is still on deposit, and how many this computer’s router will pick back up.

`npx -y orrery-node@0.1.7`

## 0.1.6 · 2026-11-09 07:39 UTC

**A router that loses its records picks its channels back up.**

- **Router** · Lose `~/.orrery/router/channels.json` (new machine, wiped folder, restarted server) and keep the session key: on first contact the router finds its open channel on chain, checks the node’s last voucher carries its own signature, and carries on. No new deposit, no hour of waiting.
- **Router** · Every answer’s `usage` now has `cost` in USDC, the field OpenRouter calls `usage.cost`. Streams end with it when you ask with `stream_options.include_usage`, and have no usage chunk otherwise.
- **Router** · `orrery bench` measures embedding models too, through `/v1/embeddings`.
- **Node** · Nodes answer `GET /orrery/channel?address=` with the last voucher they hold, which is what lets routers recover.

`npx -y orrery-node@0.1.6`

## 0.1.5 · 2026-11-09 01:10 UTC

**Embeddings, backup models, and your bill from your own disk.**

- **Everyone** · `/v1/embeddings`: routed, paid from the same channel as chat and priced on input tokens. `provider init` spots embedding models on your server and lists them that way.
- **Router** · Backup models: send `"a|b"` or an OpenRouter-style `models` array, and the next model answers when nothing of the first one can.
- **Router** · `orrery spend` adds up what your router paid, by model or provider, from its own log. `orrery bench` compares every provider of a model from where you sit.
- **Router** · The MCP server shows agents the lowest listed price per model and refuses to pay past a `max_price`. A new `embed` tool.
- **Node** · `orrery provider earnings` adds up what your node billed; the node console has a last-24-hours table.
- **Everyone** · The router and the node console only answer requests addressed to this computer (a Host check against DNS rebinding). `--json` on doctor, bench and spend.

`npx -y orrery-node@0.1.5`

## 0.1.4 · 2026-11-08 01:08 UTC

**Built for coding agents.**

- **Router** · Codex (OpenAI Responses API) and Claude Code (Anthropic Messages API) through your own router. `orrery connect codex --write` sets Codex up; `orrery connect claude` prints the two variables Claude Code needs.
- **Router** · An MCP server (`orrery mcp`) so any agent can ask the network, see models and check its spend.
- **Router** · Prompts an agent resends every turn pay the provider’s cached-input price, and the router keeps those turns on the machine that holds the cache.
- **Router** · Requests run in parallel, one lane per provider; a busy provider hands the next request to a free one. Limits for agents left running: `--max-price`, `--daily-cap`, and the deposit itself.
- **Router** · Model aliases (`claude-*=llama-3.3-70b`), streams that resume on another provider when one drops, a local console, and `orrery doctor` to check a setup against mainnet.
- **Node** · `orrery provider init` finds Ollama, vLLM, llama.cpp, LM Studio or SGLang on your machine and writes a price list, cached-input prices included. Nodes get a console of their own.

`npx -y orrery-node@0.1.4`

## 0.1.3 · 2026-11-07 01:25 UTC

**Anthropic’s API, and steadier payments on mainnet.**

- **Router** · `/v1/messages` in Anthropic’s shape, tool use included, next to the OpenAI endpoints.
- **Everyone** · Channel transactions retry through the RPC’s brief failures instead of giving up.
- **Node** · Redeems pack as many channels as fit in one Solana transaction and skip channels that have closed, so a node gets paid in one go.

`npx -y orrery-node@0.1.3`

## 0.1.2 · 2026-11-06 08:39 UTC

**Live on Solana mainnet, with holder prices.**

- **Everyone** · Settles in mainnet USDC against the program deployed and verified on chain.
- **Everyone** · Holder prices: providers publish discounts by share of the network token’s supply, and routers rank and pay at the price your wallet qualifies for.

`npx -y orrery-node@0.1.2`

## 0.1.1 · 2026-11-06 06:42 UTC

**A proper npm page.**

- **Everyone** · Quick start, routes, payments, a provider guide and every command, on the package page.

`npx -y orrery-node@0.1.1`

## 0.1.0 · 2026-11-06 05:46 UTC

**The first release: a router on your computer, providers on chain, payment per answer.**

- **Router** · An OpenAI-compatible router on 127.0.0.1 that picks a provider listed on Solana by price, speed, reputation or privacy (`:cheap`, `:fast`, `:trusted`, `:private`), and falls through to the next one if it fails.
- **Router** · Payment channels: one deposit, then a signed running total after every answer. The program takes 0%.
- **Node** · A provider node in front of any OpenAI-compatible model server, with prompts sealed to an enclave when it runs in one.

`npx -y orrery-node@0.1.0`
