# Scan cost

How long does a local ERC-5564 scan take?

Nearly all of the ScopeLift SDK's scan time is pure-JS curve arithmetic. libsecp256k1 does the same check about 4× faster as WASM and 10–15× faster native.

<!-- generated:scan-engines -->
| Engine | Threads | Bazzite, µs | Speed-up | Turing node 1, µs | Speed-up |
| --- | ---: | ---: | ---: | ---: | ---: |
| ScopeLift SDK | 1 | 483.6 | 1.0× | 1,749.1 | 1.0× |
| noble, the SDK's curve in a lean loop | 1 | 481.4 | 1.0× | 1,751.6 | 1.0× |
| libsecp256k1 WASM | 1 | 124.5 | 3.9× | 431.2 | 4.1× |
| libsecp256k1 WASM | 2 | 63.1 | 7.7× | 222.2 | 7.9× |
| libsecp256k1 WASM | 4 | 33.4 | 14.5× | 136.4 | 12.8× |
| libsecp256k1 native | 1 | 31.3 | 15.4× | 166.4 | 10.5× |
| libsecp256k1 native | 2 | 15.6 | 30.9× | 83.9 | 20.9× |
| libsecp256k1 native | 4 | 8.4 | 57.2× | 50.8 | 34.4× |
<!-- /generated:scan-engines -->

Cells are wall time per announcement: the median over the 100k and 1M zero and sparse fixtures, which agree within 9% (one Bazzite WASM 2-thread run: 14%). `noble` runs the SDK's curve in the same loop as `wasm` and `native`, so the curve library accounts for the whole gap. Scans are linear: 1M takes 9.9–10.7× as long as 100k ([`results.csv`](../data/scan-cost/results.csv)).

Caveats: thread rows leave out worker start and slice copy (up to 6.3 s at 1M); on aarch64, `secp256k1` 5.0.2 builds libsecp256k1 with 32-bit limbs, so Turing's native rows may understate it; both hosts share cores with other work ([controls](../data/scan-cost/engines/)).

## Profile

In the Linux 1M profiles, noble's `add` and `M` take 83–85% of sampled self hits and GC about 0.1% of wall time. Retaining 1M announcements instead of 100k leaves a 100k scan unchanged on Bazzite (0.98×) and Turing (1.00×); the M1 slowed 3.06× ([`profiling-bazzite/`](../data/scan-cost/profiling-bazzite/), [`profiling-turing/`](../data/scan-cost/profiling-turing/), [`profiling-1m/`](../data/scan-cost/profiling-1m/)). The first M1 sweep, eight scenarios, took 48.9–80.4 s at 100k and 1,013–1,483 s at 1M, with peak RSS up to 4,099 MiB ([`baseline-100k-1m/`](../data/scan-cost/baseline-100k-1m/)).

[Method](../METHODS.md#scan-cost)

## Reproduce

```sh
bun run bench --sizes 10000,100000,1000000                                  # 1M needs several GiB of RAM and disk, and hours
scripts/scan-engines.sh bazzite                                             # or turing; REUSE_FIXTURES=dir,dir
bun run profile --fixture results/baseline-100k-1m/fixtures/100000-zero --output results/profile-100k --engine crypto --batch-size 0
```

[`results.csv`](../data/scan-cost/results.csv) · [`engines/`](../data/scan-cost/engines/) · [`profiling-bazzite/`](../data/scan-cost/profiling-bazzite/) · [`profiling-turing/`](../data/scan-cost/profiling-turing/) · [`baseline-100k-1m/`](../data/scan-cost/baseline-100k-1m/)
