# Recorded data

One directory per experiment. Home-directory prefixes in recorded paths are replaced with `~`. Host labels (`bazzite`, `turing-node-N`) match the findings. Recorded JSON is unchanged from the runs, so it still names the old `phaseN` paths and kinds.

| Directory | Contents |
| --- | --- |
| [scan-cost/](scan-cost/) | [Scan cost](../docs/scan-cost.md). `results.csv`: unprofiled crypto scans, 100k before/after controls and the 1M run per Linux host. `smoke`, `baseline-10000`, `baseline-100k-1m` (Apple M1): `run.json`, `samples.jsonl`, `summary.json` and each fixture's `manifest.json` (test keys, destination schedule, SHA256). `baseline-100k-1m.log` is that sweep's console log. `profiling-bazzite`, `profiling-turing`: unprofiled controls (`*-unprofiled*.json`), `summary.json`, and per profile a verified `result.json` and `functions.txt`. `profiling-1m`, `profile-smoke`: M1 retained-set controls and a profiler smoke test. |
| [paged-discovery/](paged-discovery/) | [Paged discovery](../docs/paged-discovery.md). `repeat.csv`: per-setting median, min and max. `repeat-samples.csv`: every sample with node, temperature, throttle state, swap activity and a `tainted` flag. `single-run.csv`: the original single run (Appendix A). `repeat/<host>`: `plan.json` (seeded shuffle), `run.json`, `samples.jsonl`, `controls.jsonl`, `summary.json`/`.csv`, `fixtures.json`, and on Bazzite `HOST-GATE.txt`, plus per-host `*-summary.csv/md` and `*-samples.csv`. `single-run/<host>`: the same files (`sweep/`, and `million/` for the Pi 1M rescan). `mainnet-probe`: the keyless mainnet fetch-only probe. |
| [chain-volume/](chain-volume/) | [Chain volume](../docs/chain-volume.md). `endpoints.json`: chainlist snapshot metadata and candidate URLs. `probe/<chain>.json`: limits, errors, archive depth, latency. `canonical/` and `umbra/`: `reference-*` indexer runs, `retrieve-*` full-history runs with identities, `deploy-check-*`. `consistency/<chain>.json`: known-announcement rechecks. Derived `summary.md/csv`, `endpoints.csv`, `cross-source.csv`. |
| [browser-discovery/](browser-discovery/) | [Browser discovery](../docs/browser-discovery.md). Browser samples, `samples.csv` (timings, counts, verdicts), dual-provider reference, CORS controls, command-line preflight summary. |
| [rpc-recovery/](rpc-recovery/) | [RPC recovery](../docs/rpc-recovery.md). Pinned window manifest and receipt-corroborated reference, live and loopback captures, CORS controls, verified `summary.json`. |
| [shared-feed/](shared-feed/) | [Shared feed](../docs/shared-feed.md). Request metrics, page digests, sample timings, checkpoint controls, per-node evidence and the feed format search. |

## Not included

| Left out | Size | Regenerate |
| --- | --- | --- |
| Fixtures (`announcements.jsonl`) | ~100 MB per 100k, 1 GB per 1M | `bun run src/paged-discovery/prepare-fixtures.ts --output work/fixtures --fixtures <names>` or `bun run bench`. Seed `erc5564-scan-v1`; bytes are checked against pinned SHA256 digests. |
| Paged-discovery `pages.jsonl` (per-page timings) | up to 7 MB per run | Rerun the sweep. Per-sample totals are in `samples.jsonl`. |
| Paged-discovery `state/` (scan caches, expected-match oracles) | up to 380 KB each | Rebuilt by every sweep |
| Paged-discovery `run.log`, `bun-test.log`, `host-before/after.txt` | | Written by `src/paged-discovery/run.sh`. Per-sample host state is in `samples.jsonl`. |
| Profiler dumps: `scan.cpuprofile`, `scan.collapsed`, `stacks.json`, `gc.json`, `phases.json`, `bytecodes.txt`, native `sample` output, `vm-stat` logs | up to 16 MB each | `bun run profile` ([METHODS.md](../METHODS.md#profiling)) |
| Run tarballs, `node_modules`, Bun binaries | | `bun install --frozen-lockfile` |

**All keys and addresses in the manifests are public, deterministic test material.
Never fund them.**
