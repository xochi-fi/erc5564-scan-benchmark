# ERC-5564 scan benchmark

Benchmarks stealth payment discovery and keyless announcement retrieval with ScopeLift’s unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Headline findings

- **Keyless retrieval (Phase 3).** Public RPCs silently omitted logs. Retrieval reached head on seven chains, with independent indexer comparisons on three. Base needed parallel backfill after both sequential runs exhausted their budgets. [PHASE3.md](PHASE3.md)
- **Local scanning (Phase 1).** A 10x increase in announcements took 9.9–10.7x as long on Linux (i7: 48.5–52.0 s/100k, RK1: 168.5–181.9 s/100k). Curve math accounted for 83–85% of sampled CPU self hits. The M1’s 3.06x retained-memory slowdown did not recur on either Linux host. [PHASE1.md](PHASE1.md)
- **Paged discovery (Phase 2).** Scanning took 94–97% of a cold rescan on loopback. At 100 ms RTT, 1-block pages spent 983 s fetching 1M logs, while pages of 64+ blocks took ~19–20 s per 100k. Verification took 0.205–0.208 s/payment. Larger pages delayed the first match and raised peak RSS. Catch-up on 64 new blocks took 4.0–4.5 s on the i7 across 100k and 1M histories on loopback. [FINDINGS.md](FINDINGS.md)
- **Browser discovery (Phase 4).** On three completing Base RPCs, a saved cursor cut POSTs from 12 to 6 and roughly halved median catch-up time. All 18 completed samples retrieved both canonical logs and found both synthetic matches. [PHASE4.md](PHASE4.md)
- **RPC recovery (Phase 5).** In 68 selected Base windows, a Daybreak-only scan missed all 48 expected logs. A second provider exposed the discrepancy, and a third enabled recovery of all 48. [PHASE5.md](PHASE5.md)

## Hardware

| Label in data | Hardware | Used for |
| --- | --- | --- |
| `bazzite` | Desktop, Intel i7-13700K, 32 GB RAM, Bazzite Linux; wallet pinned to P-core threads 0,2,4,6 | phase 1 controls and profiles, phases 2–5 |
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
