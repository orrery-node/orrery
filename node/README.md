# orrery-node

Peer-to-peer AI inference on Solana. A router on your computer sends each request straight to a provider's machine and pays it through a Solana payment channel. No server in the middle, and the program takes 0%.

```
your tool ──► router (127.0.0.1:7171) ──► provider's machine
                    │                          │
                    └── Solana program: channel deposit · redeem ──┘
```

## Use the network

```bash
npm i -g orrery-node
orrery router --wallet ~/.config/solana/id.json --rpc <your RPC URL>
```

Point anything that speaks the OpenAI API at `http://127.0.0.1:7171/v1` (any API key). Add one word after the model name to pick the route:

| Suffix | Picks |
|---|---|
| (none) | a blend of price, first-token time and reputation |
| `:cheap` | lowest expected cost |
| `:fast` | fastest first token this router has seen |
| `:trusted` | most USDC settled on chain, bonded $OREY |
| `:private` | verified enclaves only, the request sealed |

The first request to a provider opens a channel with a small USDC deposit (`--deposit`, default 2). After every answer a session key on your computer signs the new running total; the provider redeems it on Solana. `--daily-cap` (default $5) stops spending for the day. The console at `http://127.0.0.1:7171/` shows every request, the provider it went to and what it cost.

```bash
orrery models      # every model on the network, cheapest price, provider count
orrery providers   # every listed provider and what the chain says about it
```

## Run a provider

Put a node in front of any OpenAI-compatible server (vLLM, SGLang, Ollama, llama.cpp, or API capacity you hold), set your prices, and list it:

```bash
orrery provider register --config provider.json --wallet wallet.json
orrery provider start    --config provider.json
```

Only standard chat fields reach your upstream, so a caller cannot spend your key on models or tools your price list does not cover. Redemptions go straight to your wallet's USDC account.

Docs: https://orrerynode.com/docs · Source: https://github.com/orrery-node/orrery (MIT)
