#!/bin/bash
# composition-fixture-audit-correction-stage: root's READ-ONLY post-run corrected D audit for r12 (PREPARED; NOT run by Claude).
# Run AFTER (or alongside: it only reads, git with --no-optional-locks) root-composition-r12-full-0313. Never stops, restarts or
# writes the r12 job or stage; writes only $ST/runs/<id>.
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composition-fixture-audit-correction-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-post-run-audit.guard -- unshare -rn bash $ST/jobs/root-post-run-audit.sh > $ST/logs/root-post-run-audit.out 2>&1; echo $? > $ST/logs/root-post-run-audit.rc
# 1. tests: exactly `Ran 13 tests` + `OK`, no skip.  2. audit of the ACTUAL final tree, twice (pre/post identical; .git/index
# untouched).  3. combine: only when the r12 job has finished (rc file + summary line); otherwise INCOMPLETE (rc 3).
# rc 0 = tests pass, audit clean and combine verdict PASS WITH THE CORRECTED D AUDIT (root review required); 3 = job not finished
# (audit recorded); 1 = anything else.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/composition-fixture-audit-correction-stage; R12=$P/rpc-runtime-composition-stage/r12; G=$P/rpc-runtime-composition-stage/r11/src.git
RUN=$R12/run/r4-20261026T031250Z; LOG=$P/logs/root-composition-r12-full-0313.out; RC=$P/logs/root-composition-r12-full-0313.rc
BASE=2d56a4b193a8f3e0be1b343a1e06970fc193d9f9; CAND=debbfb377d90f4193ea9182f5cb67d714ffaa322
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## post-run-audit rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT" || die "output dir"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R12" && sha256sum -c --quiet SHA256SUMS) || die "r12 stage files changed"
[ "$(sha256sum < $R12/tools/deps-identity.py | cut -c1-64)" = f54c59356e798d5cdb2be7d7642e30e63ae668015c0ee39bccffc254c7b22484 ] || die "deps-identity.py differs"
[ -d "$RUN/trees/final/.git" ] || die "the actual final tree is absent"
export GIT_OPTIONAL_LOCKS=0
(cd "$ST" && env -i PATH=/usr/bin:/bin GIT_OPTIONAL_LOCKS=0 R12_STAGE="$R12" TMPDIR="$OUT" timeout 900 python3 -I -B tests/test_post_run_audit.py -v < /dev/null) > "$OUT/tests.txt" 2>&1; trc=$?
tok=0; grep -qx 'Ran 13 tests in [0-9.]*s' "$OUT/tests.txt" && [ "$(grep -E '^(OK|FAILED)' "$OUT/tests.txt" | tail -1)" = OK ] && ! grep -q '\.\.\. skipped' "$OUT/tests.txt" && [ $trc = 0 ] && tok=1
[ $tok = 1 ] || { echo "## FAIL: tests (rc $trc): $(tail -3 "$OUT/tests.txt" | tr '\n' ' ')"; echo "## post-run-audit rc=1"; exit 1; }
idx0=$(sha256sum < "$RUN/trees/final/.git/index" | cut -c1-64)
python3 -I -B "$ST/tools/post-run-audit.py" audit "$RUN" "$R12" "$G" $BASE $CAND "$LOG" > "$OUT/audit-pre.json"; a1=$?
python3 -I -B "$ST/tools/post-run-audit.py" audit "$RUN" "$R12" "$G" $BASE $CAND "$LOG" > "$OUT/audit-post.json"; a2=$?
cmp -s "$OUT/audit-pre.json" "$OUT/audit-post.json" || { echo "## FAIL: the audit is not stable pre/post (the tree changed while auditing)"; echo "## post-run-audit rc=1"; exit 1; }
[ "$(sha256sum < "$RUN/trees/final/.git/index" | cut -c1-64)" = "$idx0" ] || { echo "## FAIL: the final tree's index changed during the audit"; echo "## post-run-audit rc=1"; exit 1; }
cat "$OUT/audit-post.json"
[ $a1 = 0 ] && [ $a2 = 0 ] || { echo "## FAIL: corrected audit"; echo "## post-run-audit rc=1"; exit 1; }
python3 -I -B "$ST/tools/post-run-audit.py" combine "$RUN" "$R12" "$G" $BASE $CAND "$LOG" "$RC" > "$OUT/combine.json"; c=$?
cat "$OUT/combine.json"; echo "## outputs: $OUT"
if grep -q '"verdict": "INCOMPLETE' "$OUT/combine.json"; then echo "## post-run-audit rc=3 (audit clean; the r12 job has not finished)"; exit 3; fi
[ $c = 0 ] && { echo "## post-run-audit rc=0 (corrected D audit + actual receipts; root review required)"; exit 0; }
echo "## post-run-audit rc=1"; exit 1
