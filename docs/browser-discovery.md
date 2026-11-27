# Browser discovery

Can a browser wallet discover Base payments from keyless public RPCs? Three of six endpoints completed every run with both canonical logs. A saved cursor cut their POSTs from 12 to 6.

<!-- generated:browser-discovery -->
| Endpoint | Completed | First fixture match (s) | Catch-up (s) | Browser fetch (s) | RPC calls | Real completeness |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pocket | 6/6 | 1.356 / 0.463 | 1.577 / 0.714 | 1.572 / 0.710 | 12 / 6 | Exact 2/2 in every run |
| BlockPI | 6/6 | 1.443 / 0.583 | 1.724 / 0.873 | 1.718 / 0.869 | 12 / 6 | Exact 2/2 in every run |
| Sentio | 6/6 | 3.709 / 1.473 | 4.436 / 2.212 | 4.430 / 2.208 | 12 / 6 | Exact 2/2 in every run |
| Base public RPC | 0/6 | — | — | 0.683 / 0.678 | 3 / 3 | 0/2 seen before HTTP 429 on the first log page |
| dRPC | 0/6 | — | — | 0.354 / 0.348 | 3 / 3 | 0/2 seen before HTTP 400 on the first log page. The body reported a 100-block free-plan limit. |
| Blockscout RPC | 0/6 | — | — | 0.115 / 0.119 | 1 / 1 | 0/2 seen before HTTP 429 on chain ID |
<!-- /generated:browser-discovery -->

Medians, fresh / resume, three of each per endpoint, 2026-11-26 19:33–19:34 UTC. Chromium 150, Orca Electron 43.8.10, Bazzite 45, Intel i7-13700K, revision `9ba009890e71f3509489ffe5365cbc733264bf6f`.

- All 18 completions found both canonical logs and both synthetic matches. All 204 browser RPC attempts got readable HTTP responses.
- A command-line OPTIONS request to Blockscout got HTTP 403 without CORS headers. Loopback controls saw OPTIONS and POST on the allow route and only OPTIONS on the deny route.
- Fresh catch-up ranged 1.566–2.523 s (Pocket), 1.717–1.761 s (BlockPI) and 4.392–4.503 s (Sentio).
- One isolated profile ran samples serially, rotating provider order and alternating mode. Connection and preflight caches may affect timing.

## Method

- Base blocks 62,241,130–62,246,129 in 500-block windows. Resume starts at 62,244,130 from a preseeded localStorage cursor. Both modes check chain ID and the pinned head, and stop on the first error.
- PublicNode and Tenderly scanned independently in 200- and 173-block windows and agreed on the [pinned head and both canonical logs](../data/browser-discovery/reference.json). Receipts corroborated the logs, which both fall in the resume range. Comparison uses block number, block hash, transaction hash and log index, and checks for missing, extra and duplicate logs.
- A seeded synthetic fixture ([seed name](../METHODS.md#names-in-recorded-data)) places two matches and two decoys in separate local arrays, in blocks 62,244,879 and 62,245,879. The SDK checks ownership locally. No canonical log matched the synthetic recipient. No receipt or balance checks, no transactions.
- Catch-up runs from cursor read to final write. Browser fetch runs from fetch to body read, preflight wait included, without JSON parse or scan. Counts are attempted POSTs. Resource timings are kept when Chromium exposes them.

## Reproduce

Bun 1.4.4 and Orca on Bazzite, from the Orca worktree, with access to public Base RPCs.

```sh
mkdir -p results/browser-discovery-replay
bun run browser-discovery:serve results/browser-discovery-replay
```

In another terminal, create an isolated profile and a tab. Each command returns the ID the next one needs.

```sh
ORCA_CLI="${ORCA_CLI_COMMAND:-orca-ide}"
"$ORCA_CLI" tab profile create --label 'Browser discovery replay' --scope isolated --json
"$ORCA_CLI" tab create --url http://127.0.0.1:8764/ --worktree current --profile PROFILE_ID --headless --json
bun run browser-discovery "$ORCA_CLI" PAGE_ID data/browser-discovery/reference.json results/browser-discovery-replay 3
bun run browser-discovery:preflight results/browser-discovery-replay/preflight.json
```

`bun run browser-discovery:reference results/browser-discovery-replay/reference.json` recaptures the reference, with at least 275 ms between request starts per provider. Each replay needs a fresh output directory. The local server serves the harness, controls and fixture and receives samples. Chromium fetches public RPCs directly, with normal CORS and credentials omitted.

[Sample CSV](../data/browser-discovery/samples.csv) · [Browser samples](../data/browser-discovery/samples/) · [Pinned reference](../data/browser-discovery/reference.json) · [CORS controls](../data/browser-discovery/controls.json) · [Command-line preflight](../data/browser-discovery/preflight.json)
