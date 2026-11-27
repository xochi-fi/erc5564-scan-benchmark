# ERC-5564 scan benchmark

> **No OMR for ERC-5564 yet.** Wallets fetch a public feed, scan locally, and advance when two feeds agree.\
> At current volume OMR costs servers more than it saves phones.\
> [Decision](docs/shared-feed.md#decision)

> **Never fund the [test keys](METHODS.md#test-keys).**

## Findings

1. 0.5 ms (i7), 1.7 ms (A76) per announcement: scanning is cheap.
2. 28 minutes, 16,296 requests: Base keyless backfill. Other chains took seconds.
3. 0 of 48: Base logs Daybreak returned, without error. Two sources recovered all.
4. 38.8 ms vs 19.3 s: cold catch-up, two feeds vs live RPC.

![Outcome per strategy, fault and endpoint](docs/figures/outcome-matrix.svg)
<sub>Hollow: one source, blind to omissions.</sub>

![Requests against logs found, Base windows](docs/figures/cost-frontier.svg)
<sub>Feeds on loopback.</sub>

![Scan time against announcements](docs/figures/scan-vs-volume.svg)
<sub>Synthetic; rugs are real chains.</sub>

[Scan cost](docs/scan-cost.md) · [Paged discovery](docs/paged-discovery.md) · [Chain volume](docs/chain-volume.md) · [Browser discovery](docs/browser-discovery.md) · [RPC recovery](docs/rpc-recovery.md) · [Shared feed](docs/shared-feed.md) · [Methods](METHODS.md) · [Data](data/README.md)

## Quickstart

```sh
bun install --frozen-lockfile   # Bun version: packageManager in package.json
bun run check                   # tsc --noEmit
bun test                        # no network, no mocks
```

[MIT](LICENSE)
