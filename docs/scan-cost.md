# Scan cost

How long does a local ERC-5564 scan take?

It is linear in announcements: 1M take about 10× as long as 100k. Almost all of it is the SDK's pure-JS curve arithmetic: libsecp256k1 runs the same check 4× faster as WASM and 10–16× faster native.

<!-- generated:scan-cost -->
| Host | 100k before/after controls, s | 1M, s | 1M / 100k |
| --- | --- | --- | --- |
| Bazzite, P-core threads 0,2,4,6 | 48.531–51.951 | 519.084 | 9.99–10.70 |
| Turing node 1, Cortex-A76 cores 4–7 | 168.457–181.946 | 1804.305 | 9.92–10.71 |
<!-- /generated:scan-cost -->

Crypto engine, zero-match fixtures, two 100k controls per [host](../METHODS.md#hosts-and-software). Both hosts share cores with other work. At this rate the largest chain history, [Umbra on Polygon](chain-volume.md#umbra), takes about 180 s on Turing.

## Engines

<!-- generated:scan-engines -->
| Host | Engine | Threads | 100k zero, s | 100k sparse, s | 1M zero, s | 1M sparse, s | µs each, wall | µs each, CPU | vs SDK |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bazzite | ScopeLift SDK | 1 | 48.52 | 48.20 | – | – | 485.2 | 485.3 | 1.0× |
| Bazzite | SDK `checkStealthAddress` | 1 | 48.47 | 47.93 | – | – | 484.7 | 482.4 | 1.0× |
| Bazzite | noble (same curve, lean loop) | 1 | 47.99 | 48.28 | – | – | 479.9 | 478.9 | 1.0× |
| Bazzite | libsecp256k1 WASM | 1 | 12.59 [12.47–12.65] | 12.38 [12.20–12.53] | 123.65 | 125.14 | 123.6 | 123.4 | 3.9× |
| Bazzite | libsecp256k1 WASM | 2 | 6.27 [6.25–6.45] | 6.36 [6.20–6.37] | 71.32 | 62.66 | 71.3 | 135.0 | 6.8× |
| Bazzite | libsecp256k1 WASM | 4 | 3.31 [3.30–3.35] | 3.48 [3.36–3.48] | 33.40 | 33.32 | 33.4 | 132.2 | 14.5× |
| Bazzite | libsecp256k1 native | 1 | 3.13 [3.13–3.17] | 3.13 [3.13–3.15] | 31.37 | 31.31 | 31.4 | 31.8 | 15.5× |
| Bazzite | libsecp256k1 native | 2 | 1.56 [1.56–1.56] | 1.57 [1.57–1.58] | 15.66 | 15.61 | 15.7 | 32.4 | 31.0× |
| Bazzite | libsecp256k1 native | 4 | 0.85 [0.84–0.90] | 0.86 [0.86–0.87] | 8.36 | 7.93 | 8.4 | 32.6 | 58.0× |
| Bazzite | Control: crypto, before / after | 1 | 47.40 / 47.26 | – | – | – | – | – | – |
| Turing node 1 | ScopeLift SDK | 1 | 171.03 | 178.79 | – | – | 1,710.3 | 1,721.8 | 1.0× |
| Turing node 1 | SDK `checkStealthAddress` | 1 | 172.26 | 176.79 | – | – | 1,722.6 | 1,733.4 | 1.0× |
| Turing node 1 | noble (same curve, lean loop) | 1 | 173.80 | 176.52 | – | – | 1,738.0 | 1,748.8 | 1.0× |
| Turing node 1 | libsecp256k1 WASM | 1 | 43.08 [42.27–43.48] | 43.15 [42.36–43.19] | 425.35 | 437.26 | 425.3 | 426.3 | 4.0× |
| Turing node 1 | libsecp256k1 WASM | 2 | 22.23 [21.72–22.37] | 22.22 [21.76–22.30] | 221.86 | 223.58 | 221.9 | 448.7 | 7.7× |
| Turing node 1 | libsecp256k1 WASM | 4 | 13.36 [12.87–13.55] | 13.18 [13.13–13.43] | 139.33 | 143.43 | 139.3 | 555.7 | 12.3× |
| Turing node 1 | libsecp256k1 native | 1 | 16.89 [16.55–16.93] | 16.72 [16.61–16.92] | 165.08 | 165.52 | 165.1 | 166.5 | 10.4× |
| Turing node 1 | libsecp256k1 native | 2 | 8.29 [8.24–8.29] | 8.29 [8.28–8.33] | 84.90 | 85.07 | 84.9 | 172.7 | 20.1× |
| Turing node 1 | libsecp256k1 native | 4 | 4.89 [4.85–4.99] | 5.05 [4.87–5.21] | 51.21 | 51.77 | 51.2 | 204.0 | 33.4× |
| Turing node 1 | Control: crypto, before / after | 1 | 166.54 / 175.17 | – | – | – | – | – | – |
<!-- /generated:scan-engines -->

`noble` runs the SDK's curve in the same loop as `wasm` and `native`, so the curve library is the whole gap. Thread rows exclude worker start and slice copy: 1.6–1.7 s (Bazzite) and 4.5–6.3 s (Turing) at 1M. On aarch64, `secp256k1` 5.0.2 builds libsecp256k1 with 32-bit limbs, so Turing's native row may understate libsecp256k1. [Method](../METHODS.md#scan-engines)

## Retained working set

Every profile scans the same 100k prefix, digest `46416d7ef2564c31807dd4c3eed410673b38091d3fa320c96dcd76c33d837b05`.

| Host | Retain 100k, s | Retain 1M, s | Ratio |
| --- | --- | --- | --- |
| M1, shared development host (more page faults and swap; cause not isolated) | 52.734 | 161.425 | 3.06 |
| Bazzite | 48.226 | 47.157 | 0.98 |
| Turing node 1 | 180.607 | 180.927 | 1.00 |

## Initial sweep on the M1

One repetition per scenario, 1,000-announcement batches, no warmup.

| Announcements | Scan time across eight scenarios | Peak RSS, including loading and the retained fixture |
| --- | --- | --- |
| 100,000 | 48.9–80.4 s | 464–487 MiB |
| 1,000,000 | 1,013.4–1,482.5 s | 3,879–4,099 MiB |

## Profile

| Share of Linux 1M profile | Value |
| --- | --- |
| noble `add` and `M`, sampled self hits | 83–85% |
| GC, wall time | about 0.1% |

[Method](../METHODS.md#scan-cost)

## Reproduce

```sh
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1   # all eight scenarios, small
bun run bench --sizes 10000,100000,1000000                                  # 1M needs several GiB of RAM and disk, and hours
scripts/scan-engines.sh bazzite                                             # or turing; REUSE_FIXTURES=dir,dir
bun run profile --fixture results/baseline-100k-1m/fixtures/100000-zero --output results/profile-100k --engine crypto --batch-size 0
```

[`results.csv`](../data/scan-cost/results.csv) · [`engines/`](../data/scan-cost/engines/) · [`profiling-bazzite/`](../data/scan-cost/profiling-bazzite/) · [`profiling-turing/`](../data/scan-cost/profiling-turing/) · [`baseline-100k-1m/`](../data/scan-cost/baseline-100k-1m/)
