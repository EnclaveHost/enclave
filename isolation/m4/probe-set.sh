#!/bin/sh
# Prove worker execution, atomic shared memory, and futex notification. A compile
# or --help check alone is insufficient. No native cache or precompiled input.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
W=${1:?usage: probe-set.sh <wasmtime>}
result=$(timeout 20 "$W" run -C cache=n \
  -W threads,shared-everything-threads,component-model-threading,shared-memory \
  --invoke 'run()' "$here/set-probe.wat" 2>/dev/null) || exit 1
[ "$result" = 7 ] || exit 1
printf '1\n'
