# Device bench

How fast does a phone, tablet or computer browser scan announcements?

An iPhone 17 Pro in DuckDuckGo scans 10,000 announcements at 0.54 ms each with the SDK and with its `crypto` path. libsecp256k1 in WASM takes 0.087 ms each on the same phone over 10,000, a 0.87 s run that agrees with the 1,000 run within 7%. Host rates for each engine are in [scan cost](scan-cost.md). Any browser can run the [page](https://xochi-fi.github.io/erc5564-scan-benchmark/). No-JIT is unmeasured on a phone: a run labelled Lockdown Mode still had WebAssembly, so Lockdown was off, and it is left out.

<!-- generated:phone-bench -->
| Device | Class | OS | Browser | JIT | Engine | Announcements | ms per announcement | Credit |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| iPhone 17 Pro | phone | iOS 18.7 | DuckDuckGo 27.2 | on | crypto | 1,000 (0.60 s run) | 0.60 | owner |
| iPhone 17 Pro | phone | iOS 18.7 | DuckDuckGo 27.2 | on | crypto | 10,000 | 0.54 | owner |
| iPhone 17 Pro | phone | iOS 18.7 | DuckDuckGo 27.2 | on | sdk | 10,000 | 0.54 | owner |
| iPhone 17 Pro | phone | iOS 18.7 | DuckDuckGo 27.2 | on | wasm | 1,000 (0.09 s run) | 0.093 | owner |
| iPhone 17 Pro | phone | iOS 18.7 | DuckDuckGo 27.2 | on | wasm | 10,000 (0.87 s run) | 0.087 | owner |
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

The page is a few static files. It scans up to 10,000 announcements of a pinned seeded fixture (`phone-bench:v1`, a match every 1,000) with the SDK, its `checkStealthAddress` (`crypto`) or libsecp256k1 in WASM, and checks the matches against the fixture schedule. WASM can repeat the fixture to 100,000 so fast devices run for seconds. The scan runs in a Web Worker, or in short main-thread steps where workers are missing. Its Content-Security-Policy blocks every network request. Nothing leaves the device until the user submits, copies or downloads the result.

| Field in a result | Source |
| --- | --- |
| `device`, `deviceClass`, `os`, `browser`, `jit`, `notes` | What the user confirmed or typed, prefilled from detection. Pages before v9 had no `deviceClass`; the table derives it from the user agent. |
| `detected` | OS, browser, versions and device class from the user agent (a Mac with touch points is an iPad); iPhone models matching the screen; Client Hints `model`, `platform`, `platformVersion` and CPU architecture where offered (non-Chromium Linux browsers name the CPU in the user agent); a JIT guess (off only when iOS lacks WebAssembly, as in Lockdown Mode); a Lockdown label with WebAssembly present is rejected |
| `userAgent`, `screen`, `hardwareConcurrency`, `webAssembly`, `secureContext`, `worker` | The browser, as exposed to any page |
| `engine`, `count`, fixture digests, `scanMs`, `msPerAnnouncement`, matches, `verified` | The run |

## Submit

"Submit result" opens a prefilled [Device bench result](../.github/ISSUE_TEMPLATE/phone-bench.yml) issue. A [workflow](../.github/workflows/phone-bench.yml) validates it (schema, pinned fixture digests, oracle, plausible ranges) and opens a pull request adding it to `data/phone-bench/`, or comments with the reasons. A maintainer merges. The handle is recorded only when the submitter ticks the credit box. Fabricated timings that pass these checks cannot be detected.

Maintainer settings, all set: Pages source "GitHub Actions" and the variable `PHONE_BENCH_PAGES=true` publish the page from `main` ([workflow](../.github/workflows/phone-bench-pages.yml)); "Allow GitHub Actions to create and approve pull requests" lets the result workflow open its pull request. Pull requests opened by the workflow do not trigger CI until a maintainer reruns it.

## Run locally

```sh
bun run phone-bench:build                                   # work/phone-bench/index.html
bun run phone-bench:serve --host "$(tailscale ip -4)"       # http://<tailscale-ip>:8790/, tailnet only
bun run phone-bench:serve &                                 # 127.0.0.1:8790, for tailscale serve
tailscale serve --bg --https=8443 http://127.0.0.1:8790     # https://<host>.<tailnet>.ts.net:8443/
tailscale serve --https=8443 off; pkill -f src/phone-bench/serve.ts
bun run phone-bench:record result.json                      # validate and record a result by hand
BUN_JSC_useJIT=0 bun run phone-bench:cli --count 1000       # JavaScriptCore without JIT, a proxy only
podman run --rm --network host -v "$PWD/src/phone-bench:/work:ro" mcr.microsoft.com/playwright:v1.57.0-noble \
  sh -c 'cd /tmp && npm i -s playwright@1.57.0 && cp /work/webkit-check.mjs . && node webkit-check.mjs http://127.0.0.1:8790/ webkit'   # or chromium
```
