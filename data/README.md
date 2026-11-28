# Recorded data

One directory per experiment, with home paths shown as `~` ([hosts](../METHODS.md#hosts-and-software), [names](../METHODS.md#names-in-recorded-data)).

| Directory | Contents |
| --- | --- |
| [scan-cost/](scan-cost/) | [Scan cost](../docs/scan-cost.md). `results.csv`: unprofiled crypto scans, 100k before/after controls and the 1M run per Linux host. `smoke`, `baseline-10000`, `baseline-100k-1m` (Apple M1): `run.json`, `samples.jsonl`, `summary.json` and each fixture's `manifest.json` (test keys, destination schedule, SHA256). `baseline-100k-1m.log` is that sweep's console log. `profiling-bazzite`, `profiling-turing`: unprofiled controls (`*-unprofiled*.json`), `summary.json`, and per profile a verified `result.json` and `functions.txt`. `profiling-1m`, `profile-smoke`: M1 retained-set controls and a profiler smoke test. `engines/<host>/`: one `bench` output per step of `scripts/scan-engines.sh` and its `run.log`, without fixture bodies. |
| [paged-discovery/](paged-discovery/) | [Paged discovery](../docs/paged-discovery.md). `repeat.csv`: per-setting median, min and max. `repeat-samples.csv`: every sample with node, temperature, throttle state, swap activity and a `tainted` flag. `single-run.csv`: the original single run (Appendix A). `repeat/<host>`: `plan.json` (seeded shuffle), `run.json`, `samples.jsonl`, `controls.jsonl`, `summary.json`/`.csv`, `fixtures.json`, and on Bazzite `HOST-GATE.txt`, plus per-host `*-summary.csv/md` and `*-samples.csv`. `single-run/<host>`: the same files (`sweep/`, and `million/` for the Turing 1M rescan). `mainnet-probe`: the keyless mainnet fetch-only probe. |
| [chain-volume/](chain-volume/) | [Chain volume](../docs/chain-volume.md). `endpoints.json`: chainlist snapshot metadata and candidate URLs. `probe/<chain>.json`: limits, errors, archive depth, latency. `canonical/` and `umbra/`: `reference-*` indexer runs, `retrieve-*` full-history runs with identities, `deploy-check-*`. `consistency/<chain>.json`: known-announcement rechecks. `refresh/<date>.json`: weekly refresh snapshots. Derived `summary.md/csv`, `endpoints.csv`, `cross-source.csv`. |
| [browser-discovery/](browser-discovery/) | [Browser discovery](../docs/browser-discovery.md). Browser samples, `samples.csv` (timings, counts, verdicts), dual-provider reference, CORS controls, command-line preflight summary. |
| [rpc-recovery/](rpc-recovery/) | [RPC recovery](../docs/rpc-recovery.md). Pinned window manifest and receipt-corroborated reference, live and loopback captures, CORS controls, verified `summary.json`. |
| [spam-cost/](spam-cost/) | [Spam cost](../docs/spam-cost.md). Per chain: endpoint, `eth_estimateGas` of a direct and a state-override batched `announce`, latest block, 1,024-block `eth_feeHistory`, OP Stack `getL1Fee`, receipts of recorded announcements. `prices.json`: one CoinGecko quote. |
| [omission-cause/](omission-cause/) | [Omission cause](../docs/omission-cause.md). Per chain, two passes: each suspect provider's and Tenderly's answers about every known omitted announcement. |
| [freshness/](freshness/) | [Freshness](../docs/freshness.md). Per chain: 12-s samples of `latest` and `finalized` headers and the Announcer tail poll between them. |
| [real-announcements/](real-announcements/) | [Real announcements](../docs/real-announcements.md). Raw logs of every recorded ERC-5564 announcement; `scan.json` engine results; `timing-<host>.json`. |
| [shared-feed/](shared-feed/) | [Shared feed](../docs/shared-feed.md). Request metrics, page digests, sample timings, checkpoint controls, per-node evidence and the feed format search. `static/` and `remote/`: the benchmark feeds as files and runs fetching them over the network. |

## Not included

| Left out | Size | Regenerate |
| --- | --- | --- |
| Fixtures (`announcements.jsonl`) | ~100 MB per 100k, 1 GB per 1M | `bun run src/paged-discovery/prepare-fixtures.ts --output work/fixtures --fixtures <names>` or `bun run bench`. ([seed and digests](../METHODS.md#synthetic-fixtures)) |
| Paged-discovery `pages.jsonl` (per-page timings) | up to 7 MB per run | Rerun the sweep. Per-sample totals are in `samples.jsonl`. |
| Paged-discovery `state/` (scan caches, expected-match oracles) | up to 380 kB each | Rebuilt by every sweep |
| Paged-discovery `run.log`, `bun-test.log`, `host-before/after.txt` | | Written by `scripts/paged-discovery.sh`. Per-sample host state is in `samples.jsonl`. |
| Profiler dumps: `scan.cpuprofile`, `scan.collapsed`, `stacks.json`, `gc.json`, `phases.json`, `bytecodes.txt`, native `sample` output, `vm-stat` logs | up to 16 MB each | `bun run profile` ([METHODS.md](../METHODS.md#profiling)) |
| Run tarballs, `node_modules`, Bun binaries | | `bun install --frozen-lockfile` |
