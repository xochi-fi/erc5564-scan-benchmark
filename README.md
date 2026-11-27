# ERC-5564 scan benchmark

Measures stealth payment discovery and keyless announcement retrieval with ScopeLift's unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Experiments

| Experiment | Question | Short answer (figures in each doc) |
| --- | --- | --- |
| [Scan cost](docs/scan-cost.md) | How long does a local scan take? | Time grows linearly with history. ECDH point arithmetic dominates. |
| [Paged discovery](docs/paged-discovery.md) | What does a wallet pay to page through history over RPC? | On a fast link, scanning dominates. On a public link, page size decides whether the network matters. |
| [Chain volume](docs/chain-volume.md) | How many announcements exist, and can a keyless client fetch them? | Very few. Keyless retrieval reached head on all seven chains. Base needed parallel backfill. |
| [Browser discovery](docs/browser-discovery.md) | Can a browser wallet discover from public RPCs? | On half the Base RPCs tested. A saved cursor cut requests on each one that completed. |
| [RPC recovery](docs/rpc-recovery.md) | Can a wallet recover logs an RPC silently omits? | Not from one RPC. Cross-checking a second provider recovered every omitted log. |
| [Shared feed](docs/shared-feed.md) | Can a static feed replace live RPC? | Yes, with two independent feeds. The client holds its checkpoint when they disagree, and the feed needs fewer requests than live RPC. |

Run order: scan cost, paged discovery, chain volume, browser discovery, RPC recovery, shared feed. Each experiment reuses data or code from earlier ones.

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | Scan-cost controls and profiles, all later experiments |
| `turing-node-1..3` | Turing Pi RK1 modules (Rockchip RK3588, Cortex-A76 cores used), 8 GB (node 1) / 16 GB (nodes 2-3) | Scan-cost controls and profiles (node 1), paged discovery, shared feed |
| Apple M1 | MacBook, Apple M1, 8 GiB RAM | Scan-cost initial sweep and retained-set control only |

## Quickstart

Requires [Bun](https://bun.sh) at the `packageManager` version in `package.json`.

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun test        # no network, no mocks
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1
```

[Methods and layout](METHODS.md) · [Recorded results](data/README.md)

## License

[MIT](LICENSE).
