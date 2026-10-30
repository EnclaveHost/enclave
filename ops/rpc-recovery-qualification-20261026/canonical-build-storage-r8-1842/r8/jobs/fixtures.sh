#!/bin/bash
# base-state-readonly-stage/r8 NEGATIVE fixtures (PREPARED by Claude 1839; NOT run by Claude). Needs the built binary IN PLACE on /vm:
#   bash jobs/q-exit-status.sh bsro-r8-fixtures 512 unshare -Urn bash base-state-readonly-stage/r8/jobs/fixtures.sh <guard.outDir>/base-state-readonly
# r8: its dir must pass `bsro_gate.py verify-binaries`; per-case output files (tmpfs) are bounded by head -c 1 MiB. Cases: r7's 6, unchanged.
# Each case must exit 3 (refused) or, for a corrupt mdbx.dat, non-zero; NO case may create a file in its input dirs or an --out.
set -uo pipefail
export PATH=/usr/bin:/bin
X=${1:?binary}; case "$X" in /*) ;; *) echo "binary path must be absolute"; exit 9;; esac
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[ "$(basename "$X")" = base-state-readonly ] && python3 -I -B "$S/jobs/bsro_gate.py" verify-binaries "$(dirname "$X")" \
  || { echo "$X is not a verified build output of this stage"; exit 9; }
T=/tmp/bsro-r8-fix-$(date -u +%Y%m%dT%H%M%SZ)-$$; if [ -e "$T" ]; then echo "$T exists"; exit 9; fi
mkdir -p "$T" || exit 9; fails=0
run() { # name expect(3|nz) args...
  local n=$1 e=$2; shift 2; local before after; before=$(find "$T" -printf '%p %s\n' | sort | sha256sum)
  timeout 60 "$X" "$@" 2>&1 | head -c 1048576 > "$T.$n.out"; local r=${PIPESTATUS[0]}
  after=$(find "$T" -printf '%p %s\n' | sort | sha256sum)
  local ok=1; { [ "$e" = 3 ] && [ $r = 3 ]; } || { [ "$e" = nz ] && [ $r != 0 ]; } || ok=0
  [ "$before" = "$after" ] || ok=0
  echo "case $n rc=$r expect=$e unchanged=$([ "$before" = "$after" ] && echo y || echo n) $([ $ok = 1 ] && echo PASS || echo FAIL)"; [ $ok = 1 ] || fails=$((fails+1))
}
mkdir -p "$T/empty" "$T/sf" "$T/rk" "$T/fake"; : > "$T/fake/mdbx.dat"; chmod -R a-w "$T/empty" "$T/sf" "$T/rk" "$T/fake"
run empty-db         3  --db "$T/empty" --static-files "$T/sf" --rocksdb "$T/rk" --out "$T/o1"
run no-static-files  3  --db "$T/fake" --static-files "$T/missing" --rocksdb "$T/rk" --out "$T/o2"
run relative-path    3  --db fake --static-files "$T/sf" --rocksdb "$T/rk" --out "$T/o3"
run unknown-arg      3  --db "$T/fake" --static-files "$T/sf" --rocksdb "$T/rk" --out "$T/o4" --repair
chmod u+w "$T"; : > "$T/exists"; chmod a-w "$T"
run out-exists       3  --db "$T/fake" --static-files "$T/sf" --rocksdb "$T/rk" --out "$T/exists"
run corrupt-mdbx     nz --db "$T/fake" --static-files "$T/sf" --rocksdb "$T/rk" --out "$T/o5"
chmod -R u+w "$T"; rm -rf "$T" "$T".*.out
echo "## fixtures failed=$fails"; echo "## bsro-r8-fixtures rc=$([ $fails = 0 ] && echo 0 || echo 1)"; [ $fails = 0 ]
