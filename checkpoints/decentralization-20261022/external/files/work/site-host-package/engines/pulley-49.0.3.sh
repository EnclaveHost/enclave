#!/usr/bin/env bash
# An APPROXIMATION of the Android pVM tier (recorded there: wasmtime/49.0.0 execution=interpreter target=pulley64):
# local stock wasmtime 49.0.3 running the component through the Pulley interpreter on this x86 host.
if [ "${1:-}" = "serve" ]; then shift; exec wasmtime serve --target pulley64 "$@"; fi
exec wasmtime "$@"
