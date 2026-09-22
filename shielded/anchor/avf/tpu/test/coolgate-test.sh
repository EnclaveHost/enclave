#!/usr/bin/env bash
# coolgate-test.sh -- runs the REAL arm runners against a FAKE device. No phone is touched: ADB points
# at a stub and only `sleep` is shimmed, so the scripts' own control flow is what executes.
#
# The gate this replaces passed every string-presence check and still failed open. Driven with a device
# reporting Thermal Status 3 and scaling_max 1000 against cpuinfo_max 2000, it completed its 90 checks,
# printed "cool gate: Thermal Status: 3 cap=1000", launched the run and exited 0. So these tests assert
# on the EXIT STATUS and on whether `am start` was reached, which is what "refused to measure" means.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$HERE"
D=host/staged; [ -f host/staged/APPLY-PENDING ] || D=host
echo "checking $D"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
has() { if grep -qF "$2" <<<"$1"; then printf '  ok   %s\n' "$3"; pass=$((pass+1));
        else printf '  FAIL %s (missing %q)\n' "$3" "$2"; fail=$((fail+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
printf '#!/bin/sh\nexit 0\n' > "$W/bin/sleep"; chmod +x "$W/bin/sleep"
cat > "$W/bin/fakeadb" <<'EOF'
#!/usr/bin/env bash
# FAKE_THERMAL / FAKE_SCALING / FAKE_CPUINFO drive the readings.
# FAKE_HOT_FOR: report hot for the first N thermal checks, then cool (transient recovery).
# FAKE_THERMAL_RC: exit status for the thermal read (a failed transport).
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *thermalservice*)
      n=$(( $(cat "$FAKE_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_N"
      if [ -n "${FAKE_HOT_FOR:-}" ] && [ "$n" -le "$FAKE_HOT_FOR" ]; then echo "Thermal Status: 3"
      else printf '%s\n' "${FAKE_THERMAL-Thermal Status: 0}"; fi
      exit "${FAKE_THERMAL_RC:-0}" ;;
  *scaling_max_freq*)
      if [ -n "${FAKE_HOT_FOR:-}" ] && [ "$(cat "$FAKE_N" 2>/dev/null || echo 0)" -le "$FAKE_HOT_FOR" ]; then echo 1000
      else printf '%s\n' "${FAKE_SCALING-2000}"; fi; exit "${FAKE_SCALING_RC:-0}" ;;
  *cpuinfo_max_freq*) printf '%s\n' "${FAKE_CPUINFO-2000}"; exit "${FAKE_CPUINFO_RC:-0}" ;;
  *dumpsys\ power*)   echo "mWakefulness=Awake"; exit 0 ;;
  *logcat\ -d*)       echo "anchor-host: LOCAL turn 1 A: x"; echo "anchor-host: LOCAL done"; exit 0 ;;
  *)                  exit 0 ;;
esac
EOF
chmod +x "$W/bin/fakeadb"

run() {  # run <runner> [env...]  -> prints "rc|amstart_count"
  local r="$1"; shift
  : > "$W/adb.log"; rm -f "$W/n"
  local out rc
  out=$(env PATH="$W/bin:$PATH" ADB="$W/bin/fakeadb" FAKE_LOG="$W/adb.log" FAKE_N="$W/n" \
        COOL_TRIES=5 COOL_SLEEP=0 "$@" bash "$D/$r" 2>&1); rc=$?
  printf '%s\n---RC---%s---AM---%s\n' "$out" "$rc" "$(grep -c 'am start' "$W/adb.log")"
}
rc_of() { sed -n 's/.*---RC---\([0-9]*\)---AM---.*/\1/p' <<<"$1"; }
am_of() { sed -n 's/.*---AM---\([0-9]*\)$/\1/p' <<<"$1"; }

for r in tpu-run.sh local-run.sh; do
  echo "== $r =="
  o=$(run "$r" FAKE_THERMAL="Thermal Status: 3")
  ck "$r refuses a permanently HOT phone"        "$(rc_of "$o")" 4
  ck "  and never starts the run"                "$(am_of "$o")" 0
  has "$o" "cool gate: FAILED"                   "  and says the gate failed"

  o=$(run "$r" FAKE_SCALING=1000 FAKE_CPUINFO=2000)
  ck "$r refuses a CAPPED phone (status 0)"      "$(rc_of "$o")" 4
  ck "  and never starts the run"                "$(am_of "$o")" 0

  o=$(run "$r" FAKE_SCALING="")
  ck "$r refuses an EMPTY frequency read"        "$(rc_of "$o")" 4
  o=$(run "$r" FAKE_SCALING="unknown" FAKE_CPUINFO="unknown")
  ck "$r refuses a NON-NUMERIC frequency read"   "$(rc_of "$o")" 4
  o=$(run "$r" FAKE_THERMAL="")
  ck "$r refuses an EMPTY thermal read"          "$(rc_of "$o")" 4
  o=$(run "$r" FAKE_THERMAL_RC=1)
  ck "$r refuses when the thermal READ FAILS"    "$(rc_of "$o")" 4

  # Valid-looking output with a FAILURE status, on each frequency channel separately. The gate
  # captured rc for the thermal read only, so a `cat` that printed 2000 and exited 42 read as cool.
  o=$(run "$r" FAKE_SCALING_RC=42)
  ck "$r refuses when the SCALING read fails despite output" "$(rc_of "$o")" 4
  ck "  and never starts the run"                "$(am_of "$o")" 0
  o=$(run "$r" FAKE_CPUINFO_RC=42)
  ck "$r refuses when the CPUINFO read fails despite output" "$(rc_of "$o")" 4
  ck "  and never starts the run"                "$(am_of "$o")" 0
  # 0 = 0 is "uncapped" to a naive equality test, and is not a running phone
  o=$(run "$r" FAKE_SCALING=0 FAKE_CPUINFO=0)
  ck "$r refuses ZERO frequencies (0 equals 0)"  "$(rc_of "$o")" 4
  o=$(run "$r" FAKE_SCALING=0 FAKE_CPUINFO=2000)
  ck "$r refuses a zero scaling_max"             "$(rc_of "$o")" 4

  o=$(run "$r" FAKE_HOT_FOR=2)
  ck "$r proceeds after TRANSIENT heat clears"   "$(rc_of "$o")" 0
  ck "  and starts the run"                      "$(am_of "$o")" 1
  has "$o" "cool gate: OK"                       "  and records that the gate passed"

  o=$(run "$r" FAKE_THERMAL="Thermal Status: 3" NOCOOL=1)
  ck "$r honours an EXPLICIT NOCOOL=1 bypass"    "$(rc_of "$o")" 0
  ck "  and starts the run"                      "$(am_of "$o")" 1
  has "$o" "BYPASSED by NOCOOL=1"                "  and records the run as uncontrolled"
done

echo
echo "coolgate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
