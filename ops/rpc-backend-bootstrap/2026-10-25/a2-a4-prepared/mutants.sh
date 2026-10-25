#!/bin/bash
# Mutation check (queue 256). Baseline (unmutated copy) MUST pass. Each mutant removes ONE safety rule from a COPY; it is
# "killed" only if the suite reports genuine assertion FAILURES with zero ERRORS (an ImportError/crash is NOT a kill).
# Every run's full output is preserved under logs/mutants/<UTC stamp>/<name>.log. The executed names must equal EXPECTED.
set -u; H=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; rc=0
L=$H/logs/mutants/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$L"
EXPECTED="merkle-from-n no-empty-read-check no-open-gaps no-a1-age no-journal-guard no-blake3-list-check no-checkpoints-flag no-final-profile-check no-exact-selection db-before-units no-v2-enforcement no-orphan-reap no-post-exit-size"
RAN=""
copy() { rm -rf "$T"/*; cp -r "$H/a2a4.py" "$H/selection.py" "$H/write_download_receipt.py" "$H/test" "$T/"; }
suite() { (cd "$T" && python3 -u test/test_a2a4.py && python3 -u test/test_receipt_writer.py && python3 -u test/test_pinned_manifest.py) > "$1" 2>&1; }
verdict() { # <log> -> killed | survived | invalid
  if grep -qE '^FAILED \(.*errors=' "$1" || grep -qE '^(ImportError|ModuleNotFoundError|SyntaxError|NameError)' "$1"; then echo invalid
  elif grep -qE '^FAILED \(failures=[0-9]+\)$' "$1"; then echo killed
  else echo survived; fi; }
copy; suite "$L/baseline.log"; b=$?
if [ $b -ne 0 ] || grep -qE '^FAILED' "$L/baseline.log" || [ "$(grep -cE '^OK$' "$L/baseline.log")" != 3 ]; then
  echo "BASELINE FAILED (see $L/baseline.log)"; echo "MUTANTS rc=1"; exit 1; fi
echo "baseline OK"
mut() { # <name> <from> <to>
  RAN="$RAN $1"; copy
  python3 - "$T/a2a4.py" "$2" "$3" <<'PY' || { echo "MUTANT $1 anchor not found"; rc=1; return; }
import sys; p,a,b=sys.argv[1:]; s=open(p).read(); assert s.count(a)==1; open(p,'w').write(s.replace(a,b))
PY
  suite "$L/$1.log"; v=$(verdict "$L/$1.log")
  if [ "$v" = killed ]; then echo "mutant $1 killed"; else echo "MUTANT $1 $v"; rc=1; fi; }
mut merkle-from-n "'--from', '0', '--to', str(c['N'])" "'--from', str(c['N']), '--to', str(c['N'])"
mut no-empty-read-check "        if not p.stdout.strip():" "        if False:"
mut no-open-gaps "OPEN_GAPS = ['bytecodes-content-unverified']" "OPEN_GAPS = []"
mut no-a1-age "    if age < 0 or age > c['a1MaxAgeSec']:" "    if False:"
mut no-journal-guard "    if j and (j[-1]['state'] != 'finished' or j[-1].get('rc') != 0):" "    if False:"
mut no-blake3-list-check "        if not files or not all(" "        if False and not all("
mut no-checkpoints-flag "'--commit', '--checkpoints', '--skip-unwind'" "'--commit', '--skip-unwind'"
mut no-final-profile-check "    if not SEL.PROFILES[r['profile']]['final']:" "    if False:"
mut no-exact-selection "    if got != want:" "    if False:"
mut db-before-units "    g = {'stopped': gate_stopped(c)}" "    g = {}"
mut no-v2-enforcement "    if not g['storageV2']:" "    if False:"
mut no-orphan-reap "    stray = group_members(pg, exclude=(pg,))" "    stray = []"
mut no-post-exit-size "        if not why and (out_p.stat().st_size > cap or err_p.stat().st_size > STDERR_CAP):" "        if False:"
[ "$(echo $RAN | tr ' ' '\n' | sort -u | tr '\n' ' ')" = "$(echo $EXPECTED | tr ' ' '\n' | sort -u | tr '\n' ' ')" ] && [ "$(echo $RAN | wc -w)" = 13 ] \
  || { echo "MUTANT SET differs from EXPECTED"; rc=1; }
echo "logs: $L"; echo "MUTANTS rc=$rc"; exit $rc
