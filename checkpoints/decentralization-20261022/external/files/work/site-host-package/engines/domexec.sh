#!/usr/bin/env bash
# Per-app guest tier (Windows Hyper-V partition / m3 domexec, and m2 dominit): re-shape the wasm manager's serve call
# that test/e2e.mjs makes into the call domexec makes inside the guest:
#   serve -S cli [-W <features>] -C cache=n [--env ENCLAVE_CONFIG] --addr <addr> /app.wasm
# with the deployment config INHERITED as ENCLAVE_CONFIG (the monitor's /app.config). There is no /config preopen, no
# max-memory-size and no other env.
#   DOMEXEC_BIN       the guest's wasmtime
#   DOMEXEC_FEATURES  the -W list (empty = the deployed 2026-10-01 domexec, which passes none)
set -euo pipefail
BIN="${DOMEXEC_BIN:?}"
if [ "${1:-}" != "serve" ]; then exec "$BIN" "$@"; fi
shift
addr="" wasm="" cfgdir="" cfg=""; have_cfg=0
while [ $# -gt 0 ]; do
  case "$1" in
    --addr) addr="$2"; shift 2 ;;
    --dir) case "$2" in *::/config) cfgdir="${2%::/config}" ;; esac; shift 2 ;;
    --env) case "$2" in ENCLAVE_CONFIG=*) cfg="${2#ENCLAVE_CONFIG=}"; have_cfg=1 ;; esac; shift 2 ;;
    -W|-S|-C|-O) shift 2 ;;
    -S*|-W*|-C*|-O*) shift ;;
    *) wasm="$1"; shift ;;
  esac
done
if [ $have_cfg = 0 ] && [ -n "$cfgdir" ] && [ -s "$cfgdir/config.json" ]; then cfg="$(cat "$cfgdir/config.json")"; have_cfg=1; fi
args=(serve -S cli)
[ -n "${DOMEXEC_FEATURES:-}" ] && args+=(-W "$DOMEXEC_FEATURES")
args+=(-C cache=n)
if [ $have_cfg = 1 ]; then export ENCLAVE_CONFIG="$cfg"; args+=(--env ENCLAVE_CONFIG); else unset ENCLAVE_CONFIG; fi
exec env -u ENCLAVE_CONFIG_FILE "$BIN" "${args[@]}" --addr "$addr" "$wasm"
