#!/usr/bin/env bash
# freeze-test.sh -- a run must execute the harness it recorded, and must not destroy an earlier one.
#
# Both defects here were reproduced independently against the real producer with fake runners:
#   * the TPU arm still invoked ./tpu-run.sh from the live checkout while only the CPU arm used the
#     frozen copy, so row 01 tagged SOURCE=ORIGINAL and row 02 SOURCE=EDITED-LIVE under ONE captured
#     harness identity;
#   * `rm -rf $OUT/harness` deleted the previous run's frozen copy on reuse, and could delete a copy
#     another invocation was executing from.
# So these tests edit the live runners WHILE the producer runs, and re-use an OUT, and assert on what
# the rows actually executed rather than on what the directory is called.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$HERE"
SRC=host; [ -f host/staged/APPLY-PENDING ] && SRC=host/staged
echo "checking $SRC"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/host" "$W/bin"
cp host/quality-compare.sh "$W/host/"; [ "$SRC" = host/staged ] && cp host/staged/quality-compare.sh "$W/host/"
cp "$SRC/coolgate.sh" "$W/host/" 2>/dev/null || printf 'cool_gate() { return 0; }\n' > "$W/host/coolgate.sh"
LIB=1111111111111111111111111111111111111111111111111111111111111111
CONTENT=$(printf 'a%063d' 1)
printf '#!/usr/bin/env bash\nprintf "libggml-tpu.so sha256  %%s\\n" "%s" > "$1"\n' "$LIB" > "$W/host/build-identity.sh"
cat > "$W/bin/adb" <<'EOF'
#!/usr/bin/env bash
cmd="$*"
if [[ "$cmd" == *tflite* ]]; then echo "$FAKE_CONTENT  g0.tflite"; else echo "$FAKE_CONTENT  -"; fi
echo "__RC__0"
EOF
# runners that TAG their output with a marker carried inside themselves, so a log says which copy ran
mkrunner() { printf '#!/usr/bin/env bash\necho "SOURCE=%s"\necho "status=eos"\necho "LOCAL turn 1 A: 391"\necho "LOCAL done"\nsleep 0.4\n' "$2" > "$W/host/$1.sh"; chmod +x "$W/host/$1.sh"; }
mkrunner tpu-run ORIGINAL; mkrunner local-run ORIGINAL
chmod +x "$W/bin/adb" "$W/host"/*.sh
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\nWhat is 144 divided by 12? Reply with only the number.\tnumeric=12\n' > "$W/p.txt"
go() { env FAKE_CONTENT="$CONTENT" ADB="$W/bin/adb" OUT="${OUTDIR:-$W/out}" "$@" \
       bash "$W/host/quality-compare.sh" "$W/p.txt" > "$W/log" 2>&1; echo $?; }
tags() { grep -h '^SOURCE=' "${OUTDIR:-$W/out}"/*.log 2>/dev/null | sort -u | tr '\n' ' '; }

echo "== a live edit DURING the run cannot reach any row =="
rm -rf "$W/out"
( go >"$W/rc1" ) &
prod=$!
for _ in $(seq 1 100); do [ "$(ls "$W/out"/*.tpu.log 2>/dev/null | wc -l)" -ge 1 ] && break; sleep 0.1; done
mkrunner tpu-run EDITED-LIVE; mkrunner local-run EDITED-LIVE      # edit the LIVE checkout mid-run
wait $prod
ck "the run completes"                       "$(cat "$W/rc1")" 0
ck "every row executed the FROZEN harness"   "$(tags)" "SOURCE=ORIGINAL "
ck "  and all 4 arms are present"            "$(ls "$W/out"/*.log 2>/dev/null | wc -l)" 4
FR1=$(ls -d "$W/out"/harness/*/ 2>/dev/null | head -1)
ck "  the frozen copy is kept beside the rows" "$([ -n "$FR1" ] && echo yes)" yes
ck "  and it is the ORIGINAL, not the edit"  "$(grep -c ORIGINAL "$FR1/tpu-run.sh" 2>/dev/null)" 1

