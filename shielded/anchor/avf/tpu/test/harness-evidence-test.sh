#!/usr/bin/env bash
# harness-evidence-test.sh -- google-lane-run.sh must fail when the device does, and succeed when it does not.
#
# The FIRST version of this file proved nothing. Its `cd "$(dirname "$0")/.."` landed in avf/tpu, so
# HARNESS pointed at avf/tpu/host/google-lane-run.sh, which does not exist; bash exited 127 and every
# "the harness failed as expected" assertion passed on a file that was never run. A test whose negative
# cases pass because the target is missing is the same defect it was written to catch, so this version
# asserts the target exists and carries a POSITIVE control: a fake device on which everything works,
# which must produce a real answer. Without that, the failure cases mean nothing.
#
# The fake adb is scripted by FAKE_MODE so each stage can fail INDEPENDENTLY after a good preflight.
# No real device is touched.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Check the STAGED copy while repairs are pending, as the other suites do. Otherwise this exercises a
# script whose known defects are already fixed and merely waiting for a device run to end -- and its
# failures then say nothing about the code that will actually ship.
_H=host; [ -f "$(cd "$(dirname "$0")/../.." && pwd)/host/staged/APPLY-PENDING" ] && _H=host/staged
HARNESS="$(cd "$(dirname "$0")/../.." && pwd)/$_H/google-lane-run.sh"
[ -f "$HARNESS" ] || { echo "FAIL: harness not found at $HARNESS (this test would otherwise pass vacuously)"; exit 1; }

pass=0; fail=0
ck() { printf '%-56s ' "$1"; if [ "$2" = ok ]; then echo ok; pass=$((pass+1)); else echo "FAIL  ${3:-}"; fail=$((fail+1)); fi; }

WORK=$(mktemp -d); [ "${KEEPW:-0}" = 1 ] && echo "WORKDIR=$WORK"; [ "${KEEPW:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
DIG=$(printf 'x' | sha256sum | awk '{print $1}')

cat > "$WORK/adb" <<'FAKE'
#!/usr/bin/env bash
# a scriptable adb. FAKE_MODE selects which stage misbehaves; everything else succeeds.
mode="${FAKE_MODE:-ok}"
args=("$@"); i=0
[ "${args[0]:-}" = "-s" ] && i=2                      # skip -s SERIAL, proving the argv array works
verb="${args[$i]:-}"
case "$verb" in
  push)
    [ "$mode" = pushfail ] && exit 9
    # actually transport it, so the fake can echo back the prompt the harness really sent
    for a in "${args[@]}"; do [ -f "$a" ] && cp "$a" "$FAKE_PROMPT" && break; done
    exit 0 ;;
  shell)
    cmd="${args[$((i+1))]:-}"
    case "$cmd" in
      # The lane gained a per-row thermal gate. A fake that does not answer these made cool_gate spin
      # its full 90 tries at 10s each -- 15 minutes PER ROW -- and two runs of this suite sat wedged
      # for over an hour looking like a hang in the test rather than a stall in the gate. Answering
      # them cool keeps the gate exercised as a positive control instead of bypassing it.
      *thermalservice*)     echo "Thermal Status: 0"; case "$cmd" in *__RC__*) echo "__RC__0";; esac; exit 0 ;;
      *scaling_max_freq*|*cpuinfo_max_freq*)
                            echo 3052000;      case "$cmd" in *__RC__*) echo "__RC__0";; esac; exit 0 ;;
      *sha256sum*)
        [ "$mode" = identfail ] && { echo "DIGESTDIGESTDIGEST"; echo "__RC__42"; exit 0; }
        # a VALID digest and a clean remote status, but the TRANSPORT itself fails: only a check of
        # adb's own exit code can catch this
        [ "$mode" = transportfail ] && { echo "$FAKE_DIGEST  /some/file"; echo "__RC__0"; exit 42; }
        echo "$FAKE_DIGEST  /some/file"; echo "__RC__0"; exit 0 ;;
      *xxd*) echo "4c49544552544c4d0100000005000000"; echo "__RC__0"; exit 0 ;;
      *"[ -f "*) echo "__RC__0"; exit 0 ;;
      *rm\ -f*) echo "__RC__0"; exit 0 ;;
      *lm15*|*litert_lm*)
        touch "$FAKE_TRIPWIRE"
        [ "$mode" = runnerfail ] && { echo "boom"; echo "__RC__42"; exit 0; }
        if [ "$mode" = runnerfail_complete ]; then
          # a COMPLETE-looking run that nevertheless failed: only the exit-status check can catch this,
          # so it is what gives that check independent coverage
          echo "input_prompt: $(cat "$FAKE_PROMPT")"; echo "$FAKE_ANSWER"
          echo "BenchmarkInfo:"; echo "  Decode Speed: 16.20 tokens/sec"; echo "__RC__42"; exit 0
        fi
        [ "$mode" = nobench ] && { echo "input_prompt: $(cat "$FAKE_PROMPT")"; echo "391"; echo "__RC__0"; exit 0; }
        echo "input_prompt: $(cat "$FAKE_PROMPT")"
        echo "$FAKE_ANSWER"
        echo "BenchmarkInfo:"
        echo "  Decode Speed: 16.20 tokens/sec"
        echo "__RC__0"; exit 0 ;;
      *) echo "__RC__0"; exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
