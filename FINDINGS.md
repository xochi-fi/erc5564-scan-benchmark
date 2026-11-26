# Phase 2: paged discovery in a wallet

The numbers below are **medians with [min-max] over 3 repetitions** (run
2026-11-25/26). The original one-repetition sweep is kept unchanged in Appendix A.
Per-run evidence is in [`data/phase2/`](data/phase2/) (`repeat/` for the repeats,
`single-run/` for Appendix A). Every wallet sample, repeated or not, is a fresh process
whose discovered payments matched the fixture's sender-side schedule exactly (ordered
`(blockHash, transactionHash, logIndex)` identities, checked outside the timers).
Per-setting statistics are in [`data/results-phase2-repeat.csv`](data/results-phase2-repeat.csv),
every repeat sample with its host and thermal state in
[`data/results-phase2-repeat-samples.csv`](data/results-phase2-repeat-samples.csv), and the
single run in [`data/results-phase2.csv`](data/results-phase2.csv).

Hosts: "Bazzite" is a desktop with an Intel i7-13700K and 32 GB RAM running Bazzite
Linux. "Turing node N" is RK1 compute module N (Rockchip RK3588, Cortex-A76) in a
Turing Pi 2 cluster board. Phase 1 also used an Apple M1 MacBook with 8 GiB RAM.

## Verdict on the five findings

| # | Finding | Verdict after 3 repetitions |
| --- | --- | --- |
| 1 | On a fast link, discovery is scanning | **Held.** Scan is 94-97% of a cold rescan; 1M/100k = 9.95-10.1x. Pi/i7 is 3.6-3.7x on the medians, but 3.4x (cool node 3) to 4.3x (throttled node 2) per node. |
| 2 | On a public link, page size decides whether the network matters | **Held.** Network is 983 s [982-984] at 1M with 1-block pages and 18.7-20.0 s per 100k from 64 blocks up. Best totals: 87.9 s [87.8-88.0] (Bazzite) and 212.6 s [208.4-234.9] (Pi). The 1M 1-block total is 1791 s [1764-1826], 3.5% above the single run's 1731 s, which falls just below the new range (run noise; the one unflagged repeat took 1764 s). |
| 3 | Verification is a fixed per-payment round-trip tax | **Held, tightest result.** 0.205-0.208 s per payment on every host, node and page size (within any one setting the spread is under 0.5%). |
| 4 | Bigger pages delay the first match and raise memory; history size does not | **Held, with one refinement.** First match is 0.09 s vs 16-22 s at 256 blocks on Bazzite, and 0.37 s vs 57-63 s on the Pi. History size adds 3-5% memory at 16-64 blocks per page but 11% at 256 blocks (726 vs 654 MiB). |
| 5 | Catch-up cost depends on the new blocks, not the history | **Held.** 64 blocks take 4.0-4.5 s with a 100k or a 1M history; 1-block pages on `public` double it (14.5-14.7 s vs 7.3-7.9 s). The side remark "very small pages scan ~10% slower" **changed**: 6-8% on Bazzite (the single 1M run was inflated) and 11% on the Pi. |

What turned out to be noise in the single run: the Bazzite 1M `none` rescans at 1- and
16-block pages (565.2 s and 521.3 s) sat 3-5% above the repeat ranges (536-539 s,
506-516 s). They were taken while that host was swapping heavily. The Pi single-run
totals at 64-256-block pages sat in the slow half of the new range, because node 1
throttles (see below). No finding depended on either.

## What was measured

A wallet pages through ERC-5564 `Announcement` history with `eth_getLogs` over block
ranges, decodes each page, scans it with the unmodified phase-1 engine (ScopeLift SDK
`getAnnouncementsForUser`, `1.0.0-beta.5`), verifies every candidate with
`eth_getTransactionReceipt` + `eth_getBalance`, and checkpoints a scan cache. The
steps run strictly in sequence, so each cost is timed on its own:

- **network:** `eth_blockNumber` plus every `eth_getLogs` round trip, until the body is fully received;
- **scan:** the phase-1 engine over each page;
- **verify:** receipt and balance round trips plus local checks (status 1, same block, exact log present, balance >= announced amount);
- **decode / other:** JSON parse plus ABI decode; cache checkpoints.

The RPC is a local deterministic Bun server serving the phase-1 fixtures
(128 announcements per block, 1 payment per 1000 announcements, first payment at index 0).
It sits behind a TCP link emulator that counts real payload bytes and injects a
recorded profile: `none` (loopback), `lan` (1 ms RTT, 1 Gbit/s), `public`
(100 ms RTT, 50 Mbit/s down / 20 Mbit/s up, uncompressed). Scenarios:

- **cold:** clear the scan cache, then rescan the whole history;
- **catch-up:** start from a cache synced to head - 64 blocks (8,192 announcements), then sync to head.

## Repeat design

Only the settings behind the five findings were repeated (`scripts/matrix/repeat-*.json`):

- **Bazzite i7-13700K** (wallet `taskset 0,2,4,6`, server `8,10`, 32 GB): 100k sparse cold
  at 1/16/64/256-block pages and 1M sparse cold at 1/16/256-block pages, on `none` and
  `public`; 64-block catch-up on 100k and 1M histories at 1/16/256-block pages, `none` and
  `public`. 3 repetitions, 78 timed samples, 5.1 h.
- **Turing RK1 (RK3588)** nodes 1, 2 and 3 (wallet A76 cores 4-6, server core 7; node 1 has
  8 GB, nodes 2-3 16 GB; node 1 runs kernel 5.10, nodes 2-3 kernel 6.1): 100k sparse cold
  at 1/16/64/256 blocks and catch-up at 1/16/256 blocks, on `none` and `public`, plus the
  1M zero-match cold rescan at 64 blocks. One repetition per node, run in parallel: 45
  timed samples, about 2.2 h. The Pi medians therefore mix run-to-run and node-to-node
  variation, and the node of every sample is recorded.
- **Order:** each repetition is a seeded random permutation of all settings (seed recorded
  in `plan.json`), so slow host drift does not line up with one setting. Every host run is
  bracketed by the 100k crypto controls.
- **Host state per sample:** before/after snapshots plus a 2 s poll while the sample runs,
  recording thermal zones, CPU MHz, thermal-cpufreq cooling state (throttling), swap
  in/out rate and memory PSI. On the Pis each sample waited until every thermal zone was
  below 70 C (waits of up to 281 s; none on node 3).
- **Bazzite start gate:** refuse to start if MemAvailable < 8 GiB, swap in+out > 100 pages/s
  over 10 s, or memory PSI some avg60 > 1.0. It passed: 18.2 GiB available, 1.8 pages/s,
  PSI 0.00, load 1.3. Swap *size* (5.7 GiB of parked zram pages) is deliberately not gated.
- Same toolchain on all hosts: Bun 1.4.4, bun.lock `d17ecebb...`, fixtures byte-identical
  to the M1 originals (SHA256-checked against the manifest and the pinned digest; nodes 2
  and 3 received copies that were re-verified on arrival). `bun run check` and `bun test`
  (88/88) passed on every host before its sweep. The Apple M1 ran no phase-2 measurements.
- Not repeated: the `lan` profile, the 10k fixture, 4-block pages, and 1M at 64-block
  pages on Bazzite. Their single-run values remain in Appendix A.

## Controls (phase-1 crypto engine, 100k zero-match, unprofiled)

| Host / node | Before s | After s | Drift | Max C | Throttle state | Note |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Bazzite | 47.584 | 47.274 | 0.7% | 84 | n/a | ~2% faster than phase 1 (48.5-52.0) and the single run (48.5/48.2) |
| Turing node 1 | 168.285 | 172.364 | 2.4% | 86.8 | 2 | inside phase-1 range (168.5-181.9) |
| Turing node 2 | 188.253 | 187.562 | 0.4% | 86.8 | 3 | throttles to 1800 MHz; above the phase-1 range |
| Turing node 3 | 161.612 | 161.231 | 0.2% | 61.9 | 0 | never throttled (2256 MHz); below the phase-1 range |

