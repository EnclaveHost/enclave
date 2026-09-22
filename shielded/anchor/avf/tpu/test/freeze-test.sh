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

echo "== a concurrent producer is refused before anything is truncated =="
OUTDIR="$W/out2"; rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
rc=$(OUTDIR="$OUTDIR" go); ck "a first run into a fresh OUT succeeds" "$rc" 0
cp "$OUTDIR/MANIFEST.tsv" "$W/manifest.before"
sleep 30 & other=$!
echo "$other" > "$OUTDIR/.producer.lock"
rc=$(OUTDIR="$OUTDIR" go); ck "a second producer is refused"          "$rc" 3
ck "  and the existing MANIFEST is untouched" "$(cmp -s "$OUTDIR/MANIFEST.tsv" "$W/manifest.before" && echo same)" same
ck "  and BUILD was not truncated"            "$([ -s "$OUTDIR/BUILD" ] && echo nonempty)" nonempty
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null
rc=$(OUTDIR="$OUTDIR" go); ck "a stale lock from a dead pid is reclaimed" "$rc" 0

echo
echo "freeze-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
