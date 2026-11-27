# Phase 1: local scanning baseline

Local cryptographic scanning scaled roughly linearly on both Linux hosts, with elliptic-curve arithmetic dominating CPU cost. The Apple M1 slowed down with a larger retained fixture.

Fresh Bun 1.4.4 processes scanned deterministic fixtures with ScopeLift SDK 1.0.0-beta.5 and frozen dependencies. Timings cover allocation and automatic GC during the scan. [Measurement boundaries](METHODS.md#measurement-boundary) · [Paged discovery](FINDINGS.md)

## Unprofiled scaling controls (crypto engine, zero-match)

The 100k crypto controls bracket the other measurements. Ranges span two observations. All 12 Linux runs matched the fixture oracle.

| Host and CPU affinity | 100k before/after, s | 1m, s | 1m / 100k |
| --- | --- | --- | --- |
| Bazzite, i7-13700K, P-core threads 0,2,4,6, 32 GB RAM | 48.531-51.951 | 519.084 | 9.99-10.70 |
| Turing node 1, Cortex-A76 cores 4-7, 8 GB RAM | 168.457-181.946 | 1804.305 | 9.92-10.71 |

Data: [`data/results.csv`](data/results.csv),
[`data/phase1/profiling-bazzite/`](data/phase1/profiling-bazzite/),
[`data/phase1/profiling-turing/`](data/phase1/profiling-turing/).

## Retained-working-set control

These profiles scan the same 100k prefix with the same recipient keys while retaining
either 100k or 1m decoded announcements. The scanned-input digest is
`46416d7ef2564c31807dd4c3eed410673b38091d3fa320c96dcd76c33d837b05`.

| Host | Retain 100k, s | Retain 1m, s | Ratio |
| --- | --- | --- | --- |
| Apple M1, 8 GiB RAM, shared development host | 52.734 | 161.425 | 3.06 |
| Bazzite | 48.226 | 47.157 | 0.98 |
| Turing node 1 | 180.607 | 180.927 | 1.00 |

The larger M1 run recorded more page faults and system swap. Paging, compression, CPU placement, thermals and competing work remain possible causes. Scaling estimates use the Linux controls.

## Initial scale sweep (Apple M1, 8 GiB)

All 16 samples verified exact matches: zero-case results were empty; sparse cases
returned 100 and 1000 announcements. One repetition per engine/mode/case, 1000-entry
incremental batches, no explicit scan warmup.

| Announcements | Scan duration across eight scenarios | Process-lifetime peak RSS |
| --- | --- | --- |
| 100,000 | 48.9-80.4 s | 464-487 MiB |
| 1,000,000 | 1013.4-1482.5 s | 3879-4099 MiB |

Ranges span engines, modes and match cases. RSS includes loading and validation. [`data/phase1/baseline-100k-1m/`](data/phase1/baseline-100k-1m/).

## Attribution and limits

- Elliptic-curve point addition and modular reduction (the noble `add` and `M`
  functions) account for about 83-85% of sampled self hits in the Linux million-entry
  profiles. See `functions.txt` under `data/phase1/profiling-*/`.
- Recorded GC collection spans sum to about 0.1% of wall time in those profiles. They
  include concurrent phases and are not stop-the-world pause totals.
- Benchmark-process swap was zero at the Linux before/after snapshots, but Bazzite had
  other workload and host-wide swap activity. Neither host was reserved; CPU affinity
  does not reserve cores.
- These are reference-implementation observations, not browser/mobile predictions,
  statistical guarantees, or an engine ranking.
- Incremental mode still retains the whole fixture. Peak RSS includes loading and
  validation; it is not a wallet minimum-RAM requirement.

## Scope

This local baseline supports matched private-discovery experiments. It leaves first-contact bootstrap, gas, recovery, private follow-up queries and spendable-balance checks unmeasured.