The three Pi nodes are the same RK1 module but differ by up to 17% in the control. The
difference tracks cooling: nodes 1 and 2 reach 85-87 C and drop to thermal-cpufreq states
1-4 even within a 20 s sample, and node 3 never exceeds 62 C. In every cold
scan, node 3 was fastest and node 2 slowest. For example, the 1M zero-match rescan took
1751 s on node 3, 1883 s on node 1 and 2110 s on node 2.

## Summary: cold rescans (median [min-max], n = 3)

| Host | Size | Profile | Page blocks | Network s | Scan s | Verify s | Total s | First match s | Wallet peak RSS MiB | Single-run total s |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bazzite i7-13700K | 100,000 | none | 1 | 0.5 [0.4-0.5] | 51.3 [51.2-51.5] | 0.10 [0.10-0.12] | 54.1 [54.1-54.3] | 0.09 [0.09-0.09] | 143 [142-143] | 54.0 |
| Bazzite i7-13700K | 100,000 | none | 16 | 0.2 [0.2-0.2] | 49.0 [48.8-49.4] | 0.12 [0.10-0.12] | 50.9 [50.6-51.2] | 1.09 [1.08-1.09] | 174 [172-178] | 51.9 |
| Bazzite i7-13700K | 100,000 | none | 64 | 0.2 [0.2-0.2] | 48.6 [48.6-49.0] | 0.08 [0.08-0.09] | 50.3 [50.3-50.7] | 4.08 [4.08-4.08] | 231 [230-235] | 51.3 |
| Bazzite i7-13700K | 100,000 | none | 256 | 0.2 [0.2-0.3] | 47.3 [47.2-48.1] | 0.05 [0.05-0.05] | 49.0 [48.8-49.8] | 16.11 [16.10-16.48] | 654 [654-658] | 49.3 |
| Bazzite i7-13700K | 100,000 | public | 1 | 98.6 [98.4-98.6] | 53.8 [52.8-54.2] | 20.55 [20.53-20.56] | 178.6 [177.1-178.8] | 0.53 [0.53-0.54] | 152 [150-157] | 177.4 |
| Bazzite i7-13700K | 100,000 | public | 16 | 23.5 [23.5-23.6] | 49.3 [49.1-51.0] | 20.59 [20.54-20.63] | 95.3 [95.2-96.7] | 1.88 [1.87-1.97] | 176 [175-186] | 97.2 |
| Bazzite i7-13700K | 100,000 | public | 64 | 19.7 [19.6-19.7] | 48.5 [48.3-48.8] | 20.59 [20.53-20.59] | 90.4 [90.2-90.5] | 6.00 [5.98-6.03] | 282 [282-283] | 90.8 |
| Bazzite i7-13700K | 100,000 | public | 256 | 18.7 [18.7-18.7] | 47.2 [47.1-47.3] | 20.54 [20.54-20.57] | 87.9 [87.8-88.0] | 22.46 [22.40-22.54] | 658 [657-660] | 88.0 |
| Bazzite i7-13700K | 1,000,000 | none | 1 | 4.7 [4.7-5.3] | 507.7 [504.4-508.3] | 0.98 [0.92-1.07] | 538.1 [536.1-538.5] | 0.09 [0.08-0.09] | 151 [147-151] | 565.2 |
| Bazzite i7-13700K | 1,000,000 | none | 16 | 2.2 [2.2-2.2] | 488.5 [487.3-498.0] | 1.06 [1.05-1.08] | 507.1 [505.6-516.4] | 1.09 [1.08-1.10] | 180 [179-180] | 521.3 |
| Bazzite i7-13700K | 1,000,000 | none | 256 | 2.2 [2.2-2.2] | 478.6 [472.9-515.8] | 0.47 [0.47-0.47] | 495.8 [489.9-533.2] | 16.13 [16.12-17.45] | 726 [724-749] | 496.4 |
| Bazzite i7-13700K | 1,000,000 | public | 1 | 983.3 [982.3-984.2] | 541.9 [524.4-549.1] | 205.29 [205.20-205.31] | 1,791.2 [1,763.7-1,826.4] | 0.53 [0.51-0.54] | 159 [158-162] | 1,730.6 |
| Bazzite i7-13700K | 1,000,000 | public | 16 | 234.4 [233.5-234.5] | 491.7 [490.0-504.8] | 205.76 [205.46-205.79] | 951.2 [949.7-961.7] | 1.90 [1.88-1.95] | 198 [198-201] | 949.4 |
| Bazzite i7-13700K | 1,000,000 | public | 256 | 184.7 [184.6-184.7] | 471.0 [470.4-475.6] | 205.20 [205.17-205.23] | 875.4 [875.1-880.4] | 22.51 [22.37-22.62] | 672 [672-674] | 878.1 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 1 | 1.3 [1.2-1.4] | 192.1 [181.9-221.8] | 0.28 [0.23-0.30] | 199.5 [189.6-230.6] | 0.37 [0.35-0.37] | 122 [122-125] | 204.7 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 16 | 0.6 [0.5-0.7] | 179.3 [178.5-190.5] | 0.27 [0.23-0.29] | 185.3 [184.7-197.1] | 3.97 [3.97-4.07] | 149 [148-150] | 192.0 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 64 | 0.6 [0.5-0.6] | 173.2 [166.3-189.7] | 0.20 [0.17-0.24] | 179.5 [172.2-196.6] | 14.60 [14.45-15.02] | 236 [232-243] | 185.9 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 256 | 0.6 [0.6-0.7] | 172.9 [163.3-191.9] | 0.26 [0.25-0.33] | 179.3 [169.7-199.0] | 56.71 [55.84-58.95] | 500 [499-520] | 185.9 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 1 | 98.4 [98.4-98.5] | 195.4 [193.1-202.9] | 20.60 [20.59-20.62] | 321.1 [319.0-329.1] | 0.81 [0.78-0.83] | 113 [108-114] | 319.3 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 16 | 23.7 [23.7-23.8] | 175.3 [174.5-193.0] | 20.75 [20.74-20.82] | 226.3 [225.5-244.2] | 4.71 [4.71-4.83] | 141 [140-144] | 228.6 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 64 | 20.0 [20.0-20.0] | 169.7 [166.5-184.9] | 20.78 [20.78-20.82] | 216.4 [213.4-231.9] | 16.43 [16.34-17.20] | 221 [219-225] | 218.0 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 256 | 19.0 [18.9-19.0] | 167.5 [162.9-189.5] | 20.77 [20.66-20.78] | 212.6 [208.4-234.9] | 62.82 [62.22-65.33] | 498 [498-499] | 219.3 |
| Turing RK1 A76 (nodes 1-3) | 1,000,000 (zero-match) | none | 64 | 5.4 [5.2-5.9] | 1,821.0 [1,692.0-2,038.4] | 0.00 [0.00-0.00] | 1,883.2 [1,751.1-2,110.0] | - | 248 [248-250] | 1,882.3 |

Pi rows pool nodes 1-3 (one sample each). The single-run column is the Appendix A value:
Bazzite, or Turing node 1 for the Pi.

## Summary: 64-block catch-up (8,192 announcements, 8 payments; median [min-max], n = 3)

