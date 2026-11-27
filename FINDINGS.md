# Phase 2: paged discovery in a wallet

Results are medians [min–max] from three repetitions on 2026-11-25/26. Each fresh wallet process matched the fixture’s sender schedule by ordered `(blockHash, transactionHash, logIndex)` outside the timers.

[Per-run evidence](data/phase2/) · [Repeat statistics](data/results-phase2-repeat.csv) · [Samples and host state](data/results-phase2-repeat-samples.csv) · [Single-run CSV (Appendix A)](data/results-phase2.csv)

Hosts are the i7-13700K Bazzite desktop and three Turing Pi 2 RK1 modules (RK3588, Cortex-A76). [Hardware](README.md#hardware)

## Repeat and single-run comparison

Under heavy swapping, the Bazzite single-run 1M `none` totals at 1 and 16 blocks/page (565.2 and 521.3 s) were 3–5% above repeat ranges (536–539 and 506–516 s). Turing node 1 throttled and its 64–256-block totals fell in the slow half of the repeats. The single-run 1M `public` 1-block total (1731 s) was 3.5% below the repeat median (1791 s [1764–1826]).

## What was measured

The wallet sequentially fetches `eth_getLogs` pages, decodes, scans with ScopeLift’s unmodified `getAnnouncementsForUser` (1.0.0-beta.5), verifies each candidate and checkpoints. The local RPC serves Phase 1 fixtures (128 announcements/block, one payment per 1,000 announcements starting at index 0). Cold scans clear the cache. Catch-up scans start 64 blocks (8,192 announcements) behind head.

The TCP emulator applies `none` (loopback), `lan` (1 ms RTT, 1 Gbit/s), or `public` (100 ms RTT, 50 Mbit/s down and 20 Mbit/s up, uncompressed). [Timers and verification checks](METHODS.md#measurement-boundaries)

## Repeat design

- **Bazzite** (32 GB, wallet cores 0,2,4,6, server 8,10). Cold 100k sparse at 1/16/64/256 blocks and 1M sparse at 1/16/256. Catch-up on both histories at 1/16/256. Both `none` and `public`. Three repetitions, 78 samples, 5.1 h.
- **Turing nodes 1–3** (wallet A76 cores 4–6, server 7). Node 1 has 8 GB/kernel 5.10, nodes 2–3 have 16 GB/kernel 6.1. Cold 100k sparse at 1/16/64/256 and catch-up at 1/16/256 on both profiles, plus 1M zero-match cold at 64 blocks on `none`. One repetition per node in parallel, 45 samples, ~2.2 h. The spread combines run and node effects.
- **Order and host state.** Each repetition shuffles its [matrix](scripts/matrix/) using the seed in `plan.json` and is bracketed by 100k crypto controls. Snapshot before/after and poll every 2 s for temperature, CPU frequency, throttle state, swap traffic and memory PSI. Turing waited up to 281 s for all zones below 70 C (no waits on node 3).
- **Bazzite start gate.** ≥8 GiB available, ≤100 swap pages/s over 10 s and memory PSI some avg60 ≤1.0. It passed at 18.2 GiB, 1.8 pages/s, PSI 0.00 and load 1.3, with 5.7 GiB of parked zram.
- **Inputs.** Bun 1.4.4, lockfile `d17ecebb...`, SHA256-verified M1 fixtures (rechecked after copying). `bun run check` and `bun test` passed (88/88 tests) on each host. The M1 supplied fixtures only.
- **Single-run only.** `lan`, 10k, 4-block pages and Bazzite 1M at 64 blocks.

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

[Shared limitations](METHODS.md#caveats-for-phases-1-and-2) cover the synthetic workloads, deterministic link, sequential stages, process RSS and three-sample ranges. Oldest-first scans encounter a scheduled match at index 0, so time to first match primarily measures the first page. The Pi 1M fixture has zero matches and therefore no verification cost.

## Optional mainnet fetch-only probe

Single run only. Run from Turing node 1 against `ethereum-rpc.publicnode.com` (no key)
for the Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564`. The last ~10k blocks
(26,484,827-26,494,826) returned 14 announcements (10 successful 1000-block requests at 55-92 ms each),
1.1 KB per log after decoding, brotli-encoded. Older ranges returned HTTP 403
"Archive requests require a personal token", so the probe stopped there per the
no-credential rule. Raw output:
[`data/phase2/mainnet-probe/mainnet-fetch.json`](data/phase2/mainnet-probe/mainnet-fetch.json).

## Reproduce

Set `FIXTURE_DIRS` to comma-separated fixture directories and `NODE` to the Pi node number (1–3). For each report, set `BAZZITE_RUN` and the corresponding `TURING_RUN_*` variables to the host run directories.

```sh
# from the repository root
bun install --frozen-lockfile && bun run check && bun test
# repeats (3 shuffled repetitions, bracketed by controls; matrices in scripts/matrix/)
scripts/run-bazzite.sh repeat-bazzite            # Bazzite, host-gated, ~5.2 h
REUSE_FIXTURES="$FIXTURE_DIRS" HOST_LABEL="turing-node-$NODE" FIRST_REPETITION="$NODE" REPETITIONS=1 \
  WALLET_CPUS=4,5,6 CHAIN_CPUS=7 CONTROL_CPUS=4-7 scripts/phase2-run.sh repeat-turing   # per Pi node, ~2.2 h
scripts/phase2-run.sh repeat-smoke               # 5-minute end-to-end check of the repeat path
bun run src/phase2/repeat-report.ts --host "bazzite=$BAZZITE_RUN" --host "turing=$TURING_RUN_1" \
  --host "turing=$TURING_RUN_2" --host "turing=$TURING_RUN_3" --csv summary.csv --samples-csv samples.csv --md table.md
# original single run (Appendix A)
scripts/run-bazzite.sh bazzite
REUSE_FIXTURES="$FIXTURE_DIRS" WALLET_CPUS=4,5,6 CHAIN_CPUS=7 CONTROL_CPUS=4-7 scripts/phase2-run.sh turing
bun run src/phase2/report.ts --host "bazzite=$BAZZITE_RUN" --host "turing-node-1=$TURING_RUN_1" --csv results-phase2.csv --md table.md
```

---

# Appendix A: single-run results (2026-11-25, one repetition per configuration)

The single run used the same hosts and pinning, Turing node 1 only, and fixed setting order. [Repeat verdict](#repeat-and-single-run-comparison)

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

[Full single-run data](#a-full-table)

## A. Findings

- **Scanning.** ECDH/view-tag checks took 89–97% of cold rescans on `none`/`lan`. Fetching 107 MiB per 100k cost 0.2–3.9 s. Bazzite scaled ~10x from 100k to 1M. The Pi took 3.6–3.9x as long as the i7.
- **Network.** At 1M with 1-block pages, Bazzite spent 979 s fetching, 520 s scanning and 1731 s total. At 16–64 blocks/page network approached 18–19 s per 100k. The fastest 100k totals were 88 s (Bazzite) and 219 s (Pi).
- **Verification.** Two calls at 100 ms RTT cost ~0.205 s per payment, or 23% and 9% of the best public-link totals on Bazzite and Pi respectively.
- **First match and memory.** At 1 vs 256 blocks/page, Bazzite took 0.09 vs 16–22 s and Pi 0.4 vs 61–66 s. Peak RSS was 110–280 MiB up to 64 blocks and 470–720 MiB at 256. The larger history had little effect at smaller pages.
- **Catch-up.** Bazzite took 4.1–4.5 s for 64 blocks across both history sizes. On `public`, 1-block vs larger pages took 14.7 vs 7.4 s. The 1M scan itself took 532.6 vs 478.7 s at 1 vs 256 blocks/page.

## A. Caveats

The [shared caveats](#caveats) apply. In this single run, Bazzite host swap grew from 2.2 to 11.5 GiB (~2.9M additional `pswpout` pages), with 12–17 GiB available, wallet RSS under 1 GiB and control drift within 0.6%. The Pi throttled at 80–86 C (~2.0 of 2.26 GHz) and used 1M zero-match to save ~1 h of fixture generation. The 1M chain server used ~400 MiB, mostly hash indexes.

## A. Full table

[Single-run CSV](data/results-phase2.csv) contains all hosts, fixture sizes, scenarios, link profiles and page sizes, including requests, per-stage times, first match, wire bytes and wallet/server RSS.
