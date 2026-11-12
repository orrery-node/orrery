<p align="center">
  <a href="https://orrerynode.com"><img src="assets/brand/social-preview.png" alt="Orrery — AI inference, peer to peer. Zero cut in between." width="100%"></a>
</p>

<h1 align="center">Orrery</h1>

<h3 align="center">AI inference, peer to peer. Zero cut in between.</h3>

<p align="center">
  Your computer sends each request straight to someone else's machine and pays it directly on Solana.<br>
  No server in the middle. No account. No API key to buy. The program takes nothing.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/orrery-node"><img src="https://img.shields.io/npm/v/orrery-node?style=for-the-badge&color=9945ff&labelColor=0c0c0c&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14f195?style=for-the-badge&labelColor=0c0c0c" alt="MIT license"></a>
  <a href="docs/PROTOCOL.md"><img src="https://img.shields.io/badge/Solana-Anchor-5f8ff2?style=for-the-badge&logo=solana&logoColor=white&labelColor=0c0c0c" alt="Solana program"></a>
  <img src="https://img.shields.io/badge/program%20fee-0%25-14f195?style=for-the-badge&labelColor=0c0c0c" alt="0% program fee">
</p>
<p align="center">
  <img src="https://img.shields.io/badge/OpenAI-compatible-f7f7f7?style=flat-square&logo=openai&logoColor=white&labelColor=0c0c0c" alt="OpenAI-compatible">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white&labelColor=0c0c0c" alt="Node 22+">
  <img src="https://img.shields.io/badge/rust-anchor%201.2-dea584?style=flat-square&logo=rust&logoColor=white&labelColor=0c0c0c" alt="Rust, Anchor 1.2">
  <img src="https://img.shields.io/badge/rehearsal-57%2F57%20checks-14f195?style=flat-square&labelColor=0c0c0c" alt="57 of 57 rehearsal checks">
  <img src="https://img.shields.io/badge/payments-ed25519%20vouchers-9945ff?style=flat-square&labelColor=0c0c0c" alt="ed25519 vouchers">
</p>

<p align="center">
  <a href="https://orrerynode.com"><b>Website</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://orrerynode.com/docs"><b>Docs</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/PROTOCOL.md"><b>Protocol</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://www.npmjs.com/package/orrery-node"><b>npm</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://x.com/OrreryNode"><b>X</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="SECURITY.md"><b>Security</b></a>
</p>

<p align="center">
  <img src="assets/readme/hero.gif" width="840" alt="The orrery assembling from a field of stars: your router at the core, providers on its orbits, other routers in the sky, requests and payments crossing directly between them.">
</p>

<p align="center"><sub>The landing page hero, live at <a href="https://orrerynode.com">orrerynode.com</a>: every point falls into place from the inside out, then requests leave the core as purple light and come back green as payment.</sub></p>

---

## Contents