| Host | History | Profile | Page blocks | Total s | Verify s | Single-run total s |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Bazzite i7-13700K | 100,000 | none | 1 | 4.43 [4.39-4.50] | 0.01 [0.01-0.01] | 4.56 |
| Bazzite i7-13700K | 100,000 | none | 16 | 4.21 [4.17-4.23] | 0.01 [0.01-0.01] | 4.48 |
| Bazzite i7-13700K | 100,000 | none | 256 | 4.01 [3.99-4.20] | 0.01 [0.01-0.01] | 4.06 |
| Bazzite i7-13700K | 100,000 | public | 1 | 14.52 [14.45-14.71] | 1.65 [1.65-1.66] | 14.67 |
| Bazzite i7-13700K | 100,000 | public | 16 | 7.83 [7.81-7.88] | 1.65 [1.65-1.65] | 7.96 |
| Bazzite i7-13700K | 100,000 | public | 256 | 7.34 [7.33-7.38] | 1.65 [1.64-1.66] | 7.37 |
| Bazzite i7-13700K | 1,000,000 | none | 1 | 4.46 [4.42-4.56] | 0.01 [0.01-0.01] | 4.50 |
| Bazzite i7-13700K | 1,000,000 | none | 16 | 4.21 [4.18-4.27] | 0.01 [0.01-0.01] | 4.32 |
| Bazzite i7-13700K | 1,000,000 | none | 256 | 4.01 [4.00-4.02] | 0.01 [0.01-0.01] | 4.15 |
| Bazzite i7-13700K | 1,000,000 | public | 1 | 14.73 [14.70-14.74] | 1.65 [1.65-1.65] | 14.34 |
| Bazzite i7-13700K | 1,000,000 | public | 16 | 7.89 [7.83-7.89] | 1.65 [1.65-1.66] | 7.89 |
| Bazzite i7-13700K | 1,000,000 | public | 256 | 7.36 [7.35-7.36] | 1.65 [1.65-1.65] | 7.36 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 1 | 15.60 [15.48-16.05] | 0.03 [0.03-0.03] | 16.76 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 16 | 14.78 [14.72-15.24] | 0.02 [0.02-0.03] | 15.22 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | none | 256 | 14.55 [14.20-14.89] | 0.03 [0.02-0.03] | 15.64 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 1 | 26.43 [26.30-26.67] | 1.65 [1.65-1.66] | 26.84 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 16 | 18.47 [18.44-19.09] | 1.66 [1.65-1.66] | 18.68 |
| Turing RK1 A76 (nodes 1-3) | 100,000 | public | 256 | 17.70 [17.68-18.39] | 1.66 [1.66-1.67] | 18.06 |

## Findings (repeat medians [min-max])

1. **On a fast link, discovery is scanning. (Held.)** With `none`, the local ECDH/view-tag
   scan is 94-97% of a cold rescan on both hosts (Bazzite 100k: 47.3-51.3 s of
   49.0-54.1 s). Fetching 107 MiB of logs per 100k announcements costs 0.2-0.5 s on
   Bazzite and 0.6-1.3 s on the Pi. The scan scales linearly: 1M/100k is 9.95-10.1x
   (for example, 507.1 s [505.6-516.4] / 50.9 s [50.6-51.2] at 16-block pages). On the
   medians the Pi is 3.6-3.7x slower than the i7. Per node it is 3.4-3.6x on the cool
   node 3 and 3.9-4.3x on the throttled node 2, so the Pi figure is as much about cooling
   as about the core. (`lan` was not repeated; its single-run share was 89-96%.)
2. **On a public-RPC link, page size decides whether the network matters. (Held.)** With
   1-block pages, round trips dominate. At 1M on Bazzite the network takes 983 s
   [982-984], more than the 542 s [524-549] scan, for a 1791 s [1764-1826] total. From 64
   blocks per page, network sits at the bandwidth floor: 18.7-19.7 s per 100k on Bazzite
   and 19.0-20.0 s on the Pi (about 1.1 KB per announcement uncompressed at 50 Mbit/s).
   16-block pages are close, at 23.5-23.7 s. The best cold-rescan totals are 87.9 s
   [87.8-88.0] on Bazzite at 100k, 875.4 s [875.1-880.4] at 1M, and 212.6 s [208.4-234.9]
   on the Pi at 100k. The network terms are deterministic to within 1%. Every spread in
   these totals comes from the scan.
3. **Verification is a fixed per-payment round-trip tax. (Held.)** Two calls per candidate
   cost 0.2052-0.2082 s per payment at 100 ms RTT, whatever the page size, history, host
   or node. That is 20.53-20.82 s per 100 payments and 205.2-205.8 s for the 1000
   payments at 1M. It is 23.4% of the best public-link total on Bazzite (both 100k and
   1M) and 9.8% on the Pi. This is the least noisy number in the study.
4. **Bigger pages delay the first match and raise memory. (Held; history effect refined.)**
   Time to first verified match is roughly one page's fetch and scan: 0.09 s at 1 block
   versus 16.1 s (`none`) and 22.5 s (`public`) at 256 blocks on Bazzite, and 0.37/0.81 s
   versus 56.7 s [55.8-59.0] and 62.8 s [62.2-65.3] on the Pi. Wallet peak RSS follows
   page size: 103-283 MiB up to 64 blocks, 498-749 MiB for cold rescans at 256 blocks (32,768 logs, about
   28 MiB per response). History size matters little. At 16 blocks it is 180 vs 174 MiB
   (1M vs 100k, Bazzite); at 64 blocks on the Pi, 248 vs 236 MiB. At 256 blocks it is
   726 vs 654 MiB (+11%), the same as the single run (723 vs 654), so that gap is real.
   Phase 1, which held the whole fixture in memory, needed about 3.9 GiB at 1M.
5. **Incremental catch-up cost depends on the new blocks, not the history. (Held.)**
   Catching up 64 blocks on Bazzite costs 4.01-4.43 s (medians) with a 100k history and
   4.01-4.46 s with a 1M history. On `public`, 1-block pages turn it into 64 round trips
   and double it: 14.5-14.7 s versus 7.3-7.9 s at 16-256 blocks. The Pi takes 14.6-15.6 s
   on `none` and 26.4 s versus 17.7-18.5 s on `public`. **Changed:** very small pages do
   scan slower through the SDK wrapper, but by 8% (100k) and 6% (1M) on Bazzite
   (1-block vs 256-block pages, e.g. 507.7 s vs 478.6 s at 1M), not the ~10% the single
   run showed. On the Pi it is 11% on every node. The cause was not isolated.

## Bazzite host activity during the repeat run

The start gate passed, but other desktop work on the host (an IDE and the
`kwin_wayland` compositor) grew during the first hour. MemAvailable at sample start fell
from 17.4 to 12.8 GiB, zram swap in use rose from 5.7 to 14.4 GiB, and the 1-minute load
peaked at 10.9 (just before sample 9 of 78). After that, load stayed at 0.9-2.7 and
available memory drifted from 12.8 to 10.4-11.1 GiB over the remaining four hours. The benchmark's own processes stayed small:
wallet up to 750 MiB, chain servers 46-708 MiB each.

The per-sample flag is deliberately strict: any 2 s interval with more than 100 swap
pages/s, or memory PSI avg10 above 1.0. It marks 23 of 78 timed samples, mostly
in that first hour. Flagged samples were within -0.3% to +2.0% of their unflagged
same-setting peers, with two exceptions:

- sample 9, 1M `public` 1-block (load 10.9, PSI avg10 9.1): 1826 s vs 1764 s unflagged, +3.6%;
- sample 22, 1M `none` 256-block (23k swap pages/s): 533 s vs 490/496 s, +8% (all three
  samples of this setting are flagged; the other two agree within 1.2%).

Both are the max of their group, so the medians are unaffected. Excluding every flagged
sample would change no finding. Flags are in the `tainted` column of `results-phase2-repeat-samples.csv`.
Intel exposes no thermal-cpufreq device, so Bazzite has no throttle-state column. Its
package temperature reached 100 C only during samples 8-9, the load spike.

