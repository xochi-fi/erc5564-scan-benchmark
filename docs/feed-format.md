# Feed format

What does a wallet fetch instead of `eth_getLogs`?

`erc5564-feed/1`: every Announcer log up to a finalized block, in static pages. Identical pages have identical bytes, so clients compare digests.

<!-- generated:feed -->
| Chain | Announcements, A / B | Finalized block, A / B | Non-empty pages | Page kB, raw / gzip | Build requests, A / B | Agreed through block |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Ethereum | 302 / pending | 26,510,107 / pending | 5 of 7 | 95.5 / 47.6 | — / pending | pending |
| Base | pending / pending | pending / pending | pending | pending | pending / pending | pending |
| Arbitrum One | 19 / pending | 528,147,108 / pending | 7 of 309 | 8.5 / 5.2 | — / pending | pending |
| OP Mainnet | 2 / pending | 160,113,052 / pending | 1 of 40 | 0.7 / 0.6 | — / pending | pending |
| Gnosis | 3 / pending | 49,504,316 / pending | 1 of 16 | 0.8 / 0.5 | — / pending | pending |
| Polygon PoS | 9 / pending | 98,080,522 / pending | 5 of 41 | 3.3 / 2.4 | — / pending | pending |
| Sepolia | 1,040 / 1,040 | 12,226,639 / 12,226,700 | 7 of 7 | 415.8 / 204.8 | — / — | 12,226,639 |
<!-- /generated:feed -->

`pending` rows were still backfilling. Feeds A and B use disjoint providers except Base, where both use Pocket (keyless Base full history has three providers; thirdweb answers HTTP 429). B shares no code with A, but one operator runs both.

| Item | Rule |
| --- | --- |
| URLs | `https://raw.githubusercontent.com/xochi-fi/erc5564-scan-benchmark/feed/{a,b}/v1/<chainId>/manifest.json`, `…/p/<sha256>.json` |
| Manifest | `format`, `chainId`, `contract`, `topic0`, `deployBlock`, `pageBlocks` (1,000,000), `finalized {number, hash}`, `pages [{from, to, count, sha256}]`, `producer` (not compared) |
| Pages | Page *i* covers `deployBlock + i·pageBlocks` up to the next boundary or `finalized.number`. Empty pages are listed as `{"r":[]}` and not fetched |
| Body | `{"r":[c0..c6]}`, no whitespace, rows by block then log index: block delta from the previous row (first from `from`), block hash and tx hash in base64, log index, tx index, topics 1–3 in base64 without leading zero bytes, data in hex with each run of ≥3 zero bytes written `g<base-36 length>.`. A body must re-encode to the same bytes |
| Finality | Up to the lower `finalized` block of the producer's two sources, which must agree on its hash |
| Publishing | Only pages both sources return identically, after one refetch; otherwise the previous manifest stays |
| Agreement | Same `from`, `to`, `sha256`: agreed. Same `from`, lower `to` on one feed: agreed up to it if rows match. Otherwise stop, hold the checkpoint and retry later or cross-check RPC ([RPC recovery](rpc-recovery.md)) |
| Left out | Signed page commitments ([decision](shared-feed.md#decision)), Umbra |

The encoding is the [byte-optimized](../data/shared-feed/autoresearch/feed-bytes.params.json) format search result, with zero runs counted in whole bytes and 1,000,000-block pages for sparse history. The [workflow](../.github/workflows/feed.yml) rebuilds both feeds every 6 h onto the `feed` branch, seeded from [`data/feed/`](../data/feed/); it needs no repository setting.

## Reproduce

Builds follow the [live RPC rules](../METHODS.md#live-rpc).

```sh
bun test test/feed.test.ts                  # recorded Gnosis RPC, no network
bun run feed:verify data/feed/a data/feed/b
bun run feed:build-a --out results/feed/a --work results/feed/work-a --report results/feed/build-a.json
bun run feed:build-b --out results/feed/b --report results/feed/build-b.json
bun run src/feed/pack.ts pack results/feed/a data/feed/a   # and b
```
