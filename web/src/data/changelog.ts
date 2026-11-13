// Every orrery-node release in plain words. Times are the npm publish times (registry.npmjs.org/orrery-node).
// CHANGELOG.md at the repo root carries the same text; change both together.

export type Change = { who: 'router' | 'provider' | 'everyone'; text: string };
export type Release = { version: string; at: string; headline: string; changes: Change[] };

export const UNRELEASED: Change[] = [
  { who: 'everyone', text: 'A node can put “payment inside” in its price list, whose hash is on chain. A router keeps to the signed flag once it has seen it, but a front that strips the flag, or hides the wire key, before a router has ever reached the node used to get that router’s first requests the old way. Set `paymentInside: true` in provider.json and register again, and the mark rides in the list itself: a router keeps payment inside the seal from its very first request to that node, and sends it nothing in the clear if the wire key is missing. Off for nodes already listed, since it changes the list and a node has to register again; `orrery provider init` turns it on for a new node, which registers anyway.' },
];

export const RELEASES: Release[] = [
  {
    version: '0.1.16',
    at: '2026-11-13T10:00:24Z',
    headline: 'Payment travels inside the seal: a node’s host no longer sees which channel pays, how long your prompt is or what the channel has paid, and doctor, status and MCP say how each request went.',
    changes: [
      { who: 'router', text: 'A router behind a proxy checks it from the far side before it pays for anything. 0.1.15 let `orrery doctor` ask a node what address it sees; now the router asks at start-up, prints the answer in its first lines, shows it on `/orrery/status` as `proxySeen`, and asks again on every registry refresh. When the node saw one of this computer’s own public addresses the proxy hides nothing: `orrery router` does not start, and a running router answers 503 `proxy_gives_address_away` and sends nothing until a later check comes back clean. A matching private address does not stop a router (a node’s own balancer may use the same one). Still true: a computer behind a home router does not know its public address, so there the line is for you to read.' },
      { who: 'router', text: 'A router that lost its records does not open a second channel when the node is only out of reach. A router with its session key but no channel file (a container that restarted, a wiped home folder) finds its open channel on chain and asks the node where it stands. If the node did not answer, it used to treat that as "no channel" and open a new one, locking a second deposit beside the first until you closed one yourself. Now the request fails for that node, nothing is opened, and the next request asks again; the search on chain is tried twice before the router gives up on it. Still as before: a node that answers and is owed more than the last voucher it holds (the router stopped between an answer and its voucher) gets a new channel, because a router without its records cannot check that claim.' },
      { who: 'router', text: 'A router told to stop finishes paying first. The voucher for an answer is handed to the node right after the answer, without holding the answer up, so a router stopped in that instant (Ctrl-C, a container being replaced) left the node owed for an answer it held no signature for. On SIGINT or SIGTERM `orrery router` now lets answers in flight finish and hands over the vouchers still on their way, for at most 20 seconds, then exits; asked again a second later it stops at once. Measured on mainnet by stopping the router the instant its answer arrived: 0.1.15 left the node owed $0.000034 beyond its voucher; this one stayed 0.3 s longer and left nothing. The next request would have paid that either way; what it prevents is a router without its records being unable to pick the channel back up.' },
      { who: 'provider', text: 'A node says when its data folder may not outlive a restart. Since 0.1.15 a node waits until redeeming is worth the fee, so between redemptions what routers signed to it exists only in the ledger file in its data folder. `orrery provider check` now has a `data folder` line with the folder and what is waiting there, which fails for a temporary folder and warns for a folder on a container’s own disk (no disk mounted there); a node says the same once when it starts. It reads the signs it can see; a folder it does not flag is not a promise.' },
      { who: 'router', text: 'A node that is away for a moment costs you a short wait, not an error. When no node for a model could be reached (it did not answer, or something in front of it answered 502, 503 or 504) the request failed at once, and the node was then set aside for 15 seconds, doubling with each failure up to five minutes, so with one node for a model a restart on its side became minutes of refusals on yours. Now a request whose nodes are all away waits 1.5 seconds and goes round again, then every 3 seconds, while it has been open for less than 8 seconds (`--patience <seconds>`, 0 for the old behaviour); one request can ask for its own with `x-orrery-patience: <seconds>` (0 to 30), so an agent with somewhere else to go fails at once and one that would rather wait does; and a cooldown only sends requests to the other nodes of a model: when there is no other, the node is asked again. A node that answers and refuses is not asked twice. Measured on mainnet by cutting the path to the node for two seconds: 0.1.15 answered 502 in 8 ms and then 503 for the request after it; this one answered both, the first after 6.6 s. With the node away for nine seconds, a request sent with `x-orrery-patience: 20` was answered after 11.3 s, and one with `0` got its 502 in 8 ms. When every node did fail, the 502 carries `Retry-After: 3`, the header OpenAI and Anthropic SDKs read before they try again.' },
      { who: 'router', text: 'A node listed by an IPv6 address is reached through either kind of proxy. Through SOCKS5 the router refused it outright ("not supported yet"), and the URL kept its brackets on the way to the tunnel, so a SOCKS5 proxy was sent `[::1]` as if it were a name; an HTTP proxy got the brackets right by accident. Now a SOCKS5 proxy is sent the address as its 16 bytes, the way curl sends it, an HTTP proxy is asked for `CONNECT [addr]:port`, and a name still goes to either proxy as the name, so the lookup happens there. Checked against curl with the same test proxy; this machine has no IPv6 route, so not yet on a real IPv6 path.' },
      { who: 'provider', text: 'A node answering `GET /v1/seen` no longer tells callers the private addresses of the network in front of it. Behind a hosting balancer, 0.1.15 gave every caller the balancer’s private hop as `socket` (and any private address in `X-Forwarded-For`). Now, once one of the addresses is public, the private ones are left out and `socket` is empty when it is private; on one machine or one private network nothing changes. Checked on our own node, which gave its balancer’s private hop to every caller until this.' },
      { who: 'router', text: 'A request’s length no longer shows the prompt’s length. Sealing keeps the length of what it seals, and length is what a proxy, the network and a node’s balancer see, so a proxy could tell a seven-character question from a page of text. The router now pads each request with spaces (JSON ignores them) to a size class before sealing: 1 KiB, doubling up to 64 KiB, then every 64 KiB. Measured on mainnet through a local proxy, one request to our node: with 0.1.15 a 644-character prompt sent 848 bytes more than a 7-character one; with this, 1 byte more. ' },
      { who: 'provider', text: 'A node pads each sealed frame of an answer to whole 256-byte blocks. A streamed answer goes out about a token per frame, and the length of each sealed frame is visible on the way, so unpadded frames spell out the length of every token, which is enough to guess at the text. In the rehearsal, one answer of 20 frames came out in 12 different lengths; now in one. Routers of any version read the padded frames. Still visible: how many frames, and when.' },
      { who: 'router', text: 'An agent working through `orrery mcp` is told what its task has left. When `ask` runs under a task, the answer ends with what the task has spent and has left, and so does a refusal for its budget, so an agent knows to stop or to raise the budget without parsing an error sentence. `status` lists every task with its budget, what it has spent and has left, and how many answers it paid for.' },
      { who: 'everyone', text: 'Payment travels inside the seal. Every request carried its channel and its voucher as headers, and a hosting platform in front of a node ends TLS and can read headers: which channel, and so which wallet, every request was paid from, even when the prompt was sealed and the router sat behind a proxy. A node now says on `/v1/wire` that it reads payment from inside the sealed body; to such a node the router puts the channel and voucher there, sends no payment headers, and hands over each voucher sealed too. Older nodes still get headers, and new nodes still read them from older routers. Not covered yet: the flag is not signed (a platform rewriting the node’s answers could strip it), and the call a router makes to pick a channel back up after losing its records still names the channel.' },
      { who: 'router', text: 'A channel the node released no longer stalls the router. When a node closes a router’s channel (it may, and the rest goes straight back to the wallet), it then answers that channel with 404, and the router kept sending on it and failing, for that node, until its own five-minute check of the channel came round. Now a node’s 404 `unknown_channel` or 409 `channel_closing` makes the router let the channel go and send the same request once more on a fresh one. Found while writing a rehearsal check: once the node’s cache of the released channel ran out, seven other checks failed with it.' },
      { who: 'everyone', text: 'Picking a channel back up is sealed too. A router that lost its records finds its channel on chain and asks the node where it stands: the latest voucher the node holds and what it is owed. That question named the channel in the address (`GET /orrery/channel?address=`) and the answer carried the channel and its voucher in the clear, so a hosting platform in front of the node could still tie one wallet to its requests, the thing payment inside the seal had just closed. To a node that reads payment inside the seal the router now asks by `POST /orrery/channel`, sealed to the node’s wire key, and the node answers sealed with the same key, padded to whole 256-byte blocks. What the front sees is that a router asked. Older nodes are asked as before.' },
      { who: 'router', text: 'A router picking a channel back up carries on whenever the node is owed nothing beyond its voucher. It asked for the node’s own tally to equal the voucher exactly, and a node can count a little less than the router signed for (our node on mainnet: 13 units, $0.000013, under). The router then set the channel aside, and the next request would have opened a second one beside it. Now it refuses only when the node counts more than the voucher, which means answers the router has no record of paying for.' },
      { who: 'everyone', text: 'The flag a node sets to say it reads payment inside the seal is signed, and a router keeps to it. Unsigned, a hosting platform in front of a node could strip it from `/v1/wire` and get the channel and voucher back as headers, or hide the wire key and get the prompt in the clear. Now the node signs the flag with its node key for its wire key (`insideSig`), and a router that has read it signed keeps that node key in `router/pins.json`: a missing flag no longer brings headers back, and a missing wire key means nothing goes to that node in the clear, neither a request nor a question about a channel, until the key shows again. Left: a platform that strips both before a router has ever reached the node.' },
      { who: 'provider', text: '`orrery provider check` reads your node’s wire key from its public address, the way routers read it, and says when what arrives is not what the node signs. A hosting platform in front of a node can drop the signed flag that payment goes inside, or the whole key, and then routers new to the node send the channel in headers, or the request in the clear. The new `wire key` line names which: no answer, not signed by this node key, another node’s key, or the flag dropped.' },
      { who: 'router', text: '`orrery doctor` says how each node gets your request and your payment. Under every node that answers, a `sealing` line: sealed to the node’s own key with the payment inside (both signed by its node key), sealed with the payment in headers its host can read, or plain JSON inside TLS. It also says when this router keeps to a node’s signed flag, and fails a node that showed a signed wire key before and shows none now.' },
      { who: 'router', text: 'An agent can ask how its requests travel. The router’s `/orrery/status` gives each node a `sealing` value: `inside` (request and payment sealed to the node’s own key), `request` (sealed, payment in headers its host can read), `plain` (JSON inside TLS) or `withheld` (the node showed a signed wire key before and shows none now, so the router sends it nothing). The `status` tool of `orrery mcp` says the same in words next to each node.' },
      { who: 'provider', text: 'A node answers a sealed voucher hand-over sealed. The voucher went to the node sealed, but the answer, what the channel has paid in total and what it owes, came back in the clear, and a total is the one before plus a price: the node’s front could chain one wallet’s answers together and match them to what is redeemed on chain. Now the answer is sealed with the same key and padded to 256 bytes. A router never needed to read it; an older router sending the voucher in the clear gets the plain answer as before.' },
      { who: 'everyone', text: 'A node’s 402 is sealed to a router that pays inside the seal. When a node is owed for an answer it holds no voucher for, or a channel is running out, it refuses with 402 and the details: what the channel has paid and owes, the unpaid answers, the deposit. Those went back in the clear, and totals chain one wallet’s requests together while a deposit can name the channel on chain. Now they are sealed with the request’s own key and padded; the code (`payment_required`, `channel_exhausted`) stays readable, and the router opens the rest, pays the unpaid answer and goes on as before.' },
      { who: 'router', text: 'Every answer says how its payment traveled: `x-orrery-payment: inside` when the channel and voucher went inside the seal, `headers` when they went as headers to an older node. Under `orrery mcp`, an `ask` answer ends with one line on how it traveled: sealed to a verified enclave, sealed to the node’s own key (payment inside, or in headers its host can read), or plain JSON inside TLS.' },
      { who: 'router', text: 'The `status` tool of `orrery mcp` tells an agent how its requests leave this computer: through which proxy and what address a node sees there, that the router has stopped because a node saw this computer’s own address, or that there is no proxy and nodes see the address requests leave from. With `--private-only` it says so too.' },
      { who: 'provider', text: 'A node tells its operator how routers paid it. Each answer in the node’s log now says whether its payment came inside the seal, and `orrery provider earnings` (and the node’s local `/orrery/earnings`) ends with how many of the window’s answers were paid that way; the rest named their channel in headers the node’s host can read, which is what routers before 0.1.16 do.' },
    ],
  },
  {
    version: '0.1.15',
    at: '2026-11-12T08:35:50Z',
    headline: 'Ask a node what address it sees of you, one connection carries answer after answer, and a job refused for its budget is told what is left.',
    changes: [
      { who: 'everyone', text: 'Ask a node what address it sees. A router behind `--proxy` could only say what it was told to do; now the far side says what arrived. A node answers `GET /v1/seen` with the address of the connection it accepted and whatever a balancer or forwarding proxy wrote into `X-Forwarded-For`, and `orrery doctor` asks the first node that answers, through your proxy, and prints it on a `seen as` line. The line fails when a proxy is set and the node saw one of this computer’s own addresses: a forwarding HTTP proxy passed it on in a header, or the proxy sends from this computer. Nodes on older releases do not answer, and doctor says so.' },
      { who: 'everyone', text: 'A node’s connection carries one answer after another. The router stopped reading an answer at `[DONE]`; over a real network the end of the stream arrives a moment later, so the stream was dropped and the connection with it, and every answer paid for a new connection and a new TLS handshake. It now reads each answer to its end (for a second at most), finishes the voucher’s reply and lets go of refusals it will not read. A node that is slow to end its answer does not hold yours up: the router waits 150 ms for the end and reads the rest in the background. Counted on mainnet: behind a proxy the same three requests that opened 6 tunnels in 0.1.14 open 3 (one to the node for the whole session, two to the RPC), and without a proxy six answers that opened 7 new connections to the node in 0.1.14 open 2. We could not measure the time saved per answer: the model’s own variation is larger.' },
      { who: 'router', text: 'A request refused for a job’s budget says what the job has spent and has left in headers. Every answer under a task already carried `x-orrery-task-spent` and `x-orrery-task-left`; the 402 that ends the job carried neither, so an agent had to read the remainder out of the error sentence. Both refusals now carry both headers: `over_budget` when what is left cannot cover one more request, and `task_budget_spent` when nothing is left (`x-orrery-task-left: 0.000000`).' },
      { who: 'provider', text: 'A node does not redeem dust. A redemption is a transaction and costs its fee whatever it moves, and a node with no minimum set redeemed any amount at all: ours was paying about 0.00001 SOL to collect $0.00002. With no `redeem.minUnits` in your config a channel is now redeemed once five cents are waiting on it (`provider init` writes the same), a channel that is closing is still redeemed whatever it holds, and `orrery provider redeem` still redeems everything when you ask. `orrery provider check` says so when your minimum is under a cent. What a router has signed stays yours until then: a voucher does not expire.' },
    ],
  },
  {
    version: '0.1.14',
    at: '2026-11-12T04:02:41Z',
    headline: 'Behind a proxy the router speaks SOCKS5 and keeps its tunnels open, and a job that is out of budget is told so with a 402.',
    changes: [
      { who: 'router', text: '`--proxy` speaks SOCKS5 as well as HTTP. `orrery router --proxy socks5://127.0.0.1:9050` sends everything the router sends, to nodes and to the Solana RPC, through a SOCKS5 proxy, with a name and password if the address carries them. The proxy is given the host’s name, so the lookup happens there and not on your machine, and TLS to the node runs inside the tunnel. As with an HTTP proxy there is no fallback: a proxy that is down, refuses or is not SOCKS5 fails the request. Checked on mainnet through a local SOCKS5 server (18 tunnels, every one asked for by name) and against curl as a second client of the same server; not yet run through Tor itself.' },
      { who: 'router', text: 'Behind a proxy, tunnels are kept and reused. In 0.1.13 every request to a node and every RPC call opened a new connection to the proxy, a new tunnel and a new TLS handshake. Now the next request to the same host rides the tunnel that is already open, one request at a time on each; a tunnel the far end has closed is replaced once without failing the request, and one that carries nothing for two minutes is shut. The same three mainnet requests that opened 16 tunnels in 0.1.13 open 6 in 0.1.14. Tunnels made under one set of TLS rules are never handed to a request made under another, and changing the proxy closes the old ones.' },
      { who: 'router', text: 'A job that cannot afford one more request is answered 402, not 404. When what is left of a task budget could not cover the worst case of the next request, the router refused it as `over_budget` with status 404, which reads like a missing model to a client. It is 402 (payment required) now, with the same message saying what is left. A per-request budget (`x-orrery-max-cost`) that nothing fits is still 404: that one is a search with no result.' },
    ],
  },
  {
    version: '0.1.13',
    at: '2026-11-11T23:14:31Z',
    headline: 'Behind a proxy your router shows nobody where you are, any tool can carry a job’s budget in its API key, and every answer says where its time went.',
    changes: [
      { who: 'router', text: 'A node no longer has to learn your address, and neither does your RPC. `orrery router --proxy http://127.0.0.1:8118` (or `ORRERY_PROXY`) sends every request to a node through an HTTP proxy you choose, so the node sees the proxy’s address and not yours. For an https node the router asks the proxy for a tunnel and speaks TLS to the node inside it; requests are already encrypted to the node’s own key, so the proxy learns which node and how many bytes, and nothing of what was said. There is no fallback: with the proxy down a request fails, it does not go out directly, and a router will not start with a proxy that does not answer. The Solana RPC goes the same way: its calls are tunnelled too, and transactions are confirmed by asking for their status because the RPC’s websocket is never opened. So do the chip makers’ certificate lists. On mainnet, a router started this way held connections to the proxy and to nothing else. SOCKS is not spoken yet, and every request opens a new tunnel, so it is slower than going direct.' },
      { who: 'router', text: 'A job’s name and budget can ride in the API key. Most tools let you set a key and nothing else, so the router now reads `orrery/<task>/<budget>` from the key field (`Authorization: Bearer` or `x-api-key`) the way it reads the `x-orrery-task` headers. Put `orrery/refactor/0.25` where Cursor, Continue, aider or an SDK asks for a key and that job stops at a quarter. `orrery run --budget 0.25 -- <any command>` does it for you and prints the bill when the command exits.' },
      { who: 'router', text: 'An answer says where its time went. The router times five stages of every answer: choosing the node, making sure a channel is open, sealing the request, the wait for the node’s first event, and signing the payment. They come back in the standard `Server-Timing` header (`route`, `channel`, `seal`, `node`, `sign`) and show with the answer on `/orrery/status`. On mainnet the four stages on your own machine came to between 2.3 and 3.7 ms across five requests in a row; the first request after a start spent about 400 ms reading its channel once. No transaction is in the request path: the router works from listings it already read, and a node re-reads a channel from chain at most once in 30 seconds (that read is part of `node`). The router’s own once-a-minute read of your $OREY balance used to hold up whichever request came next; it now runs in the background and requests use the last reading. A node reports its own part of the wait the same way, and the router passes it on as `node-open` (decrypting the request), `node-check` (the channel, the last voucher, the holder price) and `node-upstream` (its model server). Those three are the node’s own account; a node on an older version reports none.' },
      { who: 'router', text: 'An answer says what your router withheld. When a client attached ids (`user`, `metadata`, `safety_identifier`, a cache key), the response carries `x-orrery-withheld` with their names, never their values, and the router’s log line and record of the answer say the same.' },
      { who: 'router', text: 'The Intel TDX verifier checks the chip’s patch level. A quote says which microcode and TDX module the platform runs; Intel publishes a signed list of which versions are current for each platform family. Your router fetches that list from Intel, checks its signature against the same pinned root, and refuses an enclave Intel lists as out of date, revoked or unsupported. `orrery enclave verify` prints it as its own line (`--allow-outdated` to look anyway, `--offline` to skip). On the sample quote we test with, it says what Intel says: older than every level Intel supports.' },
      { who: 'router', text: 'The AMD SEV-SNP verifier checks the firmware level. AMD derives a different chip key for every firmware level, so the level a report states has to be the one its chip certificate was issued for, and the certificate has to be for that very chip. `orrery enclave verify` prints the level (boot loader, trusted OS, SNP firmware, microcode) as its own line, and `--min-firmware 3.0.8.115` (or `ORRERY_SNP_MIN_FIRMWARE` for a router) refuses anything below a floor you choose. AMD publishes no signed list of current levels, so the floor is yours to set.' },
      { who: 'router', text: 'The router takes its enclave policy as flags. `orrery router --min-firmware 3.0.8.115` refuses AMD enclaves below a firmware level you choose (the environment variable still works; the flag wins), and `--allow-outdated` lets your router seal to an Intel enclave that Intel lists as out of date, which it refuses by default. A level that does not parse stops the router before it starts. `orrery help` now lists `--enclave-images` as well.' },
      { who: 'router', text: '`orrery run` without `--budget` now gives the job a dollar. In 0.1.12 a run started without one had every request refused, because a job needs a budget from its first request; pass `--budget` there.' },
    ],
  },
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
