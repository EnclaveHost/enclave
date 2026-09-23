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
case "${1:-}" in /proc/*/stat) f="$FAKE_HOME/ticks.$(basename "$(dirname "$1")")"; t=$(( $(/bin/cat "$f" 2>/dev/null || echo 1000) + 150 )); echo $t > "$f"
  echo "${1//[^0-9]/} (x) S 1 1 1 0 -1 0 0 0 0 0 $t 0 0 0"; exit 0;; esac
exec /bin/cat "$@"
EOF
printf '#!/bin/sh\nexit 0\n' > "$W/stubs/input"; printf '#!/bin/sh\nexit 0\n' > "$W/stubs/wm"
# ps + /proc/<pid>/stat for the CPU sample: pids 101 (app) and 202 (crosvm) always, 303 (virtmgr) only in the FIRST
# sample (a process that exits must not count); each read of a stat file adds 150 ticks to it
cat > "$W/stubs/ps" <<'EOF'
#!/usr/bin/env bash
echo "  PID NAME"; echo "  101 host.enclave.anchor.avf"; echo "  202 crosvm"; [ -e "$FAKE_HOME/ps-once" ] || { echo "  303 virtmgr_lave.anchor.avf"; : > "$FAKE_HOME/ps-once"; }
echo "  404 crosvm_isolated_storage_service_vm"
EOF
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
  echo "LOCAL ready: {ctx=4096}"
  echo "LOCAL ask sha256=$(printf '%s' "$ask" | sha256sum | cut -d' ' -f1) bytes=${#ask}"
  n=0; IFS='|' read -r -a parts <<<"$ask"; for p in "${parts[@]}"; do [ -n "$(tr -d '[:space:]' <<<"$p")" ] || continue; n=$((n+1))
     [ "${FAKE_DROP_STATS:-0}" = "$n" ] || echo "LOCAL turn $n STATS {status=eos, decode_tokens=5, decode_tok_s=1.00}"
     echo "VSOCK LOCAL tpu turn $n: exchanges=700 (140.0/token) ms per exchange: mask 0.2"; done
  [ -n "${FAKE_EXTRA_LINE:-}" ] && echo "$FAKE_EXTRA_LINE"
  echo "LOCAL done: $n scripted turns"
  [ "${FAKE_NO_FOOTER:-0}" = 1 ] || echo "CAPTURE END label=$label lines=9 bytes=99 status=complete"; } > "$L"
if [ "${FAKE_CPU_ONLY:-0}" = 1 ]; then printf 'CAPTURE BEGIN label=%s\nLOCAL ask sha256=%s bytes=1\nLOCAL turn 1 STATS {status=eos, decode_tokens=5}\nLOCAL done: 1 scripted turns\nCAPTURE END label=%s lines=4 bytes=9 status=complete\n' "$label" "$(printf '%s' "$ask" | sha256sum | cut -d' ' -f1)" "$label" > "$L"; : > "$c/$label.complete"; exit 0; fi
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
        COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 LANE_CPU=0 OUT="$W/out" ASK="${ASK_:-Say hi.}" "$@" \
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
OUT=$(env -i HOME="$HOME" PATH="$W/bin:/usr/bin:/bin" ADB="$W/bin/fakeadb" FAKE_STUBS="$W/stubs" FAKE_HOME="$W/home" COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 LANE_CPU=0 OUT="$W/out" ASK="x" bash "$HERE/lane-run2.sh" reused 2>&1); RC=$?
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
# lane-conditions.sh over three conditions on the same fake device: every one must run and be recorded (the first
# version ran one, because the driver's adb calls consumed the conditions list from the shared stdin)
rm -rf "$W/home" "$W/lc"; mkdir -p "$W/home/files/capture"
printf 'lc-1\ta\t\nlc-2\tb\t--ei threads 2\nlc-3\tc\t\n' > "$W/conds.tsv"
OUT=$(env -i HOME="$HOME" PATH="$W/bin:/usr/bin:/bin" ADB="$W/bin/fakeadb" FAKE_STUBS="$W/stubs" FAKE_HOME="$W/home" COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 LANE_CPU=0 ASK="Say hi." \
      bash "$HERE/lane-conditions.sh" "$W/lc" "$W/conds.tsv" 2>&1)
ck "lane-conditions runs every condition" "$(grep -c $'\tok\t0$' "$W/lc/RUNS.tsv")" 3
ck "... and freezes the CPU tools beside the driver" "$(ls "$W/lc/driver/tpu" | tr '\n' ' ')" "cpu-sampler.sh cpu-window.py lane-run2.sh "
ASK_='Say hi.'; run cpuonly GRAPHS=none FAKE_CPU_ONLY=1; ck "GRAPHS=none: a CPU-only run with no TPU records passes" "$RC" 0
run cpuonly-tpu GRAPHS=none; ck "GRAPHS=none but the capture shows a TPU worker: refused" "$RC" 1
run tpu-no-counters FAKE_CPU_ONLY=1; ck "a TPU run without TPU records: refused" "$RC" 1
# a TMPDIR that cannot be written stands in for a full /tmp: refused, and named as such
mkdir -p "$W/ro"; chmod 0500 "$W/ro"
OUT=$(env -i HOME="$HOME" PATH="$W/bin:/usr/bin:/bin" TMPDIR="$W/ro" ADB="$W/bin/fakeadb" FAKE_STUBS="$W/stubs" FAKE_HOME="$W/home" COOL_TRIES=1 COOL_SLEEP=0 LANE_TRIES=3 LANE_SLEEP=0 LANE_CPU=0 OUT="$W/out" ASK="x" bash "$HERE/lane-run2.sh" tmpfull 2>&1); RC=$?
ck "an unwritable TMPDIR: refused" "$RC" 1; grep -q "cannot create a temp file" <<<"$OUT"; ck "... and named as a disk problem, not a dozing phone" "$?" 0
chmod 0700 "$W/ro"
echo "lane-run2: $pass passed, $fail failed"; [ $fail = 0 ]
