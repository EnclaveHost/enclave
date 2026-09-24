#!/usr/bin/env bash
# restart-test.sh <out_dir> [label] -- PVM-CPU.md target 5 on the phone: the pVM dies mid-conversation and the app, with no
# user action, runs it again and finishes the conversation. The installed build must be a pvm-cpu build (supervised restart
# is its default: 2 restarts) or the launch must allow restarts. Three scripted turns; crosvm is SIGKILLed during turn 2.
# PASS needs, all from the capture the app wrote:
#   - turn 2 marked INTERRUPTED, and no answer line for turn 2 anywhere (an interrupted turn is never shown as an answer);
#   - "LOCAL restart 1", then a fresh VM: a second ATTEST end and a second MODEL ok (the new VM re-verifies the model);
#   - "LOCAL restart ready", turn 3's STATS, "LOCAL done", and the capture closed status=complete;
#   - recovery = kill -> restart ready, and kill -> turn 3's first token, both on the phone's CLOCK_BOOTTIME.
set -uo pipefail
OUT="$1"; LABEL="${2:-rs-01}"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
ASK='Explain what a hash table is in about 150 words.|Explain in detail how TCP congestion control works, with the phases and what triggers each.|Write a Python function that checks whether a string is a palindrome. Give only the code.'
[ "$(sh_ "run-as $P sh -c 'test -e files/capture/$LABEL.log && echo USED'")" = USED ] && { echo "label $LABEL already used on the device"; exit 2; }
sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
sh_ "am start -S -n $P/.Main --es mode local --es vmname anchorlocal --ei mem 8192 --es model /data/user/0/$P/files/model.gguf --ei max_new 256 --es capture $LABEL --es ask $(q "$ASK")" > "$OUT/am.txt"
cat_() { sh_ "run-as $P cat files/capture/$LABEL.log"; }
# wait for turn 1 to finish (<= 6 min), then let turn 2 decode ~8 s
for _ in $(seq 1 72); do cat_ | grep -q '^LOCAL turn 1 STATS' && break; sleep 5; done
cat_ | grep -q '^LOCAL turn 1 STATS' || { echo "turn 1 never finished"; cat_ > "$OUT/$LABEL.log"; exit 1; }
sleep 8
pid=$(sh_ ps -A -o PID,NAME | awk '$2=="crosvm_anchorlocal"{print $1}' | head -1)
[ -n "$pid" ] || { echo "no VM to kill"; exit 1; }
kill_ms=$(sh_ "cut -d' ' -f1 /proc/uptime; run-as $P kill -9 $pid" | head -1 | awk '{printf "%d", $1 * 1000}')
echo "killed crosvm_anchorlocal pid=$pid at boottime_ms=$kill_ms"
# wait for the capture to close (<= 8 min)
for _ in $(seq 1 96); do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$LABEL.complete && echo Y'")" = Y ] && break
  cat_ | grep -q '^CAPTURE END' && break; sleep 5; done
cat_ > "$OUT/$LABEL.log"
L="$OUT/$LABEL.log"; fail=0
ck() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=$((fail+1)); fi; }
ck "turn 2 is marked INTERRUPTED" "grep -q '^LOCAL turn 2 INTERRUPTED' '$L'"
ck "no answer line for turn 2" "! grep -q '^LOCAL turn 2 A:' '$L'"
ck "an automatic restart" "grep -q '^LOCAL restart 1 ' '$L'"
ck "the new VM attested again (two ATTEST end)" "[ \$(grep -c 'ATTEST end' '$L') -ge 2 ]"
ck "the new VM re-verified the model (MODEL ok after the restart)" "sed -n '/^LOCAL restart 1 /,\$p' '$L' | grep -q 'MODEL ok'"
ck "the engine was ready again" "grep -q '^LOCAL restart ready' '$L'"
ck "turn 3 finished after the restart" "grep -q '^LOCAL turn 3 STATS' '$L'"
ck "the conversation ended (LOCAL done)" "grep -q '^LOCAL done' '$L'"
ck "the capture closed complete" "grep -q '^CAPTURE END label=$LABEL .*status=complete' '$L'"
ready_ms=$(sed -n 's/^LOCAL restart ready boottime_ms=\([0-9]*\).*/\1/p' "$L" | head -1)
first3=$(sed -n 's/^LOCAL turn 3 window boottime_ms start=[0-9]* first=\([0-9]*\).*/\1/p' "$L" | head -1)
[ -n "$ready_ms" ] && echo "recovery: kill -> engine ready again $(( (ready_ms - kill_ms) / 1000 )).$(( (ready_ms - kill_ms) % 1000 / 100 )) s"
[ -n "$first3" ] && echo "recovery: kill -> turn 3's first token $(( (first3 - kill_ms) / 1000 )).$(( (first3 - kill_ms) % 1000 / 100 )) s"
echo "$([ $fail = 0 ] && echo PASS || echo "FAIL ($fail)") restart-test $LABEL"
exit $fail
