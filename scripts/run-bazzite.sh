#!/usr/bin/env bash
# Bazzite (i7-13700K) entry point with the CPU pinning used for the recorded results.
#
# Optional reuse of an existing checkout (each fixture is SHA256-checked before use):
#   REUSE_NODE_MODULES=<dir with node_modules and an identical bun.lock>
#   REUSE_FIXTURES=<comma-separated fixture directories>
# Without them, dependencies are installed from bun.lock and fixtures are regenerated.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
export HOST_LABEL="${HOST_LABEL:-bazzite}"
# Same P-core threads as the phase-1 Bazzite controls; chain/link on two other P-cores.
export WALLET_CPUS="${WALLET_CPUS:-0,2,4,6}"
export CONTROL_CPUS="${CONTROL_CPUS:-0,2,4,6}"
export CHAIN_CPUS="${CHAIN_CPUS:-8,10}"
if [[ -z "${BUN:-}" ]] && ! command -v bun >/dev/null 2>&1 && [[ -x "$HOME/.bun/bin/bun" ]]; then
  export BUN="$HOME/.bun/bin/bun"
fi
exec "$ROOT/scripts/phase2-run.sh" "${1:-repeat-bazzite}"
