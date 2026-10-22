#!/bin/bash
# The patch set of the composed candidate (policy-tree) against main's working copy at the recorded base, plus the built
# packages and an inventory with every file's sha256. Read-only on main; writes only patches/.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-service-placement; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
cd "$H"; rm -rf patches; mkdir -p patches/packages
ROLES=(network/host-services/roles.mjs network/host-services/runner.mjs scripts/build-host-service-packages.mjs network/cold-bootstrap.mjs
       scripts/check-transport-profile.mjs test/hosted-service-placement.test.mjs test/transport-profile.test.mjs)
POLICY=(network/policy-carriers.mjs network/host-services/policy-mirror.mjs network/service-index.mjs test/hosted-policy-cold-start.test.mjs
        network/host-services/argv-guard.mjs network/host-services/entries/route-dns.mjs)
mk() { out=$1; shift; : > "$out"; for f in "$@"; do if [ -e "$M/$f" ]; then a="$M/$f"; else a=/dev/null; fi
  diff -u --label "a/$f" --label "b/$f" "$a" "policy-tree/$f" >> "$out" || [ $? -eq 1 ]; done; }
mk patches/01-host-service-roles-and-cold-bootstrap.patch "${ROLES[@]}"
mk patches/02-policy-mirror-and-carriers.patch "${POLICY[@]}"
cp policy-tree/network/host-services/packages/* patches/packages/
{ echo "base: main working copy at $(cat base/main-head.txt) (hashes: base/main-tree.sha256); composed candidate: policy-tree"
  echo "patch 01 (placement roles, runner, cold client, transport profile): ${ROLES[*]}"
  echo "patch 02 (policy mirror, carriers, policy kind, route-dns argv guard): ${POLICY[*]}"
  echo "(the runner, roles, cold client and placement test are new files: patch 01 carries their FINAL composed content)"
  echo; echo "sha256 of every delivered file:"
  (cd policy-tree && sha256sum "${ROLES[@]}" "${POLICY[@]}" network/host-services/packages/*)
  echo; echo "patch sha256:"; (cd patches && sha256sum *.patch)
  echo; echo "unchanged authority (byte-identical to main):"
  for f in network/platform-host-policy.mjs network/host-policy-runtime.mjs network/host-service-gate.mjs network/host-policy-mirrors.mjs network/host-policy-adapters.mjs network/platform-host-policy-config.mjs custody/v2/quorum.mjs; do
    cmp -s "$M/$f" "policy-tree/$f" && echo "  SAME $f" || { echo "  DIFFERS $f"; exit 1; }; done
} > patches/INVENTORY.txt
# the patches apply to a clean copy of main's files
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in "${ROLES[@]}" "${POLICY[@]}"; do [ -e "$M/$f" ] && { mkdir -p "$T/$(dirname "$f")"; cp "$M/$f" "$T/$f"; }; done
(cd "$T" && patch -p1 -s < "$H/patches/01-host-service-roles-and-cold-bootstrap.patch" && patch -p1 -s < "$H/patches/02-policy-mirror-and-carriers.patch")
for f in "${ROLES[@]}" "${POLICY[@]}"; do cmp -s "$T/$f" "policy-tree/$f" || { echo "patch result differs: $f"; exit 1; }; done
echo "patches apply cleanly and reproduce policy-tree"; cat patches/INVENTORY.txt | head -5