- [What it is](#what-it-is)
- [Why peer to peer](#why-peer-to-peer)
- [Features](#features)
- [Quick start](#quick-start)
- [Routes](#routes)
- [How payment works](#how-payment-works)
- [The program takes 0%](#the-program-takes-0)
- [Holder pricing](#holder-pricing)
- [Run a provider](#run-a-provider)
- [Architecture](#architecture)
- [Security model](#security-model)
- [CLI](#cli)
- [Router console](#router-console)
- [Build from source](#build-from-source)
- [FAQ](#faq)
- [Roadmap](#roadmap) · [Changelog](CHANGELOG.md)
- [Contributing](#contributing)

---

## What it is

Orrery has three parts, and none of them is a server we run.

| | Runs on | Does |
|---|---|---|
| **Router** | your computer, `127.0.0.1:7171` | serves the OpenAI API to your tools, picks a provider for every request, signs what you owe |
| **Provider node** | anyone's machine | sits in front of any OpenAI-compatible model server, checks each signature, answers, cashes the totals |
| **Program** | Solana | holds the payment channels. No fee field, no third account, nobody can delist a provider |

<p align="center">
  <img src="assets/readme/p2p.png" width="760" alt="Your router talks to each provider's machine directly; the Solana program only holds channel deposits underneath; the place a server would sit is empty.">
</p>

Requests and answers go straight between your router and the provider's machine. The program only holds each channel's deposit: a provider redeems what you signed, and the rest comes back to you.

## Why peer to peer

|  | A hosted AI gateway | **Orrery** |
|---|---|---|
| Where your request goes | through the gateway's servers | **straight from your computer to the provider's machine** |
| What sits in between | a company that takes a cut | **a Solana program with no fee field** |
| How you pay | an account and prepaid credits | **your own wallet, a signed running total per answer** |
| Who can sell inference | whoever the gateway approves | **anyone with a model and a URL; nobody can delist them** |
| What a provider risks | chargebacks, unpaid usage | **at most one answer: the next one is served only once the last is paid** |
| What a user risks | the whole prepaid balance | **what is left in open channels, under a daily cap you set** |
| Private prompts | readable by whoever runs the box | **`:private` seals them to a verified hardware enclave** |
| If the company goes away | your tools stop working | **the program and every node keep running** |

## Features

<table>
  <tr>
    <td width="33%" valign="top">
      <b>OpenAI-compatible router</b><br>
      <sub>Chat Completions, streaming or not, and <code>/v1/models</code> on localhost. Cursor, Continue, Aider, Open WebUI, LangChain and the OpenAI SDKs work unchanged.</sub>
    </td>
    <td width="33%" valign="top">
      <b>Pay per answer</b><br>
      <sub>One wallet signature opens a channel. After that a session key signs an 88-byte running total per answer. No credits, no invoices.</sub>
    </td>
    <td width="33%" valign="top">
      <b>0% in the middle</b><br>
      <sub>The settlement program has no fee field and no third recipient. The rehearsal checks that user + providers + open deposits equal the starting balance.</sub>
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <b>Anyone can provide</b><br>
      <sub>vLLM, SGLang, Ollama, llama.cpp or API capacity you hold. List with one command, set your own prices. No application, no stake.</sub>
    </td>
    <td width="33%" valign="top">
      <b>Routes in one word</b><br>
      <sub>Add <code>:cheap</code>, <code>:fast</code>, <code>:trusted</code> or <code>:private</code> to a model name. The router falls through to the next provider if one fails.</sub>
    </td>
    <td width="33%" valign="top">
      <b>Sealed when you ask</b><br>
      <sub>The private route encrypts the prompt (X25519, HKDF, AES-256-GCM) to a key inside a hardware enclave whose claim the router verified.</sub>
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <b>Hold $OREY, pay less</b><br>
      <sub>Providers can publish holder prices by share of supply. Your router reads your balance from chain and pays the lower price; the provider checks the same numbers.</sub>
    </td>
    <td width="33%" valign="top">
      <b>Reputation from the chain</b><br>
      <sub>USDC settled, redemptions, age and bond, read from each provider's account, plus your own router's success rate. Nothing a provider can just claim.</sub>
    </td>
    <td width="33%" valign="top">
      <b>MIT, all of it</b><br>
      <sub>The program, the router, the provider node, the rehearsal and this site. Read why every request went where it went.</sub>
    </td>
  </tr>
</table>

## Quick start

**1. Install** (Node.js 22 or newer)

```bash
npm install -g orrery-node
orrery help
```

**2. Fund a wallet** with a few USDC (each channel locks a $2 deposit by default; unspent USDC comes back when it closes) and about 0.05 SOL for fees and channel rent.

```bash
solana-keygen new -o ~/.config/solana/orrery.json
solana address -k ~/.config/solana/orrery.json
```

**3. Run the router**

```bash
orrery router --wallet ~/.config/solana/orrery.json --rpc <your RPC URL> --daily-cap 5
```

```
Orrery router on http://127.0.0.1:7171/v1  ·  3 providers  ·  route auto  ·  wallet 7xKXtg…
session key 9WzDXw…AWWM signs vouchers; console at http://127.0.0.1:7171/
```

**4. Point your tools at it** — any API key works.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:7171/v1", api_key="unused")
reply = client.chat.completions.create(
    model="llama-3.3-70b:cheap",
    messages=[{"role": "user", "content": "Hello from the network"}],
)
print(reply.choices[0].message.content)
```

<details>
<summary><b>TypeScript, streaming</b></summary>

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:7171/v1', apiKey: 'unused' });
const stream = await client.chat.completions.create({
  model: 'deepseek-v3:fast',
  stream: true,
  messages: [{ role: 'user', content: 'Explain payment channels in two lines' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```
</details>

<details>
<summary><b>curl</b></summary>

```bash
curl http://127.0.0.1:7171/v1/chat/completions -i \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-oss-120b:cheap","messages":[{"role":"user","content":"hi"}]}'
```

Every answer carries who served it and what you paid:

```
x-orrery-provider: 5Tq7…
x-orrery-route: price
x-orrery-cost: 0.000009
```

and the body's `usage` has the same bill: `{"prompt_tokens": 91, "completion_tokens": 102, "total_tokens": 193, "cost": 0.000018}`. Streams end with it when you set `"stream_options": {"include_usage": true}`.
</details>

<details>
<summary><b>Claude Code and Codex CLI</b></summary>

With the router running, one command starts Claude Code on it as one job and prints the job's bill when you quit (from 0.1.12):

```bash
orrery run claude --budget 0.05
```

```
orrery · claude-todo-app-1111-0834
  7 answers · 95,727 tokens (91,156 in, 4,571 out) · $0.004062 of $0.05 budget
  each answer paid from your wallet to the node that served it
```

It names the network model outright (`gpt-oss-120b` unless you pass `--model`), tags every request with the job and its budget, and hands Claude Code a placeholder key. A key or token already in your environment is not passed on. Arguments after `--` go to Claude Code. Without `--budget` the job gets a dollar (from 0.1.13; on 0.1.12 always pass `--budget`).

Any other tool that reads `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` runs the same way (from 0.1.13): `orrery run --budget 0.25 -- aider --model openai/gpt-oss-120b`. The job and its budget ride in the API key the tool is handed, `orrery/<task>/<budget>`, because a key is the one thing every tool lets you set. You can write such a key yourself in Cursor, Continue or an SDK and get the same job budget with no wrapper.

By hand, on any version: Claude Code asks for Claude model names, so give the router an alias and point Claude Code at it:

```bash
orrery router --wallet ~/.config/solana/orrery.json --alias 'claude-*=gpt-oss-120b'
ANTHROPIC_BASE_URL=http://127.0.0.1:7171 ANTHROPIC_API_KEY=orrery claude
```

The key is a placeholder: Claude Code will not start without one, and the router ignores it. To bill a job as one and stop it at a limit, add `ANTHROPIC_CUSTOM_HEADERS=$'x-orrery-task: my-job\nx-orrery-task-budget: 0.05'` and read the bill with `orrery spend --by task`.

Codex CLI: `orrery connect codex --write`, then `codex --profile orrery`.
</details>

<details>
<summary><b>Cursor, Continue, Aider, Open WebUI, LangChain</b></summary>

| Tool | Setting |
|---|---|
| Cursor | Settings → Models → OpenAI API key: any string · Override OpenAI Base URL: `http://127.0.0.1:7171/v1` · add a model such as `llama-3.3-70b:cheap` |
| Continue | a model with `provider: openai`, `apiBase: http://127.0.0.1:7171/v1`, `model: deepseek-v3` |
| Aider | `OPENAI_API_BASE=http://127.0.0.1:7171/v1 aider --model openai/llama-3.3-70b:cheap` |
| Open WebUI | Admin → Connections → OpenAI API: URL `http://127.0.0.1:7171/v1`, any key |
| LangChain | `ChatOpenAI(base_url="http://127.0.0.1:7171/v1", api_key="unused", model="qwen3-235b")` |
</details>

The full guide, with every flag and a troubleshooting table, is at **[orrerynode.com/docs](https://orrerynode.com/docs)**.

## Routes

<p align="center">
  <img src="assets/readme/routes.jpg" width="840" alt="One word after the model name decides the route; the router ranks candidate providers and picks one.">
</p>

| Suffix | Route | Picks |
|---|---|---|
| *(none)* | auto | `0.6 × relative cost + 0.25 × relative first-token time + 0.45 × (1 − reputation)`, among providers above your reputation floor |
| `:cheap` | price | lowest expected cost for this request |
| `:fast` | speed | fastest first token this router has measured (EWMA) |
| `:trusted` | reputation | settled volume 35% · redemptions 15% · age 15% · bonded $OREY 10% · this router's own success rate 25% |
| `:private` | privacy | only providers whose enclave this router verified; the request is sealed, and the answer names the enclave in `x-orrery-enclave`, `x-orrery-enclave-image` and `x-orrery-enclave-verdict`. Start the router with `--private-only` to make every request take this route, whatever it asks for |

The router tries the top three providers in order and cools a failing one down for 15 seconds up to 5 minutes, so a slow or dead provider is skipped without your tool noticing. If a provider drops a stream mid-answer, the router hands the text so far to the next provider whose manifest says `resume: true` and keeps writing into the same stream; the provider that dropped it is paid nothing for that answer. Pin one with `x-orrery-provider: <address prefix>`, or set the route with `x-orrery-route`.

## How payment works

<p align="center">
  <img src="assets/readme/payments.jpg" width="840" alt="A payment channel: a running total signed after every answer, and the 88 bytes of the latest voucher.">
</p>

```mermaid
sequenceDiagram
    autonumber
    participant T as Your tool
    participant R as Router · your computer
    participant P as Provider node · their machine
    participant S as Solana program
    R->>S: open_channel(deposit, session key) · once per provider
    T->>R: POST /v1/chat/completions · llama-3.3-70b:cheap
    R->>P: request + channel + last signed total
    P-->>R: streamed answer + usage record
    R->>P: new voucher: signed running total
    P->>S: redeem(highest total) · whenever it likes
    S-->>P: USDC to the provider's wallet · nothing to anyone else
```

**The voucher** is 88 bytes, signed with ed25519 by a session key that never leaves your computer:

| Bytes | Field |
|---|---|
| 0–15 | `orrery/voucher/1` (domain separator) |
| 16–47 | channel address |
| 48–55 | cumulative amount, u64 little-endian, USDC base units |
| 56–87 | usage hash: `sha256(previous ‖ "requestId\|model\|in\|out\|cost")`, a chain over every answer |

The router prices each answer itself from the provider's published list and pays **the smaller** of its number and the provider's. A provider serves the next request only once the previous one is paid, so it is never owed more than one answer, and you never pay for one you did not get. To redeem, anyone submits `[Ed25519Program check, redeem]` in one transaction; the program reads the instructions sysvar to confirm the check covers exactly this key and these bytes.

## The program takes 0%

<p align="center">
  <img src="assets/readme/zero.jpg" width="760" alt="The program in the middle takes 0%. Where the rehearsal's 100 USDC went: 97.999864 back with the user, 0.000199 paid to providers, 1.999937 still in open channels.">
</p>

There is no fee field in the program and no third account to send a fee to. In the local rehearsal, 100 USDC went in and 100 USDC is accounted for: back with the user, paid to the providers, or still in open channels. There is no fourth line.

## Holder pricing

A provider can publish holder prices next to its list prices: hold a share of the network token's supply, and that provider charges you less. The token is the mint the program's admin sets once as its bond mint ($OREY), so a tier means the same thing at every provider. That mint is set to `2nB8hRZcSGKbxpfazRd749nXbWRgG27q6yQcasWcThse` ([tx](https://solscan.io/tx/2pDwnjaSZCoZZuGYEYQP6tKr6QhCJdRhcU4urxEMybaQ6CtcDkNwnajwsSJCq1JeKYAd4gWhMtPEmA53rfyQMFir)), so holder prices are on.

| You hold | You pay at a provider with these tiers (the seed provider's) |
|---|---|
| less than 0.1% of $OREY supply | the list price |
| 0.1% or more | 20% less |
| 1% or more | 35% less |

- **Your router** reads your wallet's $OREY balance and the token's supply from chain, ranks providers by the price you will actually pay, and signs at that price.
- **The provider** reads the same two numbers for the wallet that opened the channel and charges the same. Both sides use one integer formula, so they agree without trusting each other.
- **The tiers are part of the price list**, whose sha-256 is on chain. A provider that lists holder prices and does not apply them still gets paid its own number, but every router that sees it counts the miss against its success rate.
- **Nothing is taken from anyone.** The settlement program does not change and still has no fee. A holder price is a discount a provider chooses to give.

Providers add tiers to `provider.json`, in basis points (`share` of supply, `off` the list price):

```jsonc
"holder": { "tiers": [{ "share": 10, "off": 2000 }, { "share": 100, "off": 3500 }] }
```

## Run a provider

<p align="center">
  <img src="assets/readme/providers.jpg" width="840" alt="Providers: every one is someone's own machine.">
</p>

Every provider is someone's own machine. Put a node in front of any OpenAI-compatible server, set your prices, and list it; routers anywhere can then pay you per answer.

```bash
orrery provider init                                                   # find Ollama, vLLM, llama.cpp, LM Studio or SGLang and write provider.json
orrery provider register --config provider.json --wallet wallet.json   # list on chain; your wallet stays cold
orrery provider show     --config provider.json                         # what the chain says, including your node key
orrery provider start    --config provider.json                         # serve, check vouchers, redeem
```

```jsonc
{
  "name": "My GPU",
  "region": "eu-west",
  "publicUrl": "https://gpu.example.org",
  "rpcUrl": "https://your-rpc.example.com",
  "settleMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "wallet": "~/.config/solana/provider-wallet.json",
  "upstream": { "baseUrl": "http://127.0.0.1:8000/v1" },
  "models": [
    { "id": "llama-3.3-70b", "upstreamModel": "meta-llama/Llama-3.3-70B-Instruct",
      "context": 131072, "maxOutput": 8192,
      "price": { "input": 120000, "output": 300000 } }      // USDC base units per million tokens: $0.12 / $0.30
  ],
  "redeem": { "everySecs": 300, "minUnits": 50000 }
}
```

<details>
<summary><b>Upstreams</b></summary>

| Server | `upstream` |
|---|---|
| vLLM | `"baseUrl": "http://127.0.0.1:8000/v1"` |
| SGLang | `"baseUrl": "http://127.0.0.1:30000/v1"` |
| Ollama | `"baseUrl": "http://127.0.0.1:11434/v1"` |
| llama.cpp | `"baseUrl": "http://127.0.0.1:8080/v1"` |
| OpenRouter or any API | `"baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY"` |
</details>

<details>
<summary><b>Keep it running with systemd</b></summary>

```ini
[Unit]
Description=Orrery provider node
After=network-online.target

[Service]
ExecStart=/usr/bin/env orrery provider start --config /etc/orrery/provider.json
Environment=OPENROUTER_API_KEY=...
Restart=always
User=orrery

[Install]
WantedBy=multi-user.target
```
</details>

- **Keep the data folder.** Between redemptions, what routers signed to you exists only in the ledger in `dataDir` (default `~/.orrery/provider`): up to `redeem.minUnits` per channel. In a container, mount a disk there. `orrery provider check` flags a temporary folder or a container's own disk, and the node says so when it starts (in main, next release).
- **Your wallet stays cold.** The node runs on its own key (`~/.orrery/provider/node.json`), which can redeem and post enclave claims but can never send what you earn anywhere except your wallet's USDC account. Give it ~0.01 SOL for redemption fees.
- **Private nodes on AMD SEV-SNP.** In `provider.json`, `"tee": { "mode": "snp", "report": "report.bin", "vcek": "vcek.der" }` serves the report your CPU signed for the node's encryption key, with the chip's certificate. The node refuses to start on a report made for another key (it prints the report data to ask for) or on a VM launched with debugging allowed. Routers verify the report themselves against AMD's roots before they seal a prompt to you; check your own with `orrery enclave verify`.
- **Your upstream key is safe.** Only standard chat fields reach your upstream; fallback model lists, plugins, provider routing and `n` are dropped, so a caller cannot spend your key on something your price list does not cover.
- **Holder prices (optional).** Add `holder.tiers` to give wallets that hold $OREY a lower price. See [Holder pricing](#holder-pricing).
- **Change anything** by editing the file and running `register` again: it updates the listing, and routers check the new price list against the hash on chain.

## Architecture

```mermaid
flowchart LR
    subgraph users[Users]
      A[Router A<br/>laptop]:::r
      B[Router B<br/>workstation]:::r
      C[Router C<br/>CI runner]:::r
    end
    subgraph providers[Providers]
      K[Kestrel<br/>GPU co-op]:::p
      I[Ironbridge<br/>rack]:::p
      V[Vault Nine<br/>enclave]:::p
    end
    A -- request · voucher --> K
    A -- request · voucher --> I
    B -- request · voucher --> I
    B -- sealed request --> V
    C -- request · voucher --> K
    S[(Solana program<br/>channels · 0% fee)]:::s
    A & B & C -. open · top up · close .-> S
    K & I & V -. redeem .-> S
    classDef r fill:#1a1030,stroke:#9945ff,color:#f7f7f7
    classDef p fill:#0b1a14,stroke:#14f195,color:#f7f7f7
    classDef s fill:#0c0c0c,stroke:#5f8ff2,color:#f7f7f7
```

Every router talks to every provider directly. The program never sees a prompt or an answer; it only holds deposits and pays out signed totals. Byte layouts, every instruction and the threat table: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

## Security model

| If | The most you lose |
|---|---|
| a provider stops answering | nothing: the router moves on, and it signs only after an answer arrives |
| a provider overstates token counts | at most the reservation for that one answer (its listed price for `maxOutput` tokens) |
| your session key leaks | what is left in your open channels, redeemable only by their providers; close them |
| your router misbehaves | at most `--daily-cap` per day |
| a provider's node key leaks | nothing of the provider's: redemptions only go to the listing wallet |
| the admin turns hostile | nothing: the admin cannot move deposits or bonds, list or delist, or add a fee |

What a node learns about you: the prompt (unless you use `:private`, where only a verified enclave can read it), the channel that pays, and the address your router connects from. It does not learn who the end user is: ids that clients attach for an API company's abuse checks (`user`, `safety_identifier`, a cache key, Anthropic `metadata.user_id`, which Claude Code fills with an account, device and session id) are dropped by the router before a request leaves your machine, and a node does not pass `user` on to its model server either (from 0.1.12). The answer then carries `x-orrery-withheld` with the names of what was dropped (never the values), so you can see it happened.

The program has **not been audited yet**. Read [SECURITY.md](SECURITY.md) for what each key can do and how to report a vulnerability privately.

## CLI

| Command | Does |
|---|---|
| `orrery router --wallet <keypair> --rpc <url>` | run the router on `127.0.0.1:7171` |
| `orrery models` | every model on the network, cheapest price, provider count |
| `orrery provider price --config provider.json [--beat 5] [--floor in/out] [--write]` | undercut the cheapest other listing of each model by a margin, never below your floor |
| `orrery provider check --config provider.json` | is this node ready to earn: model server, public address, listing, fee money, enclave, pledge |
| `orrery enclave verify --node <listing>` | audit a private node: its claim from chain, its report from the node, every check a router runs (`--report --vcek` and `--quote` check a file) |
| `orrery providers` | every listing, what the chain says about it and whether its model server answers |
| `orrery channels` | your channels: deposit, what you signed, what was redeemed |
| `orrery close <channel> --wallet <keypair>` | start closing (the provider gets a grace period to redeem) |
| `orrery close <channel> --wallet <keypair> --finish` | after the grace period, the rest comes back to you |
| `orrery provider init` | find a local model server and write a starting provider.json |
| `orrery provider register \| show \| start \| attest \| redeem --config provider.json` | run a provider |

Task budgets: send `x-orrery-task: <name>` on every request of a job and `x-orrery-task-budget: 0.05` on the first. A tool that cannot add headers can say the same in its API key: `orrery/<task>/<budget>` (from 0.1.13). The router keeps one running total per task, answers with `x-orrery-task-spent` and `x-orrery-task-left`, and refuses the next request once the budget is gone with a 402 that carries the same two headers from 0.1.15 (`GET /orrery/tasks` lists them; over MCP, `task` and `task_budget`). Budgets are kept in `~/.orrery/router/tasks.json`, so they survive a restart, and `orrery spend --by task` adds up what each job cost from the router's own log. `orrery sealed` lists every private answer with the enclave the router had verified.

Router flags: `--route`, `--deposit` (2), `--top-up-below` (0.25), `--daily-cap` (5), `--min-reputation` (0.2), `--port` (7171), `--refresh` (60), `--enclave-images`, `--alias` (`claude-*=llama-3.3-70b`: answer other model names with a network model). Environment: `ORRERY_WALLET`, `ORRERY_RPC_URL`, `ORRERY_HOME` (`~/.orrery`), `ORRERY_ALIASES`.

## Router console

The router serves a live console at `http://127.0.0.1:7171/`: every request, the provider that answered, tokens and cost, your providers and your channels.

<p align="center">
  <img src="assets/readme/console.png" width="880" alt="The router console: default route, spent today, providers, open channels, and tables of recent requests, providers and channels.">
</p>

## Build from source

```
program/   Anchor program (Rust) · provider registry, payment channels, ed25519 vouchers, enclave claims, bonds
node/      router + provider node (TypeScript, Node 22) · published to npm as orrery-node
web/       orrerynode.com and its docs (Next.js, three.js)
docs/      protocol specification
assets/    brand and README media
```

```bash
cd program && anchor build --arch v2 && cargo test -p orrery   # 2 unit + 13 LiteSVM tests on the compiled program
cd node && pnpm install && pnpm test                            # 136 tests
pnpm e2e                                                        # full local rehearsal, 57 checks
cd web && pnpm install && pnpm dev                              # http://localhost:3870
```

**The rehearsal** (`node/devtools/e2e.ts`) starts a local validator with the program, creates a stand-in network token and sets it as the bond mint, lists four providers in front of mock models (one behind a development enclave, one with holder prices), runs a router whose wallet holds 2% of the token through fourteen requests on every route, switches the cheapest provider off mid-run, redeems on chain, has one provider release its channel, and checks every unit of USDC:

```
  ✓ /v1/models lists the network catalog
  ✓ price route picks the cheapest llama
  ✓ streaming works and only Ironbridge has deepseek
  ✓ privacy route seals the request to the only enclave
  ✓ route header works too
  ✓ speed route settles on the provider with the fastest first token
  ✓ a wallet holding 2% of the network token pays the 1% tier price
  ✓ when the cheapest provider goes dark the request falls through
  ✓ router logged every answered request
  ✓ Kestrel GPU Co-op redeemed exactly what the router signed
  ✓ Ironbridge Compute redeemed exactly what the router signed
  ✓ Vault Nine redeemed exactly what the router signed
  ✓ Halo Compute redeemed exactly what the router signed
  ✓ a provider releasing its channel sends the rest straight back to the user
  ✓ no fee in the program: user + providers + open deposits = 100 USDC
  ✓ program totals agree
  ✓ a provider with many channels redeems them in transactions that fit, skipping one that closed
17/17 checks passed
```

## FAQ

<details>
<summary><b>Do I need an account or an API key?</b></summary>

No. Your Solana wallet is the account. The router accepts any API key string from your tools and pays from your channels.
</details>

<details>
<summary><b>What does a request cost?</b></summary>

Whatever the provider lists, per million input and output tokens, in USDC. `orrery models` shows the cheapest price per model across the network. Nothing is added on top: the program has no fee.
</details>

<details>
<summary><b>What stops a provider from overcharging?</b></summary>

The router recomputes every cost from the provider's published price list (whose hash is on chain) and signs the smaller number, never more than it reserved for that request. Providers that misbehave lose reputation, and the router stops picking them.
</details>

<details>
<summary><b>What stops a user from not paying?</b></summary>

A provider serves the next request only after the previous one is paid by a signed voucher, and the deposit is already locked in the channel. The most a provider can be owed is one answer.
</details>

<details>
<summary><b>Can someone shut a provider down?</b></summary>

No. Anyone can list, and no instruction in the program lets anyone, including the admin, delist a provider.
</details>

<details>
<summary><b>What is $OREY for?</b></summary>

Two things. Holding it lowers your price at every provider that publishes holder prices (at the seed provider: 0.1% of supply for 20% off, 1% for 35% off; see [Holder pricing](#holder-pricing)). And providers can bond it behind their listing, which routers count as 10% of reputation. A bond is never slashed; unbonding returns it after seven days, only to the provider that posted it. It launches on Meteora.
</details>

<details>
<summary><b>Which API does the router speak?</b></summary>

OpenAI Chat Completions (`/v1/chat/completions`, streaming or not), the OpenAI Responses API (`/v1/responses`, streaming or not, function calls included; `orrery connect codex --write` sets up the Codex CLI), `/v1/models`, and the Anthropic Messages API (`/v1/messages`, streaming or not, tool use included, plus `/v1/messages/count_tokens`). For an Anthropic client, set `ANTHROPIC_BASE_URL=http://127.0.0.1:7171` and use a network model id such as `llama-3.3-70b`; Claude Code runs this way with the router's `--alias 'claude-*=<model>'`. Agents can also reach the network over MCP: `orrery mcp` serves `ask`, `models` and `status` on stdio in front of your router (`claude mcp add orrery -- npx -y orrery-node mcp`).
</details>

## Roadmap

- [x] Settlement program: registry, channels, ed25519 vouchers, enclave claims, bonds
- [x] Router and provider node, OpenAI-compatible, streaming, fall-through
- [x] Local end-to-end rehearsal on the real program, 57 of 57 checks (end-user ids never reaching a model server, a client started with `orrery run` and billed as one job, requests encrypted to the node's own key, task budgets for agents, a node buying and burning the network token with its pledged share and the router verifying it on chain, every API, quotes before paying, per-request budgets, routers skipping a node whose model server is down and showing it in their status, embeddings, fallbacks, billed usage in streams, bench on chat and embedding models, a router picking its channel back up after losing its records, limits, cache pricing and affinity, 400 parallel answers, Codex CLI and Claude Code, DNS-rebinding refusal, logs that add up to what was signed)
- [x] Holder pricing: tiers by share of $OREY supply, checked by router and provider
- [x] npm package [`orrery-node`](https://www.npmjs.com/package/orrery-node)
- [x] Site and docs at [orrerynode.com](https://orrerynode.com)
- [x] Program deployed on Solana mainnet and initialized (USDC settlement, 1 h close grace, 7 day unbonding, $0.10 minimum deposit)
- [x] Reproducible build: the program on chain hashes to `0880750c…5451`, the same as `solana-verify build` of this repo
- [x] Seed provider live on mainnet (Orrery Seed: llama-3.3-70b, deepseek-v3, qwen3-235b, gpt-oss-120b; holder tiers published), first paid requests settled on chain
- [x] $OREY live on Meteora (`2nB8hRZcSGKbxpfazRd749nXbWRgG27q6yQcasWcThse`), set as the program's bond mint, holder prices on
- [ ] Buyback and burn: a share of what Orrery earns buys $OREY on the market and burns it. It runs outside the settlement program, which keeps no fee; a smaller supply moves every holder toward the next tier
- [ ] Independent audit
- [x] Anthropic Messages API (`/v1/messages`) on the router, tool use included (orrery-node 0.1.3)
- [x] OpenAI Responses API, MCP server, model aliases, resumed streams, `orrery provider init` (orrery-node 0.1.4)
- [x] Codex CLI and Claude Code through the router, checked in the rehearsal; `orrery connect` writes their settings (0.1.4)
- [x] Cached-input prices and prompt-cache affinity for agents that resend their context every turn (0.1.4)
- [x] Parallel requests: one lane per provider, busy providers hand off to the next free one; 400 answers 16 at a time, 0 failed (0.1.4)
- [x] Spending limits for unattended agents: `--max-price`, `--daily-cap`, the channel deposit (0.1.4)
- [x] Router and provider consoles, `orrery doctor` (0.1.4)
- [x] Embeddings (`/v1/embeddings`), routed and paid like chat, priced on input tokens (0.1.5)
- [x] Model fallbacks (`"a|b"` or a `models` array), `orrery bench`, `orrery spend` and `orrery provider earnings`, MCP prices and `max_price` (0.1.5)
- [x] Billed usage in OpenAI's shape with `usage.cost`, benches for embedding models, and routers that pick their channels back up after losing their records (0.1.6)
- [x] Quotes before paying (`orrery quote`, MCP `quote`), a dollar budget per request (`x-orrery-max-cost`, `--max-cost`), `orrery provider compare`, the wallet's channels in `doctor` and `orrery channels`, and nodes that report their model server on `/health`, which routers check every 30 seconds and route around (0.1.7)
- [x] Wallet and node pages read live from the program, with share cards; the network terminal (preview on sample data)
- [x] Routers show each node's model server (console, status, MCP, `orrery providers`); a built-in AMD SEV-SNP verifier and `orrery enclave verify`; private nodes on SEV-SNP; routers verify burn pledges on chain, a `:burn` route and `x-orrery-burn` (0.1.8)
- [x] Built-in hardware verifier for AMD SEV-SNP: the router checks an enclave's report itself, against AMD's roots, with no attestation service (`orrery enclave verify`, 0.1.8)
- [x] Built-in verifier for Intel TDX, checked against a real quote (`orrery enclave verify --quote`), TDX nodes, task budgets for agents, burn pledges that buy on mainnet through Jupiter (`orrery provider burn`), enclave verdicts in `doctor` (0.1.9)
- [x] A receipt on every private answer (`x-orrery-enclave` headers, kept in the router's log, `orrery sealed`), `orrery enclave verify --node` to audit a private node check by check, a `--private-only` router, a bill per job (`orrery spend --by task`, budgets that survive a restart), `orrery provider price` (0.1.10)
- [x] Wire sealing: every request encrypted to the node's own key, signed by the node key on its listing (`x-orrery-wire`), and enclave verifiers that read AMD's and Intel's revocation lists (0.1.11)
- [x] End-user ids dropped by the router before a request leaves (`user`, `safety_identifier`, a cache key, Anthropic `metadata.user_id`), no `user` passed upstream by a node, and `orrery run claude` with a budget and a bill (0.1.12)
- [x] Revocation lists in the built-in verifiers: AMD's and Intel's signed lists are fetched from the chip maker, verified against the pinned roots and checked for the chip's certificates (0.1.13)
- [x] Wire sealing: every request is encrypted to the node's own key (signed by the node key on chain), so a host, load balancer or firewall in front of a node sees ciphertext (0.1.13)
- [x] Intel's patch level (TCB) in the TDX verifier: the platform's microcode and TDX module versions are read from the quote, Intel's signed TCB list for that platform family is fetched and verified against the pinned root, and a platform Intel lists as out of date, revoked or unsupported is refused (`--allow-outdated` to look anyway; 0.1.13)
- [x] AMD's firmware level in the SEV-SNP verifier: the level the report states must be the one the chip key was issued for (AMD derives a different key per level) and the certificate must be for that very chip; `--min-firmware 3.0.8.115` or `ORRERY_SNP_MIN_FIRMWARE` holds it to a minimum of yours (AMD publishes no signed list of current levels; 0.1.13)
- [x] A proxy for everything a router sends (`orrery router --proxy http://host:port`): nodes and the Solana RPC see the proxy's address and not yours, the proxy carries requests it cannot read, transactions are confirmed without the RPC's websocket, and a proxy that is down fails the request instead of letting it out directly (0.1.13)
- [ ] AMD firmware on Turin (its level is laid out differently); NVIDIA GPU attestation
- [x] SOCKS5 proxies (`--proxy socks5://host:port`, with a name and password when given): the proxy is sent the host's name, so the lookup happens there (0.1.14)
- [x] Tunnels through the proxy are kept and reused between requests (0.1.14)
- [x] A node listed by an IPv6 address, through either kind of proxy (in main, next release)
- [x] Requests padded to a size class before sealing, so their length on the wire shows the class and not the prompt's length (in main, next release)
- [x] Answer frames padded to whole 256-byte blocks, so their lengths do not spell out the tokens (in main, next release)
- [ ] Hide how many frames an answer has and when they go out
- [x] The proxy checked from the far side: a node answers `GET /v1/seen` with the address it saw, and `orrery doctor` asks it through your proxy and prints a `seen as` line, which fails when the node saw one of this computer's own addresses (0.1.15)
- [x] One connection to a node carries answer after answer, with or without a proxy (0.1.15)
- [x] A router that lost its records and cannot reach the node does not open a second channel beside the first (in main, next release)
- [x] A router told to stop (Ctrl-C, SIGTERM) lets answers in flight finish and hands over the vouchers still on their way before it exits (in main, next release)
- [x] A node that is away for a moment: the request waits and goes round again (`--patience`, 8 seconds by default, or `x-orrery-patience: <seconds>` on one request), and a cooldown no longer refuses a model's only node (in main, next release)
- [x] A router behind a proxy asks a node what it sees before it pays for anything, shows it on `/orrery/status`, and does not send while the node sees this computer's own public address (in main, next release)
- [x] A node does not redeem dust: with no `redeem.minUnits` set, a channel is redeemed once five cents are waiting on it (0.1.15)
- [ ] A run through Tor itself
- [ ] $OREY bonds live on mainnet

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) lists good places to start. Before opening a pull request, run the program tests, `pnpm test` and `pnpm e2e` in `node/`, and keep the protocol document in step with any change to the program or the wire format. Security issues go through private reporting, not public issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

<p align="center"><br><img src="assets/brand/mark.svg" width="56" alt="Orrery"><br><sub>Peer to peer. Zero cut in between.</sub></p>
