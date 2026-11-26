# Phase 4 — Base browser wallet discovery

On Bazzite, resuming from a saved cursor halved browser RPC calls and roughly halved median catch-up time on the three endpoints that completed. All 18 completed samples retrieved both expected canonical Base logs exactly and found both synthetic matches. The other 18 samples stopped on a readable HTTP error.

## Results

Three fresh and three resume attempts per endpoint on 2026-11-26 at 19:33–19:34 UTC. Times below are medians in seconds, shown as fresh / resume. Browser measurements used Chromium 150 in Orca's Electron 43.8.10 on Bazzite 45 with an Intel Core i7-13700K, based on merged main at `9ba009890e71f3509489ffe5365cbc733264bf6f`.

| Endpoint | Completed | First fixture match (s) | Catch-up (s) | Browser fetch (s) | RPC calls | Real completeness |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pocket | 6/6 | 1.356 / 0.463 | 1.577 / 0.714 | 1.572 / 0.710 | 12 / 6 | Exact 2/2 in every run |
| BlockPI | 6/6 | 1.443 / 0.583 | 1.724 / 0.873 | 1.718 / 0.869 | 12 / 6 | Exact 2/2 in every run |
| Sentio | 6/6 | 3.709 / 1.473 | 4.436 / 2.212 | 4.430 / 2.208 | 12 / 6 | Exact 2/2 in every run |
| Base public RPC | 0/6 | — | — | 0.683 / 0.678 | 3 / 3 | 0/2 observed before HTTP 429 on the first log page |
| dRPC | 0/6 | — | — | 0.354 / 0.348 | 3 / 3 | 0/2 observed before HTTP 400 on the first log page. The RPC body reported a 100-block free-plan limit |
| Blockscout RPC | 0/6 | — | — | 0.115 / 0.119 | 1 / 1 | 0/2 observed before HTTP 429 on chain ID |

Across **204 browser RPC fetches**, all reached readable HTTP responses, so the measured suite had **0 CORS failures and 0 unresolved fetch rejections**. Base public RPC's HTTP 429 included JSON-RPC code `-32011`. dRPC's HTTP 400 included JSON-RPC code `35`. Blockscout's browser response exposed an HTTP 429 with a rate-limit message. A separate command-line OPTIONS diagnostic encountered a Cloudflare HTTP 403 without CORS headers for Blockscout. The two observations describe different clients at different times. The local CORS controls recorded OPTIONS and POST for the allowed route and OPTIONS alone for the denied route, which rejected in browser JavaScript.

Pocket fresh varied most across repeats, with catch-up ranging from 1.566 to 2.523 s. BlockPI ranged from 1.717 to 1.761 s and Sentio from 4.392 to 4.503 s. These are three serial samples per mode and provider on one machine and network with a single isolated browser profile. Endpoint order rotated and fresh/resume order alternated. Connection reuse and Chromium's CORS preflight cache can affect wall-clock times.

## Scope and timing

- Fresh started at Base block **62,241,130** and used 10 sequential pages of 500 blocks. Resume read a preseeded localStorage cursor at **62,244,129**, then started at **62,244,130** and used four pages. Both stopped at fixed head **62,246,129**. Every run cleared prior benchmark cursor state, then restored the cursor only for resume. Both also attempted chain ID and historical head hash checks. The benchmark stopped at the first failure under this fixed, no-retry page policy.
- PublicNode and Tenderly, neither in the browser endpoint matrix, independently scanned the full range in 200- and 173-block pages. They agreed on the pinned head hash `0x52970c9a17a278f7da13d0e6a30f464652339bd7b157341f5435ed77f108f0e0` and the exact identities of both canonical ERC-5564 logs, and checked each log against its transaction receipt. Browser equality used block number, block hash, transaction hash, and numeric log index, with missing, extra and duplicate checks. Fresh and resume were compared against their respective inclusive ranges. Both reference logs fall in the resume range. Cross-provider agreement is evidence for this range and these two logs; the benchmark does not establish completeness across Base history.
- The existing synthetic generator used seed `phase4:base:browser:v1` and produced two matches and two decoys. The browser scanned these in separate arrays after processing the corresponding live page. It timed the SDK's first synthetic match when that page became available. Both modes had the same first-match block, **62,244,879**, and second-match block, **62,245,879**. No live log matched the synthetic recipient, so real time to first match is unavailable. Verification measured here is the SDK ownership check. The browser did no receipt or balance verification and sent no transactions.
- Catch-up time starts just before reading the cursor and stops after scanning and writing the fixed-head cursor. Browser fetch time is the sum of fetch-to-body-complete intervals, including any preflight wait inside the fetch. It excludes JSON parse and local scan time, and it includes browser scheduling, connection, and server response time. RPC count means JavaScript POST fetch attempts, with OPTIONS and localhost requests excluded. Individual Chromium resource timings, when exposed, are preserved without inferring wire-level phase times from zeros.

## Reproduce on Bazzite

Use Bun 1.4.4 and the Orca desktop app with its CLI available on Bazzite. Run from the repository’s Orca worktree. The live replay needs network access to public Base RPCs and uses the saved reference for the same fixed identities.

```sh
bun install --frozen-lockfile
mkdir -p results/phase4-replay
bun scripts/phase4/serve.ts results/phase4-replay
```

In another terminal, create a new isolated profile and use the returned ID. The tab command returns the page ID.

```sh
ORCA_PHASE4_CLI="${ORCA_CLI_COMMAND:-orca-ide}"
"$ORCA_PHASE4_CLI" tab profile create --label 'Phase 4 replay' --scope isolated --json
"$ORCA_PHASE4_CLI" tab create --url http://127.0.0.1:8764/ --worktree current --profile PROFILE_ID --headless --json
bun scripts/phase4/run.ts "$ORCA_PHASE4_CLI" PAGE_ID data/phase4/reference.json results/phase4-replay 3
bun scripts/phase4/preflight.ts results/phase4-replay/preflight.json
```

To independently recapture the reference, run `bun scripts/phase4/reference.ts results/phase4-replay/reference.json`. The replay needs a fresh sample output directory. The local server serves the harness, controls, and fixture and receives sample output. Chrome fetch accesses public RPC endpoints directly with normal CORS enforcement and omitted credentials.

[Sample CSV](data/phase4/samples.csv) · [Browser samples](data/phase4/samples/) · [Pinned reference](data/phase4/reference.json) · [Browser CORS controls](data/phase4/controls.json) · [Command-line preflight summary](data/phase4/preflight.json)
