#!/bin/bash
# G4 job 2: (a) CONTROL - the byte-copied G3 builder on the frozen G3 tree must reproduce the LIVE G3 stage (f54c2e0f);
# (b) the G4 stage from this tree. Local files only.
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021; G=$D/../host-service-tls-20261021/g3-final-package; A=$D/../hosted-services-activation
cd "$D/g4"; rm -rf control-g3 stage-g4
node build-stage-g3.copy.mjs --tree "$G/tree" --app-static "$A/capture/app-static.json" --out "$D/g4/control-g3" --with-service-tls > control-g3.out 2>&1; echo "control rc=$?"
node build-stage-g3.copy.mjs --tree "$D/tree" --app-static "$A/capture/app-static.json" --out "$D/g4/stage-g4" --with-service-tls > stage-g4.out 2>&1; echo "g4 rc=$?"
