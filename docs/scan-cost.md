# Scan cost

How long does a local ERC-5564 scan take?

It is linear in announcements: 1M take about 10× as long as 100k.

<!-- generated:scan-cost -->
| Host | 100k before/after controls, s | 1M, s | 1M / 100k |
| --- | --- | --- | --- |
| Bazzite, P-core threads 0,2,4,6 | 48.531–51.951 | 519.084 | 9.99–10.70 |
| Turing node 1, Cortex-A76 cores 4–7 | 168.457–181.946 | 1804.305 | 9.92–10.71 |
<!-- /generated:scan-cost -->

Crypto engine, zero-match fixtures, two 100k controls per [host](../METHODS.md#hosts-and-software). Both hosts share cores with other work. At this rate the largest chain history, [Umbra on Polygon](chain-volume.md#umbra), takes about 180 s on Turing.

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
bun run profile --fixture results/baseline-100k-1m/fixtures/100000-zero --output results/profile-100k --engine crypto --batch-size 0
```

[`results.csv`](../data/scan-cost/results.csv) · [`profiling-bazzite/`](../data/scan-cost/profiling-bazzite/) · [`profiling-turing/`](../data/scan-cost/profiling-turing/) · [`baseline-100k-1m/`](../data/scan-cost/baseline-100k-1m/)
