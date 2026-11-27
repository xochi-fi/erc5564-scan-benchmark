# Shared feed

Can a static, finalized announcement feed replace live RPC for Base discovery without trusting one source? In this test it did. Two loopback feeds found the same 48 logs with 36 GETs where live RPC used 71 POSTs. When one of the two feeds dropped every log, the client held its checkpoint. A corrected source recovered all 48 on resume.

| Path | Mode | Exact logs in sampled range | POST / GET | Request / response body bytes | Fetch (ms) | Scan (ms) | Page verification (ms) | First synthetic match (ms) | Catch-up (ms), median [min–max] |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live RPC | Cold | 48/48 | 71 / 0 | 16,679 / 83,147 | 6,834 | 41.4 | 4.8 | 3,928 | 19,327 [19,316–19,491] |
| Dual feed, loopback | Cold | 48/48 | 0 / 36 | 0 / 92,134 | 3.9 | 32.2 | 1.2 | 4.4 | 38.8 [38.4–51.1] |
| Live RPC | Warm | 28/28 | 39 / 0 | 8,935 / 58,987 | 3,833 | 23.6 | 2.8 | 2,829 | 10,530 [10,525–10,563] |
| Dual feed, loopback | Warm | 28/28 | 0 / 20 | 0 / 55,492 | 2.7 | 20.6 | 1.0 | 6.0 | 25.4 [25.1–30.9] |

Bazzite 45, Intel i7-13700K, Bun 1.4.4, 2026-11-27. Live Tenderly over the Internet against two prebuilt loopback HTTP feeds. Medians of three samples per arm and mode in one process, alternating arm order. Cold has no checkpoint. Warm reloads one written after eight pages (block 44,788,281) and excludes that prefix. Connections and runtime state can persist.

- Fetch sums request start to body read, overlapping GETs included. Body bytes are decoded, without headers or framing.
- RPC samples check chain ID, finalized block and pinned block, with request starts ≥275 ms apart. Feed samples make one manifest GET per source and two concurrent GETs per page.
- Catch-up includes parsing, pacing, discovery and checkpoint I/O. Page verification is log validation plus, for the dual feed, source agreement. First match is timed after the needed responses and the scan of its page group. No canonical log matched the synthetic recipient.

One compact source's cold pages took 43,719 response bytes against 57,605 for the RPC log pages (24% fewer). Two copies plus manifests took 10.8% more than all cold RPC replies and 5.9% less than all warm ones. Feed latency here is loopback. Remote RTT, hosting, caching, compression and provider limits will change the comparison.

## Omission and resume controls

| Control | Committed groups | Missed / recovered logs | GETs | Elapsed (ms) |
| --- | ---: | --- | ---: | ---: |
| Empty feed alone | 17/17 | 48 missed | 18 | 9.2 |
| Empty feed plus independent source | 1/17 | 48 pending | 8 | 0.7 |
| Resume with corrected source | 17/17 | 48 recovered | 34 | 36.8 |
| Same identities, altered ABI data | 1/17 | 48 pending | 8 | 1.1 |

Both disagreement controls retried feed page 1 and held block 37,364,281. The omission resume reread the checkpoint, retried page 1 and skipped page 0. These omissions are injected into the frozen feed; the live one is in [RPC recovery](rpc-recovery.md). Shared upstream omissions can still agree falsely. Completeness covers the selected Base windows only.

## Turing nodes

Turing Pi RK1 nodes 1–3 (RK3588), Bun 1.4.4, 2026-11-27 17:20–17:36 UTC, one run per node in sequence, `taskset -c 4-7` on the four A76 cores. Kernels 5.10.160-rockchip (node 1), 6.1.0-1012-rockchip (node 2), 6.1.0-1025-rockchip (node 3). Feeds run on each node's loopback. Live RPC reaches Tenderly over the same home uplink as Bazzite. Everything else matches the Bazzite run. A sample started only once the hottest zone was ≤70 °C, polled every 5 s. None waited. Peaks were 62.8, 67.5 and 49.9 °C. The Bazzite run predates the gate and has no temperatures.

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

- Every host matched 48/48 cold and 28/28 warm with identical requests: 71 / 39 POSTs, 36 / 20 GETs, 16,679 / 8,935 request bytes, identical feed and log page bytes. RPC response bytes differ by up to 2,416, only in the latest finalized block reply.
- Controls matched Bazzite: 48 missed, 48 pending, 48 recovered, 48 pending, with 18 / 8 / 34 / 8 GETs. Omission-resume took 113–119 ms against 36.8 ms.
- The A76 scan took 2.9–3.7× as long. Feed catch-up took 3.3–3.6× as long cold and 2.7–2.8× warm.
- Live RPC catch-up stayed within 3.8% of Bazzite, since 275 ms spacing and provider latency dominate. Node 2's RPC fetch sum ran 3.9 s (cold) and 2.5 s (warm) over node 1 with the same requests.
- Prototype setup took 794–939 ms against 745 ms.

[Node 1](../data/shared-feed/turing-node-1/summary.json) · [Node 2](../data/shared-feed/turing-node-2/summary.json) · [Node 3](../data/shared-feed/turing-node-3/summary.json)

