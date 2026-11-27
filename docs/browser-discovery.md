# Browser discovery

Can a browser wallet find Base payments through keyless providers?

Three of six providers complete every run, and a saved checkpoint halves their requests.

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

Medians of three fresh and three resume runs per provider, 2026-11-26 at 19:33 UTC, revision `9ba009890e71f3509489ffe5365cbc733264bf6f`. Every completed run also finds both synthetic matches. All 204 requests get readable HTTP responses.

| Provider | Fresh catch-up range, s |
| --- | --- |
| Pocket | 1.566–2.523 |
| BlockPI | 1.717–1.761 |
| Sentio | 4.392–4.503 |

A command-line OPTIONS request to Blockscout gets HTTP 403 without CORS headers.

## Method

| Item | Value |
| --- | --- |
| Range | Base blocks 62,241,130–62,246,129, 500-block pages |
| Resume checkpoint | Block 62,244,130 |
| Canonical announcements | 2, in the resume range; PublicNode and Tenderly agree ([reference](../data/browser-discovery/reference.json)) |
| Synthetic matches and decoys | 2 each, blocks 62,244,879 and 62,245,879 |
| Catch-up timer | Checkpoint read to final write |
| Browser fetch timer | Fetch start to body read, preflight included |

These are [browser runs](../METHODS.md#browser-runs) on port 8764.

```sh
mkdir -p results/browser-discovery-replay
bun run browser-discovery:serve results/browser-discovery-replay
bun run browser-discovery "$ORCA_CLI" PAGE_ID data/browser-discovery/reference.json results/browser-discovery-replay 3
bun run browser-discovery:preflight results/browser-discovery-replay/preflight.json
bun run browser-discovery:reference results/browser-discovery-replay/reference.json   # recapture
```

[Sample CSV](../data/browser-discovery/samples.csv) · [Browser samples](../data/browser-discovery/samples/) · [Pinned reference](../data/browser-discovery/reference.json) · [CORS controls](../data/browser-discovery/controls.json) · [Command-line preflight](../data/browser-discovery/preflight.json)
