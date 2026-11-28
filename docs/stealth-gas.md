# Stealth gas

A fresh stealth address holds tokens but no ETH, and funding it from the recipient's wallet undoes the privacy. How else can it pay for gas, and what does each way cost and reveal?

Wallets should default to an ERC-4337 paymaster paid in the token, on a stealth address delegated through EIP-7702. The destination leaks the recipient far more often than the gas route does.

<!-- generated:stealth-gas -->
| Option | Extra gas | Extra fee, Ethereum | Who learns the link | Seen on chain |
| --- | ---: | ---: | --- | --- |
| Fund from another address (ERC-20) | 21,000 | $0.0016 | Everyone, from the public funding transfer | ERC-5564 1 of 30, 0 linked; Umbra 1 of 116, 1 linked |
| Umbra relayer (tokens paid through Umbra) | 25,145 | $0.0019 | Relayer: IP, timing, destination | Umbra 115 of 116, 65 linked |
| Permit relayer (ERC-2612; Permit2 needs ETH first) | 70,815 | $0.0055 | Relayer: IP, timing, destination | ERC-5564 8 of 30, 8 linked |
| EIP-7702 + ERC-4337 paymaster | 95,368 first, 72,868 later | $0.0074 | Bundler, paymaster; delegate names the wallet | ERC-5564 5 of 30, 0 linked |
| EIP-7702 + paymaster paid in the token | 108,827 first, 86,327 later | $0.0084 | Bundler, paymaster; delegate names the wallet | - |
| Spend received ETH (ETH only) | 0 | $0 | An exchange, if sent there | ERC-5564 16 of 30, 10 linked |
<!-- /generated:stealth-gas -->

Gas is simulated on live state and fees use the [spam-cost](spam-cost.md) medians: every option costs under a cent on all six mainnets. Counts come from recorded spends ([method](../METHODS.md#stealth-gas), [data](../data/stealth-gas/)); "who learns" is inferred.

- On Base, the payer submitted every spend made by another sender, tying sender to recipient.
- ERC-5564 scheme 1 derives an EOA, so ERC-4337 needs the EIP-7702 delegation first ([ERC-5564](https://eips.ethereum.org/EIPS/eip-5564)).
- Our Umbra sample links at a rate inside [Kovács and Seres](https://arxiv.org/abs/2308.01703)'s 25.8–65.7%, mostly withdrawals to the registrant.

Caveat: the paymaster stub skips a real paymaster's signature check, and the sample holds only 30 ERC-5564 spends.

## Tests that need a funded key

| Test on Sepolia | Measures |
| --- | --- |
| 7702 UserOperation, real ERC-20 paymaster | Real paymaster overhead; what APIs receive |
| Umbra payment, relayer withdrawal | Relayer fee and request |
| Permit sent to a public relayer | Fee and request contents |

```sh
bun run stealth-gas
bun run stealth-gas:usage    # archive RPC, about 30 min
bun run stealth-gas:verify   # re-reads every spend from a second provider
bun run tables
```
