# ERC-5564 scan benchmark

Measures stealth payment discovery and keyless announcement retrieval with ScopeLift's unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Experiments

| Experiment | Question | Answer |
| --- | --- | --- |
| [Scan cost](docs/scan-cost.md) | How long does a local scan take? | i7: 48.5–52.0 s per 100k announcements. RK1: 168.5–181.9 s. |
| [Paged discovery](docs/paged-discovery.md) | What does a wallet pay to page through history over RPC? | CPU scanning took 94–97% of a cold loopback rescan. |
| [Chain volume](docs/chain-volume.md) | How many announcements exist, and can a keyless client fetch them? | Keyless retrieval reached head on seven chains. Base needed parallel backfill. |
| [Browser discovery](docs/browser-discovery.md) | Can a browser wallet discover from public RPCs? | A saved cursor cut POSTs from 12 to 6 on each completing Base RPC. |
| [RPC recovery](docs/rpc-recovery.md) | Can a wallet recover logs an RPC silently omits? | Daybreak missed 48 logs in selected Base windows. Cross-checking recovered all 48. |
| [Shared feed](docs/shared-feed.md) | Can a static feed replace live RPC? | Two local feeds recovered all 48 logs after a checkpoint hold. Cold retrieval used 36 GETs against 71 live RPC POSTs. |

Run order: scan cost, paged discovery, chain volume, browser discovery, RPC recovery, shared feed. Each experiment reuses data or code from earlier ones.

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | Scan-cost controls and profiles, all later experiments |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | Scan-cost controls and profiles (node 1), paged discovery, shared feed |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | Scan-cost initial sweep and retained-set control only |

## Quickstart

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install --frozen-lockfile
bun test
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1
```

[Methods and layout](METHODS.md) · [Recorded results](data/README.md)

## License

[MIT](LICENSE).
