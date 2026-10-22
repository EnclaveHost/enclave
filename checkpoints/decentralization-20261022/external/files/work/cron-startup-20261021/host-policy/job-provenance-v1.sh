#!/usr/bin/env bash
# ONE queued job (512 MiB). Provenance of the DEPLOYED host-admission bundle 7ce23a55: main's sources with ONLY
# PRODUCTION_MIRRORS = [] must rebuild it byte-for-byte; then the same + fix3 (lease-reader + host-admission-runtime) is the
# candidate artifact. Scratch tree; main is not edited. Only scripts/build-host-admission.mjs runs (no tests here).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/cron-startup-20261021/host-policy; S=$H/build4/tree
export TMPDIR=$H/tmp; rm -rf "$H/build4" "$TMPDIR"; mkdir -p "$TMPDIR" "$H/build4/out"
date -u +%FT%TZ > "$H/provenance-started.utc"
rsync -a --exclude .git --exclude node_modules "$W/enclave/" "$S/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules; do [ -d "$W/enclave/$nm" ] && ln -s "$W/enclave/$nm" "$S/$nm"; done
cd "$S"
cp "$H/fix4/mirrors-empty.platform-host-policy-config.mjs" network/platform-host-policy-config.mjs
node scripts/build-host-admission.mjs
cp windows/node/host-admission.bundle.mjs "$H/build4/out/mirrors-empty.bundle.mjs"; cp metal/guest/host-policy.bundle.mjs "$H/build4/out/mirrors-empty.host-policy.bundle.mjs"
cp "$H/fix3/b/network/lease-reader.mjs" network/lease-reader.mjs; cp "$H/fix3/b/network/host-admission-runtime.mjs" network/host-admission-runtime.mjs
node scripts/build-host-admission.mjs
cp windows/node/host-admission.bundle.mjs "$H/build4/out/final.bundle.mjs"; cp metal/guest/host-policy.bundle.mjs "$H/build4/out/final.host-policy.bundle.mjs"
node scripts/build-host-admission.mjs; cmp windows/node/host-admission.bundle.mjs "$H/build4/out/final.bundle.mjs" && echo REPRODUCIBLE
node --check "$H/build4/out/final.bundle.mjs" && echo SYNTAX-OK
sha256sum "$H/build4/out/"* "$W/android-feature-completion/pristine/windows/node/host-admission.bundle.mjs" "$W/android-feature-completion/pristine/metal/guest/host-policy.bundle.mjs" 2>/dev/null
cmp -s "$H/build4/out/mirrors-empty.bundle.mjs" "$W/android-feature-completion/pristine/windows/node/host-admission.bundle.mjs" && echo "PROVENANCE: main + mirrors[] == DEPLOYED 7ce23a55 byte-for-byte" || echo "PROVENANCE MISMATCH"
for f in mirrors-empty.bundle.mjs final.bundle.mjs final.host-policy.bundle.mjs; do echo "$f DO platform-policy URLs: $(grep -c '/platform-policy' "$H/build4/out/$f")"; done
rm -rf "$S"; date -u +%FT%TZ > "$H/provenance-finished.utc"
