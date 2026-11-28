#!/usr/bin/env bash
# Scan-engine host runner. See METHODS.md#scan-engines.
# usage: scripts/scan-engines.sh bazzite|turing|smoke
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
cd "$ROOT"

PLAN="${1:-}"
case "$PLAN" in
  bazzite) CPUS="${CPUS:-0,2,4,6}"; SIZES=(100000 1000000) ;;
  turing) CPUS="${CPUS:-4-7}"; SIZES=(100000 1000000) ;;
  smoke) CPUS="${CPUS:-}"; SIZES=(256) ;;
  *) printf 'usage: %s bazzite|turing|smoke\n' "$0" >&2; exit 2 ;;
esac

if [[ -z "${BUN:-}" ]]; then
  BUN="$(command -v bun || ls "$ROOT"/.runtime/*/bun 2>/dev/null | head -1)"
fi
[[ -x "$BUN" ]] || { printf 'bun not found; set BUN=/path/to/bun\n' >&2; exit 1; }
export PATH="$(dirname "$BUN"):$PATH"

readonly LABEL="${HOST_LABEL:-$PLAN}"
readonly OUT="$ROOT/results/scan-engines/${LABEL}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
exec > >(tee -a "$OUT/run.log") 2>&1

pin() { if [[ -n "$CPUS" ]]; then taskset -c "$CPUS" "$@"; else "$@"; fi; }
bench() {
  local name="$1"; shift
  printf '\n=== %s (%s) ===\n' "$name" "$(date -Is)"
  if [[ "$PLAN" == smoke ]]; then
    pin bun run bench --match-every 16 --output "$OUT/$name" "$@"
  else
    pin bun run bench --reuse-fixtures "${REUSE_FIXTURES:-$ROOT/work/fixtures}" --output "$OUT/$name" "$@"
  fi
}

uname -a; nproc; free -m; uptime
bun --version
bun install --frozen-lockfile
bun run check
bun test

small="${SIZES[0]}"
bench control-before --sizes "$small" --cases zero --engines crypto --modes full --repetitions 1
bench sdk-crypto-noble --sizes "$small" --engines sdk,crypto,noble --modes full --repetitions 1
bench fast-small --sizes "$small" --engines wasm,native --modes full --threads 1,2,4 --repetitions 3
if [[ ${#SIZES[@]} -gt 1 ]]; then
  bench fast-large --sizes "${SIZES[1]}" --engines wasm,native --modes full --threads 1,2,4 --repetitions 1
fi
bench control-after --sizes "$small" --cases zero --engines crypto --modes full --repetitions 1
uptime
printf '\nResults: %s\n' "$OUT"
