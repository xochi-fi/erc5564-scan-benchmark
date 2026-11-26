# ERC-5564 scan benchmark

A reproducible benchmark of how long a wallet takes to find its ERC-5564 stealth-address
payments, and whether it can fetch the announcement history at all without an API key.
It uses ScopeLift's `@scopelift/stealth-address-sdk` 1.0.0-beta.5, unmodified, on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Headline findings

**Phase 3, keyless history retrieval** ([PHASE3.md](PHASE3.md)). Public RPCs
silently omitted ERC-5564 logs. The benchmark reached the measured head on all
seven chains, with independent indexer comparisons on three. Base needed a
parallel backfill after both sequential runs exhausted their request budgets.

**Phase 1, local scanning** ([PHASE1.md](PHASE1.md)): ECDH and view-tag check over
announcements already in memory.

- Scanning is linear: 1m announcements took 9.9-10.7x as long as 100k (i7-13700K:
  48.5-52.0 s per 100k, 519 s per 1m; Turing Pi RK1: 168.5-181.9 s per 100k, 1804 s per 1m).
- Elliptic-curve point addition and modular reduction were about 83-85% of sampled CPU.
- An Apple M1 slowdown (3.06x when 1m entries were held in memory) did not reproduce on
  either Linux host, so the M1 is not used for scaling.

**Phase 2, paged discovery** ([FINDINGS.md](FINDINGS.md)): a wallet pages history over
`eth_getLogs` from a local deterministic chain behind a link emulator, then scans and
verifies. Medians of 3 repetitions.

- On a fast link, discovery is scanning: 94-97% of a cold rescan.
- Over an emulated public RPC (100 ms RTT), page size sets the network cost: 983 s of
  network at 1m with 1-block pages, about 19-20 s per 100k from 64 blocks per page up.
- Verification costs 0.205-0.208 s per payment, whatever the page size, history or host.
- Bigger pages delay the first match (0.09 s at 1 block, 16-22 s at 256) and raise memory
  (100-280 MiB up to 64 blocks, 500-750 MiB at 256).
- Catching up 64 new blocks takes 4.0-4.5 s on the i7 with a 100k or a 1m history.

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | phase 1 controls and profiles, phase 2, phase 3 |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | phase 1 controls and profiles (node 1), phase 2 |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | phase 1 initial sweep and retained-set control only |

## Quickstart

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install --frozen-lockfile
bun test
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1
```

Full commands for every phase, fixture checks, the repository layout and caveats are in
[METHODS.md](METHODS.md). Recorded results are described in [data/README.md](data/README.md).

## License

[MIT](LICENSE).
