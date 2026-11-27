# Shared feed

Should wallets use a shared static feed or OMR?

A shared feed, because two feeds recovered every log in milliseconds and OMR costs servers per message per recipient.

## Decision

Clients fetch every finalized feed page, scan locally, resume from a checkpoint, and retry a range when two feeds disagree. Signed page commitments wait for log indexes with proofs: drafts [EIP-7745](https://eips.ethereum.org/EIPS/eip-7745), [EIP-8304](https://eips.ethereum.org/EIPS/eip-8304) or EIP-7792. No published design signs ERC-5564 feed pages. Erigon #16364 and Nethermind #9178 are [silent `getLogs` omissions](https://docs.envio.dev/blog/nodes-silently-miss-events).

No DoS-resistant OMR variant runs in production:

| Scheme | Detector ms/msg, 1 / 2 threads | Recipient ms | Clue bytes | DoS-resistant |
| --- | ---: | ---: | ---: | --- |
| [OMRp2](https://eprint.iacr.org/2021/1256) | 59.8 / 30.1 | 11 | 956 | Yes (proven in 2024/510, Lemma 4.3) |
| [PerfOMR1](https://eprint.iacr.org/2024/204) | 4.1 / 2.1 | 21 | 2,181 | No (attacks in 2024/510, Section 5.1) |
| [PerfOMR2](https://eprint.iacr.org/2024/204) | 21.5 / 11.3 | 11 | 583 | No |
| [DoS-PerfOMR](https://eprint.iacr.org/2024/510) | 4.9 / 2.6 | 20 | 1,996 | Yes (Theorem 5.3) |

Rows are [eprint 2024/510](https://eprint.iacr.org/2024/510) Table 1: N = 2^19 messages, γ = γ̄ = 50, one GCP n4-standard-8 with SEAL HEXL / AVX512-IFMA52. Detector runtime is per scanned message for one recipient's digest. Table 2 gives DoS-PerfOMR 4.95 ms/msg amortized. [2021/1256](https://eprint.iacr.org/2021/1256) puts server cost at ~$1 per million messages. [SophOMR](https://eprint.iacr.org/2024/1814) reports 3.4x faster than PerfOMR.

![CPU per day to scan announcements against real chain rates and a phone budget](figures/scan-budget.svg)
<sub>Dashed OMR lines are single-thread literature values.</sub>

Solid lines scale the [scan-cost](scan-cost.md) controls. Each chain's Announcer averaged 0.006–1.2 announcements per day to 2026-11-26, which costs the A76 at most 2.1 ms CPU per day. The A76 scan passes DoS-PerfOMR's 20 ms recipient runtime at ~12/day. The comparison is one cloud AVX512 core against one A76 core.

| Revisit when | Assumed budget | Breaks at |
| --- | --- | ---: |
| Daily A76 scan time | 3 min CPU at 1.75 ms each | ~100k/day |
| Daily feed bytes | 60 MB at ~620 B (2 × best format) | ~100k/day |
| Wallets cover Umbra-scale streams | — | ~100k per chain |

The budgets are assumptions. At 1M/day the A76 needs 29 min.

## Feed against live RPC

<!-- generated:shared-feed -->
| Path | Mode | Exact logs in sampled range | POST / GET | Request / response body bytes | Fetch (ms) | Scan (ms) | Page verification (ms) | First synthetic match (ms) | Catch-up (ms), median [min–max] |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live RPC | Cold | 48/48 | 71 / 0 | 16,679 / 83,147 | 6,834 | 41.4 | 4.8 | 3,928 | 19,327 [19,316–19,491] |
| Dual feed, loopback | Cold | 48/48 | 0 / 36 | 0 / 92,134 | 3.9 | 32.2 | 1.2 | 4.4 | 38.8 [38.4–51.1] |
| Live RPC | Warm | 28/28 | 39 / 0 | 8,935 / 58,987 | 3,833 | 23.6 | 2.8 | 2,829 | 10,530 [10,525–10,563] |
| Dual feed, loopback | Warm | 28/28 | 0 / 20 | 0 / 55,492 | 2.7 | 20.6 | 1.0 | 6.0 | 25.4 [25.1–30.9] |
<!-- /generated:shared-feed -->

Bazzite, 2026-11-27, live Tenderly against two loopback feeds, medians of three. Live RPC is the Bun client; a [browser](rpc-recovery.md) took 70 POSTs. Remote hosting, caching and compression would change the feed numbers. Bytes are decoded bodies without headers.

## Omission and resume controls

<!-- generated:shared-feed-controls -->
| Control | Committed groups | Missed / recovered logs | GETs | Elapsed (ms) |
| --- | ---: | --- | ---: | ---: |
| Empty feed alone | 17/17 | 48 missed | 18 | 9.2 |
| Empty feed plus independent source | 1/17 | 48 pending | 8 | 0.7 |
| Resume with corrected source | 17/17 | 48 recovered | 34 | 36.8 |
| Same identities, altered ABI data | 1/17 | 48 pending | 8 | 1.1 |
<!-- /generated:shared-feed-controls -->

Both disagreement controls held block 37,364,281. The omissions are injected. [RPC recovery limits](rpc-recovery.md#method) apply.

## Turing nodes

Nodes 1–3, 2026-11-27 17:20–17:36 UTC, in sequence. A sample started only below 70 °C. Peaks were 62.8, 67.5 and 49.9 °C.

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

Requests and page bytes matched on every host; RPC replies differed by up to 2,416 bytes, in the finalized block only. Omission-resume took 113–119 ms. The A76 scan took 2.9–3.7× as long as Bazzite, feed catch-up 3.3–3.6× cold and 2.7–2.8× warm. Live RPC stayed within 3.8% because pacing and provider latency dominate.

[Node 1](../data/shared-feed/turing-node-1/summary.json) · [Node 2](../data/shared-feed/turing-node-2/summary.json) · [Node 3](../data/shared-feed/turing-node-3/summary.json)

## Feed format search

A Claude Code session ran two keep/revert searches over [`tune.ts`](../src/shared-feed/tune.ts), one params field per iteration. Each verify ran on turing-node-1 and failed on any lossy page or missed match.

| Search | Metric | Baseline | Best | Iterations | Best params |
| --- | --- | ---: | ---: | ---: | --- |
| Cold page bytes, one source | decoded body bytes | 43,719 | 14,953 (−65.8%) | 13 | [feed-bytes](../data/shared-feed/autoresearch/feed-bytes.params.json) |
| Dual-feed warm catch-up | median of 9 (ms) | 69.95 | 64.20 in loop, not confirmed | 11 | [warm-time](../data/shared-feed/autoresearch/warm-time.params.json) |

![Response bytes for feed pages and RPC payloads, with the format search](figures/feed-bytes.svg)
<sub>Lower panel: one source's cold pages per iteration.</sub>

The best bytes params are 23.8% smaller under gzip. RPC gzip was not measured. The manifest is about 2.5 kB. The warm-time loop kept only larger pages (8, 16, then 32 windows). An interleaved check of 5 rounds × 9 samples gave 70.51 ms (baseline), 71.40 ms (32-window) and 75.02 ms (byte-optimized), with more spread between rounds than between params.

[Bytes log](../data/shared-feed/autoresearch/feed-bytes.jsonl) · [Warm log](../data/shared-feed/autoresearch/warm-time.jsonl) · [Interleaved check](../data/shared-feed/autoresearch/confirm.txt) · [Baseline params](../data/shared-feed/autoresearch/baseline.params.json)

## Method

Both paths scan the [RPC-recovery windows](rpc-recovery.md#scope) in 17 groups of four. Warm starts after window 32 (block 44,788,281). The origins serve pages built separately from the Tenderly and Sentio captures. Timings exclude setup (745 ms, six POSTs) and the capture (304 POSTs). Page URLs carry only the manifest hash and page index. Feeds must agree on identity and payload; a mismatch retries once, then holds the checkpoint.

## Reproduce

Use a fresh run directory. `COOLDOWN_C` overrides the thermal gate.

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

[Evidence](../data/shared-feed/evidence.json) · [Verified summary](../data/shared-feed/summary.json)
