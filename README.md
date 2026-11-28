# ERC-5564 scan benchmark

> **No OMR for ERC-5564 yet.** Wallets fetch a public feed, scan locally, and advance when two feeds agree.\
> At current volume OMR costs servers more than it saves phones.\
> [Decision](docs/shared-feed.md#decision)

> **Never fund the [test keys](METHODS.md#test-keys).**

For wallet and SDK developers ([guidance](docs/chain-volume.md#wallet-guidance)), RPC operators ([omissions](docs/rpc-recovery.md)) and OMR researchers ([decision](docs/shared-feed.md#decision)).

## Findings

1. 0.5 ms (Bazzite), 1.7 ms (Turing) per announcement with the ScopeLift SDK, 10–15× less with native libsecp256k1: scanning is cheap.
2. 28 min, 16,296 requests: keyless Base backfill. Other chains take seconds.
3. 0 of 48: Base announcements Daybreak returns, without error. Two providers recover all.
4. 0.34 s [0.33–0.34] vs 6.9 s [6.7–8.0]: cold rescan, two feeds over the network vs live RPC without pacing.

![Outcome per strategy, fault and endpoint](docs/figures/outcome-matrix.svg)
<sub>Hollow: one provider, blind to omissions.</sub>

![Requests against announcements found](docs/figures/cost-frontier.svg)
<sub>Feeds over the network.</sub>

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
