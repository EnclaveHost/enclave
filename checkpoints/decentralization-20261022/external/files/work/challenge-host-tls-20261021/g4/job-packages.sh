#!/bin/bash
# G4 job 1: regenerate the host-service packages in THIS tree with the existing builder, then --check; compare to G3
D=/home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021; G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package/tree
cd "$D/tree" && node scripts/build-host-service-packages.mjs > "$D/g4/packages-build.out" 2>&1; echo "build exit=$?" >> "$D/g4/packages-build.out"
node scripts/build-host-service-packages.mjs --check >> "$D/g4/packages-build.out" 2>&1; echo "check exit=$?" >> "$D/g4/packages-build.out"
for f in network/host-services/packages/*; do a=$(sha256sum "$G/$f" 2>/dev/null | cut -c1-64); b=$(sha256sum "$f" | cut -c1-64); [ "$a" = "$b" ] && echo "same    $f" || echo "CHANGED $f ${a:0:8} -> ${b:0:8}"; done >> "$D/g4/packages-build.out"