## Feed format search

Two single-metric searches over [`tune.ts`](../src/shared-feed/tune.ts) with the autoresearch keep/revert protocol, one params field per iteration. A Claude Code session on a Mac ran the loop and git bookkeeping without API calls. Every verify ran on turing-node-1 over ssh (`taskset -c 4-7`, Bun 1.4.4, 70 °C gate); Bazzite had no sshd. The wrapper serves both feeds on loopback from the two RPC-recovery captures, with no RPC. It fails unless every page round-trips losslessly, both sources agree, and the scan finds 48/48 cold, 28/28 warm and the synthetic matches. Warm resumes after window 32 (block 44,788,281).

| Search | Metric | Baseline | Best | Iterations | Best params |
| --- | --- | ---: | ---: | ---: | --- |
| Cold page bytes, one source | decoded body bytes | 43,719 | 14,953 (−65.8%) | 13 | [feed-bytes](../data/shared-feed/autoresearch/feed-bytes.params.json) |
| Dual-feed warm catch-up | median of 9 (ms) | 69.95 | 64.20 in loop, not confirmed | 11 | [warm-time](../data/shared-feed/autoresearch/warm-time.params.json) |

Bytes: zero-run encoding of ABI data saved the most (34,887 → 16,753). Base64 hashes, trimmed topics, 32-window pages, columns, delta blocks and no page header saved the rest. Base64 ABI data and a per-page block hash table did not help. Under gzip the gap narrows to 10,555 → 8,043 (−23.8%). The manifest stays near 2.5 kB. With 32-window pages a source has three pages, and a checkpoint commits every 32 windows instead of 4. 16-window pages cost 40 B more.

Warm time: the loop kept only larger pages (8, 16, then 32 windows). Prefetch and encoding changes landed 0.1–2.0 ms above the best. An interleaved check (5 rounds × 9 samples, peak 69.3 °C) gave round medians of 70.3–83.8 ms (baseline), 70.4–76.3 ms (32-window) and 66.3–79.8 ms (byte-optimized). Medians of those were 70.51, 71.40 and 75.02 ms. Spread between rounds is larger than any params effect. Local scan dominates A76 warm catch-up, and no format change is confirmed to shorten it.

[Bytes log](../data/shared-feed/autoresearch/feed-bytes.jsonl) · [Warm log](../data/shared-feed/autoresearch/warm-time.jsonl) · [Interleaved check](../data/shared-feed/autoresearch/confirm.txt) · [Baseline params](../data/shared-feed/autoresearch/baseline.params.json)

## Method

- Windows, logs and head come from the [RPC-recovery reference](../data/rpc-recovery/reference.json): 68 windows of 1,000 blocks (68,000 blocks with gaps, covering all 48 known Daybreak omissions), 48 logs, head 46,544,281. Both paths scan them in 17 groups of four.
- The two origins serve pages built separately from the receipt-corroborated Tenderly and Sentio captures. Both providers confirmed chain, pinned hash and a finalized block above the pin. Setup took 745 ms, including six live POSTs, reference validation and serialization. The original capture cost 304 POSTs, 96 of them receipts. Client timings exclude both.
- The manifest lists ranges and head. A page URL holds only the manifest hash and page index, so identical requests get identical public bytes, with no recipient parameters, cookies or keys. Rows drop the repeated announcer address and event signature and keep block and transaction hashes, block number, log and transaction indexes, indexed topics and ABI data.
- Both paths use the paged-discovery ABI decoder and the ScopeLift SDK locally. The SDK checks the view tag before the full stealth-address check. Two synthetic matches and two decoys are scanned apart from canonical logs. Keys stay on the client. Scanning makes no transfers, receipt lookups or balance checks.
- Feed sources must agree on exact identity (block, block hash, transaction hash, log index) and payload. A mismatch retries the pair once, then holds the checkpoint. Each accepted group commits block, next page and result together by file rename. Direct RPC accepts any valid page unchecked. The offline verifier scores both paths against the saved reference.

Prior work, OMR crossover and feed integrity: [FINDINGS.md](../FINDINGS.md#prior-work-and-omr-crossover).

## Reproduce

```sh
mkdir -p results
bun src/shared-feed/run.ts results/shared-feed-replay
bun src/shared-feed/verify.ts results/shared-feed-replay/evidence.json
bun src/shared-feed/verify.ts data/shared-feed/evidence.json
# Turing node N, host name turing-node-N
taskset -c 4-7 bun src/shared-feed/run.ts results/shared-feed-replay
bun src/shared-feed/verify.ts data/shared-feed/turing-node-N/evidence.json
# feed format search, Turing node, no RPC
taskset -c 4-7 bun src/shared-feed/tune.ts data/shared-feed/autoresearch/feed-bytes.params.json 9
```

Use a fresh run directory. `COOLDOWN_C` overrides the 70 °C gate. The verifier prints medians, minima and maxima in that order. Recorded evidence holds public range metadata, page digests and timings. [Evidence](../data/shared-feed/evidence.json) · [Verified summary](../data/shared-feed/summary.json)
