| Chain | Deploy block | Announcements (source) | First - last block | Per month | Keyless endpoints: listed / probed / usable / full archive | Max getLogs span (blocks), endpoints serving the deploy block: median [min-max] | Full retrieval, list order | Full retrieval, probe-informed | Full retrieval, parallel | Indexers (keyless) |
| --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Ethereum | 20,042,207 | 298 (blockscout-v2) | 21,140,089 - 26,499,925 | 12.1 | 72 / 36 / 17 / 11 | 1,001 [10-whole history]; 2 took the whole history | OK: 298 logs, 1,556 s, 1,299 req, 385 KiB, 4 switches; exact match (298/298) | OK: 298 logs, 8 s, 30 req, 335 KiB, 0 switches; exact match (298/298) | - | blockscout-v2: 298; blockscout etherscan-api: failed (timeout after 90000 ms); routescan etherscan-api: 298 |
| Base | 15,502,414 | - (-) | - - - | - | 41 / 33 / 16 / 11 | 1,001 [10-63,752] | FAILED: 457 logs, 2,051 s, 8,000 req, 828 KiB, 4 switches; no reference set; request budget 8000 exhausted at block 23496414 | not run | - | blockscout-v2: blocked (Cloudflare) |
| Arbitrum One | 219,468,264 | 19 (keyless RPC only) | 434,497,958 - 522,929,374 | 2.1 | 35 / 27 / 15 / 12 | 551 [10-whole history]; 1 took the whole history | OK: 19 logs, 17 s, 68 req, 27 KiB, 0 switches; no reference set | OK: 19 logs, 14 s, 52 req, 26 KiB, 0 switches; no reference set | - | blockscout-v2: blocked (Cloudflare) |
| OP Mainnet | 121,097,390 | 2 (blockscout-v2) | 154,353,397 - 154,455,081 | 0.5 | 36 / 25 / 18 / 13 | 5,001 [50-whole history]; 2 took the whole history | OK: 2 logs, 1,105 s, 3,930 req, 156 KiB, 2 switches; exact match (2/2) | OK: 2 logs, 10 s, 40 req, 4 KiB, 0 switches; exact match (2/2) | - | blockscout-v2: 2; blockscout etherscan-api: 2 |
| Gnosis | 34,349,356 | 3 (keyless RPC only) | 40,967,594 - 41,054,058 | 0.2 | 25 / 20 / 10 / 9 | 10,000 [101-whole history]; 3 took the whole history | OK: 3 logs, 4,297 s, 4,268 req, 73 KiB, 0 switches; no reference set | OK: 3 logs, 17 s, 34 req, 5 KiB, 0 switches; no reference set | - | blockscout-v2: blocked (Cloudflare) |
| Polygon PoS | 57,888,814 | 9 (keyless RPC only) | 85,999,710 - 95,895,782 | 1.3 | 40 / 28 / 15 / 10 | 1,001 [51-whole history]; 2 took the whole history | OK: 9 logs, 1,035 s, 4,026 req, 168 KiB, 2 switches; no reference set | OK: 9 logs, 12 s, 40 req, 12 KiB, 0 switches; no reference set | - | blockscout-v2: blocked (Cloudflare) |
| Sepolia | 5,486,597 | 1,026 (blockscout-v2) | 6,241,244 - 12,186,737 | 35.7 | 30 / 21 / 14 / 11 | 10,001 [3-whole history]; 2 took the whole history | OK: 1,039 logs, 66 s, 80 req, 1,228 KiB, 1 switches; MISMATCH: 0 missing, 13 extra, 0 tx differ | OK: 1,039 logs, 8 s, 30 req, 1,227 KiB, 0 switches; MISMATCH: 0 missing, 13 extra, 0 tx differ | - | blockscout-v2: 1026; blockscout etherscan-api: 1026; routescan etherscan-api: 1039 |

| Chain | Head | SDK default requests (0 to head / 5,000) | From deploy block / 5,000 | Keyless endpoints that accept 5,000 blocks and serve the deploy block | At their median latency, s (sequential) |
| --- | ---: | ---: | ---: | --- | --- |
| Ethereum | 26,499,972 | 5,300 | 1,292 | xrpc.cl, ethereum.public.blockpi.network, mainnet.gateway.tenderly.co, gateway.tenderly.co, eth.api.pocket.network | 1,601, 398, 402, 392, 500 |
| Base | 62,559,528 | 12,512 | 9,412 | base.api.pocket.network | 771 |
| Arbitrum One | 527,746,223 | 105,550 | 61,656 | arb1.arbitrum.io, arbitrum.gateway.tenderly.co, arb-one.api.pocket.network, public-arb-mainnet.fastnode.io | 12,343, 8,250, 7,092, 5,258 |
| OP Mainnet | 160,052,248 | 32,011 | 7,791 | lb.routeme.sh, mainnet.optimism.io, optimism.public.blockpi.network, optimism.gateway.tenderly.co, gateway.tenderly.co, op.api.pocket.network, public-op-mainnet.fastnode.io | 3,429, 1,782, 6,598, 2,271, 2,315, 2,014, 1,691 |
| Gnosis | 49,479,974 | 9,896 | 3,027 | lb.routeme.sh, rpc.gnosischain.com, rpc.gnosis.gateway.fm, rpc.ap-southeast-1.gateway.fm, gnosis-rpc.publicnode.com, gnosis.api.pocket.network, gnosis.oat.farm | 2,291, 889, 914, 951, 681, 647, 1,124 |
| Polygon PoS | 97,998,130 | 19,600 | 8,022 | rpc-mainnet.matic.quiknode.pro, polygon.gateway.tenderly.co, gateway.tenderly.co, poly.api.pocket.network | 823, 1,903, 2,176, 1,518 |
| Sepolia | 12,217,146 | 2,444 | 1,347 | lb.routeme.sh, sepolia.gateway.tenderly.co, gateway.tenderly.co, eth-sepolia.api.onfinality.io, 0xrpc.io, eth-sepolia-testnet.api.pocket.network, rpc.sepolia.ethpandaops.io | 317, 168, 164, 253, 130, 113, 190 |

