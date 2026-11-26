Values are median [min-max] over n samples.

| Host | Size | Scenario | Profile | Page blocks | n | Nodes | Network s | Scan s | Verify s | Verify s/payment | Total s | First match s | Wallet peak RSS MiB | Max C | Throttle | Tainted |
| --- | ---: | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| turing | 100000 | catchup | none | 1 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.1 [0.1-0.1] | 14.9 [14.8-15.3] | 0.03 [0.03-0.03] | 0.0037 [0.0031-0.0039] | 15.6 [15.5-16.1] | 0.39 [0.36-0.40] | 115 [113-120] | 80.4 | 0 | 0 |
| turing | 100000 | catchup | none | 16 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.1 [0.0-0.1] | 14.2 [14.2-14.7] | 0.02 [0.02-0.03] | 0.0030 [0.0030-0.0034] | 14.8 [14.7-15.2] | 3.92 [3.91-4.06] | 145 [143-148] | 79.5 | 0 | 0 |
| turing | 100000 | catchup | none | 256 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.1 [0.1-0.1] | 13.9 [13.7-14.3] | 0.03 [0.02-0.03] | 0.0036 [0.0025-0.0036] | 14.5 [14.2-14.9] | 14.53 [14.18-14.87] | 167 [167-168] | 80.4 | 0 | 0 |
| turing | 100000 | catchup | public | 1 | 3 | turing-node-1 turing-node-2 turing-node-3 | 8.1 [8.1-8.2] | 16.0 [15.9-16.2] | 1.65 [1.65-1.66] | 0.2066 [0.2062-0.2071] | 26.4 [26.3-26.7] | 0.79 [0.77-0.82] | 107 [103-108] | 77.6 | 0 | 0 |
| turing | 100000 | catchup | public | 16 | 3 | turing-node-1 turing-node-2 turing-node-3 | 2.0 [2.0-2.0] | 14.3 [14.2-14.8] | 1.66 [1.65-1.66] | 0.2074 [0.2062-0.2079] | 18.5 [18.4-19.1] | 4.70 [4.65-4.83] | 139 [138-139] | 78.5 | 0 | 0 |
| turing | 100000 | catchup | public | 256 | 3 | turing-node-1 turing-node-2 turing-node-3 | 1.7 [1.7-1.7] | 13.9 [13.8-14.4] | 1.66 [1.66-1.67] | 0.2080 [0.2074-0.2082] | 17.7 [17.7-18.4] | 16.24 [16.22-16.93] | 166 [166-167] | 80.4 | 0 | 0 |
| turing | 100000 | cold | none | 1 | 3 | turing-node-1 turing-node-2 turing-node-3 | 1.3 [1.2-1.4] | 192.1 [181.9-221.8] | 0.28 [0.23-0.30] | 0.0028 [0.0023-0.0030] | 199.5 [189.6-230.6] | 0.37 [0.35-0.37] | 122 [122-125] | 86.8 | 4 | 0 |
| turing | 100000 | cold | none | 16 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.6 [0.5-0.7] | 179.3 [178.5-190.5] | 0.27 [0.23-0.29] | 0.0027 [0.0023-0.0029] | 185.3 [184.7-197.1] | 3.97 [3.97-4.07] | 149 [148-150] | 86.8 | 3 | 0 |
| turing | 100000 | cold | none | 64 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.6 [0.5-0.6] | 173.2 [166.3-189.7] | 0.20 [0.17-0.24] | 0.0020 [0.0017-0.0024] | 179.5 [172.2-196.6] | 14.60 [14.45-15.02] | 236 [232-243] | 86.8 | 3 | 0 |
| turing | 100000 | cold | none | 256 | 3 | turing-node-1 turing-node-2 turing-node-3 | 0.6 [0.6-0.7] | 172.9 [163.3-191.9] | 0.26 [0.25-0.33] | 0.0026 [0.0025-0.0033] | 179.3 [169.7-199.0] | 56.71 [55.84-58.95] | 500 [499-520] | 86.8 | 4 | 0 |
| turing | 100000 | cold | public | 1 | 3 | turing-node-1 turing-node-2 turing-node-3 | 98.4 [98.4-98.5] | 195.4 [193.1-202.9] | 20.60 [20.59-20.62] | 0.2060 [0.2059-0.2062] | 321.1 [319.0-329.1] | 0.81 [0.78-0.83] | 113 [108-114] | 85.9 | 0 | 0 |
| turing | 100000 | cold | public | 16 | 3 | turing-node-1 turing-node-2 turing-node-3 | 23.7 [23.7-23.8] | 175.3 [174.5-193.0] | 20.75 [20.74-20.82] | 0.2075 [0.2074-0.2082] | 226.3 [225.5-244.2] | 4.71 [4.71-4.83] | 141 [140-144] | 86.8 | 4 | 0 |
| turing | 100000 | cold | public | 64 | 3 | turing-node-1 turing-node-2 turing-node-3 | 20.0 [20.0-20.0] | 169.7 [166.5-184.9] | 20.78 [20.78-20.82] | 0.2078 [0.2078-0.2082] | 216.4 [213.4-231.9] | 16.43 [16.34-17.20] | 221 [219-225] | 86.8 | 4 | 0 |
| turing | 100000 | cold | public | 256 | 3 | turing-node-1 turing-node-2 turing-node-3 | 19.0 [18.9-19.0] | 167.5 [162.9-189.5] | 20.77 [20.66-20.78] | 0.2077 [0.2066-0.2078] | 212.6 [208.4-234.9] | 62.82 [62.22-65.33] | 498 [498-499] | 86.8 | 4 | 0 |
| turing | 1000000 | cold | none | 64 | 3 | turing-node-1 turing-node-2 turing-node-3 | 5.4 [5.2-5.9] | 1821.0 [1692.0-2038.4] | 0.00 [0.00-0.00] | - | 1883.2 [1751.1-2110.0] | - | 248 [248-250] | 86.8 | 4 | 0 |

| Host | Node | Run | Control | 100k crypto scan s | Max C | Throttle | Min wallet MHz | Tainted |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| turing | turing-node-1 | turing-node-1-repeat-turing-20261125T223538Z | control_before | 168.285 | 86.8 | 2 | 2016 | false |
| turing | turing-node-1 | turing-node-1-repeat-turing-20261125T223538Z | control_after | 172.364 | 86.8 | 2 | 2016 | false |
| turing | turing-node-2 | turing-node-2-repeat-turing-20261125T223655Z | control_before | 188.253 | 86.8 | 3 | 1800 | false |
| turing | turing-node-2 | turing-node-2-repeat-turing-20261125T223655Z | control_after | 187.562 | 86.8 | 3 | 1800 | false |
| turing | turing-node-3 | turing-node-3-repeat-turing-20261125T223725Z | control_before | 161.612 | 59.2 | 0 | 2256 | false |
| turing | turing-node-3 | turing-node-3-repeat-turing-20261125T223725Z | control_after | 161.231 | 61.9 | 0 | 2256 | false |
