#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
W=${1:?usage: probe-mem64.sh <wasmtime>}
result=$(timeout 20 "$W" run -C cache=n -W memory64,component-model-memory64 \
  --invoke 'f("threads")' "$here/mem64-probe.wat" 2>/dev/null) || exit 1
[ "$result" = 7 ] || exit 1
printf '1\n'
