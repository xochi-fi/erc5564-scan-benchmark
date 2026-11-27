# ERC-5564 scan benchmark

Can a wallet find its ERC-5564 stealth payments from public, keyless infrastructure, and know it found all of them? Measured with ScopeLift's unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Findings

1. **Scanning is cheap at real volume.** Every chain's full ERC-5564 history would scan in seconds ([Scan cost](docs/scan-cost.md)).
2. **Retrieval is the hard part.** Keyless RPCs reached head on all seven chains, but Base only with a parallel backfill ([Chain volume](docs/chain-volume.md)). Over a public link, page size decides whether the network matters ([Paged discovery](docs/paged-discovery.md)).
3. **Completeness fails silently.** Some RPCs answer successfully with logs missing. One public Base RPC returned 0 of 48 ([RPC recovery](docs/rpc-recovery.md)).
4. **Cross-checking fixes it cheaply.** A second RPC, or two independent static feeds, recovered every omitted log and held the checkpoint while sources disagreed ([RPC recovery](docs/rpc-recovery.md), [Shared feed](docs/shared-feed.md)).

![Scan time against announcement count, log-log](docs/figures/scan-vs-volume.svg)

![Requests to fetch each chain's full history by strategy](docs/figures/cold-start-requests.svg)

## Approaches compared

Scopes differ by row. Compare rows only where the scope matches.

<!-- generated:approaches -->
| Approach | Scope | Requests | Time | Complete |
| --- | --- | ---: | ---: | --- |
| [Local scan of fetched announcements](docs/scan-cost.md) | Synthetic 100k, no network | 0 | 48.5–52.0 s (i7), 168.5–181.9 s (A76) | Fixture oracle ✓ |
| [Paged JSON-RPC, cold rescan](docs/paged-discovery.md) | Synthetic 1M, emulated 100 ms / 50 Mbit/s link, 256-block pages, i7 | — | 875.4 s median | Fixture oracle ✓ |
| [Keyless RPC, sequential adaptive](docs/chain-volume.md) | Base, deploy block to head, live | 8,000 | 39 min | ✗ budget spent at 462 of 679 |
| [Keyless RPC, parallel backfill](docs/chain-volume.md) | Base, deploy block to head, live | 16,296 | 28 min | ✓ 679 logs |
| [Public RPC with a saved cursor](docs/browser-discovery.md) | Base, 5,000 blocks, live, browser | 12 fresh / 6 resumed | 1.58–4.44 s fresh, 0.71–2.21 s resumed | 3 of 6 endpoints exact |
| [One public RPC (Daybreak)](docs/rpc-recovery.md) | Base, 68 pinned windows × 1,000 blocks, live, browser | 70 POST | 18.69 s | ✗ 0/48 |
| [Cross-checked RPCs](docs/rpc-recovery.md) | Base, 68 pinned windows × 1,000 blocks, live, browser | 181 POST | 31.25 s | ✓ 48/48 |
| [Two static feeds](docs/shared-feed.md) | Base, 68 pinned windows × 1,000 blocks, **loopback** | 36 GET | 38.8 ms (loopback) | ✓ 48/48 |
<!-- /generated:approaches -->

The local-scan row is the [scan-cost](docs/scan-cost.md) 100k control range, which backs every scan-time estimate here. Paged discovery's own Bazzite controls ran 47.3–47.6 s, against 48.5–52.0 s here ([controls](docs/paged-discovery.md#controls-scan-cost-crypto-engine-100k-zero-match-unprofiled)).

## More

[Scan cost](docs/scan-cost.md) · [Paged discovery](docs/paged-discovery.md) · [Chain volume](docs/chain-volume.md) · [Browser discovery](docs/browser-discovery.md) · [RPC recovery](docs/rpc-recovery.md) · [Shared feed](docs/shared-feed.md) · [Methods, hardware and layout](METHODS.md) · [Recorded data](data/README.md)

## Quickstart

Requires [Bun](https://bun.sh) at the `packageManager` version in `package.json`.

```sh
bun install --frozen-lockfile
bun run check   # tsc --noEmit
bun test        # no network, no mocks
bun run bench --sizes 256 --match-every 16 --batch-size 37 --repetitions 1
```

## License

[MIT](LICENSE).
