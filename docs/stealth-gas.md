# Stealth gas

A fresh stealth address can hold tokens but no ETH, and funding it from the recipient's wallet undoes the privacy. How else can it pay for gas, and what does each way cost and reveal?

A wallet should default to an ERC-4337 paymaster paid in the token, with the stealth address delegated through EIP-7702 (inferred). It works for any ERC-20 on all six mainnets, and every option costs under a cent there (measured). What links most real spends is where the tokens go (measured).

<!-- generated:stealth-gas -->
| Option | Extra gas, Ethereum | Extra fee, Ethereum | Extra fee, other mainnets (max) | Who learns the link (inferred) | Works for | Seen on chain |
| --- | ---: | ---: | ---: | --- | --- | --- |
| Fund it from another address | 21,000 | $0.0016 | $0.00070 (Arbitrum One) | Everyone: the funding transfer is public | ERC-20 (ETH pays its own gas) | 1 of 30 ERC-5564 spends paid by funding (0 linked); 1 of 116 Umbra withdrawals paid by funding (1 linked) |
| Umbra relayer, fee in the token | 25,145 | $0.0019 | $0.00084 (Arbitrum One) | Relayer: IP, timing, destination; chain: the relayer address | ERC-20 paid through [Umbra](https://github.com/ScopeLift/umbra-protocol) | 115 of 116 Umbra withdrawals relayed (65 linked, 34 more clustered) |
| ERC-2612 permit to a relayer | 70,815 | $0.0055 | $0.0024 (Arbitrum One) | Relayer, as above | ERC-20 with `permit` (USDC; USDT on Ethereum has none); [Permit2](https://github.com/Uniswap/permit2) needs an ETH-paid approval first | 8 of 30 ERC-5564 spends moved by another sender (8 linked) |
| EIP-7702 delegation, ERC-4337 paymaster pays | 95,368 (72,868 later) | $0.0074 | $0.0032 (Arbitrum One) | Bundler and paymaster: IP and the operation; chain: paymaster and delegate name the wallet | Both, on chains with [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) | 5 of 30 ERC-5564 spends through a delegation (0 linked) |
| EIP-7702 delegation, paymaster paid in the token | 108,827 (86,327 later) | $0.0084 | $0.0036 (Arbitrum One) | As above | ERC-20 the paymaster accepts | - |
| Spend received ETH directly, e.g. to an exchange | 0 | $0 | $0 | An exchange ties its account to the stealth address | ETH only | 16 of 30 ERC-5564 spends spending own ETH (10 linked) |
<!-- /generated:stealth-gas -->

Gas is one 100-USDC spend, `eth_simulateV1` against live state on 2026-11-28; fees use the [spam-cost](spam-cost.md) medians ([method](../METHODS.md#stealth-gas), [data](../data/stealth-gas/)). Polygon's USDC needs more gas, and Sepolia prices new accounts and storage far higher. "Linked" means [Kovács and Seres](https://arxiv.org/abs/2308.01703) heuristic 6.1 or 6.2, the payer submitting the spend, or a traceable gas funder. "Clustered" means heuristic 6.3: two stealth addresses, one destination.

Caveat: the paymaster stub skips a real paymaster's signature check, Multicall3 stands in for a relayer contract, and the sample holds 30 ERC-5564 spends.

On Ethereum and Base, fewer than one in four scheme-1 announcements pays the stealth address in the same transaction, and most sampled paid addresses have never spent ([census](../data/stealth-gas/)). Every relayed ERC-5564 spend on Base was sent by the payer itself, which ties sender and recipient (measured). ERC-5564 scheme 1 derives an EOA, so ERC-4337 needs the EIP-7702 delegation first (read from [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564)).

Kovács and Seres linked 48.5%, 25.8%, 65.7% and 52.6% of Umbra transactions on Ethereum, Polygon, Arbitrum and OP Mainnet in 2023 (read from the paper). Our recent Umbra token withdrawals fall inside that range on heuristic 6.1 alone (measured). The relayer hides the gas, and then the tokens go to the address that registered the stealth keys.

## Tests that need a funded key

Not run. Each needs Sepolia ETH and USDC from a faucet on a key only the owner holds.

| Test | Measures |
| --- | --- |
| A UserOperation from a 7702-delegated stealth address, through a public bundler and a real ERC-20 paymaster | Paymaster signature and fee overhead; what the bundler and paymaster APIs receive (IP, API key, sender) |
| An Umbra token payment, then a withdrawal through Umbra's relayer | The relayer's request, fee and what it logs |
| An ERC-2612 permit sent to a public relayer service | Its fee and what the request reveals |

## Reproduce

```sh
bun run stealth-gas
bun run stealth-gas:usage    # archive RPC, about 30 min at the pacing in METHODS.md
bun run stealth-gas:verify   # re-reads every spend from a second provider
bun run tables
```
