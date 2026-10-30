#!/bin/bash
# r3 (ROOT runs it; Claude did not): regenerate ONLY the management vendor provenance manifest in a fresh private
# full-history clone, validate it, then run the FULL offline baseline + patched suites with that baseline fix.
#   R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r3
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $R3/logs/root-r3.guard -- unshare -rn bash $R3/jobs/root-r3.sh
# Exit 1 on a failed regeneration check or any failed suite, 2 on a harness/pin problem.
set -uo pipefail
R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r3; R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r2; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source; REV=bf77da364373a9c7d881489af5b760207a03997c; NM=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules
JS_PIN=05209546a4b0b68091e13efa7afa9a33221271c9dc161dca7a3c9da1212bd6a3      # site/vendor/management.js at REV (= manifest sha256)
MAN_PIN=61798129909adc0930aae33749fe623bb35b2cd8c8ff797b3cd18657822948c5     # site/vendor/management.MANIFEST.json at REV (stale provenance)
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo"; exit 2; }
(cd "$R3" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: r3 files changed"; exit 2; }
(cd "$R2" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: r2 inputs (overlay, verify_tree_v2) changed"; exit 2; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ); WK=$R3/work-$STAMP; OUT=$R3/logs/root-r3-$STAMP
[ ! -e "$WK" ] && mkdir -p "$WK" "$OUT" || { echo "## HARNESS: work dir"; exit 2; }
sha() { sha256sum "$1" | cut -c1-64; }
clone() { git clone -q --no-local --no-checkout "$R" "$1" && git -C "$1" checkout -q --detach "$REV" && [ "$(git -C "$1" rev-parse HEAD)" = "$REV" ] && ln -s "$NM" "$1/node_modules"; }
echo "## node $(node --version)"
echo "## [A] regenerate the management vendor manifest (scripts/build-management-vendor.mjs, unmodified) in a fresh clone"
clone "$WK/regen" || { echo "## HARNESS: regen clone"; exit 2; }
[ "$(sha "$WK/regen/site/vendor/management.js")" = "$JS_PIN" ] && [ "$(sha "$WK/regen/site/vendor/management.MANIFEST.json")" = "$MAN_PIN" ] || { echo "## HARNESS: vendor inputs differ from the pins"; exit 2; }
git -C "$WK/regen" show "$REV:site/vendor/management.MANIFEST.json" > "$OUT/old-manifest.json"
(cd "$WK/regen" && node scripts/build-management-vendor.mjs) > "$OUT/regen.out" 2>&1; g=$?; cat "$OUT/regen.out"
[ $g = 0 ] || { echo "## REGEN FAILED (rc $g)"; echo "## aggregate rc=1"; exit 1; }
python3 -I "$R3/jobs/check_manifest_regen.py" "$WK/regen" "$REV" "$OUT/old-manifest.json" "$JS_PIN" "$OUT/regen.json" || { echo "## aggregate rc=1"; exit 1; }
cp "$WK/regen/site/vendor/management.MANIFEST.json" "$OUT/management.MANIFEST.regenerated.json"
git -C "$WK/regen" diff -- site/vendor/management.MANIFEST.json > "$OUT/baseline-management-manifest.patch"
NEWMAN=$(sha "$OUT/management.MANIFEST.regenerated.json"); echo "## regenerated manifest sha256 $NEWMAN (separate baseline fix: $OUT/baseline-management-manifest.patch)"
echo "## [B] trees: baseline (REV + manifest fix) and patched (+ the unchanged r2 browser overlay)"
clone "$WK/tree-base" && clone "$WK/tree" || { echo "## HARNESS: tree clones"; exit 2; }
for d in tree-base tree; do cp "$OUT/management.MANIFEST.regenerated.json" "$WK/$d/site/vendor/management.MANIFEST.json"; done
python3 -I - "$R2" "$WK" "$OUT" "$NEWMAN" <<'PY' || { echo "## HARNESS: overlay/pins"; exit 2; }
import json, shutil, sys
r2, wk, out, newman = sys.argv[1:]
p = json.load(open(f"{r2}/jobs/tree-pins.json")); m = "site/vendor/management.MANIFEST.json"
for f in list(p["overlaid"]) + list(p["added"]): shutil.copyfile(f"{r2}/src/{f}", f"{wk}/tree/{f}")
base = {"rev": p["rev"], "overlaid": {m: newman}, "added": {}, "symlinks": p["symlinks"], "generatedAfterBuild": [], "gitClone": True}
pat = dict(p); pat["overlaid"] = {**p["overlaid"], m: newman}
json.dump(base, open(f"{out}/pins-tree-base.json", "w"), indent=1); json.dump(pat, open(f"{out}/pins-tree.json", "w"), indent=1)
PY
for d in tree-base tree; do python3 -I "$R2/jobs/verify_tree_v2.py" "$R" "$WK/$d" "$OUT/pins-$d.json" pre "$OUT/$d-verify-pre.json" || { echo "## HARNESS: $d verification"; exit 2; }; done
rc=0; : > "$OUT/summary.tsv"
suite() { local label=$1 dir=$2 f=$3 tap n r p fl sk td cn ok
  n=$(echo "$f" | tr '/.' '__'); tap=$OUT/$label.$n.tap
  (cd "$WK/$dir" && timeout 600 node --test --test-concurrency=1 --test-reporter=tap "$f") > "$tap" 2>&1; r=$?
  p=$(sed -n 's/^# pass //p' "$tap" | tail -1); fl=$(sed -n 's/^# fail //p' "$tap" | tail -1); sk=$(sed -n 's/^# skipped //p' "$tap" | tail -1)
  td=$(sed -n 's/^# todo //p' "$tap" | tail -1); cn=$(sed -n 's/^# cancelled //p' "$tap" | tail -1)
  ok=PASS; { [ "$r" = 0 ] && [ "${fl:-x}" = 0 ] && [ "${sk:-x}" = 0 ] && [ "${td:-x}" = 0 ] && [ "${cn:-x}" = 0 ] && [ "${p:-0}" -gt 0 ]; } || { ok=FAIL; rc=1; }
  printf '%s\t%s\t%s\trc=%s\tpass=%s\tfail=%s\tskipped=%s\ttodo=%s\tcancelled=%s\n' "$ok" "$label" "$f" "$r" "${p:-?}" "${fl:-?}" "${sk:-?}" "${td:-?}" "${cn:-?}" | tee -a "$OUT/summary.tsv"; }
REG="test/config-dev-overrides.test.mjs test/site-built-in-profile.test.mjs test/site-independent-bundle.test.mjs test/site-independent-profile.test.mjs
 test/site-independent-identity.test.mjs test/site-independent-management-unit.test.mjs test/admin-console.test.mjs test/admin-metrics.test.mjs
 test/api-base-binding.test.mjs test/catalog-version.test.mjs test/featured.test.mjs test/pay.test.mjs test/reviews.test.mjs test/publish-cid-verify.test.mjs"
echo "## [C] suites"; suite patched tree test/browser-read-authority.test.mjs
for f in $REG; do suite baseline tree-base "$f"; done
for f in $REG; do suite patched tree "$f"; done
printf 'INCOMPLETE\tboth\ttest/site-independent-live-reads.test.mjs\tnot run here: a live read-only suite (ENCLAVE_LIVE_READS=1 + public Base RPC, already user-authorized); deferred until the own backend is ready\n' | tee -a "$OUT/summary.tsv"
for d in tree-base tree; do python3 -I "$R2/jobs/verify_tree_v2.py" "$R" "$WK/$d" "$OUT/pins-$d.json" post "$OUT/$d-verify-post.json" || { echo "## $d: tests left the tree changed"; rc=1; }; done
echo "## logs: $OUT"; echo "## aggregate rc=$rc (offline suites; live-reads INCOMPLETE, not counted)"
exit $rc
