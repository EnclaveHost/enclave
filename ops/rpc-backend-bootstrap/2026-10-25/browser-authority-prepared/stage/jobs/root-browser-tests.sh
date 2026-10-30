#!/bin/bash
# browser-authority-stage test job (ROOT runs it; Claude did not). Offline, pure node tests:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $S/logs/root-browser-tests.guard -- unshare -rn bash $S/jobs/root-browser-tests.sh
# Pins -> tree content verification (verify_tree.py, reused byte-identical from consumer-remaining-stage) -> each suite on its
# own (TAP): pass only with rc 0, fail 0, skipped 0, todo 0, cancelled 0, pass > 0 -> tree re-verified (tests leave nothing).
# Exit 1 on any failed suite, 2 on a harness/pin problem. No build, no browser, no network.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source; T=$S/tree
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo"; exit 2; }
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned stage files changed"; exit 2; }
python3 -I "$S/jobs/verify_tree.py" "$R" "$T" "$S/jobs/tree-pins.json" pre "$S/logs/tree-verify-pre-$(date -u +%Y%m%dT%H%M%SZ).json" || { echo "## HARNESS: tree failed content verification"; exit 2; }
OUT=$S/logs/root-browser-tests-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
echo "## node $(node --version)"
rc=0; : > "$OUT/summary.tsv"
suite() { local f=$1 tap n r p fl sk td cn ok
  n=$(echo "$f" | tr '/.' '__'); tap=$OUT/$n.tap
  (cd "$T" && timeout 600 node --test --test-concurrency=1 --test-reporter=tap "$f") > "$tap" 2>&1; r=$?
  p=$(sed -n 's/^# pass //p' "$tap" | tail -1); fl=$(sed -n 's/^# fail //p' "$tap" | tail -1); sk=$(sed -n 's/^# skipped //p' "$tap" | tail -1)
  td=$(sed -n 's/^# todo //p' "$tap" | tail -1); cn=$(sed -n 's/^# cancelled //p' "$tap" | tail -1)
  ok=PASS; { [ "$r" = 0 ] && [ "${fl:-x}" = 0 ] && [ "${sk:-x}" = 0 ] && [ "${td:-x}" = 0 ] && [ "${cn:-x}" = 0 ] && [ "${p:-0}" -gt 0 ]; } || { ok=FAIL; rc=1; }
  printf '%s\t%s\trc=%s\tpass=%s\tfail=%s\tskipped=%s\ttodo=%s\tcancelled=%s\n' "$ok" "$f" "$r" "${p:-?}" "${fl:-?}" "${sk:-?}" "${td:-?}" "${cn:-?}" | tee -a "$OUT/summary.tsv"; }
echo "## [1] new suite"; suite test/browser-read-authority.test.mjs
echo "## [2] unchanged regression suites over the changed modules (config/chain/wallet/build-site seams)"
for f in test/config-dev-overrides.test.mjs test/site-built-in-profile.test.mjs test/site-independent-bundle.test.mjs test/site-independent-profile.test.mjs \
         test/site-independent-identity.test.mjs test/site-independent-live-reads.test.mjs test/site-independent-management-unit.test.mjs \
         test/admin-console.test.mjs test/admin-metrics.test.mjs test/api-base-binding.test.mjs test/catalog-version.test.mjs test/featured.test.mjs \
         test/pay.test.mjs test/reviews.test.mjs test/publish-cid-verify.test.mjs; do suite "$f"; done
python3 -I "$S/jobs/verify_tree.py" "$R" "$T" "$S/jobs/tree-pins.json" post "$OUT/tree-verify-post-tests.json" || { echo "## tests left the tree changed"; rc=1; }
echo "## logs: $OUT"; echo "## aggregate rc=$rc"
exit $rc
