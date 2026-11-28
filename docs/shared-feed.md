# Shared feed

Should wallets use a shared static feed or OMR?

A shared feed. Two feeds recover every announcement in milliseconds, and OMR costs servers per message per recipient.

## Decision

Clients fetch every finalized feed page, scan locally, resume from a checkpoint, and retry a window when the two feeds disagree. Signed page commitments wait for log indexes with proofs: drafts [EIP-7745](https://eips.ethereum.org/EIPS/eip-7745), [EIP-8304](https://eips.ethereum.org/EIPS/eip-8304) or EIP-7792. Erigon #16364 and Nethermind #9178 are [silent `getLogs` omissions](https://docs.envio.dev/blog/nodes-silently-miss-events).

| Scheme | Detector ms/msg, 1 / 2 threads | Recipient ms | Clue bytes | DoS-resistant |
| --- | ---: | ---: | ---: | --- |
| [OMRp2](https://eprint.iacr.org/2021/1256) | 59.8 / 30.1 | 11 | 956 | Yes (2024/510 Lemma 4.3, §7.3) |
| [PerfOMR1](https://eprint.iacr.org/2024/204) | 4.1 / 2.1 | 21 | 2,181 | No (attacks in 2024/510 §5.1, §7.4, §8) |
| [PerfOMR2](https://eprint.iacr.org/2024/204) | 21.5 / 11.3 | 11 | 583 | No |
| [DoS-PerfOMR](https://eprint.iacr.org/2024/510) | 4.9 / 2.6 | 20 | 1,996 | Yes (2024/510 Theorem 7.2) |

Rows are [eprint 2024/510](https://eprint.iacr.org/2024/510) Table 1 (N = 2^19, γ = γ̄ = 50, one GCP n4-standard-8, AVX512-IFMA52; revisions 2021/1256 2022-04-14, 2024/204 2024-11-21, 2024/510 2025-02-07). No DoS-resistant variant runs in production.

![CPU per day to scan announcements against real chain rates and a phone budget](figures/scan-budget.svg)
<sub>Solid lines scale the scan-cost controls; dotted is single-thread native libsecp256k1 on Turing ([scan cost](scan-cost.md)). Dashed OMR lines are single-thread literature values on one cloud AVX512 core. Ticks: each chain's average daily rate.</sub>

| Revisit when | Assumed budget | Breaks at |
| --- | --- | ---: |
| Daily Turing scan time | 3 min CPU at [scan-cost](scan-cost.md) rates, SDK or native libsecp256k1 | ~100k/day or ~1M/day |
| Daily feed bytes | 60 MB at ~620 B (2 × best format) | ~100k/day |
| Wallets cover Umbra-scale streams | — | ~100k per chain |

The budgets are assumptions. A Turing scan passes DoS-PerfOMR's 20 ms recipient time at ~12/day with the SDK and ~120/day with native libsecp256k1 ([rates](scan-cost.md)). Spam can buy these volumes cheaply ([spam cost](spam-cost.md)).

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
| Bazzite | Cold | 351.6 [336.7–4,272] | 337.3 [329.6–341.0] | 6,895 [6,652–8,020] | 36 / 71 | 22,302 / 83,147 |
| Bazzite | Warm | 212.6 [201.7–1,687] | 198.3 [194.1–206.7] | 3,860 [3,808–4,021] | 20 / 39 | 12,976 / 58,987 |
| Turing node 3 | Cold | 492.4 [463.9–526.0] | 476.6 [452.7–505.2] | 8,482 [8,454–9,698] | 36 / 71 | 22,302 / 83,561 |
| Turing node 3 | Warm | 315.7 [282.8–906.8] | 283.1 [247.8–373.8] | 4,413 [3,989–5,141] | 20 / 39 | 12,976 / 59,401 |
<!-- /generated:shared-feed -->

Medians [min–max] of 9 runs; the README uses concurrent GETs on Bazzite, and slow raw GitHub edges make the sequential maxima ([data](../data/shared-feed/remote/)). On loopback the gap was 498× against paced RPC ([summary](../data/shared-feed/summary.json)). Injected omissions and altered payloads hold the checkpoint, but shared upstreams can agree falsely ([controls](../data/shared-feed/summary.json), [RPC recovery](rpc-recovery.md#injected-faults)).

A keep/revert search over [`tune.ts`](../src/shared-feed/tune.ts) cut one feed's cold page bytes by 65.8% ([log](../data/shared-feed/autoresearch/feed-bytes.jsonl), [params](../data/shared-feed/autoresearch/feed-bytes.params.json), [figure](figures/feed-bytes.svg)); a warm-time search found nothing beyond round-to-round spread ([log](../data/shared-feed/autoresearch/warm-time.jsonl), [check](../data/shared-feed/autoresearch/confirm.txt)).

## Method

Both paths scan the [RPC-recovery windows](rpc-recovery.md#windows) in 17 pages of four; warm catch-up starts after window 32. The remote feeds are `data/shared-feed/static/`, served by raw.githubusercontent.com and jsDelivr from commit `7b78192`; the files stay in the repo because those URLs read them from a commit. A fresh process per run. RPC without pacing drops the client's ≥275 ms start-to-start wait from the recorded samples.

```sh
bun run shared-feed results/shared-feed-replay                       # taskset -c 4-7 on a Turing node
bun run shared-feed:verify data/shared-feed/evidence.json
bun run shared-feed:static
ROUNDS=9 bun run shared-feed:remote results/remote https://raw.githubusercontent.com/xochi-fi/erc5564-scan-benchmark/COMMIT/data/shared-feed/static/tenderly/ https://cdn.jsdelivr.net/gh/xochi-fi/erc5564-scan-benchmark@COMMIT/data/shared-feed/static/sentio/
bun run shared-feed:remote-verify data/shared-feed/remote/bazzite/samples.jsonl
taskset -c 4-7 bun run shared-feed:tune data/shared-feed/autoresearch/feed-bytes.params.json 9
```
