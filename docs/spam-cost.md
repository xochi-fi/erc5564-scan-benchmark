# Spam cost

What does it cost an attacker to push a chain past the [revisit thresholds](shared-feed.md#decision)?

Little: the table gives the daily price per chain. Every wallet then pays the scan time and bytes of the [shared-feed budgets](shared-feed.md#decision) at that volume, and a DoS-PerfOMR detector pays its per-message time ([scheme table](shared-feed.md#decision)) for each recipient, so spam does not favour OMR. The thresholds are attack prices.

<!-- generated:spam-cost -->
| Chain | Gas, direct / batched | Base + p10 tip (gwei) | Native (USD) | 100k/day | 1M/day | Block gas at 1M/day |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ethereum | 28,443 / 5,630 | 0.046 + 4.7e-6 | ETH 1,663.21 | $43.48 | $435 | 1.3% |
| Base | 28,443 / 5,630 | 0.005 + 4.3e-4 | ETH 1,663.21 | $5.09 | $50.86 | 0.3% |
| Arbitrum One | 28,733 / 5,631 | 0.020 + 0 | ETH 1,663.21 | $18.73 | $187 | — |
| OP Mainnet | 28,443 / 5,630 | 6.1e-6 + 5.0e-8 | ETH 1,663.21 | <$0.01 | $0.06 | 0.3% |
| Gnosis | 28,443 / 5,630 | 1.0e-8 + 1.0e-9 | xDAI 1.00 | <$0.01 | <$0.01 | 1.9% |
| Polygon PoS | 28,443 / 5,630 | 250 + 75 | POL 0.078 | $14.24 | $142 | 0.1% |
| Sepolia | 34,046 / 5,548 | 1.3e-8 + 1.0e-6 | testnet | free | free | 0.4% |
<!-- /generated:spam-cost -->

Batched gas is a state-override loop contract calling `announce`; 17 real direct-call receipts used 28,301–31,594 gas. Fees are recorded medians from 2026-11-28 00:30 UTC and would rise under sustained spam; Sepolia gas is free.

ERC-5564 leaves spam to parsing providers ("Security Considerations", "DoS Countermeasures"): filter by the indexed `caller`, staking, or a sender `toll`. New contracts and EOAs are cheap, so a `caller` filter costs an attacker little (inferred).

```sh
bun run spam-cost
bun run tables
```
