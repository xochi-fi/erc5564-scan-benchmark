# Phase 4 — Base browser wallet discovery

## Results

Three fresh and three resume attempts per endpoint on 2026-11-26, 19:33–19:34 UTC. Times are medians in seconds (fresh / resume). Chromium 150, Orca Electron 43.8.10, Bazzite 45, Intel i7-13700K, revision `9ba009890e71f3509489ffe5365cbc733264bf6f`.

| Endpoint | Completed | First fixture match (s) | Catch-up (s) | Browser fetch (s) | RPC calls | Real completeness |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pocket | 6/6 | 1.356 / 0.463 | 1.577 / 0.714 | 1.572 / 0.710 | 12 / 6 | Exact 2/2 in every run |
| BlockPI | 6/6 | 1.443 / 0.583 | 1.724 / 0.873 | 1.718 / 0.869 | 12 / 6 | Exact 2/2 in every run |
| Sentio | 6/6 | 3.709 / 1.473 | 4.436 / 2.212 | 4.430 / 2.208 | 12 / 6 | Exact 2/2 in every run |
| Base public RPC | 0/6 | — | — | 0.683 / 0.678 | 3 / 3 | 0/2 observed before HTTP 429 on the first log page |
| dRPC | 0/6 | — | — | 0.354 / 0.348 | 3 / 3 | 0/2 observed before HTTP 400 on the first log page. The RPC body reported a 100-block free-plan limit |
| Blockscout RPC | 0/6 | — | — | 0.115 / 0.119 | 1 / 1 | 0/2 observed before HTTP 429 on chain ID |

All 18 completions found both canonical logs and both synthetic matches. The 204 browser RPC attempts yielded readable HTTP responses. An independent command-line OPTIONS request to Blockscout returned HTTP 403 without CORS headers. Loopback CORS controls logged OPTIONS and POST on the allow route and only OPTIONS on the denied route.

Fresh catch-up ranges were 1.566–2.523 s (Pocket), 1.717–1.761 s (BlockPI), and 4.392–4.503 s (Sentio). One isolated profile ran the samples serially. Provider order rotated and mode order alternated. Connection and preflight caches may affect timing.

## Scope and timing

- Base blocks 62,241,130–62,246,129, in 500-block windows. Resume starts at 62,244,130 from a preseeded localStorage cursor. Both modes check chain ID and pinned head and stop on the first error.
- PublicNode and Tenderly independently used 200- and 173-block windows. They agreed on the [pinned head and both canonical logs](data/phase4/reference.json). Receipts corroborated the logs. Both logs fall in the resume range. Browser comparisons used block number, block hash, transaction hash and log index, including missing, extra and duplicate checks.
- Seed `phase4:base:browser:v1` placed two matches and two decoys in separate local arrays. The match blocks were 62,244,879 and 62,245,879. The SDK checked ownership locally. There were no canonical matches for the synthetic recipient, receipt or balance checks during the browser run, or transactions.
- Catch-up covers cursor read through the final write. Browser fetch time covers fetch through body read, including preflight wait, and excludes JSON parse and scan. Counts are attempted RPC POSTs. Resource timings are recorded when Chromium exposes them.

## Reproduce on Bazzite

Use Bun 1.4.4 and Orca on Bazzite. Run from the Orca worktree with access to public Base RPCs.

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

To independently recapture the reference, run `bun scripts/phase4/reference.ts results/phase4-replay/reference.json`. Reference requests are paced at a minimum of 275 ms between starts per provider. The replay needs a fresh sample output directory. The local server serves the harness, controls, and fixture and receives sample output. Chrome fetch accesses public RPC endpoints directly with normal CORS enforcement and omitted credentials.

[Sample CSV](data/phase4/samples.csv) · [Browser samples](data/phase4/samples/) · [Pinned reference](data/phase4/reference.json) · [Browser CORS controls](data/phase4/controls.json) · [Command-line preflight summary](data/phase4/preflight.json)
