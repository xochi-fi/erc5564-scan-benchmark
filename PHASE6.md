# Phase 6 — Shared Base announcement feed

## Bazzite results

Bazzite 45, Intel i7-13700K, Bun 1.4.4, 2026-11-27. Live Tenderly over the Internet versus two prebuilt loopback HTTP feeds. Three samples per arm and mode in one process, alternating arm order. Cold starts without a checkpoint. Warm reloads a checkpoint written after scanning eight pages through block 44,788,281. Warm timings exclude that prefix scan. Connections and runtime state can persist.

| Path | Mode | Exact logs in sampled range | POST / GET | Request / response body bytes | Fetch (ms) | Scan (ms) | Page verification (ms) | First synthetic match (ms) | Catch-up (ms), median [min–max] |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live RPC | Cold | 48/48 | 71 / 0 | 16,679 / 83,147 | 6,834 | 41.4 | 4.8 | 3,928 | 19,327 [19,316–19,491] |
| Dual feed, loopback | Cold | 48/48 | 0 / 36 | 0 / 92,134 | 3.9 | 32.2 | 1.2 | 4.4 | 38.8 [38.4–51.1] |
| Live RPC | Warm | 28/28 | 39 / 0 | 8,935 / 58,987 | 3,833 | 23.6 | 2.8 | 2,829 | 10,530 [10,525–10,563] |
| Dual feed, loopback | Warm | 28/28 | 0 / 20 | 0 / 55,492 | 2.7 | 20.6 | 1.0 | 6.0 | 25.4 [25.1–30.9] |

Times are medians. Fetch sums request start through body read, including overlapping GETs. Body bytes are decoded sizes without HTTP headers or transport framing. Each RPC sample includes chain ID, finalized block and pinned block checks, with starts spaced at least 275 ms apart. Each feed sample includes a manifest GET per source and two concurrent GETs per page. Catch-up includes parsing, pacing, local discovery and checkpoint I/O. Page verification covers log validation and, for dual feed, source agreement. First match is timed after the required responses and the local scan of its page group. No canonical log matched the synthetic recipient.

One compact source's cold pages used 43,719 response bytes versus 57,605 for the RPC log pages alone (24% fewer). Two copies plus manifests used 10.8% more response bytes than all cold RPC replies, and 5.9% fewer than all warm RPC replies. The feed latency is local. Remote RTT, hosting, caching, compression and provider limits will change the comparison.

## Bazzite vs Turing

Turing Pi RK1 nodes 1–3 (Rockchip RK3588), Bun 1.4.4, 2026-11-27 17:20–17:36 UTC, one run per node, nodes in sequence. Process pinned with `taskset -c 4-7` to the four Cortex-A76 cores. Kernels 5.10.160-rockchip (node 1), 6.1.0-1012-rockchip (node 2), 6.1.0-1025-rockchip (node 3). Each node serves both feeds on its own loopback. Live RPC reaches Tenderly over the same home uplink as Bazzite. Same 68 windows, arms, sample order, checkpoints and retry rule as Bazzite.

Thermal gate: before each sample, the hottest thermal zone must be at most 70 °C, polled every 5 s. No sample waited. Peak readings were 62.8 °C, 67.5 °C and 49.9 °C. The Bazzite run predates the gate and recorded no temperatures.

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

All hosts matched 48/48 cold and 28/28 warm logs with the same requests: 71 / 39 POSTs and 36 / 20 GETs, 16,679 / 8,935 request bytes and identical feed and log page bytes. RPC response bytes differ by up to 2,416 only in the latest finalized block reply. Controls matched Bazzite on every node: 48 missed, 48 pending, 48 recovered, 48 pending, with 18 / 8 / 34 / 8 GETs. Omission-resume took 113–119 ms against 36.8 ms.

On the A76 cores, local scan took 2.9–3.7× as long. Loopback feed catch-up took 3.3–3.6× cold (129–140 ms) and 2.7–2.8× warm (69–72 ms). Live RPC catch-up stayed within 3.8% of Bazzite, because the 275 ms request spacing and provider latency dominate. Node 2's RPC fetch sum ran 3.9 s cold and 2.5 s warm above node 1 with the same request count. Prototype setup took 794–939 ms against 745 ms.

[Node 1](data/phase6/turing-node-1/summary.json) · [Node 2](data/phase6/turing-node-2/summary.json) · [Node 3](data/phase6/turing-node-3/summary.json)

## Scope and method

- The [Phase 5 reference](data/phase5/reference.json) pins 68 selected 1,000-block windows, 48 logs and Base head 46,544,281. The windows cover 68,000 blocks with gaps and include all 48 known Daybreak omissions. Both paths scan exactly those windows in 17 groups of four.
- Two loopback origins serve pages built separately from the receipt-corroborated Tenderly and Sentio captures. Both providers confirmed the chain, pinned hash and a finalized block above the pin. One-time prototype setup took 745 ms including six live POSTs, reference validation and page serialization. The earlier Phase 5 capture cost 304 POSTs including 96 receipt calls. Client timings exclude both build steps.
- The manifest lists the fixed ranges and head. A page URL uses only the manifest hash and page index. Identical requests receive identical public bytes, with no recipient parameters, cookies or keys. Compact rows omit repeated announcer address and event signature. Rows retain block and transaction hashes, block number, log and transaction indexes, indexed topics and ABI data.
- Both paths use the Phase 2 ABI decoder and ScopeLift SDK locally. The SDK derives and checks the view tag before the full stealth-address check. Two synthetic matches and two decoys are scanned separately from canonical logs. No recipient keys leave the client. No live transfers, candidate receipt lookups or balance checks occur during scanning.
- Both feed sources must agree on exact identity (block, block hash, transaction hash, log index) and payload. A mismatch retries the same pair once, then holds the checkpoint. Each accepted scan group commits its block, next page index and result together via file rename. Direct RPC accepts a valid page without cross-checking. The offline verifier scores both paths against the saved reference.

## Omission and resume controls

| Control | Committed groups | Missed / recovered logs | GETs | Elapsed (ms) |
| --- | ---: | --- | ---: | ---: |
| Empty feed alone | 17/17 | 48 missed | 18 | 9.2 |
| Empty feed plus independent source | 1/17 | 48 pending | 8 | 0.7 |
| Resume with corrected source | 17/17 | 48 recovered | 34 | 36.8 |
| Same identities, altered ABI data | 1/17 | 48 pending | 8 | 1.1 |

Both disagreement controls retried feed page index 1 and held block 37,364,281. The omission resume reread the checkpoint, retried page 1 and skipped page 0. Shared upstream omissions can still yield false agreement. These controls inject omissions into the frozen feed. The live Daybreak omission was measured in [Phase 5](PHASE5.md). Completeness applies to the selected Base windows only.

## Reproduce

```sh
bun install --frozen-lockfile
mkdir -p results
bun scripts/phase6/run.ts results/phase6-replay
bun scripts/phase6/verify.ts results/phase6-replay/evidence.json
bun scripts/phase6/verify.ts data/phase6/evidence.json
# Turing node N, host name turing-node-N
taskset -c 4-7 bun scripts/phase6/run.ts results/phase6-replay
bun scripts/phase6/verify.ts data/phase6/turing-node-N/evidence.json
```

Use a fresh run directory. `COOLDOWN_C` overrides the 70 °C thermal gate. The verifier emits medians, minima and maxima in that order. Recorded evidence contains public range metadata, page digests and timings. [Evidence](data/phase6/evidence.json) · [Verified summary](data/phase6/summary.json)
