# Freshness

How long after inclusion does a wallet see an announcement?

A feed-only wallet waits for finality, minutes on most chains. An RPC tail from the last finalized block to head sees it within seconds, for one `eth_getLogs` per poll. So the decision is feed plus tail: the checkpoint moves only with finalized feed pages, and tail matches stay pending until then.

<!-- generated:freshness -->
| Chain | RPC-only and hybrid: mined to seen | Feed-only: mined to finalized, median [max] | Tail blocks | Tail requests / bytes per poll | Reorged heads | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ethereum | 14 s | 16.0 min [19.2 min] | 79 | 1 / 36 | 0 | 150 |
| Base | 1 s | 19.8 min [26.3 min] | 5,892 | 1 / 37 | 0 | 150 |
| Arbitrum One | 1 s | 18.0 min [22.4 min] | 3,266 | 1 / 36 | 0 | 150 |
| OP Mainnet | 2 s | 18.1 min [28.6 min] | 556 | 1 / 36 | 0 | 150 |
| Gnosis | 4 s | 3.4 min [4.2 min] | 39 | 1 / 36 | 0 | 150 |
| Polygon PoS | 2 s | 10 s [18 s] | 2 | 1 / 36 | 0 | 150 |
| Sepolia | 13 s | 16.2 min [19.4 min] | 74 | 1 / 36 | 0 | 150 |
<!-- /generated:freshness -->

2026-11-28 00:57–01:27 UTC, one keyless endpoint per chain, a sample every 12 s. "Mined to seen" is the age of the `latest` block when it arrives, so it includes up to one sampling interval; a wallet adds its own poll interval to every path. Finality times are per step of the `finalized` tag. Feed publishing time is not included.

A reorg in the tail drops the pending match on the next poll and leaves the checkpoint at the last finalized block ([`hybrid.ts`](../src/freshness/hybrid.ts), tested in `test/freshness.test.ts`). No head reorg was seen in the samples.

```sh
bun run freshness 30
bun run tables
```
