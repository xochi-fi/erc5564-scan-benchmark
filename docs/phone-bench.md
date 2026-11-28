# Phone bench

How fast does a phone browser scan announcements?

No phone result is recorded yet. The page below measures it on the visitor's device.

`bun run phone-bench:build` writes one self-contained page, `work/phone-bench/index.html` (1.8 MB). It scans the first 1,000, 5,000 or 10,000 announcements of a pinned seeded fixture (`phone-bench:v1`, a match every 1,000) with the `crypto` or `sdk` engine, checks the matches against the fixture schedule, and prints a result JSON. Its Content-Security-Policy blocks every network request. It works over plain HTTP; without a clipboard it leaves the JSON selected for a manual copy.

## Run it

```sh
bun run phone-bench:build
bun run phone-bench:serve --host "$(tailscale ip -4)"     # http://<tailscale-ip>:8790/, tailnet only
bun run phone-bench:serve &                               # 127.0.0.1:8790 for tailscale serve
tailscale serve --bg --https=8443 http://127.0.0.1:8790   # https://<host>.<tailnet>.ts.net:8443/
tailscale serve --https=8443 off; pkill -f src/phone-bench/serve.ts   # stop
```

On the phone: fill in the device model, pick the JIT setting (iOS Lockdown Mode turns the JIT off), run, then send the result JSON.

## Record a result

```sh
bun run phone-bench:record result.json --source "name or handle"
```

It rejects a result that failed the oracle, ran another fixture or lacks a device model, and writes `data/phone-bench/<startedAt>-<device>-<engine>-<jit>.json`.

## Publish

The page is one static file with no server side. Once merged, it can be attached to a release or served from GitHub Pages; neither is set up here. Working-group members open it, run it, and send the JSON to a maintainer, who records it as above.
