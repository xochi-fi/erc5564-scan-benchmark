# Phase 3: can a keyless wallet retrieve the whole announcement history?

**Question.** Can a wallet or web app with no account and no API key reliably fetch every
ERC-5564 `Announcement` from the canonical Announcer
`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, from its deploy block to head, on each chain?

**Short answer.** Yes on all seven chains, but only if the wallet chooses its endpoints
carefully. It also has to check what it gets back, because nothing in a response says
history is missing. Of the 190 keyless endpoints probed, 105 answered `eth_getLogs` and 77
served the deploy block. Their block-range caps ranged from 10 blocks to the whole history.
With an endpoint that takes the whole history, a cold start took 8-17 s and 30-52 requests
per chain. Base has no such endpoint: it needed 16,296 requests and 28 min, spread over
four hosts. Walking the chainlist order instead took 17 s to 72 min, and on Base it
failed after 8,000 requests. Four endpoints returned an empty result, with no error, for
windows that held real announcements: one on OP Mainnet and three on Base. One of them
silently dropped 48 Base announcements from a sequential cold start. One indexer was
missing 13 of 1,039 Sepolia announcements while reporting itself 0-2 blocks behind head.

Measured 2026-11-26 from the Bazzite host (residential connection), read-only, no keys,
User-Agent `erc5564-scan-benchmark/phase3 (public keyless log-retrieval study)`, at most
4 requests/s per host, with Retry-After-aware backoff on 429. Code: [`src/phase3/`](src/phase3/).
Raw results: [`data/phase3/`](data/phase3/).

## Summary per chain

Announcements are counted from the deploy block to the head at measurement time. Sources
agreeing on the exact set are listed in the Count column. Two sets are equal when they
have the same `(block, logIndex)` rows and the same transaction hash for every row. "Full
history" endpoints are keyless endpoints that returned a deploy-block window without an
error. The span column gives their largest accepted `eth_getLogs` range
(`toBlock - fromBlock + 1`).

| Chain | Deploy block | Announcements | First - last announcement | Per month (since first) | Keyless endpoints: listed / probed / answered getLogs / full history | Max span of full-history endpoints, blocks: median [min-max] | Best keyless cold start | Naive cold start (chainlist order) | Keyless indexers |
| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| Ethereum | 20,042,207 | **298**: Blockscout v2 = Routescan = RPC (2 endpoint sets) | 21,140,089 (2024-11-08) - 26,499,925 (2026-11-26) | 12.1 (30-36 in each of the last 3 months) | 72 / 36 / 17 / 11 | 1,001 [10 - whole history]; 2 took the whole history | OK, exact: 8 s, 30 requests, 335 KiB | OK, exact: 26 min, 1,299 requests | Blockscout v2 OK (50/page); Routescan OK (100/page, ~441 blocks behind head); Blockscout etherscan-API timed out (90 s) or 429 |
| Base | 15,502,414 | **679**: RPC only (matches both partial runs on their silent-free prefixes) | 16,819,551 (2024-07-08) - 62,245,129 (2026-11-25) | 23.7 | 41 / 33 / 16 / 11 (3 of the 11 return silent empty results) | 1,001 [10 - 63,752] (none took the whole history) | OK: 28 min, 16,296 requests, 1.4 MiB, 4 hosts in parallel (Pocket, Tenderly ×2, thirdweb, then Sentio). Sequential with the same order: FAILED at 66% of history (8,000-request budget), and 48 announcements silently missing (daybreak) | FAILED: 8,000-request budget spent at 17% of history (34 min, 457 announcements so far) | Blockscout: Cloudflare challenge (blocked); Basescan/Etherscan: key required |
| Arbitrum One | 219,468,264 | **19**: RPC (2 endpoint sets agree) | 434,497,958 - 522,929,374 | 2.1 | 35 / 27 / 15 / 12 | 551 [10 - whole history]; 1 took the whole history | OK: 14 s, 52 requests | OK: 17 s, 68 requests | Blockscout: Cloudflare challenge (blocked) |
| OP Mainnet | 121,097,390 | **2**: Blockscout v2 = Blockscout etherscan-API = RPC | 154,353,397 - 154,455,081 (2026-07-17..20) | 0.5 | 36 / 25 / 18 / 13 | 5,001 [50 - whole history]; 2 took the whole history | OK, exact: 10 s, 40 requests | OK, exact: 18 min, 3,930 requests | Blockscout (explorer.optimism.io) OK |
| Gnosis | 34,349,356 | **3**: RPC (2 endpoint sets agree) | 40,967,594 - 41,054,058 (2025-07) | 0.2 | 25 / 20 / 10 / 9 | 10,000 [101 - whole history]; 3 took the whole history | OK: 17 s, 34 requests | OK: 72 min, 4,268 requests | Blockscout: Cloudflare challenge (blocked) |
| Polygon PoS | 57,888,814 | **9**: RPC (2 endpoint sets agree) | 85,999,710 - 95,895,782 | 1.3 | 40 / 28 / 15 / 10 | 1,001 [51 - whole history]; 2 took the whole history | OK: 12 s, 40 requests | OK: 17 min, 4,026 requests | Blockscout: Cloudflare challenge (blocked) |
| Sepolia | 5,486,597 | **1,039**: Routescan = RPC (2 endpoint sets); **Blockscout has 1,026** | 6,241,244 (2024-07-04) - 12,186,737 | 36.2 | 30 / 21 / 14 / 11 | 10,001 [50 - whole history]; 2 took the whole history (one 3-block value excluded: a head-lag artifact, see caveats) | OK: 8 s, 30 requests | OK: 66 s, 80 requests | Blockscout v2 and etherscan-API: 13 missing; Routescan OK |

"Best keyless cold start" orders the endpoints the way a well-informed wallet would: full-history endpoints
first, by measured span. "Naive" uses the chainlist order of the endpoints that answered
a 10-block `eth_getLogs`. Both use the same adaptive client (below), start at a
10,000-block window, and fall back across up to 8 endpoints. Deploy blocks come from the
Blockscout creation transaction (Ethereum, OP Mainnet, Sepolia) or from an `eth_getCode`
bisection (the rest). Every deploy block was rechecked on two more endpoints: code at N,
none at N-1. The full table with request bytes and failure text is
[`data/phase3/summary.md`](data/phase3/summary.md) (also `summary.csv`); per-endpoint
results are in [`endpoints.csv`](data/phase3/endpoints.csv); cross-source comparisons
are in [`cross-source.csv`](data/phase3/cross-source.csv).

## Findings

1. **The block-range cap is the whole story, and it varies 10-million-fold.**
   Among keyless endpoints that serve the deploy block, the cap on one `eth_getLogs` ran from
   10 blocks (Blast) and 50 (Nodies, 1rpc) through 100 (dRPC, Tatum), 1,000 (Tenderly
   on Base, thirdweb, Sentio) and 5,000-10,000 (BlockPI, QuickNode, mainnet.optimism.io,
   Pocket) up to 10,000,000 (arb1.arbitrum.io: "only 10000000 are allowed"). A few took the whole history:
   Tenderly's gateway on Ethereum, Arbitrum, OP, Polygon and Sepolia; rpc.gnosischain.com
   and gateway.fm on Gnosis. The cap decides the cost of a cold start. Ethereum took 30
   requests with Tenderly and 1,299 requests (26 min) when a 5,000-block endpoint did the
   work. **Base has no keyless endpoint that takes more than about 10k blocks and serves
   history correctly.** Pocket is the only one over 1,000 that returned correct results,
   and it reported pruned history partway (finding 3). A cold start therefore needed
   16,296 requests (28 min spread over four hosts at ≤4 req/s each). One endpoint alone
   at 1,000 blocks per request would need about 47,000 requests, 3+ hours.
2. **The "10k recent blocks" wall is real, but it is an archive limit, not a range limit.**
   publicnode (Ethereum, Base, Arbitrum, OP, Polygon), blockreq (last 1,024 blocks),
   blockmachine (last 100-10,000), thyme (last 128) and blazingnode (128) answer recent
   ranges and refuse older ones. Their errors say so: "Archive requests require a
   personal token", "public endpoint only serves recent blocks (last 1024)",
   "Historical queries outside the latest 128 blocks require an API key". This is the
   failure DROO described to the working group: a wallet on such an endpoint sees nothing
   older than a few hours to days. Across chains, 7-19 of the probed endpoints (28-53%) did not
   answer `eth_getLogs` at all (key, paid plan, discontinued, Cloudflare block,
   unsupported method). See the "answered getLogs" column.
3. **Some endpoints lose history without an error.** public.1rpc.io on OP Mainnet
   returned `{"result": []}` four times for 50-block windows that contain a known
   announcement. Its deploy-block probe also "succeeded" with an empty result. Pocket
   (load-balanced backends) gave different answers to the same question: accepted
   spans of 10,438-70,538 blocks while its error text says "max 10001". It also answered
   one OP window correctly and then "pruned history unavailable" on the retry. Partway
   through the Base cold start it also reported pruned history. **On Base, three
   endpoints (base.daybreak-rpc.network, rpc.degenprotocol.io, rpc.baseazul.dev) return
   `[]` for windows that hold known announcements**, while Pocket and Tenderly return
   them. They passed the deploy-block probe the same way 1rpc did. This cost real data:
   the sequential informed cold start fell back to daybreak at block 34,304,282 and
   recorded 0 of the 48 announcements in blocks 34.3M-46.5M. The run finished those windows
   "successfully". A wallet that trusts one endpoint's empty answer can "lose" a payment.
   Only a second source shows the gap.
4. **Indexers help, where they are reachable, and they are not ground truth either.**
   Blockscout's keyless API v2 gave the full set in 1-21 pages on Ethereum, OP and
   Sepolia, 0-7 blocks behind head. On Base, Arbitrum, Gnosis and Polygon it answered our
   client with a Cloudflare challenge (recorded as blocked; not worked around). On
   Sepolia, Blockscout lacks 13 announcements in blocks 11,909,881-11,926,046: it knows the
   transactions, but `/transactions/{hash}/logs` returns HTTP 500. Routescan and both RPC
   endpoint sets have them. On Ethereum, 263 of 296 Blockscout v2 log rows (first fetch) carry an empty
   `transaction_hash`, so v2 cannot be compared on tx hash alone. Routescan
   (keyless etherscan-compatible API) covers only Ethereum and Sepolia among these
   chains, at 100 results per call and 51-471 blocks behind head. Etherscan v2 needs a
   key on every chain. Base on its free tier says: "Free API access is not supported for
   this chain".
5. **At today's volume, the data is tiny; access is the cost.** The full canonical
   history is 298 logs (335 KiB of JSON) on Ethereum, 1,039 on Sepolia, 679 on Base,
   and 2-19 elsewhere. Umbra's own contract, for comparison, has 25,558-102,552
   announcements on its four busiest chains (below), and one keyless endpoint returned
   100k of them in 55 requests. Median `eth_getLogs` latency on full-history endpoints was 42-924 ms
   (median of medians 69-127 ms per chain; worst p95 2.0 s). None of the endpoints that
   accepted a range was slow enough to matter. What dominates is how many requests the
   cap forces and the rate limit on each one: Tatum allows 5 requests/min, OnFinality
   and routeme answer 429 quickly, and Sentio returns HTTP 429 to mean "range too large".

## How the endpoints behave

Endpoint list: chainlist.org [`rpcs.json`](https://chainlist.org/rpcs.json), fetched
2026-11-26T14:02Z (`Last-Modified: Mon, 23 Nov 2026 11:43:44 GMT`, SHA-256
`bd7786b2…0996a`). The per-chain URL lists are in [`endpoints.json`](data/phase3/endpoints.json).
Excluded before probing: URLs with a key in the query string, key-shaped path segments
(including published demo keys), `${…}` templates, websockets, and transaction-relay/MEV
endpoints (Flashbots, MEV Blocker, bloXroute, …). That leaves 21-36 candidates per chain.

Per endpoint, the probe ([`probe.ts`](src/phase3/probe.ts)) runs these steps:

1. `eth_chainId` and `eth_blockNumber`, then a 10-block `eth_getLogs`.
2. A max-span search ending at head. It grows ×4 from 1,000 blocks up to the whole history
   (deploy block to head), tests common round limits, then bisects, retrying a transient
   failure once.
3. Archive depth: one window at 10^4, 10^5, … blocks behind head, and one at the deploy block.
4. For chains with a reference set, the window holding the first known announcement.
5. 10 latency samples with fixed spans of ≤1,000 blocks.

The [consistency check](data/phase3/consistency/) later re-asked each full-history
endpoint for 100-block windows around the first, middle and last known announcement,
twice each.

Error messages are recorded verbatim (first 300 chars) and classified as range-limit,
result-limit, rate-limit, archive-missing, auth-required, unsupported, timeout, blocked
or other. The classifier is tested on 139 recorded messages
([`test/fixtures/phase3/rpc-errors.json`](test/fixtures/phase3/rpc-errors.json)). Some
recorded messages, with code and the cap they mean:

| Message (verbatim, trimmed) | Code | Meaning |
| --- | --- | --- |
| `You can make eth_getLogs requests with up to a 10 block range` (Blast) | -32600 | 10 blocks |
| `Block range too large: maximum allowed is 50 blocks on your current plan` (Nodies) | -32001 | 50 |
| `eth_getLogs is limited to 0 - 50 blocks range` (1rpc) | -32602 | 50 |
| `ranges over 100 blocks are not supported on free plan` (dRPC) | 35 | 100 |
| `Requested range is over limit of 100` (Tatum) | -16412 | 100 |
| `public eth_getLogs is limited to 1000 blocks` (Sentio, as HTTP 429) | 8 | 1,000 |
| `invalid params (Block range too large: maximum 1000 blocks without an API key)` (Tenderly on Base) | -32602 | 1,000 |
| `Log response size exceeded. Maximum allowed number of requested blocks is 1000` (thirdweb) | -32005 | 1,000 |
| `query exceeds max block range 2000` (daybreak, Base) | -32602 | 2,000 |
| `eth_getLogs is limited to 5000 block range` (BlockPI) | -32602 | 5,000 |
| `eth_getLogs is limited to a 10,000 range` (QuickNode Polygon, mainnet.optimism.io) | -32614 | 10,000 |
| `exceed maximum block range: 50000` (publicnode Base) | -32701 | 50,000 |
| `Archive requests require a personal token` (publicnode) | -32602 | no keyless history |
| `pruned history unavailable: requested 15502414, earliest available 51000000` (1rpc Base) | 4444 | no history before block 51M |
| `keyless requests are served for the most recent 100 blocks only` (blockmachine) | -32002 | recent only |

Results per response: no endpoint hit a result-count cap on the canonical Announcer,
which has at most 1,039 logs on any chain. On Umbra's contract (up to 102,552 logs per chain),
Tenderly served each chain's whole Umbra history in 31-55 requests (adaptive windows up
to 2^26 blocks, 1.4 MB per response on average on Arbitrum). On OP it twice refused a
range as too large a result (classified result-limit; the client halved).
Indexer pages are fixed: Blockscout v2 50 items, Blockscout etherscan-API 1,000,
Routescan 100. Fixed pages mean a cold start through an indexer costs at least
count/page requests.

Rate limits seen (429 or a quota message) during the probes: Tatum ("5 requests per
minute", Retry-After 60), OnFinality, routeme.sh (Retry-After 1), mainnet.base.org
("request limit reached"), thyme, thirdweb, Sentio (429 as its range error), and the Blockscout
etherscan-compatible API ("Too many requests. Increase limits now at
https://dev.blockscout.com"). The per-endpoint counts are the `rateLimitHits` column in
`endpoints.csv`. Latency: median of each full-history endpoint's median
`eth_getLogs` time (≤1,000-block spans, 10 samples) per chain was Ethereum 126 ms,
Base 127, Arbitrum 122, OP 107, Gnosis 96, Polygon 110, Sepolia 69. The range was
42-924 ms and the worst p95 2.0 s. With 10 samples, p95 is close to the maximum.

## The ScopeLift SDK default

`getAnnouncements` in `@scopelift/stealth-address-sdk` 1.0.0-beta.5 calls
`fetchLogsInChunks`. With no `fromBlock` it starts at block **0** (`'earliest'`) and
walks to head in **5,000-block** chunks, sequentially, with **no retry, no range
adaptation and no endpoint fallback**: one failed chunk fails the whole call. Using the
probe data:

| Chain | Requests from block 0 | Requests from the deploy block | Keyless endpoints that accept 5,000 blocks and serve the deploy block |
| --- | ---: | ---: | --- |
| Ethereum | 5,300 | 1,292 | 5 (xrpc.cl, BlockPI, Tenderly ×2, Pocket) |
| Base | 12,512 | 9,412 | 1 (Pocket, whose history and limits vary by backend) |
| Arbitrum One | 105,550 | 61,656 | 4 |
| OP Mainnet | 32,011 | 7,791 | 7 |
| Gnosis | 9,896 | 3,027 | 7 |
| Polygon PoS | 19,600 | 8,022 | 4 |
| Sepolia | 2,444 | 1,347 | 7 |

So, on a typical keyless endpoint (caps of 10-1,000 blocks), the SDK default fails on
the first chunk. On a good one it makes thousands of sequential requests, mostly over
blocks before the Announcer existed. At the measured median latencies, from block 0 that
is 7-28 min on Ethereum, and 1.5-3.4 h on Arbitrum. Passing `fromBlock` = deploy block
removes 25-76% of the requests. A chunk size the endpoint accepts, and a retry, do the rest.

## Other stealth-payment activity (extra scope)

Counted the same way (keyless RPC, deploy block to head, adaptive client). Data is in
[`data/phase3/umbra/`](data/phase3/umbra/). Umbra predates ERC-5564 and announces through
its own contract `0xFb2dc580Eed955B528407b4d36FfaFe3da685401`, event
`Announcement(address indexed receiver, uint256 amount, address indexed token, bytes32 pkx, bytes32 ciphertext)`.
Its deploy blocks were found by `eth_getCode` bisection and confirmed on two endpoints.

| Chain | Umbra deploy block | Umbra announcements | First - last | Canonical ERC-5564 Announcer |
| --- | ---: | ---: | --- | ---: |
| Ethereum | 12,343,914 | 25,558 | 2021-05-18 - 2026-11-24 | 298 |
| Base | 10,761,374 | 7,955 | 2024-02-20 - 2026-11-20 | 679 |
| Arbitrum One | 7,285,883 | 100,196 | 2022-03-18 - 2026-11-16 | 19 |
| OP Mainnet | 4,069,556 | 72,277 | 2022-03-18 - 2026-11-06 | 2 |
| Gnosis | 28,237,950 | 202 | 2023-06-08 - 2026-02-18 | 3 |
| Polygon PoS | 20,750,142 | 102,552 | 2021-11-03 - 2026-11-18 | 9 |
| Sepolia | 3,539,169 | 9,690 | 2023-05-31 - 2026-11-23 | 1,039 |

These are raw event counts: each is one stealth payment announced through Umbra (ETH or
a token). Counts were not filtered for spam or test traffic. The 296-298 figure is
therefore about the canonical singleton, not stealth payments in general. Most
EVM stealth-payment traffic so far is Umbra's own pre-standard event. (Blockscout v2 on
Sepolia again lacks some of these: 9,659 vs 9,690. Its v2 and Routescan pagings stopped
short on the large Umbra sets; see the reference files.)

Systems that cannot be counted this way, because they publish no on-chain announcement
log:

- **Fluidkey.** Stealth addresses are derived by Fluidkey's server from a viewing key the
  user shares with it (ERC-5564-style key derivation, no `Announcement` event). Dedaub's
  audit notes that the server uses the private viewing key to derive the ephemeral keys
  ([Fluidkey technical walkthrough](https://docs.fluidkey.com/technical-documentation/technical-walkthrough),
  [Dedaub audit, May 2024](https://dedaub.com/audits/fluidkey/fluidkey-stealth-account-kit-may-24-2024/)).
  Its payments look like ordinary transfers to fresh Safe accounts.
- Any scheme where sender and recipient exchange the ephemeral key off-chain (a
  payment link or message) leaves nothing to count on-chain either.
- Shielded pools (Railgun, Privacy Pools, Aztec) are a different mechanism and are not
  stealth-address announcements.

Not checked: other contracts that might emit a lookalike event. This section covers only the
canonical singleton and Umbra.

## What a wallet or web app should do so a payment never "disappears"

1. **Start a cold scan at the Announcer's deploy block, not block 0, and not "recent"**:
   Ethereum 20,042,207; Base 15,502,414; Arbitrum One 219,468,264; OP Mainnet
   121,097,390; Gnosis 34,349,356; Polygon PoS 57,888,814; Sepolia 5,486,597. Hard-code
   these per chain. A scan window of "the last N blocks" is how a claim seems to vanish.
2. **Checkpoint the next unscanned block, and advance it only after a window succeeded**
   (and has been scanned). An interruption then resumes rather than skips. Store the
   checkpoint with the viewing-key fingerprint and chain id. Keep found announcements
   separately so they don't depend on the checkpoint.
3. **Use an adaptive window, not a fixed one.** Start large (10k on L1s; probe
   the whole history first where the endpoint allows it). On a range, result-size or
   timeout error, use the number in the error message if there is one, otherwise halve.
   Grow again after a few successes. Treat HTTP 429 with a range message as a range error.
   **There is no single safe fixed page size:** the smallest cap among full-history
   keyless endpoints was 10 blocks on Ethereum, Base and Arbitrum, 50 on OP and Sepolia,
   51 on Polygon and 101 on Gnosis. 1,000 blocks worked on most full-history endpoints. Probe-free defaults that were safe
   on the endpoints listed first below: Ethereum 5,000 (BlockPI) or whole history
   (Tenderly); Base 1,000 (Tenderly) or ~10,000 (Pocket, unstable); not daybreak, degenprotocol or baseazul, which return silent empty results; Arbitrum whole history
   (Tenderly) or 10,000,000 (arb1); OP 10,000 (mainnet.optimism.io) or whole history
   (Tenderly); Gnosis whole history (rpc.gnosischain.com); Polygon 10,000 (QuickNode
   public) or whole history (Tenderly); Sepolia whole history (Tenderly).
4. **Fallback order: full-history endpoints first, by cap.** Treat an archive error
   ("archive requests require a token", "pruned history", "only serves recent blocks")
   as a reason to switch endpoints, not a reason to give up. Move endpoints whose cap is
   under ~1,000 blocks to the back. Retry 5xx/timeouts with backoff before switching.
   Ship the list with the app and re-probe it occasionally. Of the keyless chainlist entries,
   28-53% per chain were dead, keyed, discontinued, unsupported or behind Cloudflare on
   the day we looked.
5. **Never trust a single empty answer for history.** A clean `[]` from one endpoint
   is not proof of absence (finding 3). Cheap defences, given how small the data is: fetch
   the full history from two independent sources and compare counts per range. Or
   re-fetch any range that came back empty from a second endpoint before advancing the
   checkpoint, at least for ranges older than the endpoint's recent window. An indexer
   (Blockscout, Routescan) is a good second source where reachable, but compare it too
   (finding 4).
6. **What to show the user while history loads:** "Checking payments since <deploy
   date>: scanned to block N of M (x%)". Keep a visible "history incomplete" state until
   the checkpoint reaches head. If retrieval stops (all endpoints refused), say "could not
   check blocks A-B; your funds are not lost, retry or add an RPC URL", never "no
   payments". Show found payments as soon as their window is scanned, with the newest
   windows first (recent payments are most often what the user is waiting for), then
   backfill.
7. **Let the user add an RPC URL** (their own node, or a keyed provider) as the first
   fallback, and say which endpoint served each range.

## Caveats

- One day, one vantage point (a residential IP in Europe), one run per strategy. Public
  endpoint behaviour changes often (several chainlist entries were discontinued that day),
  and load-balanced services (Pocket, routeme, xrpc) answered the same query differently
  minutes apart. Treat caps as observed on 2026-11-26, not as documented limits.
- "Full history" means the endpoint returned the deploy-block window without an error. Four
  endpoints passed that check while returning empty results (finding 3). The consistency
  check catches these only for windows around known announcements (3 targets per chain). Only Ethereum,
  OP Mainnet and Sepolia have an independent indexer reference. On Base, Arbitrum,
  Gnosis and Polygon the reference is RPC runs over different endpoints. They agree exactly
  on Arbitrum, Gnosis and Polygon. On Base, the complete run agrees with both partial runs
  on every range not served by a silent endpoint.
- The max-span search ends at head. An endpoint that serves only recent blocks shows its
  recent window as its "span". The summary therefore reports spans only for full-history
  endpoints; `endpoints.csv` has all of them.
- Latency covers ≤1,000-block windows over a small event set. Response times for larger
  windows or heavier events are not characterised. p95 from 10 samples is close to the max.
- The client is a reference implementation in Bun, not a browser. A browser adds CORS:
  not tested here. Some endpoints may refuse browser origins.
- Blockscout Cloudflare challenges are recorded as blocked. A real browser may pass them.
  An automated client should not try to.
- The max-span search treats any error as "too wide". One load-balanced endpoint
  (publicnode Sepolia) answered "block range extends beyond current head" because its
  backend lagged; its recorded span of 3 is that artifact, not a cap. The classifier now
  treats that message as transient.
- Request rates were kept at ≤4/s per host. A wallet that parallelises harder will see
  more 429s than recorded here.

## Reproduce

```sh
bun install --frozen-lockfile
bun test test/phase3.test.ts   # no network: recorded error bodies, simulated endpoints
# Live, read-only, keyless; each stage writes JSON under data/phase3/ (overwrites).
bun run phase3 --stage endpoints                  # fetch chainlist rpcs.json and filter
bun run phase3 --stage reference                  # Blockscout / Routescan counts and deploy blocks
bun run phase3 --stage probe                      # per-endpoint limits, archive depth, latency (~10-25 min per chain)
bun run phase3 --stage retrieve                   # full history, list-order and probe-informed
bun run phase3 --stage retrieve --chains base --strategy parallel --max-requests 60000 --max-minutes 300   # resumable: rerun to continue
bun run phase3 --stage consistency,verify-deploy  # silent-miss check, deploy block recheck
bun run phase3 --stage umbra-reference,umbra-retrieve,umbra-verify-deploy
bun run phase3 --stage report                     # summary.md/csv, endpoints.csv, cross-source.csv
```

`--chains` takes a comma list of `ethereum,base,arbitrum,optimism,gnosis,polygon,sepolia`.
The probe and the naive cold start make several thousand requests per chain at ≤4/s per host.
