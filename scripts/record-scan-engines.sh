#!/usr/bin/env bash
# Copy a scan-engines run into data/scan-cost/engines/<label>/ without fixture bodies.
# usage: scripts/record-scan-engines.sh results/scan-engines/<run> <label>
set -euo pipefail
src="$1"; label="$2"
dest="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/scan-cost/engines/$label"
rm -rf "$dest"; mkdir -p "$dest"
cp "$src/run.log" "$dest/"
for run in "$src"/*/; do
  name="$(basename "$run")"
  mkdir -p "$dest/$name"
  cp "$run"/run.json "$run"/samples.jsonl "$run"/summary.json "$dest/$name/"
  for fixture in "$run"/fixtures/*/; do
    mkdir -p "$dest/$name/fixtures/$(basename "$fixture")"
    cp "$fixture/manifest.json" "$dest/$name/fixtures/$(basename "$fixture")/"
  done
  cp "$run"/fixtures/*.source.txt "$dest/$name/fixtures/" 2>/dev/null || true
done
# Home directories become ~, as in the other recorded runs.
grep -rlE '/(var/)?home/[^/"]+' "$dest" | xargs -r sed -i -E 's#/(var/)?home/[^/" ]+#~#g'
