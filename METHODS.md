# Methods

[Overview](README.md) · [Phase 1](PHASE1.md) · [Phase 2](FINDINGS.md) · [Phase 3](PHASE3.md) · [Phase 4](PHASE4.md) · [Phase 5](PHASE5.md) · [Phase 6](PHASE6.md) · [Commands](#commands)

# Phase 1: local scanning

## Workloads and correctness

- `zero` targets a decoy throughout. `sparse` targets the recipient at indices divisible by `matchEvery` (default 1000), and the decoy elsewhere.
- Domain-separated SHA256 with rejection sampling generates distinct, validated ephemeral keys. A fixed seed and options reproduce keys, event identities, ETH metadata, JSONL and manifest bytes.
- ABI-encoded synthetic logs model 128 announcements per block, each in its own transaction. Generation counts per-announcement tag hits with the target viewing key and each ephemeral key, including natural nonmatch hits.
- The sender schedule supplies `expectedIndices`. Verification checks ordered `(blockHash, transactionHash, logIndex)` with multiplicity, so dropped SDK rejections cannot pass as missing matches.

Before timing, the loader checks schema, scalar/point validity, decoding, identities/order, row count, SHA256 and byte accounting. It reads tag-hit counts from the manifest to avoid warming ECDH.

Offline tests use real implementations and cover determinism, matches/nonmatches, independent tag calculations, stealth private keys, input corruption, manifest errors, incremental equivalence and duplicates.

## Measurement boundary

Each engine/mode/repetition runs sequentially in a fresh Bun process:

1. Read provenance, collect garbage and snapshot memory before loading.
2. Load, validate and decode, then collect garbage and snapshot memory.
3. Prepare expected identities and optionally scan the first `--warmup` entries.
4. Collect garbage, snapshot memory and time one complete scan.
5. Snapshot CPU and memory (including lifetime peak RSS), then verify returned identities.

`scanMs` covers scan allocation and automatic GC. `--warmup 0` skips explicit warmup, after imports, ABI decoding, key validation and recipient derivation have already run.

### Engines and modes

- **sdk** uses unmodified `getAnnouncementsForUser` without sender filters or a client, including eager promises and result allocation.
- **crypto** uses `checkStealthAddress`, with ECDH/hash per entry before the view-tag check, and collects matches.
- **full** scans the whole array once. A fresh run models losing scan progress while retaining viewing keys. Seed-only and StOMR recovery, provider completeness and spendability are outside scope.
- **incremental** scans contiguous batches of retained history, including batch/result overhead. Network streaming, checkpoints, new heads and reorgs are outside scope.

### Memory and bytes

- Snapshots record RSS, JS heap and external memory before loading, after loading/GC, before scanning/GC and immediately after scanning. Deltas are approximate.
- `processLifetimePeakRssBytes` includes imports, fixture loading/validation and warmup. Use fresh processes for isolation.
- `fixtureBytes` is on-disk JSONL size. `syntheticRpcResponseBytes` counts uncompressed UTF-8 bytes of `{"jsonrpc":"2.0","id":1,"result":[...rawLogs]}`, excluding transport overhead and compression.

Streaming fixture I/O still retains key uniqueness sets during generation and decoded data plus validation sets when loading. Full SDK scans allocate one promise per entry. Provision several GB of RAM for million-entry runs.

## Artifacts

Each new run directory contains:

- `run.json`: requested options, SDK source revision, start time.
- `fixtures/<count>-<case>/announcements.jsonl`: generated raw event logs.
- `fixtures/<count>-<case>/manifest.json`: test viewing keys, destination schedule, target-tag counts, file digest and synthetic response size.
- `samples.jsonl`: unrounded verified timings, throughput, CPU time, memory snapshots, fixture digest, lockfile digest, dependency versions, Bun/Node-compatibility version, OS, CPU and RAM per process.
- `summary.json`: per-scenario median/min/max milliseconds, throughput at median duration and maximum process-lifetime RSS. Single-sample summaries are smoke observations, not statistically stable performance claims.

Scan-engine order is fixed. Power, thermals and competing load affect timing. TEE, FHE, PIR, OMR and on-chain gas are outside scope.

## Profiling a scan

The macOS and Linux profiling driver uses the same fixture loader and scan engines. Pass an existing fixture and a new output directory.

```sh
bun run profile \
  --fixture results/baseline-100k-1m/fixtures/100000-zero \
  --output results/profile-100k \
  --engine crypto --batch-size 0
```

JavaScriptCore sampling and `node:v8` GC-event recording are scoped to the scan,
excluding fixture loading and result verification. The sampling interval defaults
to 20 ms. On macOS, a 10-second native `sample` capture starts at scan entry and
`vm_stat 1` records system-wide counters. On Linux, pass `--native-seconds 0`;
the driver records `vmstat -w 1`, `/proc` memory/CPU pressure, process status,
swap counters, and available sysfs thermal/frequency data. Native Linux `perf`
sampling is not implemented. Phase snapshots include process resource counters
and JavaScriptCore heap statistics. System counters cannot be attributed solely
to the benchmark.

Outputs include `scan.cpuprofile` (Chrome DevTools), `scan.collapsed`
(flamegraph input), raw `stacks.json`, function/bytecode summaries, `gc.json`,
`phases.json`, native stacks, VM telemetry, and a verified `result.json` with
source/lockfile hashes. GC event costs are microseconds in the pinned Bun
release ([native observer](https://github.com/oven-sh/bun/blob/38afee6c84fc/src/jsc/bindings/NodeV8.h)).
They span collection prologue to epilogue, including concurrent phases; their
sum must not be assumed to equal stop-the-world wall time. Profiling
overhead makes these diagnostic measurements, not replacement baseline samples.

`--scan-count 100000` scans only the prefix while retaining the complete loaded
fixture. Compare that diagnostic control with a separate 100k fixture to
distinguish retained-dataset effects from additional scan work. The result records
both counts and a digest of the actual scanned identities/cryptographic inputs.
`--native-seconds 0` disables native stack sampling explicitly.

# Phase 2: paged discovery in a wallet

Phase 2 measures what a wallet pays to discover its payments when it pages through announcement history over JSON-RPC, split into separately timed costs. It reuses the phase-1 fixtures (byte-identical, SHA256-checked) and the unmodified phase-1 scan engines (`scanAnnouncements` from `src/worker.ts`).

## Components

- `src/phase2/chain.ts`, `chain-server.ts`: deterministic local JSON-RPC
  server (Bun). It indexes a fixture (SHA256 checked against the manifest,
  block ordering checked), keeps only line offsets and hash indexes in memory,
  and reads log bodies from disk per request. It serves `eth_blockNumber`,
  `eth_chainId`, `eth_getLogs` (address/topic0 filter, block range, capped at
  the head), `eth_getTransactionReceipt` and `eth_getBalance`. Receipts and
  balances are synthetic: each announcement's transaction succeeded and its
  stealth address holds the ETH amount stated in its metadata. A control port
  (never on the measured path) moves the head and reports counters.
- `src/phase2/link.ts`: TCP link emulator in front of the server. It counts
  TCP payload bytes in each direction (HTTP headers + bodies) and applies a
  deterministic link profile: each direction is one FIFO link, delivery =
  max(arrival, link free) + bytes/bandwidth + one-way latency.

  | Profile | RTT | Down | Up |
  | --- | --- | --- | --- |
  | `none` | 0 (loopback) | unlimited | unlimited |
  | `lan` | 1 ms | 1 Gbit/s | 1 Gbit/s |
  | `public` | 100 ms | 50 Mbit/s | 20 Mbit/s |

- `src/phase2/wallet.ts`: the wallet. Each sample is a fresh Bun process. It
  reads the head, then for each page of `--pages` blocks (128 announcements
  per block): `eth_getLogs` -> decode (viem `decodeEventLog`, as the SDK's own
  `getAnnouncements` does) -> scan the page with the phase-1 engine -> verify
  every candidate (receipt must be status 1, in the announced block, and
  contain this exact log; stealth balance must cover the announced amount) ->
  checkpoint the scan cache (`lastScannedBlock` + verified matches, atomic
  rename). Only one page is resident at a time.
- `src/phase2/sweep.ts`: orchestrator. Per fixture and profile it starts one
  chain process; per page size it runs a **catch-up** (the scan cache from an
  untimed-in-summary prefix sync to head minus `--catchup-blocks`, then sync to
  head) and a **cold rescan** (the wallet deletes the scan cache, then rescans
  from the first fixture block). Host state (load, memory/swap, `pswpin/out`,
  thermal zones, CPU MHz, memory PSI) is recorded before and after every
  sample.

## Measurement boundaries

- `networkS` = `eth_blockNumber` + every `eth_getLogs`, from request send until
  the response body is fully received (includes server time and the emulated
  link). JSON parsing is not in it.
- `decodeS` = JSON.parse of the getLogs bodies + ABI decoding into
  `AnnouncementLog`s.
- `scanS` = the unmodified phase-1 engine over each page (`batchSize 0` per
  page, i.e. one SDK call per page).
- `verifyS` = per-candidate receipt + balance round trips (`verifyNetworkS`)
  plus the local checks and parsing.
- `otherS` = scan-cache checkpoints and loop overhead. `totalS` is the wall
  clock of the whole sync; the parts are measured sequentially, so they add up.
- `firstMatchS` = sync start until the first candidate is **verified**.
- `wireDownMiB`/`wireUpMiB` = TCP payload bytes through the emulator (includes
  HTTP headers, excludes TCP/IP framing and TLS); `bodyMiB` = JSON-RPC bodies.
- `peakRssMiB` = wallet process-lifetime peak RSS (includes Bun and SDK
  imports); `chainRssMiB` = the server process at the end of the sample.
- Exact ordered `(blockHash, transactionHash, logIndex)` identity verification
  happens after the timers, against an oracle read directly from the fixture
  file at the manifest's destination schedule (independent of server and
  wallet code). Every sample checks the in-memory result, the newly found
  matches since the checkpoint, and the persisted cache.

## What phase 2 does not measure

See [shared caveats](#caveats-for-phases-1-and-2) for modeled link and runtime limits. The optional mainnet probe records real fetch cost separately. Oldest-first order and a match at index 0 make `firstMatchS` a first-page metric. Birthday-block and newest-first scans are outside scope, along with reorgs, subscriptions, ERC-20 payments, spending nonce/gas and sweeping key derivation. Query privacy is outside scope: every log, receipt and balance lookup reveals interest to the RPC.

# Reproducing, layout and scope

## Software

ScopeLift's [`@scopelift/stealth-address-sdk`](https://github.com/ScopeLift/stealth-address-sdk)
`1.0.0-beta.5` (npm `gitHead`
[`88bcc27c`](https://github.com/ScopeLift/stealth-address-sdk/tree/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2)),
unmodified, on [Bun](https://bun.sh) **1.4.4** (the `packageManager` version; other
versions run but are recorded as a different environment). Phases 1 and 2 use
deterministic synthetic announcements generated from a seed and need no RPC provider,
indexer, account, funded wallet or credentials. Synthetic announcement metadata
describes a fixed ETH amount; no transfer or transaction is ever executed.

## Commands

```sh
bun install --frozen-lockfile
bun run check          # tsc --noEmit
bun test               # unit and integration tests, no network, no mocks

# Phase 1: small end-to-end check of all eight scenarios
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1

# Phase 1: scale sweep (1m fixtures need several GB of RAM and disk, and hours)
bun run bench --sizes 10000,100000,1000000

# Phase 1: profile an existing zero-match fixture (adjust the run directory)
bun run profile --fixture results/baseline-100k-1m/fixtures/100000-zero --output results/profile-100k \
  --engine crypto --batch-size 0

# Phase 2: regenerate fixtures and check them against the pinned digests
bun run src/phase2/prepare-fixtures.ts --output work/fixtures \
  --fixtures 100000-zero,10000-sparse,100000-sparse,1000000-sparse

# Phase 2: one sweep
bun run phase2 --fixtures work/fixtures/100000-sparse --pages 1,16,64,256 \
  --profiles none,public --scenarios cold,catchup \
  --control-fixture work/fixtures/100000-zero --output results/phase2-my-run

# Phase 2: whole host plans used for the recorded results
scripts/phase2-run.sh repeat-smoke      # a few minutes, end-to-end check of the repeat path
scripts/run-bazzite.sh repeat-bazzite   # i7 pinning defaults, host-gated, about 5.2 h
scripts/phase2-run.sh repeat-turing     # per Pi node; see FINDINGS.md "Reproduce" for the env

# Phase 2: optional read-only mainnet fetch probe (off by default, never mixed into the results)
bun run phase2:mainnet --rpc https://ethereum-rpc.publicnode.com --output results/mainnet-probe

# Phase 3 (live network, read-only, keyless; all stages in PHASE3.md)
bun test test/phase3.test.ts                 # offline: recorded error bodies, simulated endpoints
bun run phase3 --stage endpoints,reference,probe,retrieve,consistency,report
```

Phases 1 and 2 use fresh output directories under ignored `results/` or `work/`. Phase 3 writes to `data/phase3/` by default and can overwrite recorded files. Pass `--output results/phase3-my-run` on every stage to keep a separate live run. Every sample checks its discovered payments against an oracle taken
from the fixture's sender-side schedule; a run exits nonzero if any sample does not
match. Do not put the large workloads in ordinary CI.

Fixtures are deterministic: the default seed `erc5564-scan-v1` and the fixture options
produce byte-identical `announcements.jsonl` files, and their SHA256 digests are pinned
in [`data/phase1/*/fixtures/*/manifest.json`](data/phase1/) and in
`src/phase2/prepare-fixtures.ts`, which refuses a fixture whose bytes differ.

### Phase 2 host runner options

| Setting | Use |
| --- | --- |
| Plan argument | `bazzite`, `turing`, `smoke` or a repeat plan from [scripts/matrix/](scripts/matrix/) |
| `BUN` | Bun override. Defaults to PATH, then `./.runtime/*/bun`. |
| `REUSE_NODE_MODULES`, `REUSE_FIXTURES` | Project directory with the same lockfile, and comma-separated fixture directories checked by SHA256. |
| `HOST_LABEL`, `WALLET_CPUS`, `CHAIN_CPUS`, `CONTROL_CPUS` | Output label (default short hostname) and Linux CPU lists. |
| `MAINNET_RPC` | Optional read-only public RPC probe. |
| `REPETITIONS`, `FIRST_REPETITION`, `SEED` | Repeat count, first repeat number and shuffle seed prefix for split runs. |
| `COOLDOWN_C` | Maximum thermal zone temperature before each sample, default 70 °C for `repeat-turing`. |
| `HOST_GATE`, `ALLOW_BUSY_HOST` | Enable host gate (default for `repeat-bazzite*`) or log an override after failure. |
| `GATE_MIN_AVAILABLE_GIB`, `GATE_MAX_SWAP_PAGES_PER_S`, `GATE_MAX_PSI_AVG60` | Gate defaults are 8 GiB, 100 pages/s and PSI some avg60 of 1.0. |

## Hosts

[Hardware and pinning](README.md#hardware) · [Phase 2 node and host-state details](FINDINGS.md#repeat-design)

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | phase-1 fixture generator, scan engines, CLI and profiler |
| `src/phase2/` | local JSON-RPC chain server, link emulator, wallet, sweep and report tools |
| `src/phase3/` | keyless endpoint probe, adaptive history retriever, indexer clients, report |
| `test/` | `bun test` suites |
| `scripts/` | Phase 2 host plans, Phase 4–5 browser harnesses, Phase 6 feed benchmark |
| `data/` | recorded results: summary CSVs and per-run JSON/JSONL ([data/README.md](data/README.md)) |
| `PHASE1.md` | phase 1 findings |
| `FINDINGS.md` | phase 2 findings, repeat tables and Appendix A single run |
| `PHASE3.md` | phase 3 findings: keyless log retrieval per chain, guidance for wallets |
| `METHODS.md` | workloads, measurement boundaries, artifacts, phase-2 components, this section |

## Caveats for phases 1 and 2

- The chain and the match rate are synthetic: 128 announcements per block and 1
  payment per 1000 announcements are far above real usage. A keyless mainnet probe saw
  14 real announcements in about 10k recent blocks.
- The link model omits TLS, compression, provider query time and limits, rate limiting,
  jitter and loss. Its near-zero network spread is a property of the emulator. Treat
  `public` as a controlled what-if, not a provider measurement.
- Fetching, scanning and verifying run sequentially, with no prefetch, so each cost is
  separable. A pipelined wallet could hide up to min(network, scan).
- n = 3 separates the findings from run noise but does not support confidence
  intervals. The Pi's three samples per setting come from three nodes, so its spread is
  mostly node-to-node.
- Peak RSS is the process lifetime high-water mark, including Bun and SDK imports.
- These are CLI measurements of a reference implementation, not browser or mobile
  wallet performance, and not a comparison with OMR, PIR, TEE or FHE schemes.
