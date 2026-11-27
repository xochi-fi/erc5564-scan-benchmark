# Methods

[Overview](README.md) · [Hardware](#hardware) · [Names in recorded data](#names-in-recorded-data) · [Commands](#commands) · [Layout](#repository-layout)

## Software

Versions are pinned in `package.json`: the SDK in `dependencies` and Bun in `packageManager`. The [SDK](https://github.com/ScopeLift/stealth-address-sdk) is unmodified, npm `gitHead` [`88bcc27c`](https://github.com/ScopeLift/stealth-address-sdk/tree/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2). Other Bun versions run but are recorded as a different environment.

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | Scan-cost controls and profiles, all later experiments |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | Scan-cost controls and profiles (node 1), paged discovery, shared feed |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | Scan-cost initial sweep and retained-set control only |

Experiments ran in this order, each reusing data or code from earlier ones: scan cost, paged discovery, chain volume, browser discovery, RPC recovery, shared feed.

## Names in recorded data

The experiments were first numbered as phases. Code, docs and `data/` directories now use experiment names, but a few `phaseN` strings remain because recorded fixtures, seeds or evidence depend on them. Renaming them would change fixture bytes or break the match with recorded JSON.

| String | Experiment | Where | Why it stays |
| --- | --- | --- | --- |
| `phase2-repeat-v1` | Paged discovery | Default `--seed` of `sweep.ts` and `scripts/paged-discovery.sh` | Prefix of the recorded shuffle seeds in `repeat/<host>/run.json`, which reproduce each `plan.json` order |
| `phase2-wallet`, `phase2-paged-discovery`, `phase2-mainnet-fetch-only` | Paged discovery | `kind` of wallet results, sweep runs and the mainnet probe | Recorded `samples.jsonl` and `run.json` carry these kinds |
| `phase2-test`, `phase2-test-zero` | Paged discovery | Seeds in `test/paged-discovery.test.ts` | Test fixtures only |
| `erc5564-scan-benchmark/phase3 (…)` | Chain volume | User-Agent in `src/chain-volume/http.ts` | Unchanged from the recorded run, so providers saw the same client |
| `phase4:base:browser:v1` | Browser discovery | Synthetic fixture seed in `src/browser-discovery/serve.ts` | Reproduces the two recorded matches and decoys |
| `phase4-checkpoint`, `phase5:<name>` | Browser discovery, RPC recovery | localStorage keys during the recorded runs (not stored in `data/`) | Renamed: the code now uses `browser-discovery-checkpoint` and `rpc-recovery:<name>`, which does not change any result |
| `phase6:base:v1` | Shared feed | Synthetic fixture seed in `src/shared-feed/run.ts` and `tune.ts` | Reproduces the recorded synthetic matches |

Recorded JSON is unchanged from the runs, so it may also name old `phaseN` paths.

## Synthetic fixtures

Scan cost and paged discovery use seeded synthetic announcements. They need no RPC provider, indexer, account, funded wallet or credentials. Metadata states a fixed ETH amount. No transfer is ever made.

- `zero` targets a decoy throughout. `sparse` targets the recipient at indices divisible by `matchEvery` (default 1000) and the decoy elsewhere.
- Ephemeral keys come from domain-separated SHA256 with rejection sampling. A fixed seed and options reproduce keys, event identities, ETH metadata, JSONL and manifest bytes.
- Logs are ABI-encoded at 128 announcements per block, one per transaction. Generation counts view-tag hits for the target key, natural nonmatch hits included.
- The sender schedule gives `expectedIndices`. Verification checks ordered `(blockHash, transactionHash, logIndex)` with multiplicity, so a dropped SDK rejection cannot pass as a missing match.
- Before timing, the loader checks schema, scalar and point validity, decoding, identities and order, row count, SHA256 and byte counts. It reads tag-hit counts from the manifest so it does not warm ECDH.
- The default seed `erc5564-scan-v1` gives byte-identical `announcements.jsonl`. Digests are pinned in [`data/scan-cost/*/fixtures/*/manifest.json`](data/scan-cost/) and in `src/paged-discovery/prepare-fixtures.ts`, which rejects a fixture whose bytes differ.

Offline tests use the real implementations. They cover determinism, matches and nonmatches, independent tag calculation, stealth private keys, input corruption, manifest errors, incremental equivalence and duplicates.

## Scan cost

Results: [docs/scan-cost.md](docs/scan-cost.md).

### Measurement boundary

Each engine, mode and repetition runs in a fresh Bun process. Engine order is fixed, so power, thermals and competing load can shift timings. Each process:

1. Read provenance, collect garbage, snapshot memory.
2. Load, validate and decode. Collect garbage, snapshot memory.
3. Prepare expected identities. Optionally scan the first `--warmup` entries.
4. Collect garbage, snapshot memory, time one complete scan.
5. Snapshot CPU and memory, lifetime peak RSS included. Verify the returned identities.

`scanMs` includes scan allocation and automatic GC. `--warmup 0` skips explicit warmup. Imports, ABI decoding, key validation and recipient derivation have already run by then.

| Engine or mode | What it does |
| --- | --- |
| `sdk` | Unmodified `getAnnouncementsForUser`, no sender filter or client, eager promises and result allocation included. |
| `crypto` | `checkStealthAddress`: ECDH and hash per entry, then the view-tag check. |
| `full` | Scans the whole array once. Models a lost scan cursor with retained viewing keys. |
| `incremental` | Scans contiguous batches of retained history, batch and result overhead included. |

Seed-only and StOMR recovery, provider completeness, spendability, network streaming, checkpoints, new heads and reorgs are out of scope.

Memory snapshots record RSS, JS heap and external memory at the four points above. Deltas are approximate. `processLifetimePeakRssBytes` includes imports, loading, validation and warmup. `fixtureBytes` is the JSONL size on disk. `syntheticRpcResponseBytes` is the uncompressed UTF-8 size of `{"jsonrpc":"2.0","id":1,"result":[...rawLogs]}`. Generation keeps key-uniqueness sets. Loading keeps decoded data and validation sets. Full SDK scans allocate one promise per entry. Million-entry runs need several GB of RAM.

A run directory holds:

| File | Contents |
| --- | --- |
| `run.json` | Options, SDK revision, start time |
| `fixtures/<count>-<case>/announcements.jsonl` | Raw event logs |
| `fixtures/<count>-<case>/manifest.json` | Test viewing keys, destination schedule, tag counts, file digest, synthetic response size |
| `samples.jsonl` | Unrounded verified timings, throughput, CPU time, memory, fixture and lockfile digests, dependency versions, Bun version, OS, CPU and RAM |
| `summary.json` | Per-scenario median/min/max ms, throughput at the median, max lifetime RSS. A single-sample summary is a smoke observation. |

### Profiling

`bun run profile` uses the same loader and engines on an existing fixture. JavaScriptCore sampling (20 ms default) and `node:v8` GC events cover the scan only. On macOS a 10 s native `sample` starts at scan entry and `vm_stat 1` records system counters. On Linux pass `--native-seconds 0`. The driver then records `vmstat -w 1`, `/proc` memory and CPU pressure, process status, swap counters and sysfs thermal and frequency data. Linux `perf` is not implemented. System counters include other processes.

Outputs: `scan.cpuprofile`, `scan.collapsed`, `stacks.json`, function and bytecode summaries, `gc.json`, `phases.json`, native stacks, VM telemetry and a verified `result.json` with source and lockfile hashes. GC durations are in microseconds in the pinned Bun ([native observer](https://github.com/oven-sh/bun/blob/38afee6c84fc/src/jsc/bindings/NodeV8.h)). They run from collection prologue to epilogue, concurrent phases included, so their sum is not stop-the-world time. Profiles are diagnostics, not baseline samples.

`--scan-count 100000` scans a prefix while retaining the full fixture. Comparing it with a separate 100k fixture separates retained-set effects from extra scan work. The result records both counts and a digest of the scanned inputs.

## Paged discovery

Results: [docs/paged-discovery.md](docs/paged-discovery.md). The wallet reuses the scan-cost fixtures (SHA256-checked) and engines (`scanAnnouncements` in `src/shared/worker.ts`).

| File | Role |
| --- | --- |
| `chain.ts`, `chain-server.ts` | Local JSON-RPC server. Indexes a fixture after checking SHA256 and block order, keeps line offsets and hash indexes in memory, reads log bodies from disk. Serves `eth_blockNumber`, `eth_chainId`, `eth_getLogs` (address and topic0, capped at head), `eth_getTransactionReceipt` and `eth_getBalance`. Receipts and balances are synthetic. A control port off the measured path moves the head and reports counters. |
| `link.ts` | TCP link emulator. Counts payload bytes each way, HTTP headers included. Each direction is one FIFO link: delivery = max(arrival, link free) + bytes/bandwidth + one-way latency. |
| `wallet.ts` | One fresh Bun process per sample. Reads the head, then per page: `eth_getLogs`, viem `decodeEventLog` (as the SDK's `getAnnouncements` does), scan, verify each candidate, checkpoint. Verification needs receipt status 1, the announced block, this exact log, and a stealth balance covering the announced amount. The checkpoint (`lastScannedBlock` plus matches) is written by atomic rename. One page is resident at a time. |
| `sweep.ts` | Starts one chain per fixture and profile. Per page size it runs a catch-up (prefix sync to head minus `--catchup-blocks`, then sync to head) and a cold rescan (cache deleted, scan from the first block). Records load, memory, swap, `pswpin/out`, thermal zones, CPU MHz and memory PSI around every sample. |

Files are in `src/paged-discovery/`.

| Profile | RTT | Down | Up |
| --- | --- | --- | --- |
| `none` | 0 (loopback) | unlimited | unlimited |
| `lan` | 1 ms | 1 Gbit/s | 1 Gbit/s |
| `public` | 100 ms | 50 Mbit/s | 20 Mbit/s |

### Measurement boundaries

| Field | Covers |
| --- | --- |
| `networkS` | `eth_blockNumber` and every `eth_getLogs`, send to last body byte, server time and link included. No JSON parsing. |
| `decodeS` | JSON.parse of log bodies and ABI decoding |
| `scanS` | The unmodified engine per page (`batchSize 0`, one SDK call per page) |
| `verifyS` | Receipt and balance round trips (`verifyNetworkS`) plus local checks |
| `otherS` | Checkpoints and loop overhead. Parts run sequentially and sum to `totalS`. |
| `firstMatchS` | Sync start to the first verified candidate |
| `wireDownMiB`, `wireUpMiB` | TCP payload through the emulator, HTTP headers included, no TCP/IP framing or TLS. `bodyMiB` is JSON-RPC bodies. |
| `peakRssMiB`, `chainRssMiB` | Wallet lifetime peak RSS with imports; server RSS at sample end |

After the timers stop, each sample checks exact ordered identities against an oracle read straight from the fixture at the manifest's schedule. The check covers the in-memory result, matches found since the checkpoint, and the persisted cache.

Out of scope: birthday-block and newest-first scans, reorgs, subscriptions, ERC-20 payments, spending nonce and gas, sweep key derivation and query privacy. Every log, receipt and balance lookup reveals interest to the RPC. Oldest-first order with a match at index 0 makes `firstMatchS` a first-page metric.

### Host runner

`scripts/paged-discovery.sh PLAN` (or `bun run paged-discovery:host PLAN`) runs the check, tests, fixtures and a sweep, then archives the run under `results/paged-discovery/`. The `bazzite` and `repeat-bazzite*` plans default to the i7 pinning below; other plans take the CPU lists from the environment.

| Setting | Use |
| --- | --- |
| Plan | `bazzite`, `turing`, `smoke` or a repeat plan in [src/paged-discovery/matrix/](src/paged-discovery/matrix/) |
| `BUN` | Bun override. Defaults to PATH, then `./.runtime/*/bun`. |
| `REUSE_NODE_MODULES`, `REUSE_FIXTURES` | Project with the same lockfile; comma-separated fixture directories, SHA256-checked |
| `HOST_LABEL`, `WALLET_CPUS`, `CHAIN_CPUS`, `CONTROL_CPUS` | Output label and Linux CPU lists. Bazzite plans default to `bazzite`, `0,2,4,6`, `8,10`, `0,2,4,6`; other plans to the short hostname and no pinning. |
| `MAINNET_RPC` | Optional read-only public RPC probe |
| `REPETITIONS`, `FIRST_REPETITION`, `SEED` | Repeat count, first repeat number, shuffle seed prefix |
| `COOLDOWN_C` | Max thermal zone temperature before each sample. Default 70 °C for `repeat-turing`. |
| `HOST_GATE`, `ALLOW_BUSY_HOST` | Enable the host gate (default for `repeat-bazzite*`), or run anyway and log the override |
| `GATE_MIN_AVAILABLE_GIB`, `GATE_MAX_SWAP_PAGES_PER_S`, `GATE_MAX_PSI_AVG60` | Defaults 8 GiB, 100 pages/s, PSI some avg60 1.0 |

## Commands

Setup, type check and tests: [Quickstart](README.md#quickstart). After changing anything under `data/`, run `bun run figures` and `bun run tables`. CI fails if the checked-in output is stale.

Each experiment doc ends with its own commands, all exposed as `bun run` scripts in `package.json`. Runs write under ignored `results/` or `work/`, never over `data/`, unless you pass a `data/` path. A run exits nonzero if any sample misses the fixture oracle. Keep the large workloads out of ordinary CI.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/shared/` | Fixture generator, scan engines, types, Announcer constants, raw-log decoding and the pinned Base windows, used by several experiments |
| `src/scan-cost/` | Benchmark CLI and profiler |
| `src/paged-discovery/` | Local chain, link emulator, wallet, sweep, reports and repeat matrices |
| `src/chain-volume/` | Keyless endpoint probe, adaptive retriever, indexer clients, report |
| `src/browser-discovery/`, `src/rpc-recovery/` | Browser harnesses |
| `src/shared-feed/` | Feed builder, benchmark, verifier and format search |
| `src/figures/` | `bun run figures` and `bun run tables`: README figures and the generated result tables, from `data/` |
| `scripts/` | `paged-discovery.sh`, the paged-discovery host runner |
| `test/` | `bun test` suites and recorded fixtures |
| `data/<experiment>/` | Recorded results ([data/README.md](data/README.md)) |
| `docs/<experiment>.md` | Results per experiment. Tables between `<!-- generated:… -->` markers come from `bun run tables`. |
| `docs/figures/` | SVGs from `bun run figures` |

## Caveats for synthetic experiments

These apply to scan cost and paged discovery.

- The chain and match rate are synthetic. 128 announcements per block and one payment per 1,000 announcements far exceed real use. See the [mainnet fetch-only probe](docs/paged-discovery.md#mainnet-fetch-only-probe) for real density.
- The link model has no TLS, compression, provider query time, limits, rate limiting, jitter or loss. Its near-zero network spread comes from the emulator. `public` is a controlled what-if, not a provider measurement.
- Fetch, scan and verify run sequentially with no prefetch, so each cost is separable. A pipelined wallet could hide up to min(network, scan).
- n = 3 separates findings from run noise but is too small for confidence intervals. The Pi's three samples per setting come from three nodes, so its spread is mostly between nodes.
- Peak RSS is the process high-water mark, Bun and SDK imports included.
- These are CLI runs of a reference implementation. They are not browser or mobile wallet numbers, and not a comparison with OMR, PIR, TEE or FHE. On-chain gas is out of scope.
