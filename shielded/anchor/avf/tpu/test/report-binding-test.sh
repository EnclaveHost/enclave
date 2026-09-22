#!/usr/bin/env bash
# report-binding-test.sh -- the old-correct/new-wrong regression, driven through the REAL producer
# (quality-compare.sh) and the REAL report (quality-report.py). Only the device is faked: adb, the
# build-identity check, and the two runners. No phone, no model, no compiler.
#
# The defect this exists to catch, reproduced by the audit:
#
#   A row is re-run because the bundle at the same path now holds different bytes. The new run answers
#   0 for "17 times 23". The PREVIOUS run's log, under a different key, is still in the directory with
#   the correct 391. The report globbed NN.*.arm.log, took the lexicographically last hash, scored the
#   OLD log, and printed PASS 1/1. Deleting the old log made it correctly say FAIL.
#
# So a stale artifact for a superseded configuration was being reported as this run's result. The repair
# is that the producer writes MANIFEST.tsv binding id+key+status+prompt, and the report reads only that.
#
# Every arm of this test asserts a MUTANT fails: a test that passes against the broken code proves
# nothing, and this suite has shipped vacuous tests twice before.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"           # .../avf  (tpu/test -> up two)
[ -f "$HERE/host/quality-compare.sh" ] || { echo "FAIL: staging root wrong: no host/quality-compare.sh under $HERE"; exit 1; }
[ -f "$HERE/host/quality-report.py" ]  || { echo "FAIL: staging root wrong: no host/quality-report.py under $HERE"; exit 1; }

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s\n       want: %s\n       got : %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
has() { if grep -qF "$2" <<<"$1"; then printf '  ok   %s\n' "$3"; pass=$((pass+1));
        else printf '  FAIL %s (missing %q)\n' "$3" "$2"; fail=$((fail+1)); fi; }
