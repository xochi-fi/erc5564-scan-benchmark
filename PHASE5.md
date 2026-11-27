# Phase 5 — Base RPC omission and recovery

Daybreak reproduced the Phase 3 silent omission in Chromium on Bazzite. A second provider exposed the discrepancy, and a third supplied the agreeing response needed to recover all 48 expected announcements.

## Replay scope

Phase 3 switched from Pocket to Daybreak at Base block **34,304,282**. Daybreak returned 6,120 successful 2,000-block pages before the sequential backfill exhausted its request budget at next block **46,544,282**. Its saved identities contain zero logs in that interval. Phase 3's parallel artifact contains 48.

The replay selected every original 2,000-block page containing a Phase 3 identity and five empty control pages spread across the interval, including its first and last pages. That yields **34 of the original 6,120 pages**, covering 68,000 blocks and all 48 known missing logs. The direct Daybreak probe used the original 2,000-block boundaries. The strategy comparisons split each selected page into two adjacent 1,000-block windows so Tenderly and Sentio could each serve the same requests. All strategy arms used the same ordered manifest of **68 windows**. Reported catch-up is to the end of that manifest. The intervening unsampled blocks were outside the replay.

Tenderly and Sentio independently rescanned the manifest using 1,000- and 613-block steps. Both reported Base chain ID and the pinned end-block hash `0x5fc7736af83e73efc37234527fe43bb48a5be7fdb5afe10f847b9475615ed535`. They agreed on all 48 identities across 46 distinct blocks and each source verified the address, topics and data in the corresponding transaction receipts. The identity tuple is block number, block hash, transaction hash and numeric log index. All 48 also matched the Phase 3 parallel identities using the fields saved there. The reference was frozen before the Chromium trials. A preliminary PublicNode attempt reported an archive-token requirement on the pinned block lookup.

## Browser method

The benchmark reused the [Phase 4](PHASE4.md) browser transport, CORS controls, pinned-head check, and receipt corroboration method. It ran on Bazzite 45 using Chromium 150.0.7871.250 in Orca Electron 43.8.10, with an isolated profile. Browser POSTs went directly to each live RPC, with CORS enforcement and omitted credentials. A separate loopback origin returned a readable response for the allow control and rejected the deny control at OPTIONS, with no deny POST.

Single RPC accepted each successful page, including an empty one, and stopped on error. Cross-check started two providers concurrently. Exact identity-set agreement allowed the cursor and accepted identities to be written together in one localStorage value. Disagreement or an error called a third provider for that same window. The cursor stopped if two successful responses still failed to agree. Resume reread the durable cursor and retried the first unaccepted window. The accepted identities were scored against the frozen reference after the run. The scanner used only the pinned head hash from the reference during decisions.

Each browser arm serially walked windows with a per-live-host minimum of 270 ms between request starts. The wall-clock timing includes chain and head checks, pacing, response reads, page comparison and checkpoint writes. The counts cover browser POST attempts including chain and head checks. OPTIONS, local artifact writes and reference collection are excluded. The harness initializes all configured providers, including the standby third, so even unused fallback contributes two startup calls. Each table row is one run. Browser connections and preflights can be reused. Loopback fixtures have no pacing or Internet latency and their times only describe the fixture.

## Measurements

The live samples ran on November 26, 2026 at approximately 20:00–20:02 UTC. There were zero extra or duplicate identities and zero browser fetch, HTTP or JSON-RPC errors in the live comparison.

| Live strategy | Accepted / expected logs | RPC POSTs | Third-provider pages | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Daybreak, original-width diagnostic | 0 / 48 observed | 36 | 0 | 9.52 s to probe 34 pages |
| Daybreak single | 0 / 48 | 70 | 0 | 18.69 s |
| Daybreak + Tenderly, Sentio fallback | 48 / 48 | 181 | 39 | 31.25 s |
| Tenderly single | 48 / 48 | 70 | 0 | 18.82 s |
| Tenderly + Sentio, Pocket on standby | 48 / 48 | 142 | 0 | 28.76 s |

Daybreak alone advanced through all 68 windows while missing 48 logs. Its cross-check accepted 29 empty agreements and used Sentio on 39 mismatches. Tenderly and Sentio agreed on each of those 39 windows. Recovery added **111 POSTs and 12.55 s** over Daybreak alone. The 111 additional calls were 68 second-provider page requests, 39 fallback page requests and four additional startup checks. The healthy pair added **72 POSTs and 9.94 s** over Tenderly alone.

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

The HTTP 503 cross-check recovered the affected window using two successful sources. It incurred one extra fallback call versus a fault-free cross-check. The equal-count case stopped when the first two sources returned different one-log subsets and the third returned both logs. The mismatch-plus-error case held the cursor at index 7, before blocks 41,623,282–41,624,281. Resume retried that same window, preserved the seven committed windows and completed with 48 exact identities. The stopped run and resume together used 190 POSTs and 284.7 ms of active loopback time. That excludes the interval between runs. Compared with the 181-call uninterrupted omission fixture, the recovery path repeated three page calls and six initialization calls.

## What agreement establishes

The original-width replay demonstrates successful empty responses in known nonempty historical pages, and the timing comparison measures the cost of recovering them on one browser and network. Two independent operators agreeing on exact identities is stronger evidence than matching page counts. Equal counts can conceal different identities, as the equal-count control demonstrates. Two sources can still share an upstream, omit the same data, or agree on a faulty filter. The shared-omission control committed all windows while returning zero logs. Receipts establish inclusion for the reported logs. They do not establish that every matching receipt was discovered. The pinned hash fixes which historical end block the run intended to check. These results apply to the selected windows only.

## Reproduce locally

Use Bun 1.4.4 and the Orca desktop app with its CLI available on Bazzite. Run from the repository’s Orca worktree. Keep the saved reference for comparisons to the exact same identities and head. Choose a fresh output directory for a replay.

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
