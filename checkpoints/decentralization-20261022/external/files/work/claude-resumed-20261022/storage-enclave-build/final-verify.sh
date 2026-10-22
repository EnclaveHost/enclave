#!/bin/bash
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd); W=$(cd "$B/../.." && pwd); SC=$W/claude-resumed-20261022/control-package/storage-migration/source-candidate
(cd "$W/indexd-c2-implementation/src" && sha256sum -c --quiet ../SRC.sha256) && echo "c2 tested source unchanged (SRC.sha256 95a50516)"
(cd "$W/indexd-replica-rollout/src" && sha256sum -c --quiet "$W/indexd-c2-implementation/BASE-src.sha256") && echo "fence tested source unchanged (BASE-src.sha256 7c5cf425)"
(cd "$SC" && sha256sum -c --quiet SOURCE-PINS.sha256) && echo "source-candidate SOURCE-PINS unchanged"
echo "helpers: $(sha256sum "$SC/assemble-trees.sh" "$SC/verify-assemble.sh" "$W/indexd-c2-implementation/package/release/build.sh" | cut -c1-16 | tr '\n' ' ')"
sha256sum "$W/indexd-replica-rollout/release/indexd-v0.6.0-fence.1-linux-amd64" "$W/indexd-c2-implementation/package/release/indexd-v0.6.0-fence.2-c2-linux-amd64"
for n in fence-enclave c2-enclave; do (cd "$B/trees/$n" && sha256sum -c --quiet "$B/inventory/$n.sha256") && echo "$n assembled tree unchanged ($(wc -l < "$B/inventory/$n.sha256") files)"; done
(cd "$B/out" && sha256sum */indexd)
ls -d "$B"/gocache/* "$B"/control/* "$B"/.precheck-cache.* 2>/dev/null && echo "LEFTOVER" || echo "no leftover caches/control copies"
