#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
WASM_V1_REL="target/wasm32v1-none/release/smoke_contract.wasm"
WASM_LEGACY_REL="target/wasm32-unknown-unknown/release/smoke_contract.wasm"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  build                       Build the contract Wasm
  optimize                    Optimize the built Wasm
  deploy [--network N] [--account A] [--skip-build]
                              Deploy optimized Wasm and print contract id

Options:
  --network N                 testnet | mainnet (default: testnet or STELLAR_NETWORK)
  --account A                 stellar keys alias to sign deploy (default: default or STELLAR_ACCOUNT)
  --skip-build                Skip build/optimize before deploy
  -h, --help                  Show this help

Environment:
  STELLAR_NETWORK             Default network if --network not provided
  STELLAR_ACCOUNT             Default account alias if --account not provided
EOF
}

cmd=${1:-}
shift || true

NETWORK="${STELLAR_NETWORK:-testnet}"
ACCOUNT="${STELLAR_ACCOUNT:-default}"
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="$2"; shift 2 ;;
    --network=*)
      NETWORK="${1#*=}"; shift ;;
    --account)
      ACCOUNT="$2"; shift 2 ;;
    --account=*)
      ACCOUNT="${1#*=}"; shift ;;
    --skip-build)
      SKIP_BUILD=true; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

resolve_wasm_rel() {
  if [ -f "$PROJECT_DIR/$WASM_V1_REL" ]; then
    echo "$WASM_V1_REL"
  elif [ -f "$PROJECT_DIR/$WASM_LEGACY_REL" ]; then
    echo "$WASM_LEGACY_REL"
  else
    echo "$WASM_V1_REL"
  fi
}

resolve_wasm_opt_rel() {
  local wasm_rel="$1"
  echo "${wasm_rel%.wasm}.optimized.wasm"
}

build() {
  (cd "$PROJECT_DIR" && stellar contract build)
}

optimize() {
  if [ "$SKIP_BUILD" != true ]; then
    build
  fi
  local wasm_rel
  wasm_rel=$(resolve_wasm_rel)
  if [ ! -f "$PROJECT_DIR/$wasm_rel" ]; then
    echo "Build artifact not found at $wasm_rel. Run build first." >&2
    exit 1
  fi
  local wasm_opt_rel
  wasm_opt_rel=$(resolve_wasm_opt_rel "$wasm_rel")
  (cd "$PROJECT_DIR" && stellar contract optimize --wasm "$wasm_rel" --wasm-out "$wasm_opt_rel")
}

deploy() {
  optimize
  local wasm_rel
  wasm_rel=$(resolve_wasm_rel)
  local wasm_opt_rel
  wasm_opt_rel=$(resolve_wasm_opt_rel "$wasm_rel")
  if [ ! -f "$PROJECT_DIR/$wasm_opt_rel" ]; then
    echo "Optimized Wasm not found at $wasm_opt_rel." >&2
    exit 1
  fi
  local out
  out=$(cd "$PROJECT_DIR" && stellar contract deploy --wasm "$wasm_opt_rel" --network "$NETWORK" --source "$ACCOUNT")
  # Extract first contract id from output and print only it
  local id
  id=$(printf "%s" "$out" | grep -Eo 'C[A-Z0-9]{55}' | head -n1 || true)
  if [[ -z "$id" ]]; then
    echo "Failed to parse contract id from deploy output:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "$id"
}

case "$cmd" in
  build) build ;;
  optimize) optimize ;;
  deploy) deploy ;;
  *) usage; exit 1 ;;
esac
