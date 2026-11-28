# Omission cause

Why do some keyless providers return `[]` for known announcements?

Daybreak and Base Azul (below block 62.5M) answer `[]` for history they do not hold. Degen Protocol drops answers intermittently and 1rpc by page size. An empty Transfer canary in the same block flagged 12 of 14 omissions; it misses Degen's, so the [two-provider cross-check](rpc-recovery.md) stays.

<!-- generated:omission-cause -->
| Provider | Known announcements omitted | Receipt missing | Omissions with an empty Transfer canary | Found by another query | Class |
| --- | ---: | ---: | ---: | ---: | --- |
| base.daybreak-rpc.network (Base) | 6/6 | 6/6 | 6/6 | 0/6 | No receipts or logs: headers only, `[]` for every filter, `block not found` by hash |
| rpc.degenprotocol.io (Base) | 1/6 | 0/6 | 0/1 | 1/1 | Intermittent: one pass drops the 1- and 50-block answers, keeps the 1,000-block one |
| rpc.baseazul.dev (Base) | 3/6 | 4/6 | 2/3 | 0/3 | Pruned below block 62.5M, served as `[]`, an error or a partial answer |
| public.1rpc.io (OP Mainnet) | 4/4 | 2/4 | 4/4 | 2/4 | Filter bug: `[]` for one block, found in 50 blocks; receipts and canaries vary |
<!-- /generated:omission-cause -->

2026-11-28, two passes a few minutes apart, every known announcement from [chain volume](chain-volume.md#findings) on these providers. Each pass asks the provider and Tenderly (control) for the block header, the receipt, the Announcer logs over 1, 50 and 1,000 blocks and by block hash, the Announcement topic without an address, every Transfer log in the block, and USDC's. Tenderly answered every query. Classes are inferred from the answers; no provider was contacted.

| Wallet check | Cost on the [Daybreak replay](rpc-recovery.md#windows) | Catches |
| --- | ---: | --- |
| One Transfer canary on a busy block at startup | +1 POST | Daybreak, pruned ranges |
| Transfer canary per window | 70 → 138 POST (derived: one per 68 windows) | Daybreak, 1rpc, most pruned ranges |
| Two-provider cross-check | 70 → 181 POST | Every omission in the replay |

```sh
bun run omission-cause     # ≥275 ms between requests per provider
bun run tables
```