hasnt() { if grep -qF "$2" <<<"$1"; then printf '  FAIL %s (found %q, should not be there)\n' "$3" "$2"; fail=$((fail+1));
          else printf '  ok   %s\n' "$3"; pass=$((pass+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/host" "$W/bin"
cp "$HERE/host/quality-compare.sh" "$HERE/host/quality-report.py" "$HERE/host/quality_checks.py" "$HERE/host/safe_py.py" "$W/host/"
LIBID=1111111111111111111111111111111111111111111111111111111111111111

# ---- the fakes. Each one is the narrowest thing that satisfies the producer's contract. ----
cat > "$W/bin/adb" <<'EOF'
#!/usr/bin/env bash
# Speaks the producer's dev_run protocol: output, then the remote status marker. The failure modes below
# are the ones that LOOK like success -- plausible 64-hex output with a failing status.
cmd="$*"
if [ "${FAKE_EMPTY_HASH:-0}" = 1 ]; then
  # what `cat missing/*.tflite | sha256sum` returns: the hash of nothing
  echo "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  -"
  echo "__RC__0"; exit 0
fi
if [ "${FAKE_NO_GRAPHS:-0}" = 1 ] && [[ "$cmd" == *tflite* ]]; then echo "__RC__0"; exit 0; fi
if [[ "$cmd" == *tflite* ]]; then echo "$FAKE_CONTENT  g0.tflite"; echo "$FAKE_CONTENT  g1.tflite"
else echo "$FAKE_CONTENT  -"; fi
echo "__RC__${FAKE_REMOTE_RC:-0}"
exit "${FAKE_ADB_RC:-0}"
EOF
cat > "$W/host/build-identity.sh" <<EOF
#!/usr/bin/env bash
printf 'libggml-tpu.so sha256  %s\n' "$LIBID" > "\$1"
EOF
# The runners: emit the three markers the producer and report require, and exit \$FAKE_RC.
for r in tpu-run local-run; do cat > "$W/host/$r.sh" <<'EOF'
#!/usr/bin/env bash
echo "status=eos"
echo "LOCAL turn 1 A: $FAKE_ANSWER"
[ "${FAKE_RC:-0}" = 0 ] && echo "LOCAL done"
exit "${FAKE_RC:-0}"
EOF
done
chmod +x "$W/bin/adb" "$W/host"/*.sh
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' > "$W/prompts.txt"

# The mutant report: the exact defect the audit reproduced -- glob the arm logs and take the last hash.
python3 - "$W/host/quality-report.py" "$W/host/quality-report-MUTANT.py" <<'EOF'
import sys
src = open(sys.argv[1]).read()
old = """            return answer(os.path.join(D, f"{i}.{r['key']}.{which}.log"))"""
assert old in src, "the mutant no longer applies -- the report changed shape; update this test"
new = """            import glob as _g
            _c = sorted(_g.glob(os.path.join(D, f"{i}.*.{which}.log")))
            return answer(_c[-1] if _c else os.path.join(D, f"{i}.{r['key']}.{which}.log"))"""
open(sys.argv[2], "w").write(src.replace(old, new))
EOF

# The producer's own key formula, so the test can CHOOSE content ids that put the stale log last in sort
# order. Without this the mutant would only reproduce the false PASS about half the time, and a test that
# passes by coin flip is not a test.
gid_for() { printf '%s  g0.tflite\n%s  g1.tflite\n' "$1" "$1" | sort | sha256sum | awk '{print $1}'; }
key_for() { printf '%s|%s|%s|%s|%s' \
  "What is 17 times 23? Reply with only the number." 48 "$(gid_for "$1")" "$1" "$LIBID" | sha256sum | cut -c1-16; }
OLD_C=""; NEW_C=""
for i in $(seq 1 400); do
  a=$(printf 'a%063d' "$i"); b=$(printf 'b%063d' "$i")
  if [[ "$(key_for "$a")" > "$(key_for "$b")" ]]; then OLD_C=$a; NEW_C=$b; break; fi
done
[ -n "$OLD_C" ] || { echo "FAIL: could not pick content ids (sha256 search exhausted)"; exit 1; }

run_producer() { FAKE_CONTENT="$1" FAKE_ANSWER="$2" FAKE_RC="${3:-0}" \
  FAKE_ADB_RC="${FAKE_ADB_RC:-0}" FAKE_REMOTE_RC="${FAKE_REMOTE_RC:-0}" \
  FAKE_EMPTY_HASH="${FAKE_EMPTY_HASH:-0}" FAKE_NO_GRAPHS="${FAKE_NO_GRAPHS:-0}" \
  ADB="$W/bin/adb" OUT="$W/out" MAXNEW=48 bash "$W/host/quality-compare.sh" "$W/prompts.txt" >"$W/prod.log" 2>&1; echo $?; }
report() { python3 "${2:-$W/host/quality-report.py}" "$W/out" "$W/prompts.txt" 2>&1; }

echo "== the stale-artifact regression: old log correct, current run wrong =="
rc=$(run_producer "$OLD_C" 391);            ck "producer succeeds on the first (correct) run" "$rc" 0
has "$(report)" "tpu 1/1" "the correct run reports 1/1"
rc=$(run_producer "$NEW_C" 0);              ck "producer succeeds after the bundle content changed" "$rc" 0
# the test is only meaningful if the stale correct log is genuinely still present and sorts last
n=$(ls "$W/out"/01.*.tpu.log | wc -l);      ck "both keys' logs are in the directory" "$n" 2
last=$(ls "$W/out"/01.*.tpu.log | sort | tail -1)
ck "the STALE log is the one sort order would pick" "$(grep -c 'A: 391' "$last")" 1
OUT_NEW=$(report)
has   "$OUT_NEW" "tpu 0/1"  "the report scores the CURRENT run and FAILS it"
hasnt "$OUT_NEW" "tpu 1/1"  "the stale correct answer is not credited to this run"
OUT_MUT=$(report x "$W/host/quality-report-MUTANT.py")
has   "$OUT_MUT" "tpu 1/1"  "MUTANT (glob+sort order) does show the false PASS, so this test discriminates"

echo "== a failed arm is a failure, never a silent pass =="
rm -rf "$W/out"
rc=$(run_producer "$OLD_C" 391 7);          ck "producer exits nonzero when an arm fails" "$rc" 1
ck "no log is promoted for a failed arm" "$(ls "$W/out"/01.*.tpu.log 2>/dev/null | wc -l)" 0
ck "the failed output is kept for inspection" "$(ls "$W/out"/01.*.tpu.log.failed 2>/dev/null | wc -l)" 1
st=$(awk -F'\t' '$1=="01"{print $3}' "$W/out/MANIFEST.tsv"); ck "the manifest records the arm as failed" "$st" fail
OUT_F=$(report)
has "$OUT_F" "tpu 0/1" "a failed arm is scored as a failure"
has "$OUT_F" "the producer recorded this arm as fail" "the report says WHY, from the manifest"

echo "== an unidentifiable binary is refused: unknown-binary is not an identity =="
rm -rf "$W/out"
cp "$W/host/build-identity.sh" "$W/host/build-identity.real"
printf '#!/usr/bin/env bash\nprintf "could not read the installed apk\\n" > "$1"\n' > "$W/host/build-identity.sh"
chmod +x "$W/host/build-identity.sh"
rc=$(run_producer "$OLD_C" 391);            ck "producer refuses when no library digest is available" "$rc" 3
ck "and writes no manifest to score" "$(ls "$W/out/MANIFEST.tsv" 2>/dev/null | wc -l)" 0
cp "$W/host/build-identity.real" "$W/host/build-identity.sh"

echo "== the same path with different bytes is a different key =="
rm -rf "$W/out"
run_producer "$OLD_C" 391 >/dev/null
k1=$(awk -F'\t' '$1=="01"{print $2}' "$W/out/MANIFEST.tsv")
run_producer "$NEW_C" 391 >/dev/null
k2=$(awk -F'\t' '$1=="01"{print $2}' "$W/out/MANIFEST.tsv" | tail -1)
if [ "$k1" != "$k2" ]; then printf '  ok   %s\n' "replaced bundle contents change the key (paths are not identity)"; pass=$((pass+1));
else printf '  FAIL %s\n' "same key for different bundle bytes"; fail=$((fail+1)); fi
ck "and the row is re-run rather than served from cache" "$(grep -c 'cached' "$W/prod.log")" 0

# Mutation-checked 2026-09-22: reverting the transport-status check, the remote-status check, the
# empty-input-hash rejection, the expect_rows denominator, or the malformed-row handling each makes this
# suite fail. The "no readable graphs" property is enforced by TWO lines (the count check and the
# per-digest loop); removing either alone still refuses, so only removing both is detectable. That is
# redundancy, not a vacuous test -- verified by mutating both together.
echo "== output that LOOKS like a digest is not an identity =="
# Exactly the audit's staging: every content-digest call emits 64 hex and then exits 42.
rm -rf "$W/out"; rc=$(FAKE_ADB_RC=42 run_producer "$OLD_C" 391)
ck "producer refuses when the digest ADB call fails the transport" "$rc" 3
ck "and scores nothing" "$(ls "$W/out/MANIFEST.tsv" 2>/dev/null | wc -l)" 0
rm -rf "$W/out"; rc=$(FAKE_REMOTE_RC=7 run_producer "$OLD_C" 391)
ck "producer refuses when the REMOTE digest command fails" "$rc" 3
rm -rf "$W/out"; rc=$(FAKE_EMPTY_HASH=1 run_producer "$OLD_C" 391)
ck "producer refuses the hash of EMPTY input (cat of nothing)" "$rc" 3
rm -rf "$W/out"; rc=$(FAKE_NO_GRAPHS=1 run_producer "$OLD_C" 391)
ck "producer refuses an empty graph list" "$rc" 3

echo "== an interrupted manifest cannot shrink the denominator =="
rm -rf "$W/out"; run_producer "$OLD_C" 391 >/dev/null
# simulate a run cut short: the producer declared 1 row but only reached 0 of them
python3 - "$W/out/MANIFEST.tsv" <<'PY'
import sys
p=sys.argv[1]; keep=[l for l in open(p) if l.startswith("#")]
keep.insert(0, "# expect_rows\t8\n") if False else None
open(p,"w").writelines(keep)
PY
sed -i 's/^# expect_rows\t1$/# expect_rows\t8/' "$W/out/MANIFEST.tsv"
OUT_S=$(report)
has "$OUT_S" "out of 8 prompts" "the denominator is the DECLARED count, not the rows present"
has "$OUT_S" "tpu 0/8" "rows the run never reached are failures, not exclusions"
echo "== a malformed manifest row is a failure, not a skip =="
rm -rf "$W/out"; run_producer "$OLD_C" 391 >/dev/null
printf '02\tdeadbeef\tok\n' >> "$W/out/MANIFEST.tsv"
sed -i 's/^# expect_rows\t1$/# expect_rows\t2/' "$W/out/MANIFEST.tsv"
OUT_M=$(report)
has "$OUT_M" "out of 2 prompts" "the malformed row stays in the denominator"
has "$OUT_M" "malformed" "and is reported as malformed"

echo "== a manifest with no declared count is refused =="
rm -rf "$W/out"; run_producer "$OLD_C" 391 >/dev/null
grep -v '^# expect_rows' "$W/out/MANIFEST.tsv" > "$W/m.tmp" && mv "$W/m.tmp" "$W/out/MANIFEST.tsv"
report >/dev/null 2>&1; ck "report refuses a manifest with no expect_rows (exit 2)" "$?" 2

echo "== a directory with no manifest is refused, not guessed at =="
rm -rf "$W/out2"; mkdir -p "$W/out2"
printf 'status=eos\nLOCAL turn 1 A: 391\nLOCAL done\n' > "$W/out2/01.deadbeef.tpu.log"
cp "$W/out2/01.deadbeef.tpu.log" "$W/out2/01.deadbeef.cpu.log"
OUT_R=$(python3 "$W/host/quality-report.py" "$W/out2" "$W/prompts.txt" 2>&1); rc=$?
ck "report refuses a directory it cannot bind (exit 2)" "$rc" 2
hasnt "$OUT_R" "1/1" "it reports no score at all rather than a flattering one"

echo
echo "report-binding-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
