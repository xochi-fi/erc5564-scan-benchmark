# RPC recovery

Can a browser wallet recover logs a public RPC silently drops? In these windows, yes.

<!-- generated:recovery-live -->
| Live strategy | Accepted / expected logs | RPC POSTs | Third-provider pages | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Daybreak, original-width diagnostic | 0 / 48 observed | 36 | 0 | 9.52 s to probe 34 pages |
| Daybreak single | 0 / 48 | 70 | 0 | 18.69 s |
| Daybreak + Tenderly, Sentio fallback | 48 / 48 | 181 | 39 | 31.25 s |
| Tenderly single | 48 / 48 | 70 | 0 | 18.82 s |
| Tenderly + Sentio, Pocket on standby | 48 / 48 | 142 | 0 | 28.76 s |
<!-- /generated:recovery-live -->

One run per row, 2026-11-26 about 20:00 UTC, with no extra or duplicate identities and no transport or JSON-RPC errors. The Daybreak cross-check accepted 29 empty agreements and called Sentio on 39 mismatches.

![Logs accepted over wall time for each live strategy](figures/live-timeline.svg)
<sub>A step is a window committed with new logs, timed at its last log request.</sub>

## Injected faults

Loopback fixtures replay real logs from the frozen reference with injected omissions, differing subsets, HTTP 503 and an HTTP 200 JSON-RPC error; separate loopback paths stand in for separate sources.

<!-- generated:recovery-faults -->
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
<!-- /generated:recovery-faults -->

The equal-count run stopped once the third source returned both one-log subsets. The mismatch-plus-error run stopped before blocks 41,623,282–41,624,281; stop plus resume cost three page calls and six startup calls more than uninterrupted recovery.

## Scope

The windows come from the Base run in [chain-volume finding 3](chain-volume.md#findings), where Daybreak returned zero logs in 6,120 successful 2,000-block pages through block 46,544,281. The replay takes all 29 positive pages plus five empty controls, boundaries included. The original-width diagnostic queries these 34 pages as is. Strategy trials split them into 68 windows of 1,000 blocks (68,000 blocks) holding 48 known logs.

Tenderly (1,000-block steps) and Sentio (613-block steps) scanned the ranges independently and agreed on head hash, chain ID and all 48 receipt-checked identities across 46 blocks. PublicNode needed an archive token at the pinned head.

## Method

[Browser runs](../METHODS.md#browser-runs) with the [browser-discovery](browser-discovery.md) transport: CORS-enforced POSTs, no credentials.

- Single RPC commits any successful page and stops on error.
- Cross-check queries two providers and calls a third on an error or disagreement; a commit needs two agreeing responses.
- One localStorage value holds accepted identities and the next window; resume retries the first uncommitted one.
- Scoring against the reference happens after the scan. Fixtures run [unpaced](../METHODS.md#live-rpc).
- Wall time covers checks, pacing, body reads, comparison and cursor writes. POST counts include startup calls to every provider, standby included.

## Limits

Exact identity agreement catches equal counts with different logs, but shared upstreams or filters can still agree falsely: the shared-omission run committed every window empty. Receipts prove inclusion only for logs found. Completeness holds for the selected windows only.

## Reproduce

The replay is read-only and needs no keys. Server port 8784.

```sh
bun run rpc-recovery:serve data/rpc-recovery/reference.json results/rpc-recovery-replay
bun run rpc-recovery "$ORCA_CLI" PAGE_ID data/rpc-recovery/reference.json results/rpc-recovery-replay   # all (default), live or fixture
bun run rpc-recovery:verify data/rpc-recovery/reference.json results/rpc-recovery-replay > results/rpc-recovery-replay/summary.json
bun run rpc-recovery:verify data/rpc-recovery/reference.json data/rpc-recovery   # recorded samples
bun run rpc-recovery:reference results/rpc-recovery-replay/reference-rediscovery.json   # recapture
```

[Pinned reference](../data/rpc-recovery/reference.json) · [Browser samples](../data/rpc-recovery/) · [Verified metrics](../data/rpc-recovery/summary.json) · [CORS controls](../data/rpc-recovery/controls.json)
