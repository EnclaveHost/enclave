#!/bin/bash
# custody-rpc-stage r4 test job (root runs it; Claude does not). Pure node tests, no network beyond loopback:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/custody-rpc-stage
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/r4.guard -- unshare -rn bash $S/jobs/root-r4.sh
# Each suite FILE runs on its own (node --test, TAP), so every suite has its own exit code. A suite passes only with rc 0,
# fail 0, skipped 0, todo 0, cancelled 0 and pass > 0. The job exits 1 if ANY suite (new, base or patched) did not pass,
# 2 on a harness/pin problem; base failures are labelled pre-existing in summary.json, never hidden.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/custody-rpc-stage
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo inside the namespace"; exit 2; }
ip -o link show lo | grep -q 'UP' || { echo "## HARNESS: lo is not UP"; exit 2; }
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned candidate/test files changed"; exit 2; }
DIFF=$(cd "$S" && diff -rq tree-base tree-patched 2>&1 | grep -v node_modules | sort)
WANT=$(printf '%s\n' "Files tree-base/custody/chain.mjs and tree-patched/custody/chain.mjs differ" "Files tree-base/custody/custodian-daemon.mjs and tree-patched/custody/custodian-daemon.mjs differ" \
  "Files tree-base/custody/v2/quorum.mjs and tree-patched/custody/v2/quorum.mjs differ" "Only in tree-patched/custody: chain-source.mjs" "Only in tree-patched/custody: custodian-config.mjs" \
  "Only in tree-patched/test: custody-chain-source.test.mjs" | sort)
[ "$DIFF" = "$WANT" ] || { echo "## HARNESS: tree-patched differs from tree-base beyond the 6 pinned paths:"; echo "$DIFF"; exit 2; }
OUT=$S/logs/r4-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
REG=$(cat "$S/logs/regression-list.txt")
rc=0; : > "$OUT/summary.tsv"
suite() { # <label> <tree> <file>
  local label=$1 tree=$2 f=$3 tap n r p fl sk td cn ok
  n=$(echo "$f" | tr '/.' '__'); tap=$OUT/$label.$n.tap
  (cd "$S/$tree" && node --test --test-concurrency=1 --test-reporter=tap "$f") > "$tap" 2>&1; r=$?
  p=$(sed -n 's/^# pass //p' "$tap" | tail -1); fl=$(sed -n 's/^# fail //p' "$tap" | tail -1); sk=$(sed -n 's/^# skipped //p' "$tap" | tail -1)
  td=$(sed -n 's/^# todo //p' "$tap" | tail -1); cn=$(sed -n 's/^# cancelled //p' "$tap" | tail -1)
  ok=PASS; { [ "$r" = 0 ] && [ "${fl:-x}" = 0 ] && [ "${sk:-x}" = 0 ] && [ "${td:-x}" = 0 ] && [ "${cn:-x}" = 0 ] && [ "${p:-0}" -gt 0 ]; } || { ok=FAIL; rc=1; }
  printf '%s\t%s\t%s\trc=%s\tpass=%s\tfail=%s\tskipped=%s\ttodo=%s\tcancelled=%s\n' "$ok" "$label" "$f" "$r" "${p:-?}" "${fl:-?}" "${sk:-?}" "${td:-?}" "${cn:-?}" | tee -a "$OUT/summary.tsv"
}
echo "## [1] new suite (tree-patched)"; suite new tree-patched test/custody-chain-source.test.mjs
echo "## [2] regression, pristine deab17485 (tree-base)"; for f in $REG; do suite base tree-base "$f"; done
echo "## [3] regression, patched (tree-patched)"; for f in $REG; do suite patched tree-patched "$f"; done
python3 -I - "$OUT/summary.tsv" "$OUT/summary.json" <<'PY'
import json, sys
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip()]
st = {(r[1], r[2]): r[0] for r in rows}
out = {'suites': [dict(zip(['result', 'label', 'file', 'rc', 'pass', 'fail', 'skipped', 'todo', 'cancelled'], r)) for r in rows],
       'patchedOnlyFailures': sorted(f for (l, f), v in st.items() if l == 'patched' and v == 'FAIL' and st.get(('base', f)) == 'PASS'),
       'preExistingBaseFailures': sorted(f for (l, f), v in st.items() if l == 'base' and v == 'FAIL'),
       'newSuite': st.get(('new', 'test/custody-chain-source.test.mjs'))}
json.dump(out, open(sys.argv[2], 'w'), indent=1)
print('## patched-only failures:', out['patchedOnlyFailures'] or 'none', '| pre-existing base failures:', out['preExistingBaseFailures'] or 'none', '| new:', out['newSuite'])
PY
echo "## logs: $OUT"; echo "## aggregate rc=$rc"
exit $rc
