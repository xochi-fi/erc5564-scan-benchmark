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

## Reproduce on Bazzite

```sh
bun install --frozen-lockfile
mkdir -p results
bun scripts/phase6/run.ts results/phase6-replay
bun scripts/phase6/verify.ts results/phase6-replay/evidence.json
bun scripts/phase6/verify.ts data/phase6/evidence.json
```

Use a fresh run directory. The verifier emits medians, minima and maxima in that order. Recorded evidence contains public range metadata, page digests and timings. [Evidence](data/phase6/evidence.json) · [Verified summary](data/phase6/summary.json)