## Caveats

- Synthetic chain: receipts and balances are derived from the fixtures. The 1-in-1000
  match rate and 128 announcements per block are far above real usage. The optional
  mainnet probe (below) saw 14 real announcements in about 10k recent blocks.
- The link model has no TLS, compression, provider query time, range or result
  limits, rate limiting, jitter or loss. Real public RPCs usually compress (the
  probe saw `br`) and cap `eth_getLogs`. Treat `public` as a controlled what-if, not a
  provider measurement. Because it is deterministic, three repetitions show almost no
  network spread. That is a property of the emulator, not of real links.
- Fetch, scan and verify are sequential by design. A pipelined wallet could hide up
  to min(network, scan). Pages are scanned oldest first and the fixture's first
  payment is at index 0, so time to first match measures the first page, not a
  realistic wait.
- n = 3 is enough to separate the findings from run noise. It is not enough for
  confidence intervals. The Pi's three samples come from three nodes whose cooling
  differs, so its min-max is mostly node-to-node.
- The hosts were not reserved. See the Bazzite host activity section above. The Pi's 1M
  run uses the zero-match fixture (no verification).
- Peak RSS is process lifetime (includes Bun and SDK imports). The server process is
  separate and reported in the CSVs.

## Optional mainnet fetch-only probe

Single run only. Run from Turing node 1 against `ethereum-rpc.publicnode.com` (no key)
for the Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564`. The last ~10k blocks
(26,484,827-26,494,826) returned 14 announcements (10 successful 1000-block requests at 55-92 ms each),
1.1 KB per log after decoding, brotli-encoded. Older ranges returned HTTP 403
"Archive requests require a personal token", so the probe stopped there per the
no-credential rule. Raw output:
[`data/phase2/mainnet-probe/mainnet-fetch.json`](data/phase2/mainnet-probe/mainnet-fetch.json).

## Reproduce

```sh
# from the repository root
bun install --frozen-lockfile && bun run check && bun test
# repeats (3 shuffled repetitions, bracketed by controls; matrices in scripts/matrix/)
scripts/run-bazzite.sh repeat-bazzite            # Bazzite, host-gated, ~5.2 h
REUSE_FIXTURES=<fixtures dir> HOST_LABEL=turing-node-N FIRST_REPETITION=N REPETITIONS=1 \
  WALLET_CPUS=4,5,6 CHAIN_CPUS=7 CONTROL_CPUS=4-7 scripts/phase2-run.sh repeat-turing   # per Pi node, ~2.2 h
scripts/phase2-run.sh repeat-smoke               # 5-minute end-to-end check of the repeat path
bun run src/phase2/repeat-report.ts --host bazzite=<run dir> --host turing=<node 1 run dir> \
  --host turing=<node 2 run dir> --host turing=<node 3 run dir> --csv summary.csv --samples-csv samples.csv --md table.md
