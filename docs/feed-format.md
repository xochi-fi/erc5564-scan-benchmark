# Feed format

What does a wallet fetch instead of `eth_getLogs`?

`erc5564-feed/1`: every Announcer log up to a finalized block, in static pages. Two feeds publish identical bytes for identical pages, so clients compare digests.

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

Snapshot of 2026-11-28; `pending` rows were still backfilling. Feeds A and B use disjoint providers per chain except Base, where keyless full history has three providers (thirdweb answers HTTP 429) and both use Pocket. B shares no code with A. One operator runs both, so the pair cannot catch an operator who publishes the same wrong pages twice.

## Spec

| Item | Rule |
| --- | --- |
| URLs | `https://raw.githubusercontent.com/xochi-fi/erc5564-scan-benchmark/feed/{a,b}/v1/<chainId>/manifest.json` and `…/p/<sha256>.json` |
| Manifest | `format`, `chainId`, `contract`, `topic0`, `deployBlock`, `pageBlocks` (1,000,000), `finalized {number, hash}`, `pages [{from, to, count, sha256}]`, `producer` (ignored when comparing) |
| Pages | Page *i* covers `deployBlock + i·pageBlocks` to the lesser of the next boundary − 1 and `finalized.number`. Every page is listed. Empty pages are `{"r":[]}` and are not fetched |
| Body | `{"r":[]}`, or `{"r":[c0..c6]}` with no whitespace, rows sorted by block, then log index |
| Columns | c0 block delta (first row from `from`), c1 block hash and c2 tx hash in padded base64, c3 log index, c4 tx index, c5 `[topic1..3]` base64 with leading zero bytes removed, c6 data as lowercase hex with each run of ≥3 zero bytes written `g<base-36 length>.` |
| Canonical | Decoders reject a body that does not re-encode to the same bytes. `sha256` is over the body bytes |
| Finality | A producer covers up to the lower `finalized` block of its two sources. Both must return the same hash for it |
| Publishing | A page is published only if both sources return identical rows for its range. A disputed page is refetched once. If they still differ, the previous manifest stays |
| Agreement | Walk both manifests in order. Same `from`, `to`, `sha256`: agreed, fetch from either and check the digest. Same `from`, different `to` (one feed behind): agreed up to the lower `to` if the decoded rows match, then stop. Different `sha256`: stop |
| Disagreement | One feed omits, adds or alters a log in that page, and the client cannot tell which. It holds the checkpoint and retries after the next rebuild, or checks the range against two RPC providers ([RPC recovery](rpc-recovery.md)) |
| Left out | Signed page commitments, which wait for log indexes with proofs ([decision](shared-feed.md#decision)). Umbra |

The encoding is the byte-optimized result of the [format search](shared-feed.md#feed-format-search), with two changes: zero runs count whole bytes, and pages span 1,000,000 blocks. The search used a dense 68-window sample, but full history is sparse.

The [feed workflow](../.github/workflows/feed.yml) rebuilds both feeds every 6 h from `main` and pushes them to the `feed` branch. It needs no repository setting. If a ruleset protects new branches, allow GitHub Actions to push `feed`. It seeds from [`data/feed/`](../data/feed/) until `feed` exists.

## Reproduce

Builds follow the [live RPC rules](../METHODS.md#live-rpc) ([sources](../src/feed/sources.ts)).

```sh
bun test test/feed.test.ts                  # recorded Gnosis RPC, no network
bun run feed:verify test/fixtures/feed/a test/fixtures/feed/b --targets test/fixtures/feed/targets.json
bun run feed:verify data/feed/a data/feed/b
bun run feed:build-a --out results/feed/a --work results/feed/work-a --report results/feed/build-a.json
bun run feed:build-b --out results/feed/b --report results/feed/build-b.json
bun run src/feed/record-fixture.ts          # live: re-records the test fixture
```

[Builder A](../src/feed/build-a.ts) · [Builder B](../src/feed/build-b.ts) · [Codec and agreement](../src/feed/format.ts) · [Verifier](../src/feed/verify.ts) · [Recorded build](../data/feed/)
