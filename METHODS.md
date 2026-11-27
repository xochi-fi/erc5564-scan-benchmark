# Methods

[Overview](README.md) · [Commands](#commands) · [Layout](#repository-layout)

## Software

ScopeLift's [`@scopelift/stealth-address-sdk`](https://github.com/ScopeLift/stealth-address-sdk) `1.0.0-beta.5` (npm `gitHead` [`88bcc27c`](https://github.com/ScopeLift/stealth-address-sdk/tree/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2)), unmodified, on [Bun](https://bun.sh) 1.4.4, the `packageManager` version. Other Bun versions run but are recorded as a different environment.

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

Results: [FINDINGS.md](FINDINGS.md). The wallet reuses the scan-cost fixtures (SHA256-checked) and engines (`scanAnnouncements` in `src/shared/worker.ts`).

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

### Timers

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

`src/paged-discovery/run.sh PLAN` runs the check, tests, fixtures and a sweep, then archives the run. `scripts/run-bazzite.sh` sets i7 pinning and calls it.

| Setting | Use |
| --- | --- |
| Plan | `bazzite`, `turing`, `smoke` or a repeat plan in [scripts/matrix/](scripts/matrix/) |
| `BUN` | Bun override. Defaults to PATH, then `./.runtime/*/bun`. |
| `REUSE_NODE_MODULES`, `REUSE_FIXTURES` | Project with the same lockfile; comma-separated fixture directories, SHA256-checked |
| `HOST_LABEL`, `WALLET_CPUS`, `CHAIN_CPUS`, `CONTROL_CPUS` | Output label (default short hostname) and Linux CPU lists |
| `MAINNET_RPC` | Optional read-only public RPC probe |
| `REPETITIONS`, `FIRST_REPETITION`, `SEED` | Repeat count, first repeat number, shuffle seed prefix |
| `COOLDOWN_C` | Max thermal zone temperature before each sample. Default 70 °C for `repeat-turing`. |
| `HOST_GATE`, `ALLOW_BUSY_HOST` | Enable the host gate (default for `repeat-bazzite*`), or run anyway and log the override |
| `GATE_MIN_AVAILABLE_GIB`, `GATE_MAX_SWAP_PAGES_PER_S`, `GATE_MAX_PSI_AVG60` | Defaults 8 GiB, 100 pages/s, PSI some avg60 1.0 |

## Commands

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun test        # no network, no mocks
```

Each experiment doc ends with its own commands. Scan cost and paged discovery write new directories under ignored `results/` or `work/`. Chain volume writes to `data/chain-volume/` by default and overwrites recorded files, so pass `--output results/<run>` on every stage for a separate run. A run exits nonzero if any sample misses the fixture oracle. Keep the large workloads out of ordinary CI.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/shared/` | Fixture generator, scan engines and types used by several experiments |
| `src/scan-cost/` | Benchmark CLI and profiler |
| `src/paged-discovery/` | Local chain, link emulator, wallet, sweep, reports, host runner |
| `src/chain-volume/` | Keyless endpoint probe, adaptive retriever, indexer clients, report |
| `src/browser-discovery/`, `src/rpc-recovery/` | Browser harnesses |
| `src/shared-feed/` | Feed builder, benchmark, verifier and format search |
| `scripts/` | Host runner and repeat matrices |
| `test/` | `bun test` suites and recorded fixtures |
| `data/<experiment>/` | Recorded results ([data/README.md](data/README.md)) |
| `docs/<experiment>.md` | Results per experiment |
| `FINDINGS.md` | Paged-discovery results |

## Caveats for synthetic experiments

These apply to scan cost and paged discovery.

- The chain and match rate are synthetic. 128 announcements per block and one payment per 1,000 announcements far exceed real use. A keyless mainnet probe saw 14 real announcements in about 10k recent blocks.
- The link model has no TLS, compression, provider query time, limits, rate limiting, jitter or loss. Its near-zero network spread comes from the emulator. `public` is a controlled what-if, not a provider measurement.
- Fetch, scan and verify run sequentially with no prefetch, so each cost is separable. A pipelined wallet could hide up to min(network, scan).
- n = 3 separates findings from run noise but is too small for confidence intervals. The Pi's three samples per setting come from three nodes, so its spread is mostly between nodes.
- Peak RSS is the process high-water mark, Bun and SDK imports included.
- These are CLI runs of a reference implementation. They are not browser or mobile wallet numbers, and not a comparison with OMR, PIR, TEE or FHE. On-chain gas is out of scope.