# original single run (Appendix A)
scripts/run-bazzite.sh bazzite
REUSE_FIXTURES=<phase-1 fixtures dir> WALLET_CPUS=4,5,6 CHAIN_CPUS=7 CONTROL_CPUS=4-7 scripts/phase2-run.sh turing
bun run src/phase2/report.ts --host bazzite=<dir> --host turing-node-1=<dir> --csv results-phase2.csv --md table.md
```

---

# Appendix A: single-run results (2026-11-25, one repetition per configuration)

Kept as originally written. Hosts and pinning were as above, but only Turing node 1 was
used, and configurations ran in a fixed order. The verdicts at the top of this file
supersede the findings below.

## A. Controls (phase-1 crypto engine, 100k zero-match, unprofiled)

| Host | Before s | After s | Phase-1 range s |
| --- | ---: | ---: | --- |
| Bazzite | 48.509 | 48.235 | 48.531-51.951 |
| Turing node 1 (10k/100k sweep) | 177.044 | 176.762 | 168.457-181.946 |
| Turing node 1 (1M run) | 177.087 | 174.666 | |

Drift between bracketing controls is 0.6% (Bazzite) and 0.2%/1.4% (Pi), inside phase 1's 7-8%.

## A. Summary: cold rescans

| Host | Size | Profile | Page blocks | Network s | Scan s | Verify s | Total s | First match s | Wire down MiB | Wallet peak RSS MiB |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bazzite i7-13700K | 100,000 | none | 1 | 0.6 | 51.1 | 0.1 | 54.0 | 0.09 | 107 | 146 |
| Bazzite i7-13700K | 100,000 | none | 16 | 0.2 | 50.0 | 0.2 | 51.9 | 1.17 | 107 | 168 |
| Bazzite i7-13700K | 100,000 | none | 256 | 0.2 | 47.6 | 0.1 | 49.3 | 16.18 | 107 | 654 |
| Bazzite i7-13700K | 100,000 | public | 1 | 98.2 | 56.2 | 20.5 | 177.4 | 0.55 | 107 | 160 |
| Bazzite i7-13700K | 100,000 | public | 16 | 23.3 | 51.8 | 20.5 | 97.2 | 2.01 | 107 | 180 |
| Bazzite i7-13700K | 100,000 | public | 256 | 18.6 | 47.4 | 20.5 | 88.0 | 22.48 | 107 | 658 |
| Bazzite i7-13700K | 1,000,000 | none | 1 | 6.3 | 532.6 | 1.2 | 565.2 | 0.09 | 1073 | 157 |
| Bazzite i7-13700K | 1,000,000 | none | 16 | 2.4 | 502.4 | 1.4 | 521.3 | 1.12 | 1072 | 179 |
| Bazzite i7-13700K | 1,000,000 | none | 256 | 2.4 | 478.7 | 0.5 | 496.4 | 16.29 | 1072 | 723 |
| Bazzite i7-13700K | 1,000,000 | public | 1 | 979.4 | 520.0 | 205.0 | 1730.6 | 0.52 | 1073 | 165 |
| Bazzite i7-13700K | 1,000,000 | public | 16 | 231.6 | 497.2 | 205.2 | 949.4 | 1.89 | 1072 | 197 |
| Bazzite i7-13700K | 1,000,000 | public | 256 | 184.5 | 474.3 | 204.9 | 878.1 | 22.50 | 1072 | 671 |
| Turing Pi A76 | 100,000 | none | 1 | 1.2 | 196.9 | 0.3 | 204.7 | 0.40 | 107 | 122 |
| Turing Pi A76 | 100,000 | none | 16 | 0.6 | 185.5 | 0.3 | 192.0 | 4.07 | 107 | 150 |
| Turing Pi A76 | 100,000 | none | 256 | 0.5 | 179.4 | 0.3 | 185.9 | 61.42 | 107 | 487 |
| Turing Pi A76 | 100,000 | public | 1 | 98.3 | 193.7 | 20.6 | 319.3 | 0.80 | 107 | 111 |
| Turing Pi A76 | 100,000 | public | 16 | 23.7 | 177.7 | 20.7 | 228.6 | 4.75 | 107 | 139 |
| Turing Pi A76 | 100,000 | public | 256 | 18.9 | 174.1 | 20.7 | 219.3 | 66.47 | 107 | 497 |
| Turing Pi A76 | 1,000,000 (zero-match) | none | 64 | 5.2 | 1818.8 | 0.0 | 1882.3 | - | 1070 | 250 |

Catch-up of 64 blocks (8,192 announcements, 8 payments). Totals are in seconds and
include about 1.65 s of verification on `public`.

| Host | none | lan | public, 1-block pages | public, 16-256-block pages |
| --- | --- | --- | --- | --- |
| Bazzite (100k and 1M histories) | 4.1-4.6 | 4.2-5.0 | 14.3-14.7 | 7.4-8.0 |
| Turing node 1 (100k history) | 15.1-16.8 | 15.6-17.0 | 26.8 | 18.1-18.7 |

The full table (both hosts, 10k/100k/1M, every page size and profile, cold and
catch-up) is at the end of this file and in [`data/results-phase2.csv`](data/results-phase2.csv).

## A. Findings

1. **On a fast link, discovery is scanning.** With `none`/`lan` the local ECDH/view-tag
   scan is 89-97% of a cold rescan on both hosts. Fetching 107 MiB of logs per 100k
   announcements costs 0.2-3.9 s. The scan itself scales linearly: 1M/100k is about
   10.0x on Bazzite (e.g. 521.3 s / 51.9 s at 16-block pages). The Pi is 3.6-3.9x
   slower than the i7, as in phase 1.
2. **On a public-RPC link, page size decides whether the network matters.** With
   1-block pages (128 logs per request), round trips dominate. At 1M on Bazzite the
   network takes 979 s, more than the 520 s scan, for a 1731 s total. From about
   16-64 blocks per page, network falls to the bandwidth floor: about 18-19 s per
   100k (about 1.1 KB per announcement uncompressed at 50 Mbit/s). The cold-rescan
   total then drops to 88 s (Bazzite, 100k) and 219 s (Pi, 100k).
3. **Verification is a fixed per-payment round-trip tax.** Two calls per candidate
   cost about 0.205 s per payment at 100 ms RTT, whatever the page size or host:
   20.5 s per 100 payments and 205 s for the 1000 payments at 1M. That is 23% of the
   best public-link total on Bazzite and 9% on the Pi. A wallet with many payments
   would pay this even when scanning is cheap.
4. **Bigger pages delay the first match and raise memory; history size does not.**
   Time to first verified match is roughly one page's fetch and scan: 0.09 s at
   1 block versus 16-22 s at 256 blocks on Bazzite (0.4 s versus 61-66 s on the Pi).
   Wallet peak RSS follows page size: 110-280 MiB up to 64 blocks, 470-720 MiB at
   256 blocks (32,768 logs, about 28 MiB per response). It is unchanged between 100k
   and 1M histories (Bazzite 179 MiB at 1M with 16-block pages; Pi 250 MiB at 1M with
   64-block pages). Phase 1, which held the whole fixture in memory, needed about
   3.9 GiB at 1M.
5. **Incremental catch-up cost depends on the new blocks, not the history.** Catching
   up 64 blocks costs the same 4.1-4.5 s on Bazzite with a 100k or a 1M history. On
   `public`, small pages turn it into 64 round trips and roughly double it (14.7 s
   versus 7.4 s). Very small pages also scan about 10% slower through the SDK wrapper
   (Bazzite 1M: 532.6 s at 1 block versus 478.7 s at 256). The cause was not isolated.

## A. Caveats

- Synthetic chain: receipts and balances are derived from the fixtures. The 1-in-1000
  match rate and 128 announcements per block are far above real usage. The optional
  mainnet probe (below) saw 14 real announcements in about 10k recent blocks.
- The link model has no TLS, compression, provider query time, range or result
  limits, rate limiting, jitter or loss. Real public RPCs usually compress (the
  probe saw `br`) and cap `eth_getLogs`. Treat `public` as a controlled what-if, not a
  provider measurement.
- Fetch, scan and verify are sequential by design. A pipelined wallet could hide up
  to min(network, scan). Pages are scanned oldest first and the fixture's first
  payment is at index 0, so time to first match measures the first page, not a
  realistic wait.
- One repetition per configuration. The hosts were not reserved. Bazzite had
  host-wide swap activity from other workloads during the run (swap used rose from
  2.2 to 11.5 GiB; `pswpout` increased by about 2.9M pages), while it still had 12-17
  GiB available. The wallet itself stayed under 1 GiB, and the before/after
  controls agree within 0.6%.
- The Pi ran at 80-86 C with A76 cores at about 2.0 of 2.26 GHz (mild throttling) the
  whole time. Its 1M run used the zero-match fixture (no verification) because
  generating the 1M sparse fixture on the Pi would add about 1 h. Memory would have
  allowed it. Turing nodes 2 and 3 were not used in the single run.
- Peak RSS is process lifetime (includes Bun and SDK imports). The server process
  (about 400 MiB at 1M, mostly hash indexes) is separate and reported in the CSV.

## A. Full table

| Host | Size | Scenario | Profile | Page blocks | Requests | Network s | Decode s | Scan s | Verify s | Total s | First match s | Wire down MiB | Wallet peak RSS MiB |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bazzite | 10,000 | catchup | none | 1 | 81 | 0.043 | 0.15 | 4.298 | 0.01 | 4.519 | 0.093 | 8.67 | 130.7 |
| bazzite | 10,000 | cold | none | 1 | 100 | 0.056 | 0.194 | 5.354 | 0.011 | 5.639 | 0.089 | 10.73 | 136.14 |
| bazzite | 10,000 | catchup | none | 4 | 33 | 0.032 | 0.128 | 4.295 | 0.019 | 4.481 | 0.299 | 8.66 | 135.84 |
| bazzite | 10,000 | cold | none | 4 | 41 | 0.038 | 0.163 | 5.192 | 0.016 | 5.416 | 0.295 | 10.72 | 144.72 |
| bazzite | 10,000 | catchup | none | 16 | 21 | 0.019 | 0.118 | 4.189 | 0.012 | 4.339 | 1.148 | 8.66 | 147.23 |
| bazzite | 10,000 | cold | none | 16 | 26 | 0.025 | 0.155 | 5.217 | 0.016 | 5.415 | 1.113 | 10.72 | 166.8 |
| bazzite | 10,000 | catchup | none | 64 | 18 | 0.022 | 0.117 | 4.059 | 0.009 | 4.208 | 4.204 | 8.66 | 199.11 |
| bazzite | 10,000 | cold | none | 64 | 23 | 0.023 | 0.158 | 4.869 | 0.009 | 5.061 | 4.112 | 10.72 | 203.13 |
| bazzite | 10,000 | catchup | none | 256 | 18 | 0.022 | 0.128 | 3.926 | 0.008 | 4.084 | 4.078 | 8.66 | 196.47 |
| bazzite | 10,000 | cold | none | 256 | 22 | 0.026 | 0.146 | 4.871 | 0.013 | 5.057 | 5.047 | 10.72 | 221.79 |
| bazzite | 10,000 | catchup | lan | 1 | 81 | 0.273 | 0.15 | 4.265 | 0.045 | 4.752 | 0.099 | 8.67 | 129.01 |
| bazzite | 10,000 | cold | lan | 1 | 100 | 0.335 | 0.19 | 5.244 | 0.061 | 5.857 | 0.097 | 10.73 | 134.85 |
| bazzite | 10,000 | catchup | lan | 4 | 33 | 0.125 | 0.131 | 4.169 | 0.049 | 4.479 | 0.311 | 8.66 | 136.19 |
| bazzite | 10,000 | cold | lan | 4 | 41 | 0.157 | 0.162 | 5.248 | 0.06 | 5.633 | 0.311 | 10.72 | 149.11 |
| bazzite | 10,000 | catchup | lan | 16 | 21 | 0.099 | 0.141 | 4.172 | 0.053 | 4.467 | 1.149 | 8.66 | 147.69 |
| bazzite | 10,000 | cold | lan | 16 | 26 | 0.122 | 0.166 | 5.137 | 0.063 | 5.49 | 1.144 | 10.72 | 163.63 |
| bazzite | 10,000 | catchup | lan | 64 | 18 | 0.097 | 0.123 | 3.921 | 0.051 | 4.194 | 4.15 | 8.66 | 199.57 |
| bazzite | 10,000 | cold | lan | 64 | 23 | 0.116 | 0.151 | 4.871 | 0.059 | 5.198 | 4.204 | 10.72 | 204.88 |
| bazzite | 10,000 | catchup | lan | 256 | 18 | 0.094 | 0.119 | 3.959 | 0.05 | 4.223 | 4.181 | 8.66 | 195.91 |
| bazzite | 10,000 | cold | lan | 256 | 22 | 0.115 | 0.149 | 4.893 | 0.059 | 5.217 | 5.165 | 10.72 | 221.87 |
| bazzite | 10,000 | catchup | public | 1 | 81 | 8.132 | 0.195 | 4.265 | 1.651 | 14.261 | 0.523 | 8.67 | 135.58 |
| bazzite | 10,000 | cold | public | 1 | 100 | 10.007 | 0.264 | 5.381 | 2.069 | 17.743 | 0.518 | 10.73 | 148.56 |
| bazzite | 10,000 | catchup | public | 4 | 33 | 3.212 | 0.156 | 4.186 | 1.649 | 9.208 | 0.795 | 8.66 | 137.45 |
| bazzite | 10,000 | cold | public | 4 | 41 | 3.97 | 0.2 | 5.187 | 2.057 | 11.422 | 0.801 | 10.72 | 154.16 |
| bazzite | 10,000 | catchup | public | 16 | 21 | 1.98 | 0.133 | 4.135 | 1.648 | 7.897 | 1.882 | 8.66 | 140.27 |
| bazzite | 10,000 | cold | public | 16 | 26 | 2.431 | 0.156 | 5.118 | 2.063 | 9.77 | 1.896 | 10.72 | 158.45 |
| bazzite | 10,000 | catchup | public | 64 | 18 | 1.669 | 0.124 | 3.891 | 1.652 | 7.337 | 5.895 | 8.66 | 196.13 |
| bazzite | 10,000 | cold | public | 64 | 23 | 2.123 | 0.16 | 4.902 | 2.066 | 9.252 | 6.019 | 10.72 | 197.41 |
| bazzite | 10,000 | catchup | public | 256 | 18 | 1.669 | 0.121 | 3.932 | 1.642 | 7.365 | 5.929 | 8.66 | 198.03 |
| bazzite | 10,000 | cold | public | 256 | 22 | 2.019 | 0.154 | 4.819 | 2.055 | 9.048 | 7.199 | 10.72 | 219.93 |
| bazzite | 100,000 | catchup | none | 1 | 81 | 0.05 | 0.15 | 4.322 | 0.009 | 4.556 | 0.086 | 8.69 | 132.25 |
| bazzite | 100,000 | cold | none | 1 | 983 | 0.608 | 1.875 | 51.081 | 0.122 | 53.982 | 0.087 | 107.32 | 146.43 |
| bazzite | 100,000 | catchup | none | 4 | 33 | 0.028 | 0.124 | 4.163 | 0.014 | 4.336 | 0.302 | 8.68 | 132.53 |
| bazzite | 100,000 | cold | none | 4 | 397 | 0.311 | 1.69 | 50.905 | 0.126 | 53.117 | 0.294 | 107.24 | 145.35 |
| bazzite | 100,000 | catchup | none | 16 | 21 | 0.022 | 0.123 | 4.318 | 0.012 | 4.477 | 1.174 | 8.68 | 145.12 |
| bazzite | 100,000 | cold | none | 16 | 250 | 0.214 | 1.487 | 50.024 | 0.154 | 51.901 | 1.168 | 107.22 | 168.2 |
| bazzite | 100,000 | catchup | none | 64 | 18 | 0.024 | 0.117 | 3.928 | 0.011 | 4.081 | 4.071 | 8.68 | 198.46 |
| bazzite | 100,000 | cold | none | 64 | 214 | 0.223 | 1.462 | 49.477 | 0.095 | 51.262 | 4.116 | 107.21 | 241.52 |
| bazzite | 100,000 | catchup | none | 256 | 18 | 0.025 | 0.119 | 3.909 | 0.008 | 4.061 | 4.058 | 8.68 | 196.89 |
| bazzite | 100,000 | cold | none | 256 | 205 | 0.224 | 1.398 | 47.587 | 0.061 | 49.273 | 16.176 | 107.21 | 653.95 |
| bazzite | 100,000 | catchup | lan | 1 | 81 | 0.27 | 0.159 | 4.467 | 0.055 | 4.981 | 0.111 | 8.69 | 129.81 |
| bazzite | 100,000 | cold | lan | 1 | 983 | 3.142 | 1.971 | 53.55 | 0.58 | 59.548 | 0.102 | 107.32 | 147.46 |
| bazzite | 100,000 | catchup | lan | 4 | 33 | 0.129 | 0.129 | 4.289 | 0.043 | 4.596 | 0.311 | 8.68 | 136.17 |
| bazzite | 100,000 | cold | lan | 4 | 397 | 1.533 | 1.678 | 51.948 | 0.585 | 55.828 | 0.32 | 107.24 | 156.76 |
| bazzite | 100,000 | catchup | lan | 16 | 21 | 0.099 | 0.133 | 4.222 | 0.045 | 4.501 | 1.182 | 8.68 | 145.71 |
| bazzite | 100,000 | cold | lan | 16 | 250 | 1.178 | 1.554 | 51.259 | 0.549 | 54.559 | 1.171 | 107.22 | 187.92 |
| bazzite | 100,000 | catchup | lan | 64 | 18 | 0.093 | 0.127 | 4.084 | 0.044 | 4.349 | 4.311 | 8.68 | 196.99 |
| bazzite | 100,000 | cold | lan | 64 | 214 | 1.114 | 1.441 | 50.166 | 0.528 | 53.256 | 4.343 | 107.21 | 224 |
| bazzite | 100,000 | catchup | lan | 256 | 18 | 0.092 | 0.129 | 4.138 | 0.042 | 4.403 | 4.367 | 8.68 | 198.07 |
| bazzite | 100,000 | cold | lan | 256 | 205 | 1.08 | 1.49 | 49.822 | 0.546 | 52.944 | 17.613 | 107.21 | 667.29 |
| bazzite | 100,000 | catchup | public | 1 | 81 | 8.107 | 0.186 | 4.704 | 1.643 | 14.668 | 0.562 | 8.69 | 126.89 |
| bazzite | 100,000 | cold | public | 1 | 983 | 98.176 | 2.146 | 56.237 | 20.501 | 177.406 | 0.551 | 107.32 | 159.93 |
| bazzite | 100,000 | catchup | public | 4 | 33 | 3.208 | 0.147 | 4.202 | 1.644 | 9.208 | 0.8 | 8.68 | 137.9 |
| bazzite | 100,000 | cold | public | 4 | 397 | 38.367 | 1.76 | 51.948 | 20.58 | 112.745 | 0.801 | 107.24 | 170.39 |
| bazzite | 100,000 | catchup | public | 16 | 21 | 1.979 | 0.127 | 4.216 | 1.639 | 7.964 | 1.92 | 8.68 | 143.76 |
| bazzite | 100,000 | cold | public | 16 | 250 | 23.272 | 1.547 | 51.846 | 20.548 | 97.237 | 2.008 | 107.22 | 179.76 |
| bazzite | 100,000 | catchup | public | 64 | 18 | 1.676 | 0.124 | 3.953 | 1.644 | 7.398 | 5.958 | 8.68 | 196.57 |
| bazzite | 100,000 | cold | public | 64 | 214 | 19.563 | 1.584 | 49.082 | 20.549 | 90.786 | 6.035 | 107.21 | 281.2 |
| bazzite | 100,000 | catchup | public | 256 | 18 | 1.672 | 0.12 | 3.928 | 1.646 | 7.368 | 5.93 | 8.68 | 196.37 |
| bazzite | 100,000 | cold | public | 256 | 205 | 18.635 | 1.45 | 47.361 | 20.516 | 87.967 | 22.477 | 107.21 | 658.39 |
| bazzite | 1,000,000 | catchup | none | 1 | 81 | 0.057 | 0.147 | 4.244 | 0.015 | 4.502 | 0.156 | 8.72 | 138.37 |
| bazzite | 1,000,000 | cold | none | 1 | 9814 | 6.261 | 19.327 | 532.572 | 1.229 | 565.186 | 0.091 | 1073.21 | 157.45 |
| bazzite | 1,000,000 | catchup | none | 16 | 21 | 0.025 | 0.121 | 4.156 | 0.01 | 4.316 | 1.111 | 8.71 | 151.42 |
| bazzite | 1,000,000 | cold | none | 16 | 2490 | 2.417 | 14.791 | 502.377 | 1.378 | 521.319 | 1.125 | 1072.17 | 178.66 |
| bazzite | 1,000,000 | catchup | none | 256 | 18 | 0.019 | 0.118 | 3.998 | 0.012 | 4.148 | 4.14 | 8.71 | 201.84 |
| bazzite | 1,000,000 | cold | none | 256 | 2032 | 2.356 | 14.783 | 478.714 | 0.543 | 496.424 | 16.29 | 1072.1 | 722.54 |
| bazzite | 1,000,000 | catchup | lan | 1 | 81 | 0.262 | 0.154 | 4.343 | 0.05 | 4.85 | 0.176 | 8.72 | 138.79 |
| bazzite | 1,000,000 | cold | lan | 1 | 9814 | 32.165 | 19.248 | 526.096 | 5.833 | 588.894 | 0.113 | 1073.21 | 159.18 |
| bazzite | 1,000,000 | catchup | lan | 16 | 21 | 0.105 | 0.123 | 4.266 | 0.053 | 4.552 | 1.172 | 8.71 | 149.5 |
| bazzite | 1,000,000 | cold | lan | 16 | 2490 | 11.978 | 15.558 | 517.632 | 5.921 | 551.424 | 1.19 | 1072.17 | 221.13 |
| bazzite | 1,000,000 | catchup | lan | 256 | 18 | 0.095 | 0.119 | 3.992 | 0.052 | 4.259 | 4.215 | 8.71 | 200.79 |
| bazzite | 1,000,000 | cold | lan | 256 | 2032 | 10.8 | 14.18 | 475.841 | 5.416 | 506.271 | 16.729 | 1072.1 | 683.04 |
| bazzite | 1,000,000 | catchup | public | 1 | 81 | 8.124 | 0.173 | 4.36 | 1.641 | 14.341 | 0.725 | 8.72 | 138.46 |
| bazzite | 1,000,000 | cold | public | 1 | 9814 | 979.425 | 20.499 | 520.026 | 204.995 | 1730.597 | 0.523 | 1073.21 | 165.35 |
| bazzite | 1,000,000 | catchup | public | 16 | 21 | 1.986 | 0.129 | 4.131 | 1.641 | 7.891 | 1.874 | 8.71 | 139.2 |
| bazzite | 1,000,000 | cold | public | 16 | 2490 | 231.63 | 14.896 | 497.244 | 205.21 | 949.401 | 1.888 | 1072.17 | 196.74 |
| bazzite | 1,000,000 | catchup | public | 256 | 18 | 1.676 | 0.12 | 3.919 | 1.645 | 7.362 | 5.925 | 8.71 | 200.25 |
| bazzite | 1,000,000 | cold | public | 256 | 2032 | 184.523 | 14.316 | 474.283 | 204.926 | 878.099 | 22.505 | 1072.1 | 670.86 |
| turing-node-1 | 1,000,000 | cold | none | 64 | 124 | 5.156 | 58.153 | 1818.81 | 0 | 1882.312 | - | 1069.8 | 250.2 |
| turing-node-1 | 10,000 | catchup | none | 1 | 81 | 0.109 | 0.491 | 16.085 | 0.027 | 16.769 | 0.393 | 8.67 | 115.82 |
| turing-node-1 | 10,000 | cold | none | 1 | 100 | 0.125 | 0.604 | 19.847 | 0.031 | 20.672 | 0.383 | 10.73 | 120.23 |
| turing-node-1 | 10,000 | catchup | none | 4 | 33 | 0.062 | 0.455 | 15.846 | 0.027 | 16.409 | 1.197 | 8.66 | 124.05 |
| turing-node-1 | 10,000 | cold | none | 4 | 41 | 0.08 | 0.561 | 19.685 | 0.038 | 20.394 | 1.238 | 10.72 | 126.46 |
| turing-node-1 | 10,000 | catchup | none | 16 | 21 | 0.058 | 0.461 | 15.459 | 0.026 | 16.009 | 4.185 | 8.66 | 143.75 |
| turing-node-1 | 10,000 | cold | none | 16 | 26 | 0.075 | 0.594 | 18.924 | 0.029 | 19.627 | 4.17 | 10.72 | 151.64 |
| turing-node-1 | 10,000 | catchup | none | 64 | 18 | 0.081 | 0.443 | 15.088 | 0.036 | 15.651 | 15.623 | 8.66 | 166.05 |
| turing-node-1 | 10,000 | cold | none | 64 | 23 | 0.093 | 0.647 | 18.209 | 0.027 | 18.979 | 15.608 | 10.72 | 188.55 |
| turing-node-1 | 10,000 | catchup | none | 256 | 18 | 0.078 | 0.45 | 14.939 | 0.035 | 15.506 | 15.476 | 8.66 | 167.42 |
| turing-node-1 | 10,000 | cold | none | 256 | 22 | 0.061 | 0.595 | 18.446 | 0.039 | 19.144 | 19.112 | 10.72 | 187.93 |
| turing-node-1 | 10,000 | catchup | lan | 1 | 81 | 0.327 | 0.52 | 15.744 | 0.064 | 16.71 | 0.369 | 8.67 | 117.84 |
| turing-node-1 | 10,000 | cold | lan | 1 | 100 | 0.389 | 0.657 | 19.282 | 0.078 | 20.471 | 0.367 | 10.73 | 120.6 |
| turing-node-1 | 10,000 | catchup | lan | 4 | 33 | 0.166 | 0.47 | 15.379 | 0.07 | 16.101 | 1.163 | 8.66 | 124.48 |
| turing-node-1 | 10,000 | cold | lan | 4 | 41 | 0.212 | 0.584 | 18.841 | 0.082 | 19.737 | 1.166 | 10.72 | 127.79 |
| turing-node-1 | 10,000 | catchup | lan | 16 | 21 | 0.128 | 0.501 | 14.83 | 0.058 | 15.522 | 4.101 | 8.66 | 141.97 |
| turing-node-1 | 10,000 | cold | lan | 16 | 26 | 0.148 | 0.608 | 18.918 | 0.076 | 19.754 | 4.222 | 10.72 | 144.26 |
| turing-node-1 | 10,000 | catchup | lan | 64 | 18 | 0.126 | 0.486 | 14.631 | 0.072 | 15.317 | 15.261 | 8.66 | 167.93 |
| turing-node-1 | 10,000 | cold | lan | 64 | 23 | 0.141 | 0.601 | 18.066 | 0.079 | 18.891 | 15.388 | 10.72 | 167.68 |
| turing-node-1 | 10,000 | catchup | lan | 256 | 18 | 0.118 | 0.448 | 14.632 | 0.058 | 15.26 | 15.21 | 8.66 | 166.52 |
| turing-node-1 | 10,000 | cold | lan | 256 | 22 | 0.151 | 0.592 | 17.947 | 0.088 | 18.782 | 18.709 | 10.72 | 189.08 |
| turing-node-1 | 10,000 | catchup | public | 1 | 81 | 8.132 | 0.55 | 15.914 | 1.652 | 26.345 | 0.814 | 8.67 | 107.41 |
| turing-node-1 | 10,000 | cold | public | 1 | 100 | 10.018 | 0.673 | 19.913 | 2.066 | 32.739 | 0.825 | 10.73 | 113.33 |
| turing-node-1 | 10,000 | catchup | public | 4 | 33 | 3.236 | 0.563 | 15.098 | 1.659 | 20.578 | 1.637 | 8.66 | 114.14 |
| turing-node-1 | 10,000 | cold | public | 4 | 41 | 3.983 | 0.633 | 18.513 | 2.061 | 25.221 | 1.661 | 10.72 | 121.91 |
| turing-node-1 | 10,000 | catchup | public | 16 | 21 | 2.001 | 0.545 | 14.407 | 1.651 | 18.61 | 4.75 | 8.66 | 137.63 |
| turing-node-1 | 10,000 | cold | public | 16 | 26 | 2.469 | 0.757 | 17.629 | 2.07 | 22.931 | 4.754 | 10.72 | 138.18 |
| turing-node-1 | 10,000 | catchup | public | 64 | 18 | 1.697 | 0.548 | 14.187 | 1.664 | 18.099 | 16.641 | 8.66 | 164.83 |
| turing-node-1 | 10,000 | cold | public | 64 | 23 | 2.158 | 0.593 | 17.443 | 2.081 | 22.279 | 16.657 | 10.72 | 179.02 |
| turing-node-1 | 10,000 | catchup | public | 256 | 18 | 1.703 | 0.558 | 14.163 | 1.667 | 18.095 | 16.638 | 8.66 | 164.88 |
| turing-node-1 | 10,000 | cold | public | 256 | 22 | 2.052 | 0.536 | 17.696 | 2.065 | 22.353 | 20.493 | 10.72 | 188.43 |
| turing-node-1 | 100,000 | catchup | none | 1 | 81 | 0.095 | 0.49 | 16.084 | 0.036 | 16.764 | 0.371 | 8.69 | 112.27 |
| turing-node-1 | 100,000 | cold | none | 1 | 983 | 1.235 | 5.694 | 196.883 | 0.26 | 204.656 | 0.398 | 107.32 | 122.2 |
| turing-node-1 | 100,000 | catchup | none | 4 | 33 | 0.066 | 0.467 | 16.19 | 0.028 | 16.77 | 1.24 | 8.68 | 120.98 |
| turing-node-1 | 100,000 | cold | none | 4 | 397 | 0.838 | 5.556 | 190.877 | 0.321 | 197.771 | 1.181 | 107.24 | 129.65 |
| turing-node-1 | 100,000 | catchup | none | 16 | 21 | 0.058 | 0.47 | 14.665 | 0.025 | 15.222 | 4.018 | 8.68 | 142.92 |
| turing-node-1 | 100,000 | cold | none | 16 | 250 | 0.624 | 5.56 | 185.477 | 0.266 | 191.97 | 4.065 | 107.22 | 150.02 |
| turing-node-1 | 100,000 | catchup | none | 64 | 18 | 0.068 | 0.47 | 14.511 | 0.017 | 15.07 | 15.055 | 8.68 | 166.38 |
| turing-node-1 | 100,000 | cold | none | 64 | 214 | 0.515 | 5.507 | 179.671 | 0.184 | 185.892 | 15.716 | 107.21 | 235.94 |
| turing-node-1 | 100,000 | catchup | none | 256 | 18 | 0.047 | 0.464 | 15.095 | 0.035 | 15.644 | 15.617 | 8.68 | 167.42 |
| turing-node-1 | 100,000 | cold | none | 256 | 205 | 0.531 | 5.744 | 179.378 | 0.272 | 185.935 | 61.422 | 107.21 | 486.96 |
| turing-node-1 | 100,000 | catchup | lan | 1 | 81 | 0.325 | 0.505 | 16.042 | 0.062 | 17 | 0.378 | 8.69 | 114.06 |
| turing-node-1 | 100,000 | cold | lan | 1 | 983 | 3.861 | 5.848 | 198.582 | 0.699 | 209.64 | 0.387 | 107.32 | 119.23 |
| turing-node-1 | 100,000 | catchup | lan | 4 | 33 | 0.161 | 0.449 | 15.083 | 0.06 | 15.77 | 1.202 | 8.68 | 124.71 |
| turing-node-1 | 100,000 | cold | lan | 4 | 397 | 2.143 | 5.627 | 191.783 | 0.737 | 200.472 | 1.198 | 107.24 | 129.8 |
| turing-node-1 | 100,000 | catchup | lan | 16 | 21 | 0.129 | 0.493 | 15.276 | 0.07 | 15.974 | 4.201 | 8.68 | 142.2 |
| turing-node-1 | 100,000 | cold | lan | 16 | 250 | 1.445 | 5.472 | 183.505 | 0.668 | 191.133 | 4.014 | 107.22 | 146.11 |
| turing-node-1 | 100,000 | catchup | lan | 64 | 18 | 0.112 | 0.491 | 14.9 | 0.074 | 15.58 | 15.534 | 8.68 | 167.01 |
| turing-node-1 | 100,000 | cold | lan | 64 | 214 | 1.346 | 5.897 | 180.319 | 0.599 | 188.176 | 15.418 | 107.21 | 230.57 |
| turing-node-1 | 100,000 | catchup | lan | 256 | 18 | 0.131 | 0.499 | 15.045 | 0.07 | 15.752 | 15.697 | 8.68 | 166.44 |
| turing-node-1 | 100,000 | cold | lan | 256 | 205 | 1.277 | 5.688 | 175.326 | 0.711 | 183.018 | 60.466 | 107.21 | 466.14 |
| turing-node-1 | 100,000 | catchup | public | 1 | 81 | 8.134 | 0.599 | 16.379 | 1.653 | 26.835 | 0.793 | 8.69 | 107.49 |
| turing-node-1 | 100,000 | cold | public | 1 | 983 | 98.337 | 6.02 | 193.679 | 20.57 | 319.29 | 0.797 | 107.32 | 111.43 |
| turing-node-1 | 100,000 | catchup | public | 4 | 33 | 3.227 | 0.512 | 15.309 | 1.655 | 20.721 | 1.749 | 8.68 | 114.06 |
| turing-node-1 | 100,000 | cold | public | 4 | 397 | 38.571 | 5.535 | 188.23 | 20.576 | 253.101 | 1.668 | 107.24 | 122.82 |
| turing-node-1 | 100,000 | catchup | public | 16 | 21 | 2.018 | 0.594 | 14.394 | 1.666 | 18.678 | 4.727 | 8.68 | 137.82 |
| turing-node-1 | 100,000 | cold | public | 16 | 250 | 23.666 | 6.506 | 177.673 | 20.693 | 228.614 | 4.748 | 107.22 | 139.21 |
| turing-node-1 | 100,000 | catchup | public | 64 | 18 | 1.7 | 0.573 | 14.278 | 1.666 | 18.222 | 16.762 | 8.68 | 164.26 |
| turing-node-1 | 100,000 | cold | public | 64 | 214 | 19.978 | 6.377 | 170.813 | 20.777 | 217.97 | 17.146 | 107.21 | 219.78 |
| turing-node-1 | 100,000 | catchup | public | 256 | 18 | 1.701 | 0.444 | 14.255 | 1.661 | 18.064 | 16.608 | 8.68 | 166.07 |
| turing-node-1 | 100,000 | cold | public | 256 | 205 | 18.927 | 5.513 | 174.147 | 20.74 | 219.342 | 66.473 | 107.21 | 497.28 |
