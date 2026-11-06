# Contributing to Orrery

Thanks for looking. Orrery is three pieces in one repo, and all of it is MIT:

```
program/   the Solana settlement program (Anchor)
node/      router + provider node (TypeScript, Node 22), published to npm as orrery-node
web/       orrerynode.com and its docs (Next.js)
docs/      PROTOCOL.md, the wire format and every rule the program enforces
```

## Run it

```bash
cd program && anchor build --arch v2 && cargo test -p orrery   # unit + LiteSVM tests on the compiled program
cd node && pnpm install && pnpm test                            # router and provider unit tests
pnpm e2e                                                        # full local rehearsal on a test validator
cd web && pnpm install && pnpm dev                              # http://localhost:3870
```

`pnpm e2e` needs `program/target/deploy/orrery.so`, so build the program first. It runs four providers in front of mock models, a router through every route, on-chain redemption and a final check that every unit of USDC is where it should be. If it passes, the change didn't break money.

## Good places to start

- **Provider backends.** The node forwards to any OpenAI-compatible upstream. A short guide, a config example or a small adapter for an engine you run (SGLang, TGI, MLX, LM Studio) helps the next person sell theirs.
- **Router policies.** All routing lives in `node/src/router/policy.ts`. New routes, better first-token estimates and smarter fall-through are welcome, with a test that shows the ranking you expect.
- **Anthropic Messages API.** `/v1/messages` on the router is on the roadmap.
- **Hardware attestation.** A built-in verifier for enclave reports, so `:private` doesn't depend on an external tool.
- **Docs.** Anything you had to figure out the hard way while running a router or a node.

## Pull requests

- Keep `docs/PROTOCOL.md` in step with any change to the program or the wire format. A change to either needs an issue first, because deployed routers and providers have to agree on it.
- Run `pnpm test` and `pnpm e2e` before opening the PR, and say what you ran.
- The program has no fee field, and nothing in it lets anyone list or delist a provider for someone else. PRs that change either won't be merged.
- Security issues go through private reporting, not public issues. See [SECURITY.md](SECURITY.md).
