# RPC recovery

Can a browser wallet catch and recover logs that a public RPC silently drops? In the Base windows tested, yes. Daybreak alone returned 0 of 48 logs. Daybreak cross-checked against Tenderly, with Sentio as tiebreaker, returned all 48 for 111 more POSTs and 12.55 s more.

| Live strategy | Accepted / expected logs | RPC POSTs | Third-provider pages | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Daybreak, original-width diagnostic | 0 / 48 observed | 36 | 0 | 9.52 s to probe 34 pages |
| Daybreak single | 0 / 48 | 70 | 0 | 18.69 s |
| Daybreak + Tenderly, Sentio fallback | 48 / 48 | 181 | 39 | 31.25 s |
| Tenderly single | 48 / 48 | 70 | 0 | 18.82 s |
| Tenderly + Sentio, Pocket on standby | 48 / 48 | 142 | 0 | 28.76 s |

One run per row, 2026-11-26, about 20:00–20:02 UTC. No extra or duplicate identities and no fetch, HTTP or JSON-RPC errors. The cross-check accepted 29 empty agreements and called Sentio on 39 mismatches. A healthy pair cost 72 POSTs and 9.94 s more than Tenderly alone.

## Injected faults

Loopback fixtures replay real raw logs from the frozen reference, with injected omissions, different partial subsets, HTTP 503 and an HTTP 200 JSON-RPC error. Separate loopback paths stand in for separate sources.

| Fixture | Committed windows | Missed in committed windows | Expected in pending windows | RPC POSTs | Third-provider pages | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Silent omission, single | 68 | 48 | 0 | 70 | 0 | 145.6 ms |
| Silent omission, cross-check | 68 | 0 | 0 | 181 | 39 | 278.6 ms |
| Shared silent omission, cross-check | 68 | 48 | 0 | 142 | 0 | 214.7 ms |
| Equal counts with different identities | 13 | 0 | 45 | 35 | 1 | 46.6 ms to stop |
| HTTP 503, single | 7 | 0 | 48 | 10 | 0 | 17.1 ms to stop |
| HTTP 503, cross-check | 68 | 0 | 0 | 143 | 1 | 210.7 ms |
| Mismatch with JSON-RPC error on fallback | 7 | 0 | 48 | 23 | 1 | 30.6 ms to stop |
| Resume after fallback recovers | 68 | 0 | 0 | 167 | 39 | 254.1 ms after resume |

The equal-count run stopped on two different one-log subsets once the third source returned both. The mismatch-plus-error run stopped before blocks 41,623,282–41,624,281. Resume kept the seven committed windows and recovered all 48. Stop plus resume took 190 POSTs and 284.7 ms, three page calls and six startup calls more than uninterrupted recovery.

## Scope

The windows come from the [chain-volume](chain-volume.md#findings) Base run. After it switched to Daybreak at block 34,304,282, Daybreak returned zero logs in 6,120 successful 2,000-block pages through block 46,544,281. The parallel run found 48 there.

The replay takes all 29 positive pages plus five empty controls, interval boundaries included. The original-width diagnostic queries these 34 pages as is. Strategy trials split them into 68 windows of 1,000 blocks, so catch-up covers 68,000 blocks.

Tenderly and Sentio scanned the ranges independently in 1,000- and 613-block steps. They agreed on the pinned head hash, chain ID and 48 identities across 46 blocks, and each checked address, topics and data against receipts. All identities matched the chain-volume fields. A preliminary PublicNode attempt needed an archive token at the pinned head.

## Method

Chromium 150.0.7871.250 in Orca Electron 43.8.10 on Bazzite 45, one isolated profile, with the [browser-discovery](browser-discovery.md) transport: CORS-enforced POSTs, no credentials. Loopback controls saw OPTIONS and POST on the allow route and only OPTIONS on the deny route.

- Single RPC commits any successful page, empty or not, and stops on error.
- Cross-check queries two providers at once and calls a third on an error or disagreement. A commit needs two agreeing responses.
- One localStorage value holds accepted identities and the next window. Resume retries the first uncommitted window.
- Scoring against the frozen reference happens after the scan.
- Live requests per provider start ≥270 ms apart. Fixtures run on loopback without pacing.
- Wall time covers chain and head checks, pacing, body reads, comparison and cursor writes. POST counts include startup calls to every configured provider, standby included. Connection and preflight caches can persist.

## Limits

Exact identity agreement catches different results with equal counts. Shared upstreams, filters or omissions can still agree falsely; the shared-omission run committed every window with zero logs. Receipts prove inclusion only for logs found. Completeness is claimed for the selected windows only.

## Reproduce

Bun 1.4.4 and Orca on Bazzite, from the Orca worktree, with a fresh output directory. The replay is read-only and needs no keys.

```sh
bun src/rpc-recovery/serve.ts data/rpc-recovery/reference.json results/rpc-recovery-replay
```

In another terminal, create an isolated profile, then a tab with that profile ID, then pass the page ID to the runner.

```sh
ORCA_CLI="${ORCA_CLI_COMMAND:-orca-ide}"
"$ORCA_CLI" tab profile create --label 'RPC recovery replay' --scope isolated --json
"$ORCA_CLI" tab create --url http://127.0.0.1:8784/ --worktree current --profile PROFILE_ID --headless --json
bun src/rpc-recovery/run.ts "$ORCA_CLI" PAGE_ID data/rpc-recovery/reference.json results/rpc-recovery-replay
bun src/rpc-recovery/verify.ts data/rpc-recovery/reference.json results/rpc-recovery-replay > results/rpc-recovery-replay/summary.json
bun src/rpc-recovery/verify.ts data/rpc-recovery/reference.json data/rpc-recovery   # recorded samples
```

The runner's last argument is `all` (default), `live` or `fixture`. The fixture suite makes only loopback requests. `bun src/rpc-recovery/reference.ts results/rpc-recovery-replay/reference-rediscovery.json` recaptures the reference into a new file once the output directory exists.

[Pinned reference](../data/rpc-recovery/reference.json) · [Browser samples](../data/rpc-recovery/) · [Verified metrics](../data/rpc-recovery/summary.json) · [CORS controls](../data/rpc-recovery/controls.json)
