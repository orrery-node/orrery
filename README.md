# Orrery

**AI inference, peer to peer. Zero cut in between.**

Orrery is a peer-to-peer AI inference network on Solana. A router on your computer serves an OpenAI-compatible API at `http://127.0.0.1:7171/v1`. For every request it picks a provider by price, speed, reputation or privacy, sends the request straight to that provider's machine, and pays it through a Solana payment channel. Anyone can run a provider. The program in the middle has no fee field and no third account to send one to.

```
your tool ──► router (your computer) ──────────────► provider's machine
                 │       request · answer · signed total        │
                 └──── Solana program: channel deposit · redeem ─┘
```

- Website: https://orrerynode.com · Docs: https://orrerynode.com/docs
- npm: [`orrery-node`](https://www.npmjs.com/package/orrery-node) (the `orrery` command)
- Program: `7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS`

## Use it

```bash
npm install -g orrery-node
orrery router --wallet ~/.config/solana/id.json --rpc <your RPC URL>
```

Point any OpenAI-compatible tool (Cursor, Continue, Aider, Open WebUI, LangChain, the OpenAI SDKs) at `http://127.0.0.1:7171/v1` with any API key, and add `:cheap`, `:fast`, `:trusted` or `:private` to the model name to choose the route. The full guide, including running a provider, is at https://orrerynode.com/docs.

## How it works

1. **Providers list themselves on chain**: an endpoint, the key their node signs with, and the sha-256 of a price list the node serves. No approval and no stake; nobody, including the admin, can delist them.
2. **The router opens a channel** the first time it uses a provider: the wallet locks a small USDC deposit in an account only the channel controls, and names a session key that lives on your computer.
3. **After every answer** the router prices it from the provider's published list, takes the smaller of its number and the provider's, and signs a new running total (an 88-byte ed25519 voucher). A provider never serves the next request until the previous one is paid, so neither side is ever exposed to more than one answer.
4. **The provider redeems** the highest total whenever it likes. The program pays exactly that difference to the provider's own token account. Whatever is not redeemed goes back to the user when the channel closes.
5. **Private requests** go only to providers whose hardware enclave claim the router verified, sealed with X25519 + HKDF + AES-256-GCM to a key that never leaves the enclave.

The byte-level protocol, account layout, routing formula and threat table are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Repository

```
program/   Anchor program (Rust): provider registry, payment channels, ed25519 vouchers, enclave claims, bonds
node/      the router and the provider node (TypeScript, Node 22), published to npm as orrery-node
web/       the site and docs (Next.js, three.js)
docs/      protocol specification
```

## Build and test

```bash
# program: 2 unit tests + 13 LiteSVM tests against the compiled program
cd program && anchor build --arch v2 && cargo test -p orrery

# router + provider node: 13 unit tests, then a full local rehearsal
cd node && pnpm install && pnpm test
pnpm e2e        # local validator + the program + three providers + a router: 14 checks, every unit of USDC accounted for

# site
cd web && pnpm install && pnpm dev   # http://localhost:3870
```

The rehearsal (`node/devtools/e2e.ts`) deploys the program to a local validator, lists three providers in front of mock models, runs thirteen requests across every route, switches the cheapest provider off mid-run, redeems on chain, and checks that user + providers + open deposits equal the starting balance: the program takes nothing.

## Security

See [SECURITY.md](SECURITY.md) for what each key can and cannot do and how to report a vulnerability.

## License

MIT
