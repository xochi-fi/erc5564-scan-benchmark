# ERC-5564 scan benchmark

Benchmarks stealth payment discovery and keyless announcement retrieval with ScopeLift’s unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Benchmarks

| Phase | Result |
| --- | --- |
| [1. Local scanning](PHASE1.md) | i7: 48.5–52.0 s per 100k announcements. RK1: 168.5–181.9 s. |
| [2. Wallet discovery](FINDINGS.md) | CPU scanning took 94–97% of a cold loopback rescan. |
| [3. Public RPC](PHASE3.md) | Keyless retrieval reached head on seven chains. Base needed parallel backfill. |
| [4. Browser discovery](PHASE4.md) | A saved cursor cut POSTs from 12 to 6 on each completing Base RPC. |
| [5. RPC recovery](PHASE5.md) | Daybreak missed 48 logs in selected Base windows. Cross-checking recovered all 48. |
| [6. Shared feed](PHASE6.md) | Two local feeds recovered all 48 logs after a checkpoint hold. Cold retrieval used 36 GETs versus 71 live RPC POSTs. |

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | phase 1 controls and profiles, phases 2–6 |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | phase 1 controls and profiles (node 1), phase 2 |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | phase 1 initial sweep and retained-set control only |

## Quickstart

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install --frozen-lockfile
bun test
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1
```

[Methods and reproduction](METHODS.md) · [Recorded results](data/README.md)

## License

[MIT](LICENSE).
