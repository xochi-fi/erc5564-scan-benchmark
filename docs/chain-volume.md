# Chain volume

How many ERC-5564 announcements exist per chain, and can a keyless client fetch them all?

Yes on all seven chains. Of 190 endpoints probed, 105 answer `eth_getLogs` and 77 accept a query from the deploy block.

<!-- generated:chain-volume -->
| Chain | Deploy block | Announcements | First - last announcement | Per month (since first) | Keyless endpoints: listed / probed / answered getLogs / full history | Max span of full-history endpoints, blocks: median [min-max] | Best keyless cold start | Naive cold start (chainlist order) | Keyless indexers |
| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| Ethereum | 20,042,207 | **298**: Blockscout v2 = Routescan = RPC (2 endpoint sets) | 21,140,089 (2024-11-08) - 26,499,925 (2026-11-26) | 12.1 (30-36 in each of the last 3 months) | 72 / 36 / 17 / 11 | 1,001 [10 - whole history]; 2 took the whole history | OK, exact: 8 s, 30 requests, 335 KiB | OK, exact: 26 min, 1,299 requests | Blockscout v2 OK (50/page); Routescan OK (100/page, ~441 blocks behind head); Blockscout etherscan-API timed out (90 s) or 429 |
| Base | 15,502,414 | **679**: RPC only (matches both partial runs on their silent-free prefixes) | 16,819,551 (2024-07-08) - 62,245,129 (2026-11-25) | 23.7 | 41 / 33 / 16 / 11 (3 of the 11 return silent empty results) | 1,001 [10 - 63,752] (none took the whole history) | OK, parallel: 28 min, 16,296 requests, 1,394 KiB | FAILED: 8,000-request budget spent at 17% of history (34 min, 457 announcements so far) | Blockscout: Cloudflare challenge (blocked); Basescan/Etherscan: key required |
| Arbitrum One | 219,468,264 | **19**: RPC (2 endpoint sets agree) | 434,497,958 (2026-02-21) - 522,929,374 (2026-11-10) | 2.1 | 35 / 27 / 15 / 12 | 551 [10 - whole history]; 1 took the whole history | OK: 14 s, 52 requests, 26 KiB | OK: 17 s, 68 requests | Blockscout: Cloudflare challenge (blocked) |
| OP Mainnet | 121,097,390 | **2**: Blockscout v2 = Blockscout etherscan-API = RPC | 154,353,397 (2026-07-17) - 154,455,081 (2026-07-20) | 0.5 | 36 / 25 / 18 / 13 | 5,001 [50 - whole history]; 2 took the whole history | OK, exact: 10 s, 40 requests, 4 KiB | OK, exact: 18 min, 3,930 requests | Blockscout (explorer.optimism.io) OK |
| Gnosis | 34,349,356 | **3**: RPC (2 endpoint sets agree) | 40,967,594 (2025-07-07) - 41,054,058 (2025-07-12) | 0.2 | 25 / 20 / 10 / 9 | 10,000 [101 - whole history]; 3 took the whole history | OK: 17 s, 34 requests, 5 KiB | OK: 72 min, 4,268 requests | Blockscout: Cloudflare challenge (blocked) |
| Polygon PoS | 57,888,814 | **9**: RPC (2 endpoint sets agree) | 85,999,710 (2026-04-25) - 95,895,782 (2026-10-21) | 1.3 | 40 / 28 / 15 / 10 | 1,001 [51 - whole history]; 2 took the whole history | OK: 12 s, 40 requests, 12 KiB | OK: 17 min, 4,026 requests | Blockscout: Cloudflare challenge (blocked) |
| Sepolia | 5,486,597 | **1,039**: Routescan = RPC (2 endpoint sets); **Blockscout has 1,026** | 6,241,244 (2024-07-04) - 12,186,737 (2026-11-22) | 36.1 | 30 / 21 / 14 / 11 | 10,001 [50 - whole history]; 2 took the whole history (one 3-block value excluded: a head-lag artifact, see caveats) | OK: 8 s, 30 requests, 1,227 KiB | OK: 66 s, 80 requests | Blockscout v2 and etherscan-API: 13 missing; Routescan OK |
<!-- /generated:chain-volume -->

