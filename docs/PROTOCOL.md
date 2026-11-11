# Orrery protocol

The code is the source of truth: the program in `program/programs/orrery/src/lib.rs` and `voucher.rs`, the client in `node/src/chain/program.ts`. If this document and the code disagree, the code is right.

## 1. Accounts

| Account | Seeds | Holds |
|---|---|---|
| Config | `config` | admin and pending admin, settlement mint (USDC), bond mint (set once), close grace period (10 min to 7 days), unbonding delay (1 hour to 30 days), minimum deposit, running totals of providers, channels and settled units |
| Provider | `provider` + wallet | wallet (authority and payee), node key (hot key), endpoint (http/https, at most 120 chars), price list sha-256 and sequence, active flag, enclave claim (kind, 48-byte measurement, report hash, encryption key, expiry), bond, unbonding amount and time, settled units, redemptions, channels, registration time, last settlement |
| Channel | `channel` + user + provider + id (u64 LE) | user, provider, session key, mint, deposit, redeemed, usage hash head, opened at, closing at |
| Channel vault | associated token account of the channel PDA | the deposit; only the channel can move it |
| Bond vault | associated token account of the provider PDA for the bond mint | the bond; it can only go back to the provider's wallet |

## 2. Instructions

| Instruction | Who | What |
|---|---|---|
| initialize | the program's upgrade authority only | creates Config (so nobody can race the deploy) |
| set_params / propose_admin / accept_admin | admin | within fixed bounds only; admin transfer takes two steps |
| set_bond_mint | admin, once | after the token exists |
| register_provider | anyone | no approval, no stake |
| update_provider | that provider's wallet | endpoint, price list hash, node key, active |
| attest | the provider's wallet or node key | posts or clears (kind 0) an enclave claim |
| bond / unbond / withdraw_bond | that provider's wallet | withdrawal after the delay, to the wallet only |
| open_channel(id, deposit, session key) | user | active provider, at least the minimum deposit |
| top_up | user | not while closing |
| redeem(cumulative, usage hash) | **anyone** | needs an ed25519 check of the session key over the voucher in the same transaction; pays `min(cumulative, deposit) − redeemed` to the provider wallet's token account and nowhere else |
| request_close | user | starts the grace period |
| close_channel | user (after the grace period) or provider (any time) | the rest of the deposit and the account rent go back to the user |

There is no fee anywhere. No instruction has a third recipient.

## 3. Vouchers

```
message (88 B) = "orrery/voucher/1" (16) ‖ channel (32) ‖ cumulative u64 LE (8) ‖ usage_hash (32)
signature      = ed25519(session_key, message)
```

A redemption transaction is `[Ed25519Program check over (public key, signature, message), redeem]`. The program scans the instructions sysvar zero-copy for a check that covers exactly this key and these bytes. One transaction can carry several checks and several redeems. The provider node packs as many channels as fit in Solana's 1,232-byte transaction limit: a one-channel redeem is 817 bytes and a two-channel one 1,148, so in practice two per transaction.

Usage hash chain: `h_n = sha256(h_{n-1} ‖ "requestId|model|in|out|cost")`, `h_0 = 0`. Router and provider build the same chain from the same records; the head is stored on the channel at each redemption.

## 4. One request

1. The router ranks candidates (§6). If it has no channel with the chosen provider, the wallet signs `open_channel` (2 USDC by default).
2. `POST {endpoint}/v1/chat/completions` with `x-orrery-channel` and `x-orrery-voucher` (the total so far), and no other header from the client. Before sending, the router drops the fields that say who the end user is (`user`, `metadata`, `safety_identifier`, `prompt_cache_key`; an Anthropic `metadata.user_id` is not converted into `user`), and names them back to the client in `x-orrery-withheld`. On the private route the body is sealed (§7).
3. The provider reads the channel from chain and checks that it is its own and in USDC, verifies the voucher signature, refuses with 402 `payment_required` unless **paid ≥ owed so far** (attaching the unpaid records), refuses with 402 `channel_exhausted` unless **owed + this request's maximum cost ≤ deposit**, then streams from its upstream and collects `usage`. Only standard chat fields reach the upstream, and `user` is not one of them.
4. At the end the provider computes the cost (capped at the maximum), sends the record as `event: orrery`, then `[DONE]`.
5. The router recomputes the cost from the same price list and pays **the smaller** of the two: it raises the total, signs a new voucher, and posts it to `/orrery/voucher` at once (it also rides on the next request).
6. The provider redeems the highest voucher when it chooses (`redeem.everySecs`, minimum amount). Closing channels are redeemed regardless of amount.

Cost = `ceil((input tokens × input price + output tokens × output price) / 1e6)` USDC base units, with prices in base units per million tokens ($0.60/M = 600000). A model may also list `cachedInput`, a price at or below its input price for input tokens the model server served from a prompt cache (the provider reads `usage.prompt_tokens_details.cached_tokens` from its upstream). Those tokens are billed at `cachedInput` and the rest at `input`. The router still signs the lower of the bill and its own full-price figure, so a cache report can only lower what a provider is paid, and the usage record and voucher are unchanged.

## 5. What can go wrong

