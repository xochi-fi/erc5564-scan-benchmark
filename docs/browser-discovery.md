# Browser discovery

Can a browser wallet discover Base payments from keyless public RPCs?

Three of six endpoints completed every run, and a saved cursor halved their requests.

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

Medians of three fresh and three resume runs per endpoint, 2026-11-26 19:33 UTC, revision `9ba009890e71f3509489ffe5365cbc733264bf6f`. Every completion found both synthetic matches. All 204 requests got readable HTTP responses. Fresh catch-up ranged 1.566–2.523 s on Pocket, 1.717–1.761 s on BlockPI and 4.392–4.503 s on Sentio. A command-line OPTIONS request to Blockscout got HTTP 403 without CORS headers.

## Method

The range is Base blocks 62,241,130–62,246,129 in 500-block windows. Resume starts at block 62,244,130 from a preseeded cursor. PublicNode and Tenderly agreed on the [pinned head and both canonical logs](../data/browser-discovery/reference.json), which fall in the resume range. A seeded fixture adds two matches and two decoys at blocks 62,244,879 and 62,245,879. Catch-up runs from cursor read to final write. Browser fetch runs from fetch to body read, preflight included.

## Reproduce

These are [browser runs](../METHODS.md#browser-runs) on server port 8764.

```sh
mkdir -p results/browser-discovery-replay
bun run browser-discovery:serve results/browser-discovery-replay
bun run browser-discovery "$ORCA_CLI" PAGE_ID data/browser-discovery/reference.json results/browser-discovery-replay 3
bun run browser-discovery:preflight results/browser-discovery-replay/preflight.json
bun run browser-discovery:reference results/browser-discovery-replay/reference.json   # recapture
```

[Sample CSV](../data/browser-discovery/samples.csv) · [Browser samples](../data/browser-discovery/samples/) · [Pinned reference](../data/browser-discovery/reference.json) · [CORS controls](../data/browser-discovery/controls.json) · [Command-line preflight](../data/browser-discovery/preflight.json)
