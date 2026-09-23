#!/usr/bin/env bash
# lane-run2-test.sh -- tpu/lane-run2.sh against a FAKE device. No phone is touched.
#
# The fake adb EXECUTES each remote command string in a local shell with stubs for am, run-as, dumpsys, input, wm and
# the sysfs reads, so the driver's quoting is really parsed -- the fake `am` receives the prompt exactly as a device
# shell would hand it over, and writes the digest of what it RECEIVED into the capture, the way the app does. Every
# case asserts on the EXIT STATUS, because a driver that prints a failure and exits 0 is the defect being fixed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1)); else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/stubs"
printf '#!/bin/sh\nexit 0\n' > "$W/bin/sleep"; chmod +x "$W/bin/sleep"
cat > "$W/stubs/dumpsys" <<'EOF'
#!/usr/bin/env bash
case "$1" in thermalservice) echo "Thermal Status: 0";; power) echo "mWakefulness=${FAKE_WAKE:-Awake}";; esac; exit 0
EOF
cat > "$W/stubs/cat" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in *cpufreq*) for _ in "$@"; do echo 2000; done; exit 0;; esac
exec /bin/cat "$@"
EOF
printf '#!/bin/sh\nexit 0\n' > "$W/stubs/input"; printf '#!/bin/sh\nexit 0\n' > "$W/stubs/wm"
# run-as <pkg> <cmd...>: runs in the fake app's home, where files/capture lives
cat > "$W/stubs/run-as" <<'EOF'
#!/usr/bin/env bash
shift; cd "$FAKE_HOME" || exit 1
[ "${FAKE_RUNAS_FAIL:-}" = "$1 $2" ] && exit 7
exec "$@"
EOF
# am start ...: plays the app. Writes a capture whose shape the scenario decides, from the ASK it RECEIVED.
cat > "$W/stubs/am" <<'EOF'
#!/usr/bin/env bash
[ "$1" = start ] || exit 0
shift; ask=""; label=""
while [ $# -gt 0 ]; do case "$1" in --es) [ "$2" = ask ] && ask="$3"; [ "$2" = capture ] && label="$3"; shift 3;; --ei) shift 3;; *) shift;; esac; done
printf '%s' "$ask" > "$FAKE_HOME/received-ask"
[ "${FAKE_AM_ERROR:-0}" = 1 ] && { echo "Error: Activity class does not exist."; exit 0; }
c="$FAKE_HOME/files/capture"; mkdir -p "$c"; L="$c/$label.log"
[ "${FAKE_MANGLE:-0}" = 1 ] && ask="${ask//\'/}"
{ echo "CAPTURE BEGIN label=$label"
  echo "TPU worker: serving masked rows"
  echo "TPU bundle sha256=${FAKE_BSHA:-aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbccccccccccccccccdddddddddddddddd} (hashed in 900 ms)"
  echo "${FAKE_VM_LINE:-VSOCK LOCAL tpu.bundle: already in the encrypted store (1757 MiB, sha256 ${FAKE_VM_BSHA16:-aaaaaaaaaaaaaaaa}..., re-hashed in 9.1 s)}"
  echo "LOCAL ask sha256=$(printf '%s' "$ask" | sha256sum | cut -d' ' -f1) bytes=${#ask}"
  n=0; IFS='|' read -r -a parts <<<"$ask"; for p in "${parts[@]}"; do [ -n "$(tr -d '[:space:]' <<<"$p")" ] || continue; n=$((n+1))
     [ "${FAKE_DROP_STATS:-0}" = "$n" ] || echo "LOCAL turn $n STATS {status=eos, decode_tokens=5, decode_tok_s=1.00}"
     echo "VSOCK LOCAL tpu turn $n: exchanges=700 (140.0/token) ms per exchange: mask 0.2"; done
  [ -n "${FAKE_EXTRA_LINE:-}" ] && echo "$FAKE_EXTRA_LINE"
  echo "LOCAL done: $n scripted turns"
  [ "${FAKE_NO_FOOTER:-0}" = 1 ] || echo "CAPTURE END label=$label lines=9 bytes=99 status=complete"; } > "$L"
[ "${FAKE_VM_DIES:-0}" = 1 ] && { printf 'CAPTURE BEGIN label=%s\nVM payload started\nVM payload finished exit=1\nVM stopped reason=3\n' "$label" > "$L"; exit 0; }
[ "${FAKE_NO_COMPLETE:-0}" = 1 ] || : > "$c/$label.complete"
echo "Starting: Intent { cmp=host.enclave.anchor.avf/.Main }"
EOF
cat > "$W/bin/fakeadb" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = shell ] || exit 0
shift
case "$*" in *"$FAKE_ADB_FAIL_ON"*) [ -n "${FAKE_ADB_FAIL_ON:-}" ] && exit 255;; esac
PATH="$FAKE_STUBS:$PATH" bash -c "$*"
EOF
chmod +x "$W/stubs"/* "$W/bin/fakeadb"

run() {   # run <label> [VAR=value ...] -> sets RC and OUT
  local label="$1"; shift
  rm -rf "$W/home"; mkdir -p "$W/home/files/capture" "$W/out"
  OUT=$(env -i HOME="$HOME" PATH="$W/bin:/usr/bin:/bin" ADB="$W/bin/fakeadb" FAKE_STUBS="$W/stubs" FAKE_HOME="$W/home" \
        COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 OUT="$W/out" ASK="${ASK_:-Say hi.}" "$@" \
        bash "$HERE/lane-run2.sh" "$label" 2>&1); RC=$?
}
echo "lane-run2 against a fake device"
ASK_='Say hi.'; run good; ck "a complete run exits 0" "$RC" 0
ck "... and says so last" "$(tail -1 <<<"$OUT")" "LANE-RUN OK good"
ASK_="What's 2+2? Use \"quotes\", a \$HOME, a \\backslash and a \`tick\`."; run quoting
ck "a prompt with ' \" \$ \\ \` arrives intact (exit 0)" "$RC" 0
ck "... byte for byte" "$(cat "$W/home/received-ask")" "$ASK_"
ASK_='first|second'; run twoturn; ck "two scripted turns, both recorded: exit 0" "$RC" 0
ASK_="it's"; run mangled FAKE_MANGLE=1; ck "an app that received a different prompt: refused" "$RC" 1
grep -q "altered in transport" <<<"$OUT"; ck "... naming the transport" "$?" 0
ASK_='Say hi.'
run incomplete FAKE_NO_COMPLETE=1; ck "no .complete marker: refused" "$RC" 1
run nofooter FAKE_NO_FOOTER=1; ck "marker but no footer: refused" "$RC" 1
run invalid FAKE_EXTRA_LINE="CAPTURE INVALID label=invalid reason=fsync EIO"; ck "CAPTURE INVALID inside: refused" "$RC" 1
run hostfail FAKE_EXTRA_LINE="HOST FAIL something"; ck "HOST FAIL inside: refused" "$RC" 1
run wkerr FAKE_EXTRA_LINE="TPU worker: 12 exchanges; per exchange ms: ... ERROR: run: boom"; ck "worker ERROR inside: refused" "$RC" 1
ASK_='first|second'; run nostats FAKE_DROP_STATS=2; ck "a scripted turn without its STATS: refused" "$RC" 1
ASK_='Say hi.'
run pullfail FAKE_ADB_FAIL_ON="cat files/capture"; ck "adb fails pulling the capture: refused" "$RC" 1
run probefail FAKE_ADB_FAIL_ON="then echo DONE"; ck "adb fails on the completion probe: refused" "$RC" 1
run runasfail FAKE_RUNAS_FAIL="cat files/capture/runasfail.log"; ck "the remote cat fails (status carried back): refused" "$RC" 1
run amerr FAKE_AM_ERROR=1; ck "am start reports an error: refused" "$RC" 1
run asleep FAKE_WAKE=Asleep; ck "a dozing phone: refused" "$RC" 1
# a label already on the device: refused BEFORE am start
rm -rf "$W/home"; mkdir -p "$W/home/files/capture"; : > "$W/home/files/capture/reused.log"
OUT=$(env -i HOME="$HOME" PATH="$W/bin:/usr/bin:/bin" ADB="$W/bin/fakeadb" FAKE_STUBS="$W/stubs" FAKE_HOME="$W/home" COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 OUT="$W/out" ASK="x" bash "$HERE/lane-run2.sh" reused 2>&1); RC=$?
ck "a used label: refused" "$RC" 1; ck "... before the app was started" "$([ -e "$W/home/received-ask" ] && echo started || echo not-started)" not-started
ASK_=$'two\nlines'; run newline; ck "a multi-line ASK: refused" "$RC" 1
ASK_='Say hi.'
run stalebundle FAKE_VM_BSHA16=eeeeeeeeeeeeeeee; ck "the VM holds a different bundle than the app sent: refused" "$RC" 1
run wantbundle BUNDLE_SHA256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff; ck "not the bundle the caller asked for: refused" "$RC" 1
run rightbundle BUNDLE_SHA256=aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbccccccccccccccccdddddddddddddddd; ck "the bundle the caller asked for: exit 0" "$RC" 0
for vl in "VSOCK LOCAL tpu.bundle: already in the encrypted store (1757 MiB, sha256 aaaaaaaaaaaaaaaa...)" \
          "VSOCK LOCAL tpu.bundle: 1757 MiB received in 41.9 s, sha256 aaaaaaaaaaaaaaaa... verified" \
          "VSOCK LOCAL tpu.bundle: 1757 MiB received, sha256 aaaaaaaaaaaaaaaa... verified"; do
  run wording FAKE_VM_LINE="$vl"; ck "VM wording accepted: ${vl:27:40}" "$RC" 0; done
run wrongwording FAKE_VM_LINE="VSOCK LOCAL tpu.bundle: 1757 MiB received, sha256 eeeeeeeeeeeeeeee... verified"; ck "a streamed bundle with another digest: refused" "$RC" 1
# offline re-validation of a capture: same verdicts, no device
run keep; cp "$W/home/files/capture/keep.log" "$W/keep.log"
OUT=$(env -i HOME="$HOME" PATH="/usr/bin:/bin" ASK="Say hi." LANE_CHECK_ONLY="$W/keep.log" bash "$HERE/lane-run2.sh" keep 2>&1); ck "LANE_CHECK_ONLY on a good capture: exit 0" "$?" 0
sed -i '$d' "$W/keep.log"
OUT=$(env -i HOME="$HOME" PATH="/usr/bin:/bin" ASK="Say hi." LANE_CHECK_ONLY="$W/keep.log" bash "$HERE/lane-run2.sh" keep 2>&1); ck "LANE_CHECK_ONLY without the footer: refused" "$?" 1
run vmdies FAKE_VM_DIES=1 LANE_TRIES=1000; ck "a VM that dies at load: refused" "$RC" 1
grep -q "VM stopped before the run completed" <<<"$OUT"; ck "... at once, naming it" "$?" 0
echo "lane-run2: $pass passed, $fail failed"; [ $fail = 0 ]
