#!/bin/bash
# Main-relative patch of this work's hs2 changes (APP_STATIC parity, Windows supervision, Windows runner env, refreshable
# stage tool). Reproduces tree-r3 (= final main at base/main-tree-r3.at + this patch). Read-only on main.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
cd "$H"; rm -rf patches-r2; mkdir patches-r2
WS=network/host-services/windows-supervisor
FILES=(network/host-services/roles.mjs network/host-services/runner.mjs network/host-services/stage-tool.mjs test/hosted-services-stage.test.mjs
       test/hosted-services-appstatic.test.mjs $WS/go.mod $WS/go.sum $WS/supervise.go $WS/main.go $WS/launcher_other.go $WS/job_windows.go $WS/supervise_test.go
       $WS/supervisor.template.json)
P=patches-r2/02-appstatic-windows-refresh.patch; : > $P
for f in "${FILES[@]}"; do a=/dev/null; [ -e "$M/$f" ] && a="$M/$f"
  diff -u --label "a/$f" --label "b/$f" "$a" "tree-r3/$f" >> $P || [ $? -eq 1 ]; done
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in "${FILES[@]}"; do [ -e "$M/$f" ] && { mkdir -p "$T/$(dirname "$f")"; cp "$M/$f" "$T/$f"; }; done
(cd "$T" && patch -p1 -s < "$H/$P")
for f in "${FILES[@]}"; do cmp -s "$T/$f" "tree-r3/$f" || { echo "patch result differs: $f"; exit 1; }; done
(cd tree-r3 && for f in "${FILES[@]}"; do echo "$(sha256sum < "$f" | cut -d' ' -f1) $f"; done) > patches-r2/FILES.sha256.src
sha256sum $P > patches-r2/PATCH.sha256
echo "patch applies to current main and reproduces tree-r3: ${#FILES[@]} files"; cat patches-r2/PATCH.sha256