| Chain | Source A | Source B | A | B | Same block:logIndex set | Tx hashes agree |
| --- | --- | --- | ---: | ---: | --- | --- |
| Ethereum | blockscout-v2 (tx filled) | routescan-etherscan-api | 298 | 298 | yes | yes |
| Ethereum | blockscout-v2 (tx filled) | rpc list-order (mostly ethereum.public.blockpi.network) | 298 | 298 | yes | yes |
| Ethereum | blockscout-v2 (tx filled) | rpc probe-informed (mostly gateway.tenderly.co) | 298 | 298 | yes | yes |
| Ethereum | routescan-etherscan-api | rpc list-order (mostly ethereum.public.blockpi.network) | 298 | 298 | yes | yes |
| Ethereum | routescan-etherscan-api | rpc probe-informed (mostly gateway.tenderly.co) | 298 | 298 | yes | yes |
| Ethereum | rpc list-order (mostly ethereum.public.blockpi.network) | rpc probe-informed (mostly gateway.tenderly.co) | 298 | 298 | yes | yes |
| Arbitrum One | rpc list-order (mostly arb1.arbitrum.io) | rpc probe-informed (mostly arbitrum.gateway.tenderly.co) | 19 | 19 | yes | yes |
| OP Mainnet | blockscout-v2 (tx filled) | blockscout-etherscan-api | 2 | 2 | yes | yes |
| OP Mainnet | blockscout-v2 (tx filled) | rpc list-order (mostly mainnet.optimism.io) | 2 | 2 | yes | yes |
| OP Mainnet | blockscout-v2 (tx filled) | rpc probe-informed (mostly optimism.gateway.tenderly.co) | 2 | 2 | yes | yes |
| OP Mainnet | blockscout-etherscan-api | rpc list-order (mostly mainnet.optimism.io) | 2 | 2 | yes | yes |
| OP Mainnet | blockscout-etherscan-api | rpc probe-informed (mostly optimism.gateway.tenderly.co) | 2 | 2 | yes | yes |
| OP Mainnet | rpc list-order (mostly mainnet.optimism.io) | rpc probe-informed (mostly optimism.gateway.tenderly.co) | 2 | 2 | yes | yes |
| Gnosis | rpc list-order (mostly lb.routeme.sh) | rpc probe-informed (mostly rpc.gnosischain.com) | 3 | 3 | yes | yes |
| Polygon PoS | rpc list-order (mostly rpc-mainnet.matic.quiknode.pro) | rpc probe-informed (mostly polygon.gateway.tenderly.co) | 9 | 9 | yes | yes |
| Sepolia | blockscout-v2 (tx filled) | blockscout-etherscan-api | 1026 | 1026 | yes | yes |
| Sepolia | blockscout-v2 (tx filled) | routescan-etherscan-api | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | blockscout-v2 (tx filled) | rpc list-order (mostly sepolia.gateway.tenderly.co) | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | blockscout-v2 (tx filled) | rpc probe-informed (mostly gateway.tenderly.co) | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | blockscout-etherscan-api | routescan-etherscan-api | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | blockscout-etherscan-api | rpc list-order (mostly sepolia.gateway.tenderly.co) | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | blockscout-etherscan-api | rpc probe-informed (mostly gateway.tenderly.co) | 1026 | 1039 | no:  13 only in B (e.g. 11909881:334, 11910963:86) | yes |
| Sepolia | routescan-etherscan-api | rpc list-order (mostly sepolia.gateway.tenderly.co) | 1039 | 1039 | yes | yes |
| Sepolia | routescan-etherscan-api | rpc probe-informed (mostly gateway.tenderly.co) | 1039 | 1039 | yes | yes |
| Sepolia | rpc list-order (mostly sepolia.gateway.tenderly.co) | rpc probe-informed (mostly gateway.tenderly.co) | 1039 | 1039 | yes | yes |
