# Spam cost

What does it cost to push a chain past the [revisit thresholds](shared-feed.md#decision)?

At most $435 a day buys 1M announcements on any chain measured, at recorded fees. 100k/day costs at most $44. OP Mainnet and Gnosis cost under $1 a day at 1M. Each wallet then scans 29 min of CPU a day on Turing and downloads ~620 MB.

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

2026-11-28 00:30 UTC, one keyless endpoint per chain (`data/spam-cost/<chain>.json`). Fee per gas is the median base fee and the median 10th-percentile tip over the last 1,024 blocks (`eth_feeHistory`). Prices are one CoinGecko quote (`prices.json`). OP Mainnet and Base add the `GasPriceOracle.getL1Fee` of one direct-call transaction, spread over the batch. Arbitrum's `eth_estimateGas` already includes its L1 component, and its block gas limit is not a throughput cap.

| Path | Gas per announcement | How |
| --- | ---: | --- |
| Direct call to the Announcer | 28,443 | `eth_estimateGas`, 33-byte ephemeral key, 1-byte metadata |
| Real direct calls | 28,301–31,594 | 17 receipts of recorded announcements on Ethereum, Arbitrum, OP Mainnet and Polygon |
| Batched through a contract | 5,630 | `eth_estimateGas` with a state-override loop contract calling `announce` 1 and 101 times; marginal 5,605 plus the fixed cost spread over 1,000 per transaction |

The costs are lower bounds on fees and assume fees stay at the recorded level. 1M batched announcements fill at most 1.9% of a day's block gas (Gnosis), so they barely move EIP-1559 base fees. Sepolia gas is free from faucets. No transaction was signed or sent.

## Who pays

| At 1M/day | Cost | Source |
| --- | --- | --- |
| Attacker | <$0.01–$435 per chain per day | Table above |
| Each feed wallet, Turing | 29 min CPU, ~620 MB (two feeds) | [Scan cost](scan-cost.md), [feed format](shared-feed.md#decision) |
| DoS-PerfOMR detector | 82 min CPU per recipient digest, one thread | 4.9 ms/msg, [2024/510](https://eprint.iacr.org/2024/510) Table 1 |

Spam does not change the decision. Volume spam costs an OMR detector more per recipient than a wallet's own scan, and DoS-PerfOMR resists crafted clues (2024/510 §7), not volume. It does change how to read the thresholds: they are what an attacker buys for at most $435 a day, not a margin organic growth needs years to cross.

ERC-5564 leaves spam to parsing providers ("Security Considerations", "DoS Countermeasures"): ignore or de-prioritise spammers by the indexed `caller`, staking, or a sender `toll`. A batch contract has one `caller`, but new contracts and EOAs are cheap, so `caller` filtering raises the attacker's cost only slightly (inferred).

## Reproduce

```sh
bun run spam-cost            # all chains, then prices; ≥275 ms between requests per provider
bun run tables
```
