# Phone bench

How fast does a phone browser scan announcements?

An iPhone 17 Pro in DuckDuckGo scans 10,000 announcements at 0.54 ms each with the SDK and with its `crypto` path. libsecp256k1 in WASM takes 0.087 ms each on the same phone over 10,000, a 0.87 s run that agrees with the 1,000 run within 7%. Host rates for each engine are in [scan cost](scan-cost.md). No-JIT is unmeasured on a phone: a run labelled Lockdown Mode still had WebAssembly, so Lockdown was off, and it is left out.

<!-- generated:phone-bench -->
| Device | OS | Browser | JIT | Engine | Announcements | ms per announcement | Credit |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| iPhone 17 Pro | iOS 18.7 | DuckDuckGo 27.2 | on | crypto | 1,000 (0.60 s run) | 0.60 | owner |
| iPhone 17 Pro | iOS 18.7 | DuckDuckGo 27.2 | on | crypto | 10,000 | 0.54 | owner |
| iPhone 17 Pro | iOS 18.7 | DuckDuckGo 27.2 | on | sdk | 10,000 | 0.54 | owner |
| iPhone 17 Pro | iOS 18.7 | DuckDuckGo 27.2 | on | wasm | 1,000 (0.09 s run) | 0.093 | owner |
| iPhone 17 Pro | iOS 18.7 | DuckDuckGo 27.2 | on | wasm | 10,000 (0.87 s run) | 0.087 | owner |
<!-- /generated:phone-bench -->

JavaScriptCore without its JIT bounds the Lockdown Mode case until a phone measures it. It is a proxy: Bun on a Turing node, not Safari on a phone.

<!-- generated:phone-proxy -->
| Host | Runtime | JIT | Engine | ms per announcement |
| --- | --- | --- | --- | ---: |
| turing-node-3 | bun 1.4.4 | on | crypto | 1.75 |
| turing-node-3 | bun 1.4.4 | off (`BUN_JSC_useJIT=0`) | crypto | 10.86 |
| turing-node-3 | bun 1.4.4 | on | sdk | 1.68 |
| turing-node-3 | bun 1.4.4 | off (`BUN_JSC_useJIT=0`) | sdk | 11.04 |
<!-- /generated:phone-proxy -->

The page is a few static files. It scans the first 1,000, 5,000 or 10,000 announcements of a pinned seeded fixture (WASM can repeat it to 100,000) (`phone-bench:v1`, a match every 1,000) with the SDK, its `checkStealthAddress` (`crypto`) or libsecp256k1 in WASM, in a Web Worker or in short main-thread steps where workers are missing, and checks the matches against the fixture schedule. Its Content-Security-Policy blocks every network request. Nothing leaves the device until the user submits, copies or downloads the result.

| Field in a result | Source |
| --- | --- |
| `device`, `os`, `browser`, `jit`, `notes` | What the user confirmed or typed, prefilled from detection |
| `detected` | OS, browser and versions parsed from the user agent; iPhone models matching the screen; Client Hints `model`, `platform`, `platformVersion` where offered; a JIT guess (off only when iOS lacks WebAssembly, as in Lockdown Mode); a Lockdown label with WebAssembly present is rejected |
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