FAKE
chmod 755 "$WORK/adb"

PROMPTS="$WORK/p.txt"
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' > "$PROMPTS"
PROMPTS_B="$WORK/pb.txt"
printf 'What is the capital of France? Reply with only the city name.\texact=Paris\n' > "$PROMPTS_B"

run() {  # $1 mode, $2 outdir, $3 prompts -> sets RC
  FAKE_MODE="$1" FAKE_DIGEST="$DIG" FAKE_ANSWER="${ANSWER:-391}" \
  FAKE_PROMPT="$WORK/remote_prompt" FAKE_TRIPWIRE="$WORK/ran" \
  ADB="$WORK/adb" SERIAL=FAKESERIAL OUT="$2" COOL_TRIES=3 COOL_SLEEP=0 \
    bash "$HARNESS" "$3" >"$2.log" 2>&1
  RC=$?
}

# --- POSITIVE CONTROL: without this, every negative below is meaningless -------------------------------
O="$WORK/o_ok"; rm -f "$WORK/ran"
run ok "$O" "$PROMPTS"
ck "POSITIVE CONTROL: a working device yields a result" "$([ $RC -eq 0 ] && echo ok)" "rc=$RC"
got=$(cat "$O"/01.*.txt 2>/dev/null | tr -d '\n ')
ck "  the answer is captured" "$([ "$got" = "391" ] && echo ok)" "got '$got'"
rate=$(cat "$O"/01.*.rate 2>/dev/null)
ck "  the decode rate is captured" "$(echo "$rate" | grep -q '16.20' && echo ok)" "got '$rate'"
ck "  the runner was actually invoked" "$([ -f "$WORK/ran" ] && echo ok)" "tripwire never fired"

# --- CACHE HIT: a second identical run must reuse, and must NOT re-invoke the runner ------------------
rm -f "$WORK/ran"
run ok "$O" "$PROMPTS"
ck "an identical rerun is served from cache" "$([ $RC -eq 0 ] && ! [ -f "$WORK/ran" ] && echo ok)" \
   "rc=$RC ran=$([ -f "$WORK/ran" ] && echo yes || echo no)"

# --- CHANGED PROMPT: must NOT inherit the cached answer ----------------------------------------------
rm -f "$WORK/ran"; ANSWER=Paris
run ok "$O" "$PROMPTS_B"
newtxt=$(grep -rl "Paris" "$O" 2>/dev/null | grep -c '\.txt$')
ck "a changed prompt gets a FRESH keyed answer" "$([ $RC -eq 0 ] && [ -f "$WORK/ran" ] && [ "$newtxt" -ge 1 ] && echo ok)" \
   "rc=$RC ran=$([ -f "$WORK/ran" ] && echo yes || echo no) fresh=$newtxt"
ANSWER=391

# --- STAGE-SPECIFIC FAILURES, each after a GOOD preflight --------------------------------------------
for spec in "identfail:an identity call that exits 42 despite printing a digest" \
            "transportfail:adb itself exiting 42 while printing a valid digest and __RC__0" \
            "pushfail:a prompt push that fails" \
            "runnerfail:a runner that exits 42" \
            "runnerfail_complete:a runner that exits 42 with COMPLETE output" \
            "nobench:a run with no BenchmarkInfo block"; do
  m="${spec%%:*}"; desc="${spec#*:}"
  O2="$WORK/o_$m"
  run "$m" "$O2" "$PROMPTS"
  leftover=$(find "$O2" \( -name '*.txt' -o -name '*.rate' \) 2>/dev/null | wc -l)
  ck "$desc is rejected" "$([ $RC -ne 0 ] && echo ok)" "rc=$RC"
  ck "  and leaves no usable row" "$([ "$leftover" -eq 0 ] && echo ok)" "$leftover file(s)"
done

echo; echo "$pass passed, $fail failed"
exit $((fail ? 1 : 0))
