# Shared feed

## Decision

Clients fetch every finalized feed page, scan locally with view tags, resume from a checkpoint, and retry a range when two independent feeds disagree; signed page commitments stay optional until [EIP-7745](https://eips.ethereum.org/EIPS/eip-7745) or [EIP-8304](https://eips.ethereum.org/EIPS/eip-8304) can prove completeness ([summary](../README.md)).

[OMR](paged-discovery.md#prior-work-and-omr-crossover) servers spend 4.1–59.8 ms per message per recipient on cloud AVX512 with 583–2,181 B clues and no DoS-resistant variant in production, and its ~20 ms decode beats the A76's 1.75 ms per announcement only above ~12/day, while the dual feed here recovered 48/48 and caught up cold in 38.8 ms (Bazzite) and 129–140 ms (Pi).

| Revisit when | Assumed budget | Breaks at |
| --- | --- | ---: |
| Daily A76 scan time | 3 min CPU at 1.75 ms each | ~100k/day |
| Daily feed bytes | 60 MB at ~620 B (2 × best format) | ~100k/day |
| Wallets cover Umbra-scale streams | — | ~100k per chain |

## Feed against live RPC

<!-- generated:shared-feed -->
| Path | Mode | Exact logs in sampled range | POST / GET | Request / response body bytes | Fetch (ms) | Scan (ms) | Page verification (ms) | First synthetic match (ms) | Catch-up (ms), median [min–max] |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live RPC | Cold | 48/48 | 71 / 0 | 16,679 / 83,147 | 6,834 | 41.4 | 4.8 | 3,928 | 19,327 [19,316–19,491] |
| Dual feed, loopback | Cold | 48/48 | 0 / 36 | 0 / 92,134 | 3.9 | 32.2 | 1.2 | 4.4 | 38.8 [38.4–51.1] |
| Live RPC | Warm | 28/28 | 39 / 0 | 8,935 / 58,987 | 3,833 | 23.6 | 2.8 | 2,829 | 10,530 [10,525–10,563] |
| Dual feed, loopback | Warm | 28/28 | 0 / 20 | 0 / 55,492 | 2.7 | 20.6 | 1.0 | 6.0 | 25.4 [25.1–30.9] |
<!-- /generated:shared-feed -->

Bazzite 45, Intel i7-13700K, Bun 1.4.4, 2026-11-27. Live Tenderly over the Internet against two prebuilt loopback HTTP feeds. Medians of three samples per arm and mode in one process, alternating arm order. Cold has no checkpoint. Warm reloads one written after eight pages (block 44,788,281) and excludes that prefix. Connections and runtime state can persist.

- Fetch sums request start to body read, overlapping GETs included. Body bytes are decoded, without headers or framing.
- RPC samples check chain ID, finalized block and pinned block, with request starts ≥275 ms apart. Feed samples make one manifest GET per source and two concurrent GETs per page.
- Catch-up includes parsing, pacing, discovery and checkpoint I/O. Page verification is log validation plus, for the dual feed, source agreement. First match is timed after the needed responses and the scan of its page group. No canonical log matched the synthetic recipient.

Response bytes for each path are compared in the [byte chart](#feed-format-search). Feed latency here is loopback. Remote RTT, hosting, caching, compression and provider limits will change the comparison.

## Omission and resume controls

<!-- generated:shared-feed-controls -->
| Control | Committed groups | Missed / recovered logs | GETs | Elapsed (ms) |
| --- | ---: | --- | ---: | ---: |
| Empty feed alone | 17/17 | 48 missed | 18 | 9.2 |
| Empty feed plus independent source | 1/17 | 48 pending | 8 | 0.7 |
| Resume with corrected source | 17/17 | 48 recovered | 34 | 36.8 |
| Same identities, altered ABI data | 1/17 | 48 pending | 8 | 1.1 |
<!-- /generated:shared-feed-controls -->

Both disagreement controls retried feed page 1 and held block 37,364,281. The omission resume reread the checkpoint, retried page 1 and skipped page 0. These omissions are injected into the frozen feed; the live one is in [RPC recovery](rpc-recovery.md). Shared upstream omissions can still agree falsely. Completeness covers the selected Base windows only.

## Turing nodes

Turing Pi RK1 nodes 1–3 (RK3588), Bun 1.4.4, 2026-11-27 17:20–17:36 UTC, one run per node in sequence, `taskset -c 4-7` on the four A76 cores. Kernels 5.10.160-rockchip (node 1), 6.1.0-1012-rockchip (node 2), 6.1.0-1025-rockchip (node 3). Feeds run on each node's loopback. Live RPC reaches Tenderly over the same home uplink as Bazzite. A sample started only once the hottest zone was ≤70 °C. None waited. Peaks were 62.8, 67.5 and 49.9 °C. The Bazzite run predates the gate and has no temperatures.

<!-- generated:shared-feed-hosts -->
| Path | Mode | Host | Fetch (ms) | Scan (ms) | Page verification (ms) | First synthetic match (ms) | Catch-up (ms), median [min–max] |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Live RPC | Cold | Bazzite | 6,834 | 41.4 | 4.8 | 3,928 | 19,327 [19,316–19,491] |
| Live RPC | Cold | node 1 | 8,331 | 127.0 | 8.9 | 3,948 | 19,414 [19,400–19,687] |
| Live RPC | Cold | node 2 | 12,183 | 121.5 | 8.2 | 4,182 | 19,865 [19,713–20,139] |
| Live RPC | Cold | node 3 | 8,354 | 118.5 | 9.3 | 3,948 | 19,443 [19,424–19,874] |
| Dual feed, loopback | Cold | Bazzite | 3.9 | 32.2 | 1.2 | 4.4 | 38.8 [38.4–51.1] |
| Dual feed, loopback | Cold | node 1 | 13.6 | 119.4 | 4.4 | 15.7 | 139.9 [129.9–160.2] |
| Dual feed, loopback | Cold | node 2 | 14.4 | 116.9 | 4.2 | 15.3 | 140.3 [125.8–150.9] |
| Dual feed, loopback | Cold | node 3 | 14.4 | 109.5 | 3.3 | 15.1 | 129.4 [123.3–152.0] |
| Live RPC | Warm | Bazzite | 3,833 | 23.6 | 2.8 | 2,829 | 10,530 [10,525–10,563] |
| Live RPC | Warm | node 1 | 3,817 | 82.3 | 5.0 | 2,854 | 10,548 [10,540–11,040] |
| Live RPC | Warm | node 2 | 6,291 | 69.5 | 4.8 | 2,912 | 10,931 [10,604–11,023] |
| Live RPC | Warm | node 3 | 4,340 | 67.9 | 5.1 | 2,863 | 10,640 [10,611–10,709] |
| Dual feed, loopback | Warm | Bazzite | 2.7 | 20.6 | 1.0 | 6.0 | 25.4 [25.1–30.9] |
| Dual feed, loopback | Warm | node 1 | 5.5 | 60.3 | 1.7 | 16.0 | 68.5 [65.3–89.4] |
| Dual feed, loopback | Warm | node 2 | 5.5 | 63.3 | 1.7 | 16.7 | 71.6 [67.8–73.1] |
| Dual feed, loopback | Warm | node 3 | 6.1 | 61.3 | 1.7 | 16.4 | 70.5 [66.2–71.7] |
<!-- /generated:shared-feed-hosts -->

- Every host matched 48/48 cold and 28/28 warm with identical requests: 71 / 39 POSTs, 36 / 20 GETs, 16,679 / 8,935 request bytes, identical feed and log page bytes. RPC response bytes differ by up to 2,416, only in the latest finalized block reply.
- Controls matched Bazzite: 48 missed, 48 pending, 48 recovered, 48 pending, with 18 / 8 / 34 / 8 GETs. Omission-resume took 113–119 ms against 36.8 ms.
- The A76 scan took 2.9–3.7× as long. Feed catch-up took 3.3–3.6× as long cold and 2.7–2.8× warm.
- Live RPC catch-up stayed within 3.8% of Bazzite, since 275 ms spacing and provider latency dominate.

[Node 1](../data/shared-feed/turing-node-1/summary.json) · [Node 2](../data/shared-feed/turing-node-2/summary.json) · [Node 3](../data/shared-feed/turing-node-3/summary.json)

## Feed format search

Two single-metric searches over [`tune.ts`](../src/shared-feed/tune.ts) with the autoresearch keep/revert protocol, one params field per iteration. A Claude Code session on a Mac ran the loop and git bookkeeping without API calls. Every verify ran on turing-node-1 over ssh (`taskset -c 4-7`, Bun 1.4.4, 70 °C gate); Bazzite had no sshd. The wrapper serves both feeds on loopback from the two RPC-recovery captures, with no RPC. It fails unless every page round-trips losslessly, both sources agree, and the scan finds 48/48 cold, 28/28 warm and the synthetic matches. Warm resumes after window 32 (block 44,788,281).

| Search | Metric | Baseline | Best | Iterations | Best params |
| --- | --- | ---: | ---: | ---: | --- |
| Cold page bytes, one source | decoded body bytes | 43,719 | 14,953 (−65.8%) | 13 | [feed-bytes](../data/shared-feed/autoresearch/feed-bytes.params.json) |
| Dual-feed warm catch-up | median of 9 (ms) | 69.95 | 64.20 in loop, not confirmed | 11 | [warm-time](../data/shared-feed/autoresearch/warm-time.params.json) |

![Response bytes for feed pages and RPC payloads, with the format search](figures/feed-bytes.svg)
<sub>Decoded body bytes without headers or framing, median of three samples. RPC is live Tenderly; feeds are two loopback origins built from the RPC-recovery captures. Optimized is the search's best kept params, 65.8% smaller raw and 23.8% smaller under gzip; RPC gzip was not measured. Lower panel: one source's cold pages per keep/revert iteration (13 iterations); step names are in the bytes log below. Data: `data/shared-feed/summary.json`, `evidence.json`, `autoresearch/feed-bytes.jsonl`.</sub>

The manifest stays near 2.5 kB. With 32-window pages a source has three pages, and a checkpoint commits every 32 windows instead of 4.

Warm time: the loop kept only larger pages (8, 16, then 32 windows). An interleaved check (5 rounds × 9 samples) gave medians of 70.51 ms (baseline), 71.40 ms (32-window) and 75.02 ms (byte-optimized), with more spread between rounds than between params. Local scan dominates A76 warm catch-up.

[Bytes log](../data/shared-feed/autoresearch/feed-bytes.jsonl) · [Warm log](../data/shared-feed/autoresearch/warm-time.jsonl) · [Interleaved check](../data/shared-feed/autoresearch/confirm.txt) · [Baseline params](../data/shared-feed/autoresearch/baseline.params.json)

## Method

- Windows, logs and head come from the [RPC-recovery reference](../data/rpc-recovery/reference.json): 68 windows of 1,000 blocks (68,000 blocks with gaps, covering all 48 known Daybreak omissions), 48 logs, head 46,544,281. Both paths scan them in 17 groups of four.
- The two origins serve pages built separately from the receipt-corroborated Tenderly and Sentio captures. Both providers confirmed chain, pinned hash and a finalized block above the pin. Client timings exclude setup (745 ms, six live POSTs) and the original capture (304 POSTs).
- The manifest lists ranges and head. A page URL holds only the manifest hash and page index, so identical requests get identical public bytes, with no recipient parameters, cookies or keys. Rows drop the repeated announcer address and event signature and keep block and transaction hashes, block number, log and transaction indexes, indexed topics and ABI data.
- Both paths use the paged-discovery ABI decoder and the ScopeLift SDK locally. The SDK checks the view tag before the full stealth-address check. Two synthetic matches and two decoys are scanned apart from canonical logs. Keys stay on the client. Scanning makes no transfers, receipt lookups or balance checks.
- Feed sources must agree on exact identity (block, block hash, transaction hash, log index) and payload. A mismatch retries the pair once, then holds the checkpoint. Each accepted group commits block, next page and result together by file rename. Direct RPC accepts any valid page unchecked. The offline verifier scores both paths against the saved reference.

## Reproduce

```sh
mkdir -p results
bun run shared-feed results/shared-feed-replay
bun run shared-feed:verify results/shared-feed-replay/evidence.json
bun run shared-feed:verify data/shared-feed/evidence.json
# Turing node N, host name turing-node-N
taskset -c 4-7 bun run shared-feed results/shared-feed-replay
bun run shared-feed:verify data/shared-feed/turing-node-N/evidence.json
# feed format search, Turing node, no RPC
taskset -c 4-7 bun run shared-feed:tune data/shared-feed/autoresearch/feed-bytes.params.json 9
```

Use a fresh run directory. `COOLDOWN_C` overrides the 70 °C gate. Recorded evidence holds public range metadata, page digests and timings. [Evidence](../data/shared-feed/evidence.json) · [Verified summary](../data/shared-feed/summary.json)
