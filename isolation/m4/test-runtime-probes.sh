#!/bin/sh
# Negative controls must never advertise support; the positive executable is
# an explicitly supplied, built runtime. No production process is touched.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
W=${1:?usage: test-runtime-probes.sh <patched-wasmtime>}
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
printf '#!/bin/sh\nprintf "wasmtime supports all features\\n"\n' > "$t/liar"
chmod +x "$t/liar"
for feature in set mem64; do
 if "$here/probe-$feature.sh" "$t/liar"; then echo "FAIL: help-only runtime accepted" >&2; exit 1; fi
 if "$here/probe-$feature.sh" "$t/missing"; then echo "FAIL: missing runtime accepted" >&2; exit 1; fi
 [ "$("$here/probe-$feature.sh" "$W")" = 1 ]
 echo "PASS: $feature executes, bogus and missing runtimes refused"
done
