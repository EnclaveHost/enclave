#!/usr/bin/env bash
# G3 final package, job 3: (a) CONTROL - the isolated builder copy on compose5 WITHOUT --with-service-tls must reproduce the
# r5 archives byte for byte; (b) the G3 stage from this tree WITH --with-service-tls. Local files only.
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package; H=$G/..; A=$G/../../hosted-services-activation
cd "$G"; date -u +%FT%TZ
rm -rf "$G/control-r5" "$G/stage-g3"
node build-stage-g3.mjs --tree "$H/compose5" --app-static "$A/capture/app-static.json" --out "$G/control-r5" > logs/control-r5.out 2>&1; echo "control rc=$?"
for t in enclave-host-services-hs2-windows enclave-host-services-hs2; do echo "control $t $(sha256sum control-r5/out/$t.tar | cut -c1-64) vs r5 $(sha256sum $H/stage-r5/out/$t.tar | cut -c1-64)"; done
node build-stage-g3.mjs --tree "$G/tree" --app-static "$A/capture/app-static.json" --out "$G/stage-g3" --with-service-tls > logs/stage-g3.out 2>&1; echo "g3 stage rc=$?"
sha256sum stage-g3/out/*.tar stage-g3/stage-r2/enclave-host-services-hs2-windows/STAGE-SHA256SUMS | cut -c1-16,65-
date -u +%FT%TZ
