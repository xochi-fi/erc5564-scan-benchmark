#!/usr/bin/env bash
# See METHODS.md for plans and environment options.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT
cd "$ROOT"

PLAN="${1:-}"
case "$PLAN" in
  bazzite | turing | smoke | repeat-bazzite | repeat-bazzite-light | repeat-turing | repeat-smoke) ;;
  *)
    printf 'usage: %s bazzite|turing|smoke|repeat-bazzite|repeat-bazzite-light|repeat-turing|repeat-smoke\n' "$0" >&2
    exit 2
    ;;
esac

find_bun() {
  if [[ -n "${BUN:-}" ]]; then
    printf '%s\n' "$BUN"
  elif command -v bun >/dev/null 2>&1; then
    command -v bun
  else
    local candidate
    for candidate in "$ROOT"/.runtime/*/bun "$HOME/.bun/bin/bun"; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    printf 'bun not found; set BUN=/path/to/bun\n' >&2
    return 1
  fi
}

BUN_BIN="$(find_bun)"
BUN_DIR="$(dirname "$BUN_BIN")"
export PATH="$BUN_DIR:$PATH"
readonly LABEL="${HOST_LABEL:-$(hostname -s)}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly STAMP
readonly RESULTS="$ROOT/results/paged-discovery/${LABEL}-${PLAN}-${STAMP}"
readonly FIXTURES="$ROOT/work/fixtures"
mkdir -p "$RESULTS" "$FIXTURES"
readonly LOG="$RESULTS/run.log"
exec > >(tee -a "$LOG") 2>&1

section() {
  printf '\n=== %s (%s) ===\n' "$1" "$(date -Is)"
}

host_state() {
  local file="$1"
  {
    printf 'date: %s\nhostname: %s\n' "$(date -Is)" "$(hostname)"
    uname -a
    uptime
    if [[ -r /proc/meminfo ]]; then
      free -b || true
      swapon --show || true
      grep -E '^(pswpin|pswpout) ' /proc/vmstat || true
      cat /proc/pressure/memory 2>/dev/null || true
      lscpu || true
      local zone
      for zone in /sys/class/thermal/thermal_zone*; do
        [[ -r "$zone/temp" ]] || continue
        printf 'thermal %s %s %s\n' "$(basename "$zone")" "$(cat "$zone/type" 2>/dev/null || printf '?')" "$(cat "$zone/temp")"
      done
      sensors 2>/dev/null || true
      grep -H . /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor 2>/dev/null | head -32 || true
      grep -H . /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null | head -32 || true
    else
      sysctl -n machdep.cpu.brand_string hw.memsize vm.swapusage vm.loadavg 2>/dev/null || true
    fi
    ps -eo pid,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | head -15 || true
  } > "$file" 2>&1
}

# Gate on active swapping, available memory and PSI.
host_gate() {
  local file="$RESULTS/HOST-GATE.txt"
  if [[ ! -r /proc/meminfo ]]; then
    printf 'host gate: skipped (no /proc/meminfo)\n' | tee "$file"
    return 0
  fi
  local min_avail_gib="${GATE_MIN_AVAILABLE_GIB:-8}" max_swap="${GATE_MAX_SWAP_PAGES_PER_S:-100}" max_psi="${GATE_MAX_PSI_AVG60:-1.0}"
  local avail_kib swap_rate psi_avg60 swap_used_kib load
  avail_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  swap_used_kib="$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print t-f}' /proc/meminfo)"
  local pages_before pages_after
  pages_before="$(awk '/^pswp(in|out) / {s+=$2} END {print s}' /proc/vmstat)"
  sleep 10
  pages_after="$(awk '/^pswp(in|out) / {s+=$2} END {print s}' /proc/vmstat)"
  swap_rate="$(awk -v a="$pages_before" -v b="$pages_after" 'BEGIN {printf "%.1f", (b-a)/10}')"
  psi_avg60="$(awk '/^some/ {for (i=1;i<=NF;i++) if ($i ~ /^avg60=/) {sub("avg60=","",$i); print $i}}' /proc/pressure/memory 2>/dev/null || printf 'na')"
  load="$(cut -d' ' -f1-3 /proc/loadavg)"
  local reasons=()
  awk -v a="$avail_kib" -v m="$min_avail_gib" 'BEGIN {exit !(a < m*1024*1024)}' && reasons+=("MemAvailable $((avail_kib / 1024)) MiB < ${min_avail_gib} GiB")
  awk -v r="$swap_rate" -v m="$max_swap" 'BEGIN {exit !(r > m)}' && reasons+=("swap in+out ${swap_rate} pages/s > ${max_swap} over 10 s")
  if [[ "$psi_avg60" != "na" ]]; then
    awk -v p="$psi_avg60" -v m="$max_psi" 'BEGIN {exit !(p > m)}' && reasons+=("memory PSI some avg60 ${psi_avg60} > ${max_psi}")
  fi
  {
    printf 'date: %s\nMemAvailable MiB: %s\nswap used MiB: %s\nswap in+out pages/s (10 s): %s\nmemory PSI some avg60: %s\nloadavg: %s\n' \
      "$(date -Is)" "$((avail_kib / 1024))" "$((swap_used_kib / 1024))" "$swap_rate" "$psi_avg60" "$load"
    printf 'limits: MemAvailable >= %s GiB, swap <= %s pages/s, PSI avg60 <= %s\n' "$min_avail_gib" "$max_swap" "$max_psi"
  } > "$file"
  if [[ ${#reasons[@]} -eq 0 ]]; then
    printf 'result: PASS\n' >> "$file"
    cat "$file"
    return 0
  fi
  printf 'result: FAIL\n' >> "$file"
  printf 'reason: %s\n' "${reasons[@]}" >> "$file"
  cat "$file"
  if [[ "${ALLOW_BUSY_HOST:-0}" == "1" ]]; then
    printf 'override: ALLOW_BUSY_HOST=1, running anyway; THESE RESULTS ARE TAINTED\n' >> "$file"
    printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    printf '!!! HOST GATE FAILED; ALLOW_BUSY_HOST=1 so running anyway.    !!!\n'
    printf '!!! Recorded in %s\n' "$file"
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n'
    return 0
  fi
  printf 'host gate failed; refusing to start. Free the host, or set ALLOW_BUSY_HOST=1 to run and record the override.\n' >&2
  exit 3
}

section "provenance"
printf 'plan=%s label=%s bun=%s (%s)\n' "$PLAN" "$LABEL" "$("$BUN_BIN" --version)" "$BUN_BIN"
if [[ "$("$BUN_BIN" --version)" != "1.4.4" ]]; then
  printf 'WARNING: bun is not 1.4.4; this is a different benchmark environment\n'
fi
sha256sum package.json bun.lock src/shared/*.ts src/scan-cost/*.ts src/paged-discovery/*.ts src/paged-discovery/*.sh test/*.ts scripts/*.sh scripts/matrix/*.json 2>/dev/null \
  || shasum -a 256 package.json bun.lock src/shared/*.ts src/scan-cost/*.ts src/paged-discovery/*.ts src/paged-discovery/*.sh test/*.ts scripts/*.sh scripts/matrix/*.json
host_state "$RESULTS/host-before.txt"
case "$PLAN" in
  repeat-bazzite*) GATE_DEFAULT=1 ;;
  *) GATE_DEFAULT=0 ;;
esac
if [[ "${HOST_GATE:-$GATE_DEFAULT}" == "1" ]]; then
  section "host gate"
  host_gate
fi

section "dependencies"
if [[ ! -d node_modules ]]; then
  if [[ -n "${REUSE_NODE_MODULES:-}" && -f "$REUSE_NODE_MODULES/bun.lock" ]] \
     && cmp -s "$REUSE_NODE_MODULES/bun.lock" bun.lock && [[ -d "$REUSE_NODE_MODULES/node_modules" ]]; then
    printf 'copying node_modules from %s (identical bun.lock)\n' "$REUSE_NODE_MODULES"
    cp -a "$REUSE_NODE_MODULES/node_modules" .
  else
    "$BUN_BIN" install --frozen-lockfile
  fi
fi

section "check and tests"
"$BUN_BIN" run check
"$BUN_BIN" test 2>&1 | tee "$RESULTS/bun-test.log"

prepare() {
  "$BUN_BIN" run src/paged-discovery/prepare-fixtures.ts --output "$FIXTURES" --fixtures "$1" \
    ${REUSE_FIXTURES:+--reuse "$REUSE_FIXTURES"} | tee -a "$RESULTS/fixtures.json"
}

sweep() {
  local name="$1"
  shift
  section "sweep $name"
  "$BUN_BIN" run src/paged-discovery/sweep.ts --output "$RESULTS/$name" \
    ${WALLET_CPUS:+--wallet-cpus "$WALLET_CPUS"} \
    ${CHAIN_CPUS:+--chain-cpus "$CHAIN_CPUS"} \
    ${CONTROL_CPUS:+--control-cpus "$CONTROL_CPUS"} \
    "$@"
}

case "$PLAN" in
  smoke)
    section "fixtures"
    prepare "10000-sparse"
    sweep smoke --fixtures "$FIXTURES/10000-sparse" --pages 4,64 --profiles none,public
    ;;
  bazzite)
    section "fixtures"
    prepare "100000-zero,10000-sparse,100000-sparse,1000000-sparse"
    sweep sweep \
      --fixtures "$FIXTURES/10000-sparse,$FIXTURES/100000-sparse,$FIXTURES/1000000-sparse" \
      --pages 1,4,16,64,256 --size-pages 1000000=1:16:256 \
      --profiles none,lan,public --scenarios cold,catchup \
      --control-fixture "$FIXTURES/100000-zero"
    ;;
  turing)
    section "fixtures"
    prepare "100000-zero,10000-sparse,100000-sparse,1000000-zero"
    sweep sweep \
      --fixtures "$FIXTURES/10000-sparse,$FIXTURES/100000-sparse" \
      --pages 1,4,16,64,256 --profiles none,lan,public --scenarios cold,catchup \
      --control-fixture "$FIXTURES/100000-zero"
    # 1M on the Pi: one cold rescan (zero-match fixture, already on the node), bracketed by controls.
    sweep million --fixtures "$FIXTURES/1000000-zero" --pages 64 --profiles none --scenarios cold \
      --control-fixture "$FIXTURES/100000-zero"
    ;;
  repeat-*)
    case "$PLAN" in
      repeat-bazzite*) needed="100000-zero,100000-sparse,1000000-sparse" ;;
      repeat-turing) needed="100000-zero,100000-sparse,1000000-zero" ;;
      repeat-smoke) needed="100000-zero,10000-sparse" ;;
    esac
    section "fixtures"
    prepare "$needed"
    first_rep="${FIRST_REPETITION:-1}"
    cooldown=()
    if [[ -n "${COOLDOWN_C:-}" ]]; then
      cooldown=(--cooldown-c "$COOLDOWN_C")
    elif [[ "$PLAN" == "repeat-turing" ]]; then
      cooldown=(--cooldown-c 70)
    fi
    control=()
    [[ "$PLAN" == "repeat-smoke" ]] || control=(--control-fixture "$FIXTURES/100000-zero")
    sweep repeat --matrix "$ROOT/scripts/matrix/$PLAN.json" --fixtures-root "$FIXTURES" \
      --repetitions "${REPETITIONS:-3}" --first-repetition "$first_rep" \
      --order shuffled --seed "${SEED:-phase2-repeat-v1}-${LABEL}-r${first_rep}" \
      "${cooldown[@]}" "${control[@]}"
    ;;
esac

if [[ -n "${MAINNET_RPC:-}" ]]; then
  section "optional mainnet fetch-only probe"
  "$BUN_BIN" run src/paged-discovery/mainnet.ts --rpc "$MAINNET_RPC" --output "$RESULTS/mainnet" || printf 'mainnet probe failed (optional)\n'
fi

host_state "$RESULTS/host-after.txt"
section "package"
tar -C "$(dirname "$RESULTS")" -czf "$RESULTS.tar.gz" "$(basename "$RESULTS")"
printf 'results: %s\narchive: %s\n' "$RESULTS" "$RESULTS.tar.gz"
