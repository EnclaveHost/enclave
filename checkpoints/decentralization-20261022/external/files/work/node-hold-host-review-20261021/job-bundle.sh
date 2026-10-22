#!/usr/bin/env bash
# Composition evidence: is revision2's host-admission bundle current with host-admission-runtime cb42269d? (MY copy only)
set -uo pipefail
T=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021/tree; cd "$T"; date -u +%FT%TZ
B=windows/node/host-admission.bundle.mjs; M=metal/guest/host-policy.bundle.mjs
echo "before: $(sha256sum $B | cut -c1-16) decision=$(grep -c 'async decision(' $B) metal $(sha256sum $M | cut -c1-16)"
node scripts/build-host-admission.mjs --check > /tmp/bha-check.out 2>&1; echo "--check rc=$? ($(tail -c 160 /tmp/bha-check.out | tr '\n' ' '))"
node scripts/build-host-admission.mjs > /tmp/bha-build.out 2>&1; echo "build rc=$?"
echo "after:  $(sha256sum $B | cut -c1-16) decision=$(grep -c 'async decision(' $B) metal $(sha256sum $M | cut -c1-16)"
node scripts/build-host-admission.mjs --check > /dev/null 2>&1; echo "--check after build rc=$?"
node -e "import('./$B').then(m=>console.log('exports',Object.keys(m).sort().join(',')))"
