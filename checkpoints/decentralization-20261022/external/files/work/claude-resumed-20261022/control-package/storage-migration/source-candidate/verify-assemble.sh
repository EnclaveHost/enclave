#!/bin/bash
# Local check of assemble-trees.sh: each assembled tree differs from its tested source in EXACTLY the 4 overlay files.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); W=$(cd "$here/../../../.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
"$here/assemble-trees.sh" "$t/out"
for pair in "fence-enclave:$W/indexd-replica-rollout/src" "c2-enclave:$W/indexd-c2-implementation/src"; do
  n=${pair%%:*}; s=${pair#*:}
  d=$( (diff -rq "$s" "$t/out/$n" || true) | sed "s#$s/##; s#$t/out/$n/##" | awk '{print $2}' | sort | tr '\n' ' ')
  echo "$n differs in: $d"
  [ "$d" = "build/meta.go cmd/indexd/run.go contracts/form.go contracts/funding.go " ] || { echo "UNEXPECTED DIFF"; exit 1; }
done
"$here/assemble-trees.sh" "$t/out" >/dev/null 2>&1 && { echo "did not refuse an existing out dir"; exit 1; } || echo "refuses an existing out dir"
echo VERIFY-ASSEMBLE OK
