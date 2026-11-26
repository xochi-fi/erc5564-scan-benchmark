# ERC-5564 scan benchmark

A reproducible benchmark of how long it takes a wallet to find its ERC-5564 stealth
address payments. It measures two things:

1. **Phase 1, local scanning:** the ECDH and view-tag check over a set of announcements
   that is already in memory.
2. **Phase 2, paged discovery:** a wallet that pages through announcement history over
   JSON-RPC (`eth_getLogs`), scans each page, and verifies each candidate payment, with
   network, scanning and verification timed separately.

3. **Phase 3, keyless log retrieval:** whether a wallet with no account or API key can
   fetch the full real `Announcement` history from public RPC endpoints and indexers on
   seven chains ([PHASE3.md](PHASE3.md)).

It uses ScopeLift's [`@scopelift/stealth-address-sdk`](https://github.com/ScopeLift/stealth-address-sdk)
`1.0.0-beta.5` (npm `gitHead`
[`88bcc27c`](https://github.com/ScopeLift/stealth-address-sdk/tree/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2)),
unmodified, on Bun 1.4.4. Inputs are deterministic synthetic announcements generated
from a seed. No RPC provider, indexer, account, funded wallet or credentials are needed.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.** Synthetic announcement metadata describes a fixed ETH amount; no
> transfer or transaction is ever executed.

## Headline findings

### Phase 1: local scanning ([PHASE1.md](PHASE1.md))

Crypto-engine scan of zero-match announcements, unprofiled, fresh processes:

| Host | 100k announcements, s | 1m announcements, s | 1m / 100k |
| --- | --- | --- | --- |
| Intel i7-13700K (4 P-core threads) | 48.5-52.0 | 519.1 | 9.99-10.70 |
| Turing Pi RK1, Cortex-A76 (4 cores) | 168.5-181.9 | 1804.3 | 9.92-10.71 |

The 100k ranges are two bracketing controls; each 1m figure is one run.

- Ten times more announcements took roughly ten times longer.
- Elliptic-curve point addition and modular reduction were about 83-85% of sampled CPU.
- On an Apple M1 with 8 GiB, scanning the same 100k entries took 3.06x longer when 1m
  decoded announcements were held in memory. The two Linux hosts showed no such
  penalty (0.98x and 1.00x), and the M1 cause was not isolated, so the M1's 1m runs are
  not used for scaling.

### Phase 2: paged discovery ([FINDINGS.md](FINDINGS.md))

Repeat medians [min-max], n = 3. A local deterministic JSON-RPC server serves the
phase-1 fixtures (1 payment per 1000 announcements) behind a link emulator: `none`
(loopback) or `public` (100 ms RTT, 50/20 Mbit/s, uncompressed). Cold rescan of the
whole history:

| Host | Size | Link | Page blocks | Network s | Scan s | Verify s | Total s | First match s | Wallet RSS MiB |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| i7-13700K | 100,000 | none | 16 | 0.2 | 49.0 [48.8-49.4] | 0.1 | 50.9 [50.6-51.2] | 1.09 | 174 |
| i7-13700K | 100,000 | public | 1 | 98.6 | 53.8 [52.8-54.2] | 20.6 | 178.6 [177.1-178.8] | 0.53 | 152 |
| i7-13700K | 100,000 | public | 256 | 18.7 | 47.2 [47.1-47.3] | 20.5 | 87.9 [87.8-88.0] | 22.46 | 658 |
| i7-13700K | 1,000,000 | none | 16 | 2.2 | 488.5 [487.3-498.0] | 1.1 | 507.1 [505.6-516.4] | 1.09 | 180 |
| i7-13700K | 1,000,000 | public | 1 | 983.3 | 541.9 [524.4-549.1] | 205.3 | 1791.2 [1763.7-1826.4] | 0.53 | 159 |
| i7-13700K | 1,000,000 | public | 256 | 184.7 | 471.0 [470.4-475.6] | 205.2 | 875.4 [875.1-880.4] | 22.51 | 672 |
| Turing Pi A76 (3 nodes) | 100,000 | none | 16 | 0.6 | 179.3 [178.5-190.5] | 0.3 | 185.3 [184.7-197.1] | 3.97 | 149 |
| Turing Pi A76 (3 nodes) | 100,000 | public | 256 | 19.0 | 167.5 [162.9-189.5] | 20.8 | 212.6 [208.4-234.9] | 62.82 | 498 |

All five findings held after three repetitions:

1. **On a fast link, discovery is scanning:** 94-97% of a cold rescan. It scales
   linearly (1m/100k about 10.0x). The Pi is 3.6-3.7x slower than the i7 on the
   medians: 3.4x on a well-cooled node, 4.3x on one that throttles.
2. **Over a public RPC, page size decides the network cost.** With 1-block pages, round
   trips dominate (983 s of network against a 542 s scan at 1m). From 64 blocks per
   page, network sits at the bandwidth floor of about 19-20 s per 100k announcements
   (about 1.1 KB each).
3. **Verification is a fixed per-payment tax:** 0.205-0.208 s per payment at 100 ms RTT
   (receipt plus balance lookup), independent of page size, history and host. This was
   the most stable number in the study.
4. **Bigger pages delay the first match and raise memory** (0.09 s at 1 block vs
   16-22 s at 256 blocks; 100-280 MiB up to 64 blocks vs 500-750 MiB at 256). History
   size barely matters: 180 MiB at 1m vs 174 MiB at 100k with 16-block pages. Phase 1,
   which loaded everything, needed about 3.9 GiB at 1m.
5. **Catching up 64 new blocks costs 4.0-4.5 s** on the i7 whether the history is 100k
   or 1m. On `public`, 1-block pages double it.

The full tables, the repeat design, per-finding verdicts, host activity and the
original single-run results (Appendix A) are in [FINDINGS.md](FINDINGS.md).

### Phase 3: keyless history retrieval ([PHASE3.md](PHASE3.md))

Live, read-only, keyless, 2026-11-26. The canonical Announcer has 298 announcements on Ethereum,
679 on Base, 19 on Arbitrum One, 2 on OP Mainnet, 3 on Gnosis, 9 on Polygon PoS and 1,039 on Sepolia.

- A keyless cold start from the deploy block succeeded on every chain. With an endpoint
  that accepts the whole history it took 8-17 s and 30-52 requests. Base has no such
  endpoint: it took 16,296 requests and 28 min, spread over four hosts. In chainlist order it
  took 17 s to 72 min, and on Base it ran out of an 8,000-request budget.
- Per-request block-range caps on keyless endpoints that serve history ranged from 10
  blocks to the whole history. Many popular endpoints serve only recent blocks and say so
  in their errors. Four (one on OP Mainnet, three on Base) returned empty results, with
  no error, for windows that hold real announcements. One of them silently dropped 48
  Base announcements from a cold start.
- Blockscout lacks 13 of 1,039 Sepolia announcements, and on Base, Arbitrum, Gnosis
  and Polygon it served our client a Cloudflare challenge.
- Umbra's own pre-standard contract carries far more traffic (25,558 to 102,552
  announcements per chain on its four busiest chains). The ~300 figure counts only the canonical singleton.

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | phase 1 controls and profiles, phase 2 |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | phase 1 controls and profiles (node 1), phase 2 (node 1 single run; nodes 1-3 repeats) |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | phase 1 initial sweep and retained-set control only |

None of the hosts were reserved for benchmarking; host state (load, memory, swap,
thermals, CPU frequency) is recorded with every phase-2 sample. The three RK1 nodes
differ by up to 17% because of cooling (see FINDINGS.md, Controls).

## Reproduce

Requires [Bun](https://bun.sh) **1.4.4** (the `packageManager` version; other versions
run but are recorded as a different environment).

```sh
bun install --frozen-lockfile
bun run check          # tsc --noEmit
bun test               # unit and integration tests, no network, no mocks

# Phase 1: small end-to-end check of all eight scenarios
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1

# Phase 1: scale sweep (1m fixtures need several GB of RAM and disk, and hours)
bun run bench --sizes 10000,100000,1000000

# Phase 1: profiled crypto scan of an existing fixture (macOS or Linux)
bun run profile --fixture results/<run>/fixtures/100000-zero --output results/profile-100k \
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
```

Run output goes to `results/` and `work/` (both git-ignored). Output directories must
not already exist. Every sample checks its discovered payments against an oracle taken
from the fixture's sender-side schedule; a run exits nonzero if any sample does not
match. Do not put the large workloads in ordinary CI.

Fixtures are deterministic: the default seed `erc5564-scan-v1` and the fixture options
produce byte-identical `announcements.jsonl` files, and their SHA256 digests are pinned
in [`data/phase1/*/fixtures/*/manifest.json`](data/phase1/) and in
`src/phase2/prepare-fixtures.ts`, which refuses a fixture whose bytes differ.

Phase 3 (live network, read-only, keyless; see [PHASE3.md](PHASE3.md) for all stages):

```sh
bun test test/phase3.test.ts                 # offline: recorded error bodies, simulated endpoints
bun run phase3 --stage endpoints,reference,probe,retrieve,consistency,report
```

An optional, read-only mainnet probe (`bun run phase2:mainnet --rpc <public RPC>`)
records the fetch cost of real Announcer logs. It is off by default and never mixed
into the deterministic results.

How the inputs are built and what each timer covers: [METHODS.md](METHODS.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | phase-1 fixture generator, scan engines, CLI and profiler |
| `src/phase2/` | local JSON-RPC chain server, link emulator, wallet, sweep and report tools |
| `src/phase3/` | keyless endpoint probe, adaptive history retriever, indexer clients, report |
| `test/` | `bun test` suites |
| `scripts/` | host run plans (`phase2-run.sh`), Bazzite wrapper, repeat matrices |
| `data/` | recorded results: summary CSVs and per-run JSON/JSONL ([data/README.md](data/README.md)) |
| `FINDINGS.md` | phase 2 findings, verdicts, full tables, Appendix A single run |
| `PHASE1.md` | phase 1 findings |
| `PHASE3.md` | phase 3 findings: keyless log retrieval per chain, guidance for wallets |
| `METHODS.md` | workloads, measurement boundaries, artifacts, phase-2 components |

## Caveats

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

## License

[MIT](LICENSE).
