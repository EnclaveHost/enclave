#!/usr/bin/env bash
# The node's host-admission bundle with decision() (root's host-admission-runtime cb42269d), built by the existing
# recipe (scripts/build-host-admission.mjs) on an isolated copy. Step 1 must rebuild the LIVE bundle 66c6e15a byte for
# byte from its pinned sources (provenance); step 2 swaps ONLY host-admission-runtime.mjs. No canonical edit.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; R=$W/node-cold-policy-20261021/revision2; B=$W/node-hold-host-review-20261021/bundle-build; S=$W/cron-startup-20261021/release-source
T=$B/tree; O=$B/out; export TMPDIR=$B/tmp; rm -rf "$T" "$O" "$TMPDIR"; mkdir -p "$TMPDIR" "$O"
LIVE=66c6e15a
for base in "$W/enclave" "$W/host-service-transport-20261021/tree"; do
  rm -rf "$T"; rsync -a --exclude .git --exclude node_modules "$base/" "$T/"
  for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules windows/node/node_modules; do [ -e "$base/$nm" ] && ln -sfn "$(readlink -f "$base/$nm")" "$T/$nm"; done
  cp $S/source/network/host-admission-runtime.mjs $S/source/network/lease-reader.mjs $S/source/network/platform-host-policy-config.mjs "$T/network/"
  (cd "$T" && node scripts/build-host-admission.mjs >/dev/null)
  h=$(sha256sum "$T/windows/node/host-admission.bundle.mjs" | cut -c1-8); echo "base $(basename $(dirname $base))/$(basename $base): rebuilt live sources -> $h"
  if [ "$h" = "$LIVE" ] && cmp -s "$T/windows/node/host-admission.bundle.mjs" $S/deployed/windows/node/host-admission.bundle.mjs; then echo "PROVENANCE OK (== live $LIVE)"; ok=1; break; fi
done
[ "${ok:-}" = 1 ] || { echo "PROVENANCE MISMATCH"; exit 1; }
cp "$T/windows/node/host-admission.bundle.mjs" "$O/live-rebuilt.bundle.mjs"; cp "$T/metal/guest/host-policy.bundle.mjs" "$O/live-rebuilt.metal-host-policy.bundle.mjs"
cp "$R/tree/network/host-admission-runtime.mjs" "$T/network/"
(cd "$T" && node scripts/build-host-admission.mjs >/dev/null)
cp "$T/windows/node/host-admission.bundle.mjs" "$O/candidate.host-admission.bundle.mjs"; cp "$T/metal/guest/host-policy.bundle.mjs" "$O/candidate.metal-host-policy.bundle.mjs"
node --check "$O/candidate.host-admission.bundle.mjs"
node -e "import('$O/candidate.host-admission.bundle.mjs').then(m=>{const a=m.createHostAdmission;console.log('exports', Object.keys(m).join(','));})"
grep -c "decision(" "$O/candidate.host-admission.bundle.mjs" | sed 's/^/decision( occurrences: /'
if grep -q "134\.199\.235\.187\|134\.209\.248\.172\|165\.245\.191\.129\|146\.190\.246\.39" "$O/candidate.host-admission.bundle.mjs"; then echo "CANDIDATE CONTAINS DO MIRROR URLS"; exit 1; fi
diff -u "$O/live-rebuilt.bundle.mjs" "$O/candidate.host-admission.bundle.mjs" > "$O/bundle.diff" || true
cmp -s "$O/live-rebuilt.metal-host-policy.bundle.mjs" "$O/candidate.metal-host-policy.bundle.mjs" && echo "metal host-policy bundle unchanged" || echo "metal host-policy bundle CHANGED"
sha256sum "$O"/*.mjs "$O/bundle.diff"
rm -rf "$T" "$TMPDIR"
