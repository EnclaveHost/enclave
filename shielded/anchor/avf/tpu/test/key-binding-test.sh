#!/usr/bin/env bash
# key-binding-test.sh -- a cached row must belong to the SAME experiment, runners included.
#
# The thermal/memory repair changes what a measurement means but not what it is called. With the old
# key -- prompt, token budget, graphs, bundle, library -- applying the fix into an existing OUT would
# have found every row already present, printed "cached", and reported logs produced by the UNMATCHED
# runners as a matched run. That is the relabelling defect again, one level up: not a stale row inside
# an experiment, a stale EXPERIMENT inside a result set.
#
# So the key now carries the controlled settings (mem, token budget, thermal policy) and a digest of
# the runner scripts and the gate they source. These tests drive the REAL producer with a fake device
# and check that changing any of them re-runs the row instead of serving the old one.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$HERE"
SRC=host; [ -f host/staged/APPLY-PENDING ] && SRC=host/staged
echo "checking $SRC"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
has() { if grep -qF "$2" <<<"$1"; then printf '  ok   %s\n' "$3"; pass=$((pass+1));
        else printf '  FAIL %s (missing %q)\n' "$3" "$2"; fail=$((fail+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/host" "$W/bin"
cp host/quality-compare.sh "$W/host/"                       # base, then overlay the staged copies
[ "$SRC" = host/staged ] && cp host/staged/quality-compare.sh "$W/host/"
cp "$SRC/coolgate.sh" "$W/host/" 2>/dev/null || printf 'cool_gate() { return 0; }\n' > "$W/host/coolgate.sh"
LIB=1111111111111111111111111111111111111111111111111111111111111111
CONTENT=$(printf 'a%063d' 1)     # 64 hex chars; the producer rejects anything else, correctly
printf '#!/usr/bin/env bash\nprintf "libggml-tpu.so sha256  %%s\\n" "%s" > "$1"\n' "$LIB" > "$W/host/build-identity.sh"
cat > "$W/bin/adb" <<'EOF'
#!/usr/bin/env bash
cmd="$*"
if [[ "$cmd" == *tflite* ]]; then echo "$FAKE_CONTENT  g0.tflite"; else echo "$FAKE_CONTENT  -"; fi
echo "__RC__0"
EOF
for r in tpu-run local-run; do printf '#!/usr/bin/env bash\necho "status=eos"\necho "LOCAL turn 1 A: 391"\necho "LOCAL done"\n' > "$W/host/$r.sh"; done
cat > "$W/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
# FAKE_SHA_FAIL_FOR=<file>: print a perfectly valid 64-hex digest for that file and then FAIL.
# Valid-looking output with a failure status is the shape this suite exists to catch.
if [ "${FAKE_SHA_FAIL_AGG:-0}" = 1 ] && [ $# -eq 0 ]; then
  cat >/dev/null; echo "1111111111111111111111111111111111111111111111111111111111111111  -"; exit 42
fi
if [ -n "${FAKE_SHA_FAIL_FOR:-}" ] && [ "${1:-}" = "$FAKE_SHA_FAIL_FOR" ]; then
  echo "0000000000000000000000000000000000000000000000000000000000000000  $1"; exit 42
fi
exec /usr/bin/sha256sum "$@"
EOF
chmod +x "$W/bin/adb" "$W/bin/sha256sum" "$W/host"/*.sh
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' > "$W/p.txt"

go() { env PATH="$W/bin:$PATH" FAKE_CONTENT="$CONTENT" ADB="$W/bin/adb" OUT="$W/out" "$@" \
       bash "$W/host/quality-compare.sh" "$W/p.txt" > "$W/log" 2>&1; echo $?; }
cached() { grep -c 'cached' "$W/log"; }
keyof() { awk -F'\t' '$1=="01"{print $2}' "$W/out/MANIFEST.tsv" | tail -1; }

echo "== an identical experiment is served from cache =="
rm -rf "$W/out"; ck "first run succeeds" "$(go MAXNEW=48 MEM=8192)" 0; K1=$(keyof)
go MAXNEW=48 MEM=8192 >/dev/null; ck "second identical run is cached" "$(cached)" 2

echo "== changing a CONTROLLED SETTING re-runs instead of serving the old row =="
go MAXNEW=48 MEM=4096 >/dev/null; ck "different MEM is not cached"    "$(cached)" 0
ck "  and gets a different key"     "$([ "$(keyof)" != "$K1" ] && echo diff)" diff
go MAXNEW=96 MEM=8192 >/dev/null; ck "different MAXNEW is not cached" "$(cached)" 0
go MAXNEW=48 MEM=8192 NOCOOL=1 >/dev/null; ck "NOCOOL=1 is not cached as a controlled run" "$(cached)" 0
ck "  and gets a different key"     "$([ "$(keyof)" != "$K1" ] && echo diff)" diff

echo "== changing a RUNNER re-runs: the harness is part of the experiment =="
go MAXNEW=48 MEM=8192 >/dev/null; K2=$(keyof)
printf '\n# a change to the arm runner\n' >> "$W/host/tpu-run.sh"
go MAXNEW=48 MEM=8192 >/dev/null; ck "an edited arm runner is not cached" "$(cached)" 0
ck "  and gets a different key"         "$([ "$(keyof)" != "$K2" ] && echo diff)" diff
printf '\n# a change to the shared gate\n' >> "$W/host/coolgate.sh"
K3=$(keyof); go MAXNEW=48 MEM=8192 >/dev/null; ck "an edited thermal gate is not cached" "$(cached)" 0
ck "  and gets a different key"         "$([ "$(keyof)" != "$K3" ] && echo diff)" diff

echo "== the harness has no identity unless EVERY runner digests cleanly =="
rm -rf "$W/out"
ck "a MISSING runner is refused" "$(mv "$W/host/coolgate.sh" "$W/gate.bak"; go MAXNEW=48 MEM=8192)" 3
ck "  and no manifest is written" "$(ls "$W/out/MANIFEST.tsv" 2>/dev/null | wc -l)" 0
mv "$W/gate.bak" "$W/host/coolgate.sh"
rm -rf "$W/out"; chmod 000 "$W/host/coolgate.sh"
ck "an UNREADABLE runner is refused" "$(go MAXNEW=48 MEM=8192)" 3
chmod 644 "$W/host/coolgate.sh"
rm -rf "$W/out"
ck "a FAILING digest that prints a valid hash is refused" \
   "$(go MAXNEW=48 MEM=8192 FAKE_SHA_FAIL_FOR=coolgate.sh)" 3
ck "  and no manifest is written" "$(ls "$W/out/MANIFEST.tsv" 2>/dev/null | wc -l)" 0
ck "a failing digest on the ARM runner is refused too" \
   "$(rm -rf "$W/out"; go MAXNEW=48 MEM=8192 FAKE_SHA_FAIL_FOR=tpu-run.sh)" 3
rm -rf "$W/out"; ck "and a clean set still runs" "$(go MAXNEW=48 MEM=8192)" 0

ck "a failing AGGREGATION digest is refused" "$(rm -rf "$W/out"; go MAXNEW=48 MEM=8192 FAKE_SHA_FAIL_AGG=1)" 3
rm -rf "$W/out"; ck "and a clean aggregation still runs" "$(go MAXNEW=48 MEM=8192)" 0

echo "== the settings that were in force are RECORDED, not just keyed =="
go MAXNEW=48 MEM=8192 >/dev/null
B=$(cat "$W/out/BUILD"); M=$(cat "$W/out/MANIFEST.tsv")
has "$B" "runners sha256" "BUILD records the runner digest"
has "$B" "mem=8192"       "BUILD records the memory setting"
has "$M" "# settings"     "the manifest records the settings"
has "$M" "# runners"      "the manifest records the runner digest"
go MAXNEW=48 MEM=8192 NOCOOL=1 >/dev/null; B=$(cat "$W/out/BUILD")
has "$B" "NOCOOL=1: the thermal gate was BYPASSED" "a bypassed run says so in BUILD"

echo
echo "key-binding-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