echo "== re-using the same OUT does not destroy the earlier harness =="
rc=$(go); ck "the second run (edited runners) completes" "$rc" 0
ck "the earlier frozen copy still exists"    "$([ -d "$FR1" ] && echo yes)" yes
ck "  and still holds the ORIGINAL"          "$(grep -c ORIGINAL "$FR1/tpu-run.sh" 2>/dev/null)" 1
ck "a SECOND frozen copy was published"      "$([ "$(ls -d "$W/out"/harness/*/ 2>/dev/null | wc -l)" -ge 2 ] && echo yes)" yes
ck "the new rows executed the EDITED harness" "$(grep -h '^SOURCE=' "$W/out"/*.log | sort -u | grep -c EDITED)" 1

echo "== re-running an IDENTICAL harness reuses its frozen copy rather than rewriting it =="
before=$(ls -d "$W/out"/harness/*/ | wc -l)
rc=$(go); ck "the third run completes"       "$rc" 0
ck "no new frozen copy was created"          "$(ls -d "$W/out"/harness/*/ | wc -l)" "$before"

echo "== the lock is ATOMIC: simultaneous producers cannot both enter =="
# The previous scheme tested for the file, read a pid, checked kill -0, then wrote. An independent
# repro put a barrier immediately before that write and BOTH producers passed the check and reached the
# protected region: one exited 0, one exited 1, and one MANIFEST ended up with two conflicting row 01
# entries. So the cases below are about acquisition, not about what a pid file contains.
OUTDIR="$W/out2"; rm -rf "$OUTDIR"
rc=$(OUTDIR="$OUTDIR" go); ck "startup with NO lock file present succeeds" "$rc" 0
ck "  and the lock file is left behind, not unlinked" "$([ -e "$OUTDIR/.producer.lock" ] && echo yes)" yes
cp "$OUTDIR/MANIFEST.tsv" "$W/manifest.before"

# a STALE file with no holder must simply be acquirable: flock is on the inode, not on the contents
printf 'pid 999999 acquired whenever\n' > "$OUTDIR/.producer.lock"
rc=$(OUTDIR="$OUTDIR" go); ck "a stale lock FILE with no holder is acquired" "$rc" 0

# a genuinely HELD lock must refuse, with the output directory untouched
cp "$OUTDIR/MANIFEST.tsv" "$W/manifest.before"
( exec 9>>"$OUTDIR/.producer.lock"; flock 9; sleep 8 ) & holder=$!
for _ in $(seq 1 50); do flock -n "$OUTDIR/.producer.lock" true 2>/dev/null || break; sleep 0.1; done
rc=$(OUTDIR="$OUTDIR" go); ck "a HELD lock refuses the second producer"      "$rc" 3
ck "  and the existing MANIFEST is untouched" "$(cmp -s "$OUTDIR/MANIFEST.tsv" "$W/manifest.before" && echo same)" same
ck "  and BUILD was not truncated"            "$([ -s "$OUTDIR/BUILD" ] && echo nonempty)" nonempty
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
rc=$(OUTDIR="$OUTDIR" go); ck "the lock is released when the holder dies"    "$rc" 0

# and the real thing: several producers starting at once into a FRESH directory
OUTDIR="$W/out3"; rm -rf "$OUTDIR"
pids=""; : > "$W/rcs"
for n in 1 2 3 4; do
  ( r=$(OUTDIR="$OUTDIR" go); echo "$r" >> "$W/rcs" ) & pids="$pids $!"
done
for q in $pids; do wait "$q" 2>/dev/null; done
won=$(grep -c '^0$' "$W/rcs"); refused=$(grep -c '^3$' "$W/rcs")
ck "exactly ONE of four simultaneous producers wins" "$won" 1
ck "  and the other three are refused"               "$refused" 3
ck "  leaving one row 01 entry, not several"         "$(awk -F'\t' '$1=="01"' "$OUTDIR/MANIFEST.tsv" | wc -l)" 1
ck "  and one row 02 entry"                          "$(awk -F'\t' '$1=="02"' "$OUTDIR/MANIFEST.tsv" | wc -l)" 1

# A NOTE ON WHAT IS NOT TESTED HERE, because a test that passes against the broken code is worse than
# no test. I tried to make the check-then-write race reproduce on demand: a DEBUG trap via BASH_ENV
# pausing the first command that touches the lock path, then a proper rendezvous so both producers
# resume together. Both producers demonstrably reach the rendezvous -- the barrier log shows both pids
# -- and the racy build STILL ends with one winner and one refusal, for a reason I did not isolate: the
# refusal is not coming from the lock comparison. So the case was removed rather than left passing
# against the defect it was written for.
#
# What stands instead: the four-way simultaneous case above, the held/stale/absent-lock cases, and the
# fact that flock(2) makes the property a kernel guarantee rather than a timing argument -- the file is
# opened with >> so acquiring never truncates, and it is never unlinked, so the lock always refers to
# the same inode. The racy build fails this suite on the unlink case.

echo
echo "freeze-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
