# Phase 3: keyless ERC-5564 history retrieval

**Public RPCs can silently omit ERC-5564 announcements.** On Base, one endpoint skipped 48 logs during sequential backfill. The parallel run reached head in 28 minutes and 16,296 requests using four workers and five hostnames across four providers.

Keyless scans reached head on seven chains. Where an endpoint accepted the entire history, cold starts took 8–17 s and 30–52 requests. Of 190 endpoints probed, 105 answered `eth_getLogs` and 77 accepted the deploy-block query.

The read-only Bazzite run on 2026-11-26 queried canonical Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564` from deployment to the measured head. It used a residential IP, ≤4 requests/s per host, Retry-After-aware HTTP 429 backoff and User-Agent `erc5564-scan-benchmark/phase3 (public keyless log-retrieval study)`.

[Code](src/phase3/) · [Raw results](data/phase3/)

## Summary per chain

The Announcements column lists agreeing sources. Comparisons use `(block, logIndex)`
and check transaction hashes where available. "Full history" means an endpoint
accepted a deploy-block window. Span counts both endpoints of the block range
(`toBlock - fromBlock + 1`).

| Chain | Deploy block | Announcements | First - last announcement | Per month (since first) | Keyless endpoints: listed / probed / answered getLogs / full history | Max span of full-history endpoints, blocks: median [min-max] | Best keyless cold start | Naive cold start (chainlist order) | Keyless indexers |
| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| Ethereum | 20,042,207 | **298**: Blockscout v2 = Routescan = RPC (2 endpoint sets) | 21,140,089 (2024-11-08) - 26,499,925 (2026-11-26) | 12.1 (30-36 in each of the last 3 months) | 72 / 36 / 17 / 11 | 1,001 [10 - whole history]; 2 took the whole history | OK, exact: 8 s, 30 requests, 335 KiB | OK, exact: 26 min, 1,299 requests | Blockscout v2 OK (50/page); Routescan OK (100/page, ~441 blocks behind head); Blockscout etherscan-API timed out (90 s) or 429 |
| Base | 15,502,414 | **679**: RPC only (matches both partial runs on their silent-free prefixes) | 16,819,551 (2024-07-08) - 62,245,129 (2026-11-25) | 23.7 | 41 / 33 / 16 / 11 (3 of the 11 return silent empty results) | 1,001 [10 - 63,752] (none took the whole history) | OK, parallel: 1.4 MiB (see above) | FAILED: 8,000-request budget spent at 17% of history (34 min, 457 announcements so far) | Blockscout: Cloudflare challenge (blocked); Basescan/Etherscan: key required |
| Arbitrum One | 219,468,264 | **19**: RPC (2 endpoint sets agree) | 434,497,958 - 522,929,374 | 2.1 | 35 / 27 / 15 / 12 | 551 [10 - whole history]; 1 took the whole history | OK: 14 s, 52 requests | OK: 17 s, 68 requests | Blockscout: Cloudflare challenge (blocked) |
| OP Mainnet | 121,097,390 | **2**: Blockscout v2 = Blockscout etherscan-API = RPC | 154,353,397 - 154,455,081 (2026-07-17..20) | 0.5 | 36 / 25 / 18 / 13 | 5,001 [50 - whole history]; 2 took the whole history | OK, exact: 10 s, 40 requests | OK, exact: 18 min, 3,930 requests | Blockscout (explorer.optimism.io) OK |
| Gnosis | 34,349,356 | **3**: RPC (2 endpoint sets agree) | 40,967,594 - 41,054,058 (2025-07) | 0.2 | 25 / 20 / 10 / 9 | 10,000 [101 - whole history]; 3 took the whole history | OK: 17 s, 34 requests | OK: 72 min, 4,268 requests | Blockscout: Cloudflare challenge (blocked) |
| Polygon PoS | 57,888,814 | **9**: RPC (2 endpoint sets agree) | 85,999,710 - 95,895,782 | 1.3 | 40 / 28 / 15 / 10 | 1,001 [51 - whole history]; 2 took the whole history | OK: 12 s, 40 requests | OK: 17 min, 4,026 requests | Blockscout: Cloudflare challenge (blocked) |
| Sepolia | 5,486,597 | **1,039**: Routescan = RPC (2 endpoint sets); **Blockscout has 1,026** | 6,241,244 (2024-07-04) - 12,186,737 | 36.2 | 30 / 21 / 14 / 11 | 10,001 [50 - whole history]; 2 took the whole history (one 3-block value excluded: a head-lag artifact, see caveats) | OK: 8 s, 30 requests | OK: 66 s, 80 requests | Blockscout v2 and etherscan-API: 13 missing; Routescan OK |

Probe-informed runs rank deploy-block-capable endpoints by measured span. The
list-order runs use Chainlist order for endpoints that answered a 10-block
`eth_getLogs`. Both adapt from an initial 10,000-block window and use up to eight
endpoints. The parallel strategy splits the range into 64 resumable chunks.

Deploy blocks come from Blockscout creation transactions on Ethereum, OP Mainnet and
Sepolia and `eth_getCode` bisection elsewhere. Two additional endpoints confirmed
code at the deploy block and no code at the previous block.
[Full run metrics](data/phase3/summary.md) · [Endpoint results](data/phase3/endpoints.csv) · [Source comparisons](data/phase3/cross-source.csv)

## Findings

1. **Whole-history queries work on six chains.** Tenderly accepted them on Ethereum, Arbitrum, OP Mainnet, Polygon and Sepolia. Gnosis also had rpc.gnosischain.com and gateway.fm. Base needed multiple endpoints (Pocket, two Tenderly hostnames, thirdweb and Sentio). At 1,000 blocks/request and 4 requests/s, a Base backfill would take ~47,000 calls and over three hours. [Base parallel run](data/phase3/canonical/retrieve-base-parallel.json)
2. **Recent access can hide archive limits.** publicnode required a token for history on five chains. blockreq served the last 1,024 blocks, blockmachine 100–10,000, thyme and blazingnode 128. Per chain, 28–53% of probed endpoints failed `eth_getLogs`. [Endpoint results](data/phase3/endpoints.csv)
3. **Successful responses can omit logs.** Base’s `base.daybreak-rpc.network`, `rpc.degenprotocol.io` and `rpc.baseazul.dev` and OP’s `public.1rpc.io` returned `[]` for known announcements despite passing the deploy-block probe. OP had four misses in 50-block windows. The Base probe-informed run switched to Daybreak at block 34,304,282, got no more logs and exhausted 8,000 requests at block 46,544,282 (66% through history). Parallel retrieval recovered the missing logs. Pocket’s OP response succeeded once and reported pruned history on retry. Observed spans varied from 10,438 to 70,538 blocks despite a 10,001-block error. [Consistency checks](data/phase3/consistency/) · [Base sequential run](data/phase3/canonical/retrieve-base-probe-informed.json)
4. **Indexers can also miss logs.** Blockscout v2 matched Ethereum and OP, but missed 13 Sepolia logs in blocks 11,909,881–11,926,046 with 0–2 blocks of head lag. It indexed the transactions, but `/transactions/{hash}/logs` returned HTTP 500. Routescan and both RPC runs returned those logs. The first Ethereum Blockscout v2 fetch lacked transaction hashes on 263 of 296 rows, so comparison used block and log index. Routescan lagged 51–471 blocks on Ethereum and Sepolia. Etherscan v2 requires a key and its free tier excludes Base. [Source comparisons](data/phase3/cross-source.csv)

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

Endpoints capped below 5,000 blocks reject the first request. At measured median
latencies, a scan from block 0 would take 7–28 minutes on Ethereum and 1.5–3.4 hours
on Arbitrum. Starting at deployment cuts requests by 25–76%.

## Other stealth-payment activity (extra scope)

Keyless adaptive scans counted Umbra logs from deployment to head. Umbra predates ERC-5564 and uses
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

These are raw Umbra payment announcements, including any spam or test traffic.
On Sepolia, Blockscout v2 returned 9,659 of the 9,690 observed logs. Its v2 and
Routescan pagination stopped short on the large Umbra sets.
[Umbra reference files](data/phase3/umbra/)

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

Coverage is limited to the canonical singleton and Umbra. Other contracts may emit similar events.

## Wallet retrieval and progress

1. Start at the Announcer deployment block. Store the next unscanned block, viewing-key fingerprint and chain ID. Advance only after a successful scan. Persist matches separately.
2. Adapt the window on range, result-size and timeout errors. Use a reported limit or halve the span, then grow after successes. Treat HTTP 429 with a range message as a range error. The smallest historical caps observed were 10 blocks on Ethereum, Base and Arbitrum, 50 on OP and Sepolia, 51 on Polygon and 101 on Gnosis. A 1,000-block span worked on most historical endpoints.
3. Prefer historical endpoints with larger caps. Switch on archive errors and retry transient failures with backoff. Smaller caps belong later in the fallback order. Allow a user-supplied RPC first and track which endpoint served each range.
4. Cross-check empty historical windows and compare exact identities where two independent sources are available. [Base omission replay](PHASE5.md)
5. Show scanned block ranges and found payments while backfilling. Keep history marked incomplete until catch-up. Report unresolved ranges with retry and RPC override options.

| Chain | Observed starting spans |
| --- | --- |
| Ethereum | 5,000 on BlockPI. Whole history on Tenderly. |
| Base | 1,000 on Tenderly. About 10,000 on Pocket, with unstable results. Daybreak, Degen Protocol and Base Azul returned silent omissions. |
| Arbitrum | 10,000,000 on arb1. Whole history on Tenderly. |
| OP Mainnet | 10,000 on mainnet.optimism.io. Whole history on Tenderly. |
| Gnosis | Whole history on rpc.gnosischain.com. |
| Polygon | 10,000 on QuickNode public. Whole history on Tenderly. |
| Sepolia | Whole history on Tenderly. |

## Caveats

- One run per strategy on 2026-11-26 from a residential IP in Europe. Some Chainlist endpoints were discontinued that day. Pocket, routeme and xrpc gave different answers minutes apart. Caps are observations for that date.
- A successful deploy-block query qualifies as “full history” even if it omits logs. The consistency check only tests windows around three known logs per chain. Only Ethereum, OP and Sepolia have indexer references. RPC-only comparisons agree on Arbitrum, Gnosis and Polygon, and on Base outside ranges served by silent endpoints.
- Max-span probes end at head, so recent-only endpoints show their recent window as their span. The summary uses deploy-block-capable endpoints, while [endpoints.csv](data/phase3/endpoints.csv) includes all spans. The search treated errors as range limits. A lagging publicnode backend in Sepolia produced a spurious 3-block span. The classifier now treats its “block range extends beyond current head” message as transient.
- Latency covers ≤1,000-block windows with few logs. With 10 samples, p95 is close to the maximum.
- The Bun client leaves browser CORS untested. Blockscout Cloudflare challenges count as blocked. Keep those challenges out of automated retries.
- Probes used ≤4 requests/s per host. Higher concurrency can trigger more 429s.

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
Probe-informed and parallel runs skip hosts flagged by any saved consistency results.
