# Seed recovery

Can a wallet restore every stealth payment from the seed alone, on every chain, with no saved scan progress?

Not on every chain: keys come back only in the wallet software that made them, with a deterministic signer. Announcements come back from the feed in seconds, but tokens no announcement names need a Transfer-log rescan that keyless RPC on Base can't finish.

<!-- generated:seed-recovery -->
| Step | From seed alone | Cost | What breaks it |
| --- | --- | --- | --- |
| Keys, signature-derived (SDK example, Umbra, Fluidkey) | depends | One signature | Each wallet signs its own message |
| Keys, BIP-32 (kohaku-cli) | yes | No signature | Path must be known |
| Announcements, keyless RPC | depends | [Chain volume](chain-volume.md) | [Silent omissions](rpc-recovery.md) |
| Announcements, both feeds | yes | 65 GETs, 2.1 s | Finalized blocks only ([freshness](freshness.md)) |
| Scan, SDK | yes | 0.8 s | Other scheme ids ([real announcements](real-announcements.md)) |
| Native balances | yes | 20 Multicall3 requests | Provider sees 100 addresses per request |
| Tokens named in announcements | depends | - | 391 of 1,579 announcements name one |
| Tokens never announced | depends | Base: 93,142 requests per address | 178 of 1,500 addresses got one |
| Payment never announced | no | - | No ephemeral key to scan |
<!-- /generated:seed-recovery -->

The SDK example and Umbra name the chain in the message, Umbra hashes with sha256 instead of keccak256, and Fluidkey adds a PIN. Four ECDSA libraries agree; high s, hedged nonces and passkey signers change the keys ([derivations](../data/seed-recovery/derive.json)).

Keys come from a public [test mnemonic](../METHODS.md#test-keys), offline. Announcements and assets come from both [feeds](feed-format.md) and keyless RPC on 2026-11-28, for every scheme-1 stealth address. The wallet derivations were read from source, not run: [SDK example](https://github.com/ScopeLift/stealth-address-sdk/blob/88bcc27c3b6163080ee18f330dfd6336dc8bd2e2/examples/generateDeterministicStealthMetaAddress/index.tsx#L41-L52), [Umbra](https://github.com/ScopeLift/umbra-protocol/blob/8def54a0df702f9b45ca7c33b4a38cef934ed95e/umbra-js/src/classes/Umbra.ts#L718-L767), [Fluidkey](https://github.com/fluidkey/fluidkey-stealth-account-kit/blob/2a4ccfafef127165c11ba16fc16235c919698ec2/src/utils/generateFluidkeyMessage.ts#L10-L32), [kohaku-cli](https://github.com/kassandraoftroy/kohaku-cli/blob/0b5835ea05fc1c19ae676ba73502aad5cb1646c3/src/lib/stealth/constants.ts#L6-L8). Ledger ([app-ethereum](https://github.com/LedgerHQ/app-ethereum/blob/692cf0f760171281234b75ae353ad1aa9e03cded/src/features/sign_message/ui_common_sign_message.c#L13-L16)) and Trezor ([firmware](https://github.com/trezor/trezor-firmware/blob/332283ea51a8628d2d9263dcaee5cb5792fdf0aa/crypto/ecdsa.c#L699-L716)) sign with RFC 6979. None of these wallets checks that a signer is deterministic; Umbra warns Argent users only.

Caveat: the test keys match no real payment, so the asset rows measure every real stealth address on a chain as if one wallet owned them all.

```sh
bun run seed-recovery:derive         # offline; bun test recomputes data/seed-recovery/derive.json
bun run seed-recovery                # live, read-only; writes data/seed-recovery/<chain>.json
bun run tables
```
