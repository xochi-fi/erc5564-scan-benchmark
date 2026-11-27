# Scan cost

How long does a local ERC-5564 scan take? About 0.5 ms per announcement on an i7-13700K and 1.7–1.8 ms on a Cortex-A76. Time grows linearly from 100k to 1M.

<!-- generated:scan-cost -->
| Host | 100k before/after controls, s | 1M, s | 1M / 100k |
| --- | --- | --- | --- |
| Bazzite, P-core threads 0,2,4,6 | 48.531–51.951 | 519.084 | 9.99–10.70 |
| Turing node 1, Cortex-A76 cores 4–7 | 168.457–181.946 | 1804.305 | 9.92–10.71 |
<!-- /generated:scan-cost -->

[Hardware](../METHODS.md#hardware). Crypto engine, zero-match fixtures, unprofiled. Two 100k controls bracket the other runs. All 12 Linux runs matched the fixture oracle. At this rate the largest chain history, Polygon's 102,552 Umbra announcements, takes about 180 s on the A76.

Scan-time estimates elsewhere use these 100k controls (i7 48.5–52.0 s), not the paged-discovery controls (i7 47.3–47.6 s). Data: [`results.csv`](../data/scan-cost/results.csv), [`profiling-bazzite/`](../data/scan-cost/profiling-bazzite/), [`profiling-turing/`](../data/scan-cost/profiling-turing/).

## Retained working set

Each profile scans the same 100k prefix with the same keys and retains either 100k or 1M decoded announcements. Scanned-input digest: `46416d7ef2564c31807dd4c3eed410673b38091d3fa320c96dcd76c33d837b05`.

| Host | Retain 100k, s | Retain 1M, s | Ratio |
| --- | --- | --- | --- |
| Apple M1, shared development host | 52.734 | 161.425 | 3.06 |
| Bazzite | 48.226 | 47.157 | 0.98 |
| Turing node 1 | 180.607 | 180.927 | 1.00 |

The M1 run recorded more page faults and system swap; the cause was not isolated.

## Initial sweep (Apple M1)

16 samples, all matching the oracle. Sparse cases found 100 and 1,000 announcements. One repetition per configuration, 1,000-entry incremental batches, no explicit warmup.

| Announcements | Scan time across eight scenarios | Process-lifetime peak RSS |
| --- | --- | --- |
| 100,000 | 48.9–80.4 s | 464–487 MiB |
| 1,000,000 | 1013.4–1482.5 s | 3879–4099 MiB |

Ranges span engines, modes and match cases. RSS includes loading and validation. [`baseline-100k-1m/`](../data/scan-cost/baseline-100k-1m/)

## Where the time goes

- Point addition and modular reduction (noble `add` and `M`) take 83–85% of sampled self hits in the Linux 1M profiles (`functions.txt` under `data/scan-cost/profiling-*/`).
- GC spans sum to about 0.1% of wall time, concurrent phases included.

## Limits

- Linux snapshots showed no swap for the benchmark process. Bazzite ran other workloads and had host-wide swap. Both hosts used shared cores.
- Incremental mode retains the whole fixture.
- Local CLI scanning only. Browser and mobile performance, first-contact bootstrap, gas, recovery, private follow-up queries and spendable-balance checks are out of scope.

Method: [workloads, timers and engines](../METHODS.md#scan-cost). [Shared caveats](../METHODS.md#caveats-for-synthetic-experiments).

## Reproduce

```sh
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1   # all eight scenarios, small
bun run bench --sizes 10000,100000,1000000                                  # 1M needs several GB of RAM and disk, and hours
bun run profile --fixture results/baseline-100k-1m/fixtures/100000-zero --output results/profile-100k \
  --engine crypto --batch-size 0
```
