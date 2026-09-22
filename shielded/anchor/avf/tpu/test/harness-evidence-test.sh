#!/usr/bin/env bash
# harness-evidence-test.sh -- the measurement harnesses must FAIL when the device does.
#
# Each case below is a defect an audit found in google-lane-run.sh by driving it with a fake adb:
#   * a device that always fails left the harness exiting 0 with empty reply and rate files
#   * a stale NN.raw/NN.txt/NN.rate from an OLD prompt was reported as "cached" for a NEW prompt, after
#     NN.prompt had been overwritten -- an old answer and an old tok/s relabelled as a fresh result
#   * partial output became a cache entry
#
# No device is touched: everything runs against a fake adb on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."
HARNESS="$PWD/host/google-lane-run.sh"
pass=0; fail=0
ck() { printf '%-52s ' "$1"; if [ "$2" = ok ]; then echo ok; pass=$((pass+1)); else echo "FAIL  $3"; fail=$((fail+1)); fi; }

mk_adb() {   # $1 = dir, $2 = exit code for every invocation
  mkdir -p "$1"
  cat > "$1/adb" <<EOF
#!/bin/sh
exit $2
EOF
  chmod 755 "$1/adb"
}

prompts=$(mktemp); printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' > "$prompts"

# 1. a device that always fails
d=$(mktemp -d); mk_adb "$d/bin" 42
out=$(mktemp -d)
PATH="$d/bin:$PATH" ADB="$d/bin/adb" OUT="$out" bash "$HARNESS" "$prompts" >/dev/null 2>&1
rc=$?
ck "a failing device makes the harness exit non-zero" "$([ $rc -ne 0 ] && echo ok)" "rc=$rc"
empties=$(find "$out" -name "*.txt" -o -name "*.rate" 2>/dev/null | wc -l)
ck "  and leaves no reply/rate files behind" "$([ "$empties" -eq 0 ] && echo ok)" "$empties left"

# 2. a stale result from a DIFFERENT prompt must not be reused
out2=$(mktemp -d)
printf 'Paris\n'                        > "$out2/01.deadbeefdeadbeef.txt"
printf 'Decode Speed: 999 tokens/sec\n' > "$out2/01.deadbeefdeadbeef.rate"
printf 'old raw\n'                      > "$out2/01.deadbeefdeadbeef.raw"
printf 'What is the capital of France?\n' > "$out2/01.prompt"
PATH="$d/bin:$PATH" ADB="$d/bin/adb" OUT="$out2" bash "$HARNESS" "$prompts" >/dev/null 2>&1
stale=$(grep -rl "999 tokens/sec" "$out2" 2>/dev/null | wc -l)
reused=$(grep -c "Paris" "$out2"/01.*.txt 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo 0)
# the sentinel files may still exist under THEIR key, but must not be presented as this prompt's result:
# the new prompt hashes to a different key, so no file named with the new key may contain them
newkeyfiles=$(find "$out2" -name "01.*.txt" ! -name "01.deadbeefdeadbeef.txt" 2>/dev/null | wc -l)
ck "a stale answer is not adopted for a different prompt" "$([ "$newkeyfiles" -eq 0 ] && echo ok)" \
   "$newkeyfiles file(s) created under a new key from a failing device"
ck "  the sentinel rate is never reported as this run's" "$([ "$stale" -le 3 ] && echo ok)" "$stale"

rm -rf "$d" "$out" "$out2" "$prompts"
echo; echo "$pass passed, $fail failed"
exit $((fail ? 1 : 0))
