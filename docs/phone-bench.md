# Phone bench

How fast does a phone browser scan announcements?

No phone result is recorded yet. The page measures it on the visitor's device and anyone with a GitHub account can submit the result.

<!-- generated:phone-bench -->
| Device | OS | Browser | JIT | Engine | Announcements | ms per announcement | Credit |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| No results yet |  |  |  |  |  |  |  |
<!-- /generated:phone-bench -->

The page is one static file. It scans the first 1,000, 5,000 or 10,000 announcements of a pinned seeded fixture (`phone-bench:v1`, a match every 1,000) in a Web Worker, or in short main-thread steps where workers are missing, and checks the matches against the fixture schedule. Its Content-Security-Policy blocks every network request. Nothing leaves the device until the user submits, copies or downloads the result.

| Field in a result | Source |
| --- | --- |
| `device`, `os`, `browser`, `jit`, `notes` | What the user confirmed or typed, prefilled from detection |
| `detected` | OS, browser and versions parsed from the user agent; iPhone models matching the screen; Client Hints `model`, `platform`, `platformVersion` where offered; a JIT guess (off only when iOS lacks WebAssembly, as in Lockdown Mode) |
| `userAgent`, `screen`, `hardwareConcurrency`, `webAssembly`, `secureContext`, `worker` | The browser, as exposed to any page |
| `engine`, `count`, fixture digests, `scanMs`, `msPerAnnouncement`, matches, `verified` | The run |

## Submit

"Submit result" opens a prefilled [Phone bench result](../.github/ISSUE_TEMPLATE/phone-bench.yml) issue. A [workflow](../.github/workflows/phone-bench.yml) validates it (schema, pinned fixture digests, oracle, plausible ranges) and opens a pull request adding it to `data/phone-bench/`, or comments with the reasons. A maintainer merges. The handle is recorded only when the submitter ticks the credit box. Fabricated timings that pass these checks cannot be detected.

Maintainer settings, none set yet: Pages source "GitHub Actions" and the variable `PHONE_BENCH_PAGES=true` publish the page from `main` ([workflow](../.github/workflows/phone-bench-pages.yml)); "Allow GitHub Actions to create and approve pull requests" lets the result workflow open its pull request. Pull requests opened by the workflow do not trigger CI until a maintainer reruns it.

## Run locally

```sh
bun run phone-bench:build                                   # work/phone-bench/index.html
bun run phone-bench:serve --host "$(tailscale ip -4)"       # http://<tailscale-ip>:8790/, tailnet only
bun run phone-bench:serve &                                 # 127.0.0.1:8790, for tailscale serve
tailscale serve --bg --https=8443 http://127.0.0.1:8790     # https://<host>.<tailnet>.ts.net:8443/
tailscale serve --https=8443 off; pkill -f src/phone-bench/serve.ts
bun run phone-bench:record result.json                      # validate and record a result by hand
BUN_JSC_useJIT=0 bun run phone-bench:cli --count 1000       # JavaScriptCore without JIT, a proxy only
```
