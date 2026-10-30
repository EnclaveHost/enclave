#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$P/remaining-composition-triage-stage/runs/20261026T035918Z-821032/tree
ST=$P/remaining-composition-triage-stage
FG=$P/rpc-runtime-composition-stage/r12/run/r4-20261026T031250Z/trees/final/.git
C=debbfb377d90f4193ea9182f5cb67d714ffaa322
OUT=$ST/root-journal-unprivileged-0407
mkdir "$OUT"
ip link set lo up
(cd "$ST" && sha256sum -c --quiet SHA256SUMS)
export GIT_OPTIONAL_LOCKS=0 GIT_INDEX_FILE=$OUT/check.index
git --git-dir="$FG" --work-tree="$T" read-tree "$C"
test "$(git --git-dir="$FG" --work-tree="$T" diff --name-only)" = test/helpers/windows-lease-runtime-fixture.mjs
test "$(git hash-object "$T/test/helpers/windows-lease-runtime-fixture.mjs")" = fbdcfd281d3540eedf6c7ae2cc49faa0712577d8
unset GIT_INDEX_FILE
mkdir "$OUT/tmp"
r=0
(cd "$T" && TMPDIR="$OUT/tmp" timeout 300 setpriv --bounding-set=-dac_override,-dac_read_search --no-new-privs node --test --test-reporter=tap --test-timeout=180000 test/windows-release-journal.test.mjs) > "$OUT/journal.tap" 2>&1 || r=$?
echo "$r" > "$OUT/journal.rc"
python3 - "$OUT" "$r" <<'PY'
from pathlib import Path
import sys,re,json
p=Path(sys.argv[1]);s=(p/'journal.tap').read_text();g={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$',s,re.M)}
ok=int(sys.argv[2])==0 and g==dict(tests=7,pass=7,fail=0,skipped=0,todo=0,cancelled=0)
x={'ok':ok,'counts':g,'scope':'Seven unchanged release-journal tests with DAC override/read-search capabilities removed; original permission-negative was invalid under unshare-root capabilities. Other26 P3 tests retain their unchanged passing receipts.'};(p/'verdict.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x));sys.exit(0 if ok else 1)
PY
