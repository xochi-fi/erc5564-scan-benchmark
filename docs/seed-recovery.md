# Seed recovery

Can a wallet restore every stealth payment from the seed alone, on every chain, with no saved scan progress?

Not on every chain. Keys come back only in the wallet software that made them, with a deterministic signer: each wallet signs its own message, two of them name the chain and Fluidkey adds a PIN. Announcements come back from the feed in seconds, but tokens no announcement names need a Transfer-log rescan that keyless RPC on Base can't finish.

<!-- generated:seed-recovery -->
| Step | From seed alone | Cost | What breaks it |
| --- | --- | --- | --- |
| Keys: ScopeLift SDK example | depends | One signature per chain | 7 key pairs on 7 chains: the message names the chain |
| Keys: Umbra | depends | One signature per chain | 7 key pairs on 7 chains; sha256 where the SDK uses keccak256, so the same signature gives other keys |
| Keys: Fluidkey | no | One signature | 1 key pair on 7 chains, but the message holds a PIN; PIN 1234 gives other keys |
| Keys: kohaku-cli | yes | BIP-32, no signature | 1 key pair on 7 chains; the path must be known |
| Signature | depends | - | 8 signatures from four libraries give 1 key pair; v framing is ignored. High s, a hedged nonce or a passkey signer give new keys each time; a 130-byte Safe signature is rejected |
| Announcements: keyless RPC | depends | [Chain volume](chain-volume.md) | Range caps, budgets and [silent omissions](rpc-recovery.md) |
| Announcements: both feeds | yes | 65 GETs, 459 kB, 2.1 s for the slowest chain | Finalized blocks only ([freshness](freshness.md)) |
| Scan, SDK | yes | 0.8 s for 2,068 announcements | Other scheme ids ([real announcements](real-announcements.md)) |
| Native balances | yes | 1,500 addresses in 20 Multicall3 requests; 669 hold a balance | Each request shows the provider up to 100 addresses together |
| Tokens named in announcements | depends | 7 requests | 391 of 1,579 scheme-1 announcements name a token (67 in the ERC-5564 layout, 324 in a 54-byte one), 177 name the native coin, 180 use other layouts and 831 name no asset |
| Tokens never announced | depends | ERC-20, ERC-721 and ERC-1155 Transfer logs to the addresses: 896 requests, 353 s; Base reached 0.08% at 1,000 blocks per request, so a full scan needs 745,136 requests, 93,142 for a single address | 178 of 1,500 addresses received a token that no parsed announcement names; the filter shows the provider every address |
| Payment never announced | no | - | No ephemeral key to scan. Fluidkey derives ephemeral keys from the viewing key, so its wallet can enumerate them (read, not run) |
<!-- /generated:seed-recovery -->

Keys come from a public [test mnemonic](../METHODS.md#test-keys), offline; announcements and assets come from both [feeds](feed-format.md) and keyless RPC on 2026-11-28, over every scheme-1 stealth address on each chain. Derivations were read from the sources, not measured on the wallets: [SDK example](https://github.com/ScopeLift/stealth-address-sdk/blob/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2/examples/generateDeterministicStealthMetaAddress/index.tsx#L41-L52), [Umbra](https://github.com/ScopeLift/umbra-protocol/blob/8def54a0df702f9b45ca7c33b4a38cef934ed95e/umbra-js/src/classes/Umbra.ts#L718-L767), [Fluidkey](https://github.com/fluidkey/fluidkey-stealth-account-kit/blob/2a4ccfafef127165c11ba16fc16235c919698ec2/src/utils/generateFluidkeyMessage.ts#L10-L32), [kohaku-cli](https://github.com/kassandraoftroy/kohaku-cli/blob/0b5835ea05fc1c19ae676ba73502aad5cb1646c3/src/lib/stealth/constants.ts#L6-L8). Ledger ([app-ethereum](https://github.com/LedgerHQ/app-ethereum/blob/692cf0f760171281234b75ae353ad1aa9e03cded/src/features/sign_message/ui_common_sign_message.c#L13-L16)) and Trezor ([firmware](https://github.com/trezor/trezor-firmware/blob/332283ea51a8628d2d9263dcaee5cb5792fdf0aa/crypto/ecdsa.c#L699-L716)) sign with RFC 6979. None of these wallets checks that a signer is deterministic; Umbra warns Argent users only.

Caveat: the test keys match no real payment, so the asset rows measure every real stealth address on a chain as if one wallet owned them all.

```sh
bun run seed-recovery:derive         # offline; bun test recomputes data/seed-recovery/derive.json
bun run seed-recovery                # live, read-only; writes data/seed-recovery/<chain>.json
bun run tables
```
