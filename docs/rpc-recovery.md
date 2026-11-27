# Phase 5 — Base RPC omission and recovery

## Replay scope

Phase 3 switched from Pocket to Daybreak at Base block 34,304,282. Daybreak returned zero logs in 6,120 successful 2,000-block pages through block 46,544,281. The parallel run found 48 logs in that interval.

The replay used all 29 positive pages and five empty controls, including the interval boundaries. The original-width diagnostic used those 34 pages directly. The strategy trials split them into 68 windows of 1,000 blocks. Catch-up covers only those 68,000 selected blocks.

Tenderly and Sentio independently scanned the selected ranges in 1,000- and 613-block steps. They agreed on the pinned head hash, chain ID and 48 identities across 46 blocks. Each source verified address, topics and data against transaction receipts. All identities matched the fields available in Phase 3. A preliminary PublicNode attempt required an archive token at the pinned head.

## Browser method

Chromium 150.0.7871.250 in Orca Electron 43.8.10 on Bazzite 45, one isolated profile. The [Phase 4](PHASE4.md) transport sent CORS-enforced POSTs with omitted credentials. Loopback controls recorded OPTIONS and POST on the allow route and only OPTIONS on the deny route.

Single RPC commits any successful page, including empty pages, and stops on error. Cross-check queries two providers concurrently and calls a third for errors or identity disagreements. A commit requires two agreeing responses. One localStorage value stores the accepted identities and next window. Resume retries the first uncommitted window. The harness scores results against the frozen reference after the scan.

Requests to each live provider start at least 270 ms apart. Wall time includes chain and head checks, pacing, body reads, comparison and cursor writes. POST counts include startup calls to every configured provider, including standby. One run per row. Connection and preflight caches can persist. Fixtures use loopback without pacing.

## Measurements

The live samples ran on November 26, 2026 at approximately 20:00–20:02 UTC. There were zero extra or duplicate identities and zero browser fetch, HTTP or JSON-RPC errors in the live comparison.

| Live strategy | Accepted / expected logs | RPC POSTs | Third-provider pages | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Daybreak, original-width diagnostic | 0 / 48 observed | 36 | 0 | 9.52 s to probe 34 pages |
| Daybreak single | 0 / 48 | 70 | 0 | 18.69 s |
| Daybreak + Tenderly, Sentio fallback | 48 / 48 | 181 | 39 | 31.25 s |
| Tenderly single | 48 / 48 | 70 | 0 | 18.82 s |
| Tenderly + Sentio, Pocket on standby | 48 / 48 | 142 | 0 | 28.76 s |

Daybreak single committed all windows and missed 48 logs. The cross-check accepted 29 empty agreements and used Sentio on 39 mismatches. It added 111 POSTs and 12.55 s over Daybreak single. The healthy pair added 72 POSTs and 9.94 s over Tenderly single.

The loopback fixtures replayed genuine raw logs from the frozen reference. The injected behaviors were omissions, different partial subsets, HTTP 503 and an HTTP 200 JSON-RPC error. Distinct loopback paths represented sources in the control cases.

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

The equal-count run stopped on different one-log subsets when the third source returned both. The mismatch-plus-error run stopped before blocks 41,623,282–41,624,281. Resume preserved the seven committed windows and recovered all 48 identities. Together the runs took 190 POSTs and 284.7 ms of active loopback time, including three repeated page calls and six repeated startup calls versus uninterrupted recovery.

## Limits

Agreement on block number, block hash, transaction hash and log index detects different results with equal counts. Shared upstreams, filters and omissions can yield false agreement. The shared-omission scan committed all windows with zero logs. Receipts establish inclusion for discovered logs. The selected windows bound the completeness claim.

## Reproduce locally

Use Bun 1.4.4 and Orca on Bazzite. Run from the Orca worktree with a fresh output directory.

```sh
bun install --frozen-lockfile
bun scripts/phase5/serve.ts data/phase5/reference.json results/phase5-replay
```

In another terminal, create an isolated profile, then create a tab with the returned profile ID. Pass the returned page ID to the runner.

```sh
ORCA_PHASE5_CLI="${ORCA_CLI_COMMAND:-orca-ide}"
"$ORCA_PHASE5_CLI" tab profile create --label 'Phase 5 replay' --scope isolated --json
"$ORCA_PHASE5_CLI" tab create --url http://127.0.0.1:8784/ --worktree current --profile PROFILE_ID --headless --json
bun scripts/phase5/run.ts "$ORCA_PHASE5_CLI" PAGE_ID data/phase5/reference.json results/phase5-replay
bun scripts/phase5/verify.ts data/phase5/reference.json results/phase5-replay > results/phase5-replay/summary.json
```

The runner defaults to `all` and accepts `live` or `fixture` as its final argument. The fixture suite uses only loopback requests. To independently recapture the reference into a new file, run `bun scripts/phase5/reference.ts results/phase5-replay/reference-rediscovery.json` after creating the output directory. The replay is read-only and requires no keys.

[Pinned reference](data/phase5/reference.json) · [Browser samples](data/phase5/) · [Verified metrics](data/phase5/summary.json) · [Browser CORS controls](data/phase5/controls.json)

Verify the recorded samples with `bun scripts/phase5/verify.ts data/phase5/reference.json data/phase5`.