| Situation | Result |
|---|---|
| Provider inflates token counts | The router signs the smaller of its own calculation and the provider's, capped at the request's maximum cost. Forged counts themselves are not provable on chain; reputation, local success rate and the router's own estimate are the defense |
| Provider swaps in a cheaper model | Not visible on chain. Enclaves (the measurement covers the model image) and reputation are the defense |
| Router stops paying | The provider loses at most one request's maximum cost; the next request gets 402 |
| Provider disappears | The user calls request_close and recovers the rest after the grace period (1 hour by default) |
| User disappears | The provider can redeem at any time, including during the grace period |
| Session key leaks | Bounded by what is left in open channels plus the router's daily cap ($5 by default) |
| Voucher replay on another cluster | Needs the same channel address, and channel ids are random |
| Swapped price list | The router compares its sha-256 with the hash on chain and skips the provider if they differ |

## 6. Routing

| Route | Model suffix | Order |
|---|---|---|
| auto (default) | none | among providers above the reputation floor (0.2 by default): `0.6 × relative cost + 0.25 × relative first-token time + 0.45 × (1 − reputation)` |
| price | `:cheap`, `:floor` | expected cost, ascending |
| speed | `:fast` | observed first-token time (EWMA; 1.5 s if unknown) |
| reputation | `:trusted` | reputation, descending |
| privacy | `:private` | verified enclaves only, then by price |

When the router's wallet earns a holder price at a provider (§9), the expected cost above is computed at that price.

Reputation (0 to 1) = settled volume 35% (log, saturating at $1,000) + redemptions 15% (1,000) + age 15% (90 days) + bond 10% (√ of share of the network maximum) + this router's own success rate 25% (starts at 0.6). A failing provider cools down exponentially from 15 seconds up to 5 minutes. The router tries the top three in order. `x-orrery-provider: <address prefix>` pins one provider; `x-orrery-route` overrides the route.

## 7. Sealing (private route)

The router makes an ephemeral X25519 key, does ECDH with the provider's enclave key, derives with HKDF-SHA256 (salt = ephemeral public key ‖ enclave public key, info `orrery/seal/1`) and encrypts with AES-256-GCM. The body becomes `{sealed: 1, epk, box}`; response SSE frames are sealed with the same key. Outside the enclave (the operator's host, the network) only ciphertext is visible. That the enclave key was generated inside the enclave is vouched for by the hardware report, which the router fetches and checks against the on-chain claim before sealing anything.

### Wire sealing (every other route)

A node without an enclave still holds an X25519 key of its own (`wire.key` in its data folder). It serves `GET /v1/wire` → `{ key, sig, node }`, where `sig` is the node key's ed25519 signature over `orrery/wire/1 ‖ key`; the node key is the one on the provider's account, so a router accepts the wire key only from the node that is listed. The router then sends `{wire: 1, epk, box}` built exactly like a sealed body, and the node answers in sealed SSE frames. The operator can read the prompt (only an enclave prevents that); nothing between the router and the node process can, which matters because a hosting platform ends TLS in front of the node and may inspect, log or refuse what it sees. A node with no `/v1/wire` (older than this) is sent plain JSON, and a node accepts plain JSON from older routers.

### The address a node sees

A node learns the wallet that pays it, the request, and the address the request came from. A router started with `--proxy http://host:port` (or `ORRERY_PROXY`) sends everything it sends to nodes through that HTTP proxy: `CONNECT host:443` and TLS to the node inside the tunnel for an https endpoint, a forwarded request for an http one. The node sees the proxy's address. The proxy sees which node, when and how many bytes; the body is already sealed to the node's key (above), so it reads none of it. The router never goes around a proxy that is set: if it does not answer, the request fails. Chain reads and transactions do not go through it, so the RPC a router uses still sees the router's address.

## 8. What the admin cannot do

List or delist providers, move channel deposits, move bonds, or charge a fee. The admin can tune the grace period, the unbonding delay and the minimum deposit within the bounds above, set the bond mint once, and hand over the admin role in two steps.

## 9. Holder pricing

A manifest may carry `resume: true` when the node's upstream continues a partial answer given to it as a final assistant message (assistant prefill). A router whose stream from one provider breaks after some text, with no tool call in it, may send the same request plus that text as an assistant message to the next such provider and keep streaming; the provider that broke the stream wrote no usage record, so the router signs nothing for it.

A manifest may carry `holder: { tiers: [{ share, off }, …] }`, at most four tiers, `share` in basis points of the network token's supply (1 to 10,000) and `off` in basis points of the list price (1 to 9,000), each tier larger than the one before on both. The network token is `Config.bond_mint`; until the admin sets it, no tier applies.

- A wallet's standing is the balance of its associated token account for that mint, against the mint's supply, both read from chain. Its discount is the largest `off` whose `balance × 10,000 ≥ supply × share`.
- The holder price of a model is `floor(price × (10,000 − off) / 10,000)` for input and output separately; the cost formula (§4) is unchanged.
- The provider computes the discount for the channel's payer and reports the `off` it applied in the `event: orrery` record. The router computes the discount for its own wallet, ranks with it (§6), and pays the smaller of its cost and the provider's at the discount the provider reported, provided that discount is one the manifest lists.
- If the provider applied less than the router expected, the router still pays the provider's number (so the channel never stalls) and counts the request against that provider's local success rate.
- The tiers are inside the manifest, so they are covered by the sha-256 on chain. The program itself does not change.