One run on 2026-11-26 under the [live RPC rules](../METHODS.md#live-rpc), from the Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564` deployment to head, with User-Agent `erc5564-scan-benchmark/phase3 (public keyless log-retrieval study)` ([why](../METHODS.md#names-in-recorded-data)). "Full history" means the endpoint accepts a page starting at the deploy block.

| Strategy | Endpoint order | Page size |
| --- | --- | --- |
| Probe-informed | Largest measured span first | Adapts from 10,000 blocks, up to eight endpoints |
| List-order | Chainlist order | Adapts from 10,000 blocks, up to eight endpoints |
| Parallel (Base only) | Four workers over Pocket, two Tenderly hostnames, thirdweb and Sentio | 64 resumable chunks |

![Requests to fetch each chain's full history by strategy](figures/cold-start-requests.svg)
<sub>Hollow: stopped before head.</sub>

## Findings

1. Tenderly serves whole-history queries on five chains, and rpc.gnosischain.com and gateway.fm on Gnosis. A sequential Base backfill at 1,000 blocks per page needs ~47,000 requests and over 3 h.
2. publicnode requires a token for history on five chains. blockreq serves the last 1,024 blocks, blockmachine 100–10,000, thyme and blazingnode 128. Per chain, 28–53% of probed endpoints fail `eth_getLogs`.
3. Base's `base.daybreak-rpc.network`, `rpc.degenprotocol.io` and `rpc.baseazul.dev`, and OP's `public.1rpc.io`, pass the deploy-block probe but return `[]` for known announcements. OP has four misses in 50-block pages. The Base probe-informed run switches to Daybreak at block 34,304,282, finds nothing more, and spends its 8,000 requests by block 46,544,282 ([recovery](rpc-recovery.md#windows)). Pocket on OP spans 10,438–70,538 blocks despite a 10,001-block error, then reports pruned history. [Rechecked weekly](#weekly-refresh).
4. Blockscout v2 misses 13 Sepolia announcements in blocks 11,909,881–11,926,046 because `/transactions/{hash}/logs` returns HTTP 500. Its first Ethereum fetch lacks transaction hashes on 263 of 296 rows. Routescan lags 51–471 blocks.

## Weekly refresh

[`weekly-refresh.yml`](../.github/workflows/weekly-refresh.yml) re-measures these tables every Monday. The rest of this page is the 2026-11-26 recording.

<!-- generated:chain-volume-refresh -->
| Chain | Announcements, 2026-11-26 | Announcements, 2026-11-28 | Per day since 2026-11-26 | Per month (since first) | Last announcement | Checked through block | Run of 2026-11-28 |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Ethereum | 298 | **302** | 2.90 (1.4 days) | 12.3 | 26,500,859 (2026-11-26) | 26,510,117 (2026-11-28) | sets agree |
| Base | 679 | **685** | 4.70 (1.3 days) | 23.9 | 62,949,449 (2026-11-27) | 63,176,659 (2026-11-28) | sets agree |
| Arbitrum One | 19 | **19** | 0.00 (1.4 days) | 2.1 | 522,929,374 (2026-11-10) | 528,149,344 (2026-11-28) | sets agree |
| OP Mainnet | 2 | **2** | 0.00 (1.4 days) | 0.5 | 154,455,081 (2026-07-20) | 160,113,731 (2026-11-28) | sets agree |
| Gnosis | 3 | **3** | 0.00 (1.4 days) | 0.2 | 41,054,058 (2025-07-12) | 49,504,392 (2026-11-28) | sets agree |
| Polygon PoS | 9 | **9** | 0.00 (1.4 days) | 1.3 | 95,895,782 (2026-10-21) | 98,080,764 (2026-11-28) | sets agree |
| Sepolia | 1,039 | **1,040** | 0.71 (1.4 days) | 36.1 | 12,218,263 (2026-11-26) | 12,226,789 (2026-11-28) | sets agree |
<!-- /generated:chain-volume-refresh -->

<!-- generated:chain-volume-silent -->
| Chain | Endpoint | 2026-11-26: returned / empty / errors | 2026-11-28: returned / empty / errors | 2026-11-28 | Control |
| --- | --- | --- | --- | --- | --- |
| Base | `rpc.degenprotocol.io` | 4 / 2 / 0 | 6 / 0 / 0 | returns all | `base.gateway.tenderly.co` |
| Base | `base.daybreak-rpc.network` | 0 / 6 / 0 | 0 / 6 / 0 | still silent | `base.gateway.tenderly.co` |
| Base | `rpc.baseazul.dev` | 2 / 3 / 1 | 3 / 3 / 0 | still silent | `base.gateway.tenderly.co` |
| OP Mainnet | `public.1rpc.io` | 0 / 4 / 0 | 3 / 1 / 0 | still silent | `lb.routeme.sh` |
<!-- /generated:chain-volume-silent -->

Checks that differ between vantages ([method](../METHODS.md#weekly-refresh)):

<!-- generated:chain-volume-vantage -->
Only one vantage recorded so far (residential, Europe, 2026-11-28). The first scheduled run after merge adds the GitHub-hosted runner.
<!-- /generated:chain-volume-vantage -->

A new announcement counts only when two endpoint sets with no provider in common both return it. The job skips the indexers.

## Wallet guidance

1. Start at the deployment block. Advance a per-chain checkpoint only after a successful scan.
2. On range, size or timeout errors, use the reported limit or halve the page. 1,000 blocks works on most historical endpoints.
3. Try the user's RPC first, then fallbacks by cap. Record which endpoint served each range.
4. [Cross-check](rpc-recovery.md) empty pages against a second provider.

| Chain | Observed starting spans |
| --- | --- |
| Ethereum | 5,000 on BlockPI. Whole history on Tenderly. |
| Base | 1,000 on Tenderly. About 10,000 on Pocket, with unstable results. Daybreak, Degen Protocol and Base Azul silently omit announcements. |
| Arbitrum | 10,000,000 on arb1. Whole history on Tenderly. |
| OP Mainnet | 10,000 on mainnet.optimism.io. Whole history on Tenderly. |
| Gnosis | Whole history on rpc.gnosischain.com. |
| Polygon | 10,000 on QuickNode public. Whole history on Tenderly. |
| Sepolia | Whole history on Tenderly. |

## ScopeLift SDK default

Without `fromBlock`, the SDK's `getAnnouncements` walks from block 0 in sequential 5,000-block pages with no retry or fallback. One failed page fails the call. Endpoints capped below 5,000 blocks reject the first request.

| Chain | Requests from block 0 | Requests from the deploy block | Keyless endpoints that accept 5,000 blocks and serve the deploy block |
| --- | ---: | ---: | --- |
| Ethereum | 5,300 | 1,292 | 5 (xrpc.cl, BlockPI, Tenderly ×2, Pocket) |
| Base | 12,512 | 9,412 | 1 (Pocket, whose history and limits vary by backend) |
| Arbitrum One | 105,550 | 61,656 | 4 |
| OP Mainnet | 32,011 | 7,791 | 7 |
| Gnosis | 9,896 | 3,027 | 7 |
| Polygon PoS | 19,600 | 8,022 | 4 |
| Sepolia | 2,444 | 1,347 | 7 |

At median latency, a scan from block 0 takes 7–28 min on Ethereum and 1.5–3.4 h on Arbitrum.

## Endpoint behavior

Candidates come from chainlist.org [`rpcs.json`](https://chainlist.org/rpcs.json) of 2026-11-26T14:02Z (SHA-256 `bd7786b2…0996a`), minus keyed, templated, websocket and MEV endpoints: 21–36 per chain. [`probe.ts`](../src/chain-volume/probe.ts) measures max span, archive depth and latency (10 samples at ≤1,000 blocks, so p95 is near the maximum).

The consistency check queries each full-history endpoint twice around three known announcements per chain. 65 of 87 return every announcement; the rest error or answer `[]`. A query from the deploy block counts as full history even if it omits announcements. The error classifier is tested on 139 [recorded messages](../test/fixtures/chain-volume/rpc-errors.json).

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

| Behavior | Observed |
| --- | --- |
| Result-count cap | None hit. Tenderly serves each chain's Umbra history in 31–55 requests, pages up to 2^26 blocks, 1.4 MB per response on Arbitrum. |
| Indexer page size | Blockscout v2 50, etherscan API 1,000, Routescan 100 announcements |
| Rate limits | Tatum (5 per min, Retry-After 60), OnFinality, routeme.sh (Retry-After 1), mainnet.base.org, thyme, thirdweb, Sentio, Blockscout etherscan API |
| Median `eth_getLogs` time | Ethereum 126 ms, Base 127 ms, Arbitrum 122 ms, OP 107 ms, Gnosis 96 ms, Polygon 110 ms, Sepolia 69 ms; range 42–924 ms, worst p95 2.0 s |

## Umbra

Umbra predates ERC-5564 and has its own contract, `0xFb2dc580Eed955B528407b4d36FfaFe3da685401`, event `Announcement(address indexed receiver, uint256 amount, address indexed token, bytes32 pkx, bytes32 ciphertext)`. Counts include spam and test traffic.

| Chain | Umbra deploy block | Umbra announcements | First - last | Canonical ERC-5564 Announcer |
| --- | ---: | ---: | --- | ---: |
| Ethereum | 12,343,914 | 25,558 | 2021-05-18 - 2026-11-24 | 298 |
| Base | 10,761,374 | 7,955 | 2024-02-20 - 2026-11-20 | 679 |
| Arbitrum One | 7,285,883 | 100,196 | 2022-03-18 - 2026-11-16 | 19 |
| OP Mainnet | 4,069,556 | 72,277 | 2022-03-18 - 2026-11-06 | 2 |
| Gnosis | 28,237,950 | 202 | 2023-06-08 - 2026-02-18 | 3 |
| Polygon PoS | 20,750,142 | 102,552 | 2021-11-03 - 2026-11-18 | 9 |
| Sepolia | 3,539,169 | 9,690 | 2023-05-31 - 2026-11-23 | 1,039 |

Blockscout v2 returns 9,659 on Sepolia.

[Fluidkey](https://docs.fluidkey.com/technical-documentation/technical-walkthrough) emits no announcement: its server derives stealth addresses from the user's viewing key ([Dedaub audit, May 2024](https://dedaub.com/audits/fluidkey/fluidkey-stealth-account-kit-may-24-2024/)). Off-chain ephemeral keys and shielded pools (Railgun, Privacy Pools, Aztec) leave nothing to count either.

## Caveats

- One run per strategy. Caps hold for 2026-11-26. Pocket, routeme and xrpc change answers within minutes.
- Indexer references exist only for Ethereum, OP and Sepolia.
- A lagging Sepolia publicnode backend gives a spurious 3-block span.

## Reproduce

Live stages are read-only and keyless and write JSON under `results/chain-volume/`. `--chains` takes `ethereum,base,arbitrum,optimism,gnosis,polygon,sepolia`. Later stages read earlier ones from the same `--output`. `--output data/chain-volume` replaces the recorded data.

```sh
bun test test/chain-volume.test.ts   # no network: recorded error bodies, simulated endpoints
bun run chain-volume --stage endpoints                  # fetch and filter chainlist rpcs.json
bun run chain-volume --stage reference                  # Blockscout / Routescan counts and deploy blocks
bun run chain-volume --stage probe                      # limits, archive depth, latency (~10-25 min per chain)
bun run chain-volume --stage retrieve                   # full history, list-order and probe-informed
bun run chain-volume --stage retrieve --chains base --strategy parallel --max-requests 60000 --max-minutes 300   # resumable: rerun to continue
bun run chain-volume --stage consistency,verify-deploy  # silent-miss check, deploy block recheck
bun run chain-volume --stage umbra-reference,umbra-retrieve,umbra-verify-deploy
bun run chain-volume --stage report                     # summary.md/csv, endpoints.csv, cross-source.csv
bun run chain-volume:refresh --vantage 'residential, Europe'   # weekly refresh, writes refresh/<date>.json
```


[Raw results](../data/chain-volume/) · [Run metrics](../data/chain-volume/summary.md) · [Endpoints](../data/chain-volume/endpoints.csv) · [Provider comparisons](../data/chain-volume/cross-source.csv) · [Consistency checks](../data/chain-volume/consistency/) · [Umbra](../data/chain-volume/umbra/) · [Code](../src/chain-volume/)
