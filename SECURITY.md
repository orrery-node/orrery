# Security

## What each key can do

| Key | Lives | Can | Cannot |
|---|---|---|---|
| User wallet | your machine, used by the router | open, top up and close your channels | be used by anyone else through the router; the router never sends it anywhere |
| Router session key | `~/.orrery/router/session.json` | sign running totals for your open channels | move anything beyond what is left in those channels; spend past `--daily-cap` through the router |
| Provider wallet | can stay cold | register and update the listing, bond | nothing is needed from it to serve or redeem |
| Provider node key | on the serving machine | redeem signed totals, post enclave claims | send redemptions anywhere but the provider wallet's token account |
| Program admin | the deployer, then whoever it is handed to | tune bounded parameters, set the bond mint once | list or delist providers, move deposits or bonds, charge a fee |

The protocol threat table is in [docs/PROTOCOL.md §5](docs/PROTOCOL.md#5-what-can-go-wrong).

## Upstream keys

A provider node forwards only standard chat fields (messages, sampling parameters, tools, response format) to its upstream and drops `n`. Fields that would let a caller spend the operator's upstream key on something the price list does not cover, such as fallback model lists, plugins or provider routing, never reach it. Keep upstream keys in environment variables (`upstream.apiKeyEnv`), not in `provider.json`.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" (Security tab → Advisories) on this repository rather than in a public issue. Include the affected component (program, router, provider node, site), the version or commit, and steps to reproduce. We will acknowledge within 72 hours.
