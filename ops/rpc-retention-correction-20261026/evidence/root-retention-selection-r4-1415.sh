#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/base-retention-stage/selection-r4
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$-root-discovery
mkdir -p "$OUT/tmp"
for d in selection-r4 selection-r3 activation-r2; do (cd "$P/base-retention-stage/$d" && sha256sum -c --quiet SHA256SUMS); done
set +e
TMPDIR="$OUT/tmp" timeout -k 10 600 python3 -I -m unittest discover -s "$S" -p test_selection_r4.py -v > "$OUT/tests.out" 2>&1
rc=$?
set -e
tail -n 20 "$OUT/tests.out"
python3 -I - "$OUT/tests.out" "$rc" <<'PY'
import sys,re
t=open(sys.argv[1]).read()
assert int(sys.argv[2])==0,t[-3000:]
assert re.findall(r'^Ran (\d+) tests? in',t,re.M)==['13']
assert re.search(r'^OK$',t,re.M)
assert not re.search(r'\bskipped\b|expected failures|unexpected success',t)
PY
for d in selection-r4 selection-r3 activation-r2; do (cd "$P/base-retention-stage/$d" && sha256sum -c --quiet SHA256SUMS); done
rmdir "$OUT/tmp"
printf 'PASS 13 exact r4 tests, no skips; explicit discovery fixes isolated-python import path.\n' > "$OUT/RESULT"
printf 'Results: %s\n' "$OUT"
