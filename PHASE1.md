# Phase 1: local scanning baseline

**Finding:** local cryptographic scanning scaled roughly linearly on both tested Linux
hosts. Ten times more announcements took roughly ten times longer, and elliptic-curve
arithmetic dominated CPU cost. An earlier slowdown on the Apple M1 is not evidence of
intrinsically superlinear scanning.

ScopeLift SDK `1.0.0-beta.5`, Bun 1.4.4, frozen dependencies, deterministic synthetic
announcements, fresh processes. Generation, loading/decoding, setup GC and verification
are excluded from the timer; allocation and automatic GC during scanning are included.
Fetching was not timed (that is [phase 2](FINDINGS.md)). Methods: [METHODS.md](METHODS.md).

## Unprofiled scaling controls (crypto engine, zero-match)

These controls use the lower-level crypto path, not the full SDK wrapper. The 100k
controls bracketed the other measurements. Ranges are those two observations, not
confidence intervals. All twelve Linux runs verified their fixture oracle.

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

The large M1 penalty did not reproduce on either Linux host. The M1's larger
retained-data run also recorded many more process page faults and increased system swap
use. Those observations do not isolate memory compression, paging, CPU placement,
thermals, or competing development work as the cause. The M1's 1m baseline runs
(1013-1482 s, below) are therefore not used for scaling.

## Initial scale sweep (Apple M1, 8 GiB)

All 16 samples verified exact matches: zero-case results were empty; sparse cases
returned 100 and 1000 announcements. One repetition per engine/mode/case, 1000-entry
incremental batches, no explicit scan warmup.

| Announcements | Scan duration across eight scenarios | Process-lifetime peak RSS |
| --- | --- | --- |
| 100,000 | 48.9-80.4 s | 464-487 MiB |
| 1,000,000 | 1013.4-1482.5 s | 3879-4099 MiB |

These ranges mix engines, modes and match cases; they are not confidence intervals or
evidence of an engine winner. RSS includes fixture loading and validation, not just
scanning. Data: [`data/phase1/baseline-100k-1m/`](data/phase1/baseline-100k-1m/).

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

Use this as a local-scanning reference for matched private-discovery experiments, not
as evidence that any OMR architecture wins. It does not measure first-contact
bootstrap, on-chain overhead, recovery, private follow-up queries, or time to a
verified spendable balance. Phase 2 measures bounded-residency paged discovery in a
wallet, with fetching, cryptography and verification timed separately.
