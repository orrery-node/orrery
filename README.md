# Orrery ($OREY)

A peer-to-peer AI inference network on Solana. A router on your computer serves an OpenAI-compatible API at `http://127.0.0.1:7171/v1`, picks a provider for every request by price, speed, reputation or privacy, and pays that provider directly through a Solana payment channel. Anyone can run a provider. The program takes no fee.

```
program/   Anchor program: provider registry, payment channels, ed25519 vouchers, enclave claims, bonds
node/      the router (orrery router) and the provider node (orrery provider), TypeScript, Node 22
web/       the site (Next.js): landing with a live 3D orrery hero and product cards, and docs
docs/      concept, decisions, mechanism, site direction, launch checklist
```

## Run it

```bash
# program
cd program && anchor build --arch v2 && cargo test -p switchyard        # 2 unit + 13 LiteSVM

# router + provider
cd node && pnpm install && pnpm test                                     # 12 tests
pnpm e2e                                                                 # local validator, 3 providers, 14 checks

# site
cd web && pnpm install && pnpm rehearsal && pnpm dev                     # http://localhost:3870
```

Run a router against a cluster where the program is deployed:

```bash
cd node && pnpm orrery router --wallet ~/.config/solana/id.json --rpc <RPC URL>
```

Run a provider in front of any OpenAI-compatible server (vLLM, SGLang, Ollama, llama.cpp):

```bash
pnpm orrery provider register --config provider.json --wallet wallet.json
pnpm orrery provider start --config provider.json
```

See `web/src/app/docs/page.tsx` (served at `/docs`) for the full guide and `docs/MECHANISM.md` for how payments work.

## Status

Not deployed to mainnet. OpenAI-compatible API only (no Anthropic `/v1/messages` yet). Hardware attestation needs an external verifier.
