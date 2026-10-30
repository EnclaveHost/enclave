#!/bin/bash
# base-state-readonly-stage/r12 NEGATIVE fixtures (PREPARED by Claude 1839; NOT run by Claude). Needs the built binary IN PLACE on /vm:
#   ONLY via state-fixture-capture-stage/r2 (inside `unshare -Urnm` + ns_harden /home/steven /tmp), as
#   fixtures.sh BUILD_OUT_DIR/base-state-readonly WORK_DIR    WORK_DIR = BUILD_OUT_DIR/fixture-captures/<run>/work, NEW (created here)
# r12 (root 1879): every write is under WORK_DIR on /vm: the case inputs in WORK/trees (removed at the end), the per-case outputs in
# WORK/out (KEPT as evidence; r11 deleted them). NO default and NO fallback (no /tmp, no stage runs/); arguments validated first.
# r8: its dir must pass `bsro_gate.py verify-binaries`; per-case output files (tmpfs) are bounded by head -c 1 MiB. Cases: r7's 6, unchanged.
# Each case must exit 3 (refused) or, for a corrupt mdbx.dat, non-zero; NO case may create a file in its input dirs or an --out.
set -uo pipefail
export PATH=/usr/bin:/bin
[ $# = 2 ] || { echo "usage: fixtures.sh BUILD_OUT_DIR/base-state-readonly WORK_DIR (no defaults)"; exit 9; }
X=$1; WORK=$2; BD=${X%/base-state-readonly}
[[ "$X" == "$BD/base-state-readonly" && "$BD" =~ ^/vm/enclave-volumes/rpc-recovery-validation-build/run-[0-9]{8}T[0-9]{6}Z-[0-9]+/out$ ]] \
  || { echo "binary must be <a /vm guard run out dir>/base-state-readonly"; exit 9; }
[[ "$WORK" == "$BD"/fixture-captures/* && "${WORK#"$BD"/fixture-captures/}" =~ ^[A-Za-z0-9_-]+/work$ ]] \
  || { echo "WORK_DIR must be BUILD_OUT_DIR/fixture-captures/<run>/work"; exit 9; }
R=${WORK%/work}
[ "$(cd "$BD" 2>/dev/null && pwd -P)" = "$BD" ] && [ "$(cd "$R" 2>/dev/null && pwd -P)" = "$R" ] \
  && [ "$(stat -c %d "$R")" = "$(stat -c %d "$BD")" ] || { echo "WORK_DIR's run dir must be a real dir on the build filesystem"; exit 9; }
mkdir -m 0700 "$WORK" || { echo "WORK_DIR must be NEW"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[ "$(basename "$X")" = base-state-readonly ] && python3 -I -B "$S/jobs/bsro_gate.py" verify-binaries "$(dirname "$X")" \
  || { echo "$X is not a verified build output of this stage"; exit 9; }
T=$WORK/trees; O=$WORK/out                                        # r12: both NEW, under WORK on /vm
mkdir -m 0700 "$T" "$O" || exit 9; fails=0
run() { # name expect(3|nz) args...
  local n=$1 e=$2; shift 2; local before after; before=$(find "$T" -printf '%p %s\n' | sort | sha256sum)
  timeout 60 "$X" "$@" 2>&1 | head -c 1048576 > "$O/$n.out"; local r=${PIPESTATUS[0]}
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
chmod -R u+w "$T" && rm -rf -- "$T" || { echo "## cleanup: could not remove $T"; fails=$((fails+1)); }   # r12: OUR WORK/trees only; WORK/out kept
echo "## fixtures failed=$fails"; echo "## bsro-r12-fixtures rc=$([ $fails = 0 ] && echo 0 || echo 1)"; [ $fails = 0 ]
