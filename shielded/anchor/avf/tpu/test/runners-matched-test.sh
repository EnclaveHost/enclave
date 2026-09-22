#!/usr/bin/env bash
# runners-matched-test.sh -- the two arms of quality-compare.sh must differ ONLY in the lane.
#
# They did not. local-run.sh waited for Thermal Status 0 and full big-core clocks before measuring;
# tpu-run.sh had no thermal gate at all, and the TPU arm runs first, so the CPU arm was handed a cool
# uncapped phone every time and the masked arm was handed whatever the previous row left. Separately
# the TPU arm asked for an 8192 MiB VM and the CPU arm took mode local's 7168 default. Neither
# difference is the lane, and both move a rate.
#
# While host/staged/APPLY-PENDING exists this checks the staged copies; once the fix is applied and the
# marker deleted it checks the live ones, so the guard follows the files that actually run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$HERE"
if [ -f host/staged/APPLY-PENDING ]; then D=host/staged; W="(staged; not yet applied)"; else D=host; W="(live)"; fi
echo "checking $D $W"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
gate() { grep -c "Thermal Status: 0" "$1" 2>/dev/null || echo 0; }
mem()  { grep -c -- '--ei mem' "$1" 2>/dev/null || echo 0; }
nocool() { grep -c 'NOCOOL' "$1" 2>/dev/null || echo 0; }

for f in tpu-run.sh local-run.sh; do
  ck "$f gates on a cool, uncapped phone" "$(gate "$D/$f")" 1
  ck "$f honours NOCOOL"                  "$(nocool "$D/$f")" 1
  ck "$f passes the VM memory explicitly" "$(mem "$D/$f")" 1
done
# the same default, so neither arm silently takes mode local's 7168
for f in tpu-run.sh local-run.sh; do
  ck "$f defaults MEM to 8192" "$(grep -o 'mem \${MEM:-[0-9]*}' "$D/$f" | head -1)" 'mem ${MEM:-8192}'
done
# and the driver must hand both arms the same knobs
ck "quality-compare.sh passes MEM to the tpu arm" \
   "$(awk '/arm" = tpu/{print}' "$D/quality-compare.sh" | grep -c 'MEM=')" 1
ck "quality-compare.sh passes MEM to the cpu arm" \
   "$(awk '/else  */{print}' "$D/quality-compare.sh" | grep -c 'MEM=')" 1
ck "quality-compare.sh passes NOCOOL to both" "$(grep -c 'NOCOOL="\${NOCOOL:-0}"' "$D/quality-compare.sh")" 2
echo; echo "runners-matched-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
