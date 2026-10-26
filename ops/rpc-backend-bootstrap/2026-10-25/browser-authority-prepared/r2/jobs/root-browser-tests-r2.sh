#!/bin/bash
# browser-authority-stage r2 test job (ROOT runs it; Claude did not). Offline, pure node tests, PrivateNetwork-style:
#   R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r2
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $R2/logs/root-browser-tests-r2.guard -- unshare -rn bash $R2/jobs/root-browser-tests-r2.sh
# r2 vs r1: private FULL-HISTORY clones (git clone --no-local, detached at bf77da364) so provenance-recording suites see
# real commits; a pristine BASELINE clone (tree-base) runs the same regression suites; the new suite's fixture copies the
# real import closure. verify_tree_v2.py (verify_tree.py + the gitClone checks) runs before and after.
# site-independent-live-reads needs ENCLAVE_LIVE_READS=1 and public Base RPC (it reads the DEPLOYED contracts): it is
# NOT run here and is reported as INCOMPLETE (never a pass). Every other suite: rc 0, fail 0, skipped 0, todo 0,
# cancelled 0, pass > 0. Exit 1 if any suite fails, 2 on a harness/pin problem.
set -uo pipefail
R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage/r2; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo"; exit 2; }
(cd "$R2" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned r2 files changed"; exit 2; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
for t in tree:tree-pins tree-base:tree-base-pins; do d=${t%%:*}; p=${t##*:}
  python3 -I "$R2/jobs/verify_tree_v2.py" "$R" "$R2/$d" "$R2/jobs/$p.json" pre "$R2/logs/$d-verify-pre-$STAMP.json" || { echo "## HARNESS: $d failed content/git verification"; exit 2; }
done
OUT=$R2/logs/root-browser-tests-r2-$STAMP; mkdir -p "$OUT" || exit 2
echo "## node $(node --version)"
rc=0; : > "$OUT/summary.tsv"
suite() { local label=$1 dir=$2 f=$3 tap n r p fl sk td cn ok
  n=$(echo "$f" | tr '/.' '__'); tap=$OUT/$label.$n.tap
  (cd "$R2/$dir" && timeout 600 node --test --test-concurrency=1 --test-reporter=tap "$f") > "$tap" 2>&1; r=$?
  p=$(sed -n 's/^# pass //p' "$tap" | tail -1); fl=$(sed -n 's/^# fail //p' "$tap" | tail -1); sk=$(sed -n 's/^# skipped //p' "$tap" | tail -1)
  td=$(sed -n 's/^# todo //p' "$tap" | tail -1); cn=$(sed -n 's/^# cancelled //p' "$tap" | tail -1)
  ok=PASS; { [ "$r" = 0 ] && [ "${fl:-x}" = 0 ] && [ "${sk:-x}" = 0 ] && [ "${td:-x}" = 0 ] && [ "${cn:-x}" = 0 ] && [ "${p:-0}" -gt 0 ]; } || { ok=FAIL; rc=1; }
  printf '%s\t%s\t%s\trc=%s\tpass=%s\tfail=%s\tskipped=%s\ttodo=%s\tcancelled=%s\n' "$ok" "$label" "$f" "$r" "${p:-?}" "${fl:-?}" "${sk:-?}" "${td:-?}" "${cn:-?}" | tee -a "$OUT/summary.tsv"; }
REG="test/config-dev-overrides.test.mjs test/site-built-in-profile.test.mjs test/site-independent-bundle.test.mjs test/site-independent-profile.test.mjs
 test/site-independent-identity.test.mjs test/site-independent-management-unit.test.mjs test/admin-console.test.mjs test/admin-metrics.test.mjs
 test/api-base-binding.test.mjs test/catalog-version.test.mjs test/featured.test.mjs test/pay.test.mjs test/reviews.test.mjs test/publish-cid-verify.test.mjs"
echo "## [1] new suite (patched)"; suite patched tree test/browser-read-authority.test.mjs
echo "## [2] regression, pristine baseline (tree-base)"; for f in $REG; do suite baseline tree-base "$f"; done
echo "## [3] regression, patched (tree)"; for f in $REG; do suite patched tree "$f"; done
printf 'INCOMPLETE\tboth\ttest/site-independent-live-reads.test.mjs\tnot run: needs ENCLAVE_LIVE_READS=1 + public Base RPC (reads deployed contracts); no offline fixture exists\n' | tee -a "$OUT/summary.tsv"
for t in tree:tree-pins tree-base:tree-base-pins; do d=${t%%:*}; p=${t##*:}
  python3 -I "$R2/jobs/verify_tree_v2.py" "$R" "$R2/$d" "$R2/jobs/$p.json" post "$OUT/$d-verify-post.json" || { echo "## $d: tests left the tree changed"; rc=1; }
done
echo "## logs: $OUT"; echo "## aggregate rc=$rc (offline suites; INCOMPLETE: 1 live-only suite, not counted as a pass)"
exit $rc
