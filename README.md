# ERC-5564 scan benchmark

> **No OMR for ERC-5564 yet.** Wallets fetch a public finalized feed in full, scan locally, and advance only when two feeds agree.\
> OMR is cheaper for the phone CPU above ~12/day, but costs servers 4–60 ms per message per recipient and adds ~0.6–2 kB onchain per announcement.\
> Revisit near 100k announcements/day. [Decision](docs/shared-feed.md#decision)

Can a wallet find its ERC-5564 stealth payments from public, keyless infrastructure, and know it found all of them? Measured with ScopeLift's unmodified `@scopelift/stealth-address-sdk` 1.0.0-beta.5 on Bun 1.4.4.

> **All keys and addresses in this repository are public, deterministic test material.
> Never fund them.**

## Findings

1. **Scanning is cheap at real volume.** Every chain's full ERC-5564 history would scan in seconds ([Scan cost](docs/scan-cost.md)).
2. **Retrieval is the hard part.** Keyless RPCs reached head on all seven chains, but Base only with a parallel backfill ([Chain volume](docs/chain-volume.md)). Over a public link, page size decides whether the network matters ([Paged discovery](docs/paged-discovery.md)).

![Outcome of each strategy, injected fault and endpoint recheck](docs/figures/outcome-matrix.svg)

![Requests against logs found per strategy on the pinned Base windows](docs/figures/cost-frontier.svg)

![Logs accepted over wall time for each live strategy](docs/figures/live-timeline.svg)

![Scan time against announcement count, log-log](docs/figures/scan-vs-volume.svg)

![Requests to fetch each chain's full history by strategy](docs/figures/cold-start-requests.svg)

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
