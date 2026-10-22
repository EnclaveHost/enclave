#!/usr/bin/env bash
# ONE queued job (1024 MiB). Rebuild ONLY metal/guest/platform-api.bundle.mjs (+manifest) from the integrated candidate tree
# f5dae7b1 (scratch copy + real node_modules; relay/build-network.mjs first), twice, --check, node --check. Expected bundle
# 2a903c36 (the reviewed, smoke-tested build); any other hash is reported as DRIFT, never adjusted.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; R=$W/resume-20261021; H=$R/platform-bundle-smoke; S=$H/tree
export GIT_OPTIONAL_LOCKS=0 TMPDIR=$H/tmp
date -u +%FT%TZ > "$H/integrated-build-started.utc"
rm -rf "$S" "$TMPDIR" "$H/integrated-out" "$H/integrated-out2"; mkdir -p "$TMPDIR"
cp -a "$R/reconciled-candidate" "$S"
for nm in node_modules relay/node_modules sdk/sessions/node_modules network/node_modules e2e/node_modules; do cp -a "$W/enclave/$nm" "$S/$nm"; done
cd "$S"
node relay/build-network.mjs > "$H/integrated-network-runtime.out"; cat "$H/integrated-network-runtime.out"
set +e; node scripts/build-platform-api-guest-bundle.mjs --check > "$H/integrated-before-check.out" 2>&1; echo "before (expected STALE): rc=$?"; set -e
node scripts/build-platform-api-guest-bundle.mjs --out "$H/integrated-out"
node scripts/build-platform-api-guest-bundle.mjs --out "$H/integrated-out2"
cmp "$H/integrated-out/platform-api.bundle.mjs" "$H/integrated-out2/platform-api.bundle.mjs"
cmp "$H/integrated-out/platform-api.bundle.mjs.manifest.json" "$H/integrated-out2/platform-api.bundle.mjs.manifest.json"; echo REPRODUCIBLE
cp "$H/integrated-out/"platform-api.bundle.mjs* metal/guest/
node scripts/build-platform-api-guest-bundle.mjs --check
node --check metal/guest/platform-api.bundle.mjs && echo SYNTAX-OK
GOT=$(sha256sum "$H/integrated-out/platform-api.bundle.mjs" | cut -c1-64); MGOT=$(sha256sum "$H/integrated-out/platform-api.bundle.mjs.manifest.json" | cut -c1-64)
echo "bundle $GOT (expected 2a903c362eecbde7e7bd75da75ed98c0eee93086b180cb8722aefb2b2588c578)"
echo "manifest $MGOT (expected 39fd6865cb4e1c48347ba3153d725a5a109a312f4337f1829a9283c73deb7c8c)"
cmp "$H/integrated-out/platform-api.bundle.mjs" "$H/fix/out/platform-api.bundle.mjs" && echo "BUNDLE == the reviewed smoke-tested build" || echo "DRIFT: bundle differs from the reviewed build"
cmp "$H/integrated-out/platform-api.bundle.mjs.manifest.json" "$H/fix/out/platform-api.bundle.mjs.manifest.json" && echo "MANIFEST == reviewed" || { echo "DRIFT: manifest differs:"; diff <(python3 -m json.tool "$H/fix/out/platform-api.bundle.mjs.manifest.json") <(python3 -m json.tool "$H/integrated-out/platform-api.bundle.mjs.manifest.json") | head -20; }
cp relay/network-runtime.bundle.mjs "$H/integrated-out/network-runtime.bundle.mjs.prereq"
cd "$H"; rm -rf "$S" "$H/integrated-out2"
date -u +%FT%TZ > "$H/integrated-build-finished.utc"
echo INTEGRATED-BUILD-DONE
