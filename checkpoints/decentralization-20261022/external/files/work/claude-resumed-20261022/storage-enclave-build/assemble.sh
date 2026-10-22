#!/bin/bash
# storage-enclave-build A1 step 1: run the PINNED helper in place (source-candidate/assemble-trees.sh 5a5e7e12, its own path
# depth), writing only to $B/trees; then the verify-assemble.sh diff rule and full per-tree inventories.
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd); W=$(cd "$B/../.." && pwd)
SC=$W/claude-resumed-20261022/control-package/storage-migration/source-candidate
[ "$(sha256sum "$SC/assemble-trees.sh" | cut -d' ' -f1)" = 5a5e7e12cd3acf6ae955df1b941d5372a0546023239c62f7854ce0aef803ba52 ] || { echo "helper pin differs"; exit 1; }
(cd "$W/indexd-c2-implementation/src" && sha256sum -c --quiet ../SRC.sha256) && echo "c2 source matches SRC.sha256 95a50516"
(cd "$W/indexd-replica-rollout/src" && sha256sum -c --quiet "$W/indexd-c2-implementation/BASE-src.sha256") && echo "fence source matches BASE-src.sha256 7c5cf425"
"$SC/assemble-trees.sh" "$B/trees"
for pair in "fence-enclave:$W/indexd-replica-rollout/src" "c2-enclave:$W/indexd-c2-implementation/src"; do
  n=${pair%%:*}; s=${pair#*:}; t=$B/trees/$n
  [ -z "$(find "$t" -type l)" ] || { echo "$n contains symlinks"; exit 1; }
  d=$( (diff -rq "$s" "$t" || true) | sed "s#$s/##; s#$t/##" | awk '{print $2}' | sort | tr '\n' ' ')
  echo "$n differs from its tested source in: $d"
  [ "$d" = "build/meta.go cmd/indexd/run.go contracts/form.go contracts/funding.go " ] || { echo "UNEXPECTED DIFF"; exit 1; }
  (cd "$t" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$B/inventory/$n.sha256"
  echo "$n inventory: $(wc -l < "$B/inventory/$n.sha256") files, manifest $(sha256sum "$B/inventory/$n.sha256" | cut -c1-16)"
  echo "$n go.mod $(sha256sum "$t/go.mod" | cut -c1-16) go.sum $(sha256sum "$t/go.sum" | cut -c1-16)"
done
