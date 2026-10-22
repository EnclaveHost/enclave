#!/usr/bin/env bash
# ONE shared-queue admission (multiprocess lane): the portable migration tests on tree/ (a copy of CURRENT work/enclave)
# with only this patch's files overlaid. The gate is built twice from the tree (reproducible) into logs/ - isolated; no
# deployed artifact is rebuilt or touched.
#   run.sh LOG
set -u
W=$(cd "$(dirname "$0")" && pwd -P)
LOG=$(realpath -m -- "${1:?log}"); exec > "$LOG" 2>&1
cd "$W/tree"; fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
echo "tree = copy of work/enclave HEAD $(cat "$W/notes/main-head.txt") + working tree, taken $(cat "$W/notes/main-copied-at.txt"); node $(node --version); $(anvil --version 2>/dev/null | head -1)"
for f in windows/node/lease-gas-runtime.bundle.mjs client/lease-executor-client.mjs network/lease-gas-owner.mjs windows/node/chain.mjs windows/installer/install-lease-relay.ps1; do echo "input $(sha256sum "$f" | cut -c1-64)  $f"; done
(cd "$W/src" && find . -type f | sed 's|^\./||' | sort) | while read -r f; do mkdir -p "$(dirname "$f")"; cp -- "$W/src/$f" "$f"; echo "overlay $(sha256sum "$f" | cut -c1-64)  $f"; done
for f in network/lease-relay-migration-check.mjs scripts/build-lease-relay-migration-check.mjs windows/installer/lease-gas-config-check.mjs test/lease-relay-migration.test.mjs test/lease-relay-installer-migration.test.mjs; do run node --check "$f"; done
rm -rf "$W/logs/gate-a" "$W/logs/gate-b"
run node scripts/build-lease-relay-migration-check.mjs "$W/logs/gate-a"
run node scripts/build-lease-relay-migration-check.mjs "$W/logs/gate-b" --expect-sha256 "$(node -p 'require(process.argv[1]).artifact.sha256' "$W/logs/gate-a/lease-relay-migration-check.manifest.json")"
run diff -r "$W/logs/gate-a" "$W/logs/gate-b"
run node --test --test-concurrency=1 --test-timeout=600000 test/lease-relay-migration.test.mjs test/lease-relay-installer-migration.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
