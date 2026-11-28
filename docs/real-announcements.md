# Real announcements

Do the scan engines handle every real ERC-5564 announcement?

All 2,049 recorded announcements decode. 489 use another scheme and 89 scheme-1 entries lack a valid key or view tag. The SDK's `getAnnouncementsForUser` scans every batch to the end: it settles each entry separately and drops the ones that throw. This repo's `crypto` engine calls `checkStealthAddress` directly and stops at the first of 578 throwing entries, so a wallet built that way needs a per-entry guard.

<!-- generated:real-scan -->
| Chain | Announcements | Decoded | Scheme ≠ 1 | Scheme 1, bad key | Scheme 1, no view tag | Scheme 1, 65-byte key | `crypto` engine throws | SDK batch |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Ethereum | 298 | 298 | 1 | 0 | 0 | 0 | 1 | completes |
| Base | 679 | 679 | 304 | 0 | 2 | 166 | 306 | completes |
| Arbitrum One | 19 | 19 | 3 | 0 | 0 | 0 | 3 | completes |
| OP Mainnet | 2 | 2 | 0 | 0 | 0 | 0 | 0 | completes |
| Gnosis | 3 | 3 | 0 | 0 | 0 | 0 | 0 | completes |
| Polygon PoS | 9 | 9 | 0 | 0 | 0 | 0 | 0 | completes |
| Sepolia | 1,039 | 1,039 | 181 | 63 | 24 | 43 | 268 | completes |
| All | 2,049 | 2,049 | 489 | 63 | 26 | 209 | 578 | completes |
<!-- /generated:real-scan -->

Raw logs from Tenderly (rpc.gnosischain.com for Gnosis), 2026-11-28, matching every identity in [chain volume](chain-volume.md). Scheme 1 accepts compressed (33-byte) and uncompressed (65-byte) keys. A test recipient matches none.

Real input costs the same as synthetic: `crypto` engine, 20 interleaved repetitions, `taskset -c 4-7`.

<!-- generated:real-timing -->
| Host | Input | Announcements | ms each, median [min-max] |
| --- | --- | ---: | ---: |
| Turing node 3 | Real, scheme 1 without defects | 1,471 | 1.614 [1.602-1.651] |
| Turing node 3 | Synthetic, same count | 1,471 | 1.624 [1.610-1.659] |
| Turing node 3 | Real, all (defects throw early) | 2,049 | 1.161 [1.150-1.186] |
<!-- /generated:real-timing -->

```sh
bun run real-announcements:fetch
bun run real-announcements:scan
taskset -c 4-7 bun run real-announcements:scan --time 20 --out data/real-announcements/timing-HOST.json
bun run tables
```
