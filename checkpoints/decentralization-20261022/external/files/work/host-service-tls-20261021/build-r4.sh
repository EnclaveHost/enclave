#!/usr/bin/env bash
# 1) recipe proof: rebuild final-r3 from its own tree (writes only a temp dir), must reproduce the recorded archives
# 2) compose4 packages (scripts/build-host-service-packages.mjs) + --check
# 3) the new hs2 stage from compose4 with the SAME builder, app-static capture and supervisor exe, into stage-r4/
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/host-service-tls-20261021; A=$W/hosted-services-activation
cd "$A" && node build-stage-r2.mjs --tree tree-final --app-static capture/app-static.json --out final-r3 --check; echo "r3-reproduce rc=$?"
cd "$H/compose4" && node scripts/build-host-service-packages.mjs > "$H/logs/r4-packages.out" 2>&1; echo "packages rc=$?"
node scripts/build-host-service-packages.mjs --check > "$H/logs/r4-packages-check.out" 2>&1; echo "packages-check rc=$?"
cd "$A" && node build-stage-r2.mjs --tree "$H/compose4" --app-static capture/app-static.json --out "$H/stage-r4" > "$H/logs/r4-stage.out" 2>&1; echo "stage rc=$?"
