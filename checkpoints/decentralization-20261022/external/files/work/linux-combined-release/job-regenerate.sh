#!/usr/bin/env bash
# (immutable; v1) Regenerate in MAIN exactly the three generated outputs this composition made stale (attribute-v1):
# windows/node/lease-gas-runtime.bundle.mjs(+manifest), metal/guest/lease-gas-conduit.bundle.mjs(+manifest),
# metal/guest/platform-api.bundle.mjs(+manifest) - with the established builders. Compare-and-swap: refuses unless all six
# still have the BEFORE hashes check-generated-v1 recorded. Whole-tree hashes before/after (no node_modules/.git) prove
# nothing else changed by this job (a concurrent writer elsewhere would show up and is reported, not undone).
set -euo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; here="$(cd "$(dirname "$0")" && pwd)"
cd "$M"
treehash() { find . \( -name node_modules -o -name .git \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
cat > "$here/expected-before.sha256" <<'H'
fbd95535bb4485e4568cd1012cbb0f4ba8e4d01010132774dda3a734fdf1b70b  windows/node/lease-gas-runtime.bundle.mjs
64a8f4e9ca995bd6f2ba7211616aead5ec24b2f59e40020bc3024f6fd37503f9  windows/node/lease-gas-runtime.bundle.mjs.manifest.json
e6c2c67412801fc9f5f706f98bf9ae17d5767453def817f72e36ec68fdfb4d62  metal/guest/lease-gas-conduit.bundle.mjs
f56c4db9af41787d1513d1c0eb7f6f8f65a7e149f70b208832f73ee3cc2c1706  metal/guest/lease-gas-conduit.bundle.mjs.manifest.json
2dbdde0ef3c6210f4524eeefb9de586c3b9e80c520cd3d7ef7fe839d239c879e  metal/guest/platform-api.bundle.mjs
8ce7c9a5a10534408ab3958c1f0b618c530df1edf4abe047f34826f13bc79615  metal/guest/platform-api.bundle.mjs.manifest.json
H
sha256sum -c --quiet "$here/expected-before.sha256" || { echo "CAS-REFUSED: a target changed since the check; nothing written"; exit 2; }
treehash > "$here/main-before.tree.sha256"
node scripts/build-windows-lease-runtime.mjs
node scripts/build-metal-lease-gas.mjs
node scripts/build-platform-api-guest-bundle.mjs
for s in build-windows-lease-runtime build-metal-lease-gas build-platform-api-guest-bundle; do node "scripts/$s.mjs" --check; done
treehash > "$here/main-after.tree.sha256"
diff "$here/main-before.tree.sha256" "$here/main-after.tree.sha256" | grep -E '^[<>]' | awk '{print $1, $3}' | sort -u -k2 > "$here/main-tree-delta.txt" || true
cat "$here/main-tree-delta.txt"
changed=$(awk '{print $2}' "$here/main-tree-delta.txt" | sort -u)
expected="./metal/guest/lease-gas-conduit.bundle.mjs
./metal/guest/lease-gas-conduit.bundle.mjs.manifest.json
./metal/guest/platform-api.bundle.mjs
./metal/guest/platform-api.bundle.mjs.manifest.json
./windows/node/lease-gas-runtime.bundle.mjs
./windows/node/lease-gas-runtime.bundle.mjs.manifest.json"
extra=$(comm -23 <(echo "$changed") <(echo "$expected" | sort))
[ -z "$extra" ] && echo "MAIN-DELTA-EXACT (only the six designated outputs)" || { echo "OTHER PATHS CHANGED DURING THE JOB (concurrent, not by these builders?):"; echo "$extra"; }
sha256sum windows/node/lease-gas-runtime.bundle.mjs windows/node/lease-gas-runtime.bundle.mjs.manifest.json metal/guest/lease-gas-conduit.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs.manifest.json metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json | tee "$here/generated-after.sha256"
echo REGENERATE-OK
