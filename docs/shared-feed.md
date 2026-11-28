# Shared feed

Should wallets use a shared static feed or OMR?

A shared feed. Two feeds recover every announcement in milliseconds, and OMR costs servers per message per recipient.

## Decision

Clients fetch every finalized feed page, scan locally, resume from a checkpoint, and retry a window when the two feeds disagree. Signed page commitments wait for log indexes with proofs: drafts [EIP-7745](https://eips.ethereum.org/EIPS/eip-7745), [EIP-8304](https://eips.ethereum.org/EIPS/eip-8304) or EIP-7792. No published design signs ERC-5564 feed pages. Erigon #16364 and Nethermind #9178 are [silent `getLogs` omissions](https://docs.envio.dev/blog/nodes-silently-miss-events).

No DoS-resistant OMR variant runs in production.

| Scheme | Detector ms/msg, 1 / 2 threads | Recipient ms | Clue bytes | DoS-resistant |
| --- | ---: | ---: | ---: | --- |
| [OMRp2](https://eprint.iacr.org/2021/1256) | 59.8 / 30.1 | 11 | 956 | Yes (2024/510 Lemma 4.3, §7.3) |
| [PerfOMR1](https://eprint.iacr.org/2024/204) | 4.1 / 2.1 | 21 | 2,181 | No (attacks in 2024/510 §5.1, §7.4, §8) |
| [PerfOMR2](https://eprint.iacr.org/2024/204) | 21.5 / 11.3 | 11 | 583 | No |
| [DoS-PerfOMR](https://eprint.iacr.org/2024/510) | 4.9 / 2.6 | 20 | 1,996 | Yes (2024/510 Theorem 7.2) |

Rows are [eprint 2024/510](https://eprint.iacr.org/2024/510) Table 1: N = 2^19 messages, γ = γ̄ = 50, one GCP n4-standard-8 with SEAL HEXL / AVX512-IFMA52. Detector time is per scanned message, for one recipient's digest. Table 2 gives DoS-PerfOMR 4.95 ms/msg amortized. Table 1 cites Theorem 5.3, which 7.2 builds on. Cited revisions: 2021/1256 2022-04-14, 2024/204 2024-11-21, 2024/510 2025-02-07. [2021/1256](https://eprint.iacr.org/2021/1256) puts server cost at ~$1 per million messages. [SophOMR](https://eprint.iacr.org/2024/1814) reports 3.4× the speed of PerfOMR.

![CPU per day to scan announcements against real chain rates and a phone budget](figures/scan-budget.svg)
<sub>Solid lines scale the scan-cost controls; dotted is single-thread native libsecp256k1 on Turing ([scan cost](scan-cost.md)). Dashed OMR lines are single-thread literature values on one cloud AVX512 core.</sub>

Each chain averaged 0.006–1.2 announcements per day to 2026-11-26, at most 2.1 ms CPU per day on Turing. The Turing scan passes DoS-PerfOMR's 20 ms recipient time at ~12/day with the ScopeLift SDK and ~120/day with native libsecp256k1.

| Revisit when | Assumed budget | Breaks at |
| --- | --- | ---: |
| Daily Turing scan time | 3 min CPU at [scan-cost](scan-cost.md) rates, SDK or native libsecp256k1 | ~100k/day or ~1M/day |
| Daily feed bytes | 60 MB at ~620 B (2 × best format) | ~100k/day |
| Wallets cover Umbra-scale streams | — | ~100k per chain |

The budgets are assumptions. At 1M/day, Turing needs 29 min with the SDK and 2.8 min with libsecp256k1.

## Privacy

Privacy changes the decision only past the 60 MB/day feed budget, where wallets must fetch selectively or delegate a viewing key.

| Path | Who learns | What |
| --- | --- | --- |
| Per-wallet RPC | RPC provider | IP, sync times; receipts and balances reveal your stealth addresses |
| Full feed download | Feed host, CDN | IP, fetch times, last checkpoint; retries reveal only feed disagreement |
| OMR | Detector | IP, query time, k̄, never pertinence; ~129 MB key; PerfOMR is DoS-prone |
| ERC-5564 view tag | Everyone | 1 byte of the shared secret: 128 → 124 bits |

Sources: [2021/1256](https://eprint.iacr.org/2021/1256) §1, §4.2, §8.1, §9.1, §12; [2024/204](https://eprint.iacr.org/2024/204) §1; [2024/510](https://eprint.iacr.org/2024/510) §5.1, §7.1, §7.4, Remark 7.3; [OMR Landscape](https://hackmd.io/@keewoolee/SJfUTqER-x) TL;DR; [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) "Parsing considerations". Checkpoint leak and selective-fetch fallback are inferred.

## Feed against live RPC

<!-- generated:shared-feed -->
| Host | Mode | Feed, sequential GETs (ms) | Feed, concurrent GETs (ms) | RPC without pacing (ms) | GET / POST | Bytes, feed compressed / RPC |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Turing node 3 | Cold | 492.4 [463.9–526.0] | 476.6 [452.7–505.2] | 8,482 [8,454–9,698] | 36 / 71 | 22,302 / 83,561 |
| Turing node 3 | Warm | 315.7 [282.8–906.8] | 283.1 [247.8–373.8] | 4,413 [3,989–5,141] | 20 / 39 | 12,976 / 59,401 |
| Bazzite | Cold, warm | pending | pending | 6,895 [6,652–8,020] | — | — |
<!-- /generated:shared-feed -->

Medians [min–max] of 9 samples per mode. The README uses sequential GETs, as the RPC client does. Bazzite reruns are pending while another benchmark holds the host. The remote feed is the same pages on raw.githubusercontent.com and jsDelivr at commit `7b78192`, fetched over TLS with gzip or brotli, a fresh process per sample. Concurrent mode requests every page of both feeds at once. RPC without pacing is the 2026-11-27 Tenderly samples minus the client's ≥275 ms start-to-start wait, from recorded request, scan and verification times, with no new requests.

On loopback without TLS, the same pages take 38.8 ms cold against 19.3 s of paced RPC ([Bazzite](../data/shared-feed/summary.json), [nodes 1–3](../data/shared-feed/)). Three-sample runs before these hit a raw GitHub edge that took ~210 ms per cache hit for whole samples, spreading cold rescans over 0.4–4.2 s ([first runs](../data/shared-feed/remote/)). Each request now records the edge that served it.

## Omission and resume controls

<!-- generated:shared-feed-controls -->
| Control | Committed groups | Missed / recovered logs | GETs | Elapsed (ms) |
| --- | ---: | --- | ---: | ---: |
| Empty feed alone | 17/17 | 48 missed | 18 | 9.2 |
| Empty feed plus independent source | 1/17 | 48 pending | 8 | 0.7 |
| Resume with corrected source | 17/17 | 48 recovered | 34 | 36.8 |
| Same identities, altered ABI data | 1/17 | 48 pending | 8 | 1.1 |
<!-- /generated:shared-feed-controls -->

The omissions are injected. Both disagreement controls hold block 37,364,281. Shared upstreams can agree falsely ([RPC recovery](rpc-recovery.md#injected-faults)).

## Feed format search

A Claude Code session ran two keep/revert searches over [`tune.ts`](../src/shared-feed/tune.ts), one params field per iteration. Each verify ran on Turing node 1 and fails on any lossy page or missed match.

| Search | Metric | Baseline | Best | Iterations | Best params |
| --- | --- | ---: | ---: | ---: | --- |
| Cold page bytes, one feed | decoded body bytes | 43,719 | 14,953 (−65.8%) | 13 | [feed-bytes](../data/shared-feed/autoresearch/feed-bytes.params.json) |
| Dual-feed warm catch-up | median of 9 (ms) | 69.95 | 64.20 in loop, not confirmed | 11 | [warm-time](../data/shared-feed/autoresearch/warm-time.params.json) |

![Response bytes for feed pages and RPC payloads, with the format search](figures/feed-bytes.svg)
<sub>Lower panel: one feed's cold pages per iteration.</sub>

The best bytes params are 23.8% smaller under gzip. RPC gzip is not measured. The manifest is about 2.5 kB. The warm-time loop keeps only larger pages (8, 16, then 32 windows). An interleaved check of 5 rounds × 9 samples finds more spread between rounds than between params:

| Params | Median, ms |
| --- | ---: |
| Baseline | 70.51 |
| 32-window pages | 71.40 |
| Byte-optimized | 75.02 |

[Bytes log](../data/shared-feed/autoresearch/feed-bytes.jsonl) · [Warm log](../data/shared-feed/autoresearch/warm-time.jsonl) · [Interleaved check](../data/shared-feed/autoresearch/confirm.txt) · [Baseline params](../data/shared-feed/autoresearch/baseline.params.json)

## Method

Both paths scan the [RPC-recovery windows](rpc-recovery.md#windows) in 17 groups of four. Warm catch-up starts after window 32 (block 44,788,281). The feeds serve pages built separately from the Tenderly and Sentio captures. Timings exclude setup (745 ms, six POSTs) and the capture (304 POSTs). Page URLs carry only the manifest hash and page index. The feeds must agree on identity and payload. A mismatch retries once, then holds the checkpoint.

Use a fresh run directory. `COOLDOWN_C` overrides the temperature gate.

```sh
mkdir -p results
bun run shared-feed results/shared-feed-replay
bun run shared-feed:verify results/shared-feed-replay/evidence.json
bun run shared-feed:verify data/shared-feed/evidence.json
bun run shared-feed:static                                                      # rewrite data/shared-feed/static
taskset -c 0,2,4,6 bun run shared-feed:remote results/remote https://raw.githubusercontent.com/xochi-fi/erc5564-scan-benchmark/COMMIT/data/shared-feed/static/tenderly/ https://cdn.jsdelivr.net/gh/xochi-fi/erc5564-scan-benchmark@COMMIT/data/shared-feed/static/sentio/
bun run shared-feed:remote-verify data/shared-feed/remote/bazzite/evidence.json   # or turing-node-3
taskset -c 4-7 bun run shared-feed results/shared-feed-replay                # Turing node N, host name turing-node-N
bun run shared-feed:verify data/shared-feed/turing-node-N/evidence.json
taskset -c 4-7 bun run shared-feed:tune data/shared-feed/autoresearch/feed-bytes.params.json 9   # format search, no RPC
```

[Evidence](../data/shared-feed/evidence.json) · [Verified summary](../data/shared-feed/summary.json)
