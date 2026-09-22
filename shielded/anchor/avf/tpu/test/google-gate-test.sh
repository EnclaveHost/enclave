#!/usr/bin/env bash
# google-gate-test.sh -- the Google lane against a COMPLETE fake device.
#
# An earlier probe of this concluded "the gate refuses" from a non-zero exit. It proved nothing: the
# fake was incomplete, so the script died later at the device-identity step and never reached the gate
# at all. Meanwhile `cool_gate || die` was being called BEFORE die was defined, so on a hot phone bash
# printed "die: command not found" and CARRIED ON -- there is no errexit -- and the batch ran and
# reported nocool=0.
#
# So this fixture is complete: identity digests, a LITERTLM header, a runner that exposes --sampler and
# produces a benchmark block. The script can therefore run to completion, and the assertions are the
# ones that matter -- on a hot, failed or capped device the RUNNER IS NEVER INVOKED and NO usable row
# is written -- plus a cool control that does complete.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$HERE"
D=host; [ -f host/staged/APPLY-PENDING ] && D=host/staged
[ -f "$D/google-lane-run.sh" ] || { echo "FAIL: no google-lane-run.sh under $D"; exit 1; }
echo "checking $D"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
       else printf '  FAIL %s (want %s, got %s)\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }

W=$(mktemp -d); [ "${KEEP:-0}" = 1 ] && echo "KEEPING $W" || trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/stubs"
printf '#!/bin/sh\nexit 0\n' > "$W/bin/sleep"; chmod +x "$W/bin/sleep"
HEX=$(printf 'a%063d' 1)
cat > "$W/stubs/dumpsys" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  thermalservice) printf '%s\n' "${FAKE_THERMAL-Thermal Status: 0}"; exit "${FAKE_THERMAL_RC:-0}" ;;
  power) echo "mWakefulness=Awake" ;;
esac
exit 0
EOF
cat > "$W/stubs/cat" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  *scaling_max_freq) printf '%s\n' "${FAKE_SCALING-2000}"; exit "${FAKE_SCALING_RC:-0}" ;;
  *cpuinfo_max_freq) printf '%s\n' "${FAKE_CPUINFO-2000}"; exit 0 ;;
esac
exec /bin/cat "$@"
EOF
# a COMPLETE device: identity, header, flags, and a runner that produces a benchmark block
cat > "$W/bin/adb" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_LOG"
# a real adb takes "-s SERIAL" before the subcommand; a fake that does not skip it sees "-s" as the
# subcommand and answers nothing, which is how the SERIAL case failed here first time round
while [ "\${1:-}" = "-s" ]; do shift 2; done
case "\${1:-}" in
  push) shift; while [ "\${1:-}" = "-q" ]; do shift; done
        /bin/cp "\$1" "\$FAKE_PROMPT" 2>/dev/null; exit 0 ;;
  shell) shift ;;
  *) exit 0 ;;
esac
cmd="\$*"
case "\$cmd" in
  *thermalservice*|*cpufreq*)  PATH="\$FAKE_STUBS:\$PATH" bash -c "\$cmd"; exit \$? ;;
  *sha256sum*)                 echo "$HEX  x"; echo "__RC__0"; exit 0 ;;
  *xxd*|*head\ -c\ 16*)        echo "4c49544552544c4d0500000000000000"; echo "__RC__0"; exit 0 ;;
  *helpfull*)                  echo "    --sampler (Sampling policy); default: \"model\";"; exit 0 ;;
  *\[\ -f*)                    echo "__RC__0"; exit 0 ;;
  *lm15*)                      echo "RUNNER_INVOKED" >> "\$FAKE_RUN"
                               echo "input_prompt: \$(/bin/cat "\$FAKE_PROMPT" 2>/dev/null)"
                               echo "391"
                               echo "BenchmarkInfo:"
                               echo "  Decode Speed: 15.7 tokens/sec"
                               echo "__RC__0"; exit 0 ;;
  *rm\ -f*)                    echo "__RC__0"; exit 0 ;;
  *)                           echo "__RC__0"; exit 0 ;;
esac
EOF
chmod +x "$W/stubs"/* "$W/bin/adb"
printf 'What is 17 times 23? Reply with only the number.\tnumeric=391\n' > "$W/p.txt"

run() {  # run <env...> -> "rc|runner_invocations|usable_rows"
  : > "$W/adb.log"; : > "$W/run.log"; rm -rf "$W/out"
  local rc
  env PATH="$W/bin:$PATH" FAKE_STUBS="$W/stubs" FAKE_LOG="$W/adb.log" FAKE_RUN="$W/run.log" \
      FAKE_PROMPT="$W/pushed.txt" ADB="$W/bin/adb" OUT="$W/out" \
      COOL_TRIES=3 COOL_SLEEP=0 "$@" bash "$D/google-lane-run.sh" "$W/p.txt" >"$W/o" 2>&1; rc=$?
  printf '%s|%s|%s' "$rc" "$(grep -c RUNNER_INVOKED "$W/run.log")" "$(ls "$W/out"/*.txt 2>/dev/null | wc -l)"
}
f1() { cut -d'|' -f1 <<<"$1"; }; f2() { cut -d'|' -f2 <<<"$1"; }; f3() { cut -d'|' -f3 <<<"$1"; }

echo "== a COOL device completes: the fixture is capable of success =="
o=$(run); ck "cool control finishes"          "$(f1 "$o")" 0
ck "  and invokes the runner"                 "$(f2 "$o")" 1
ck "  and writes a usable row"                "$(f3 "$o")" 1

echo "== a HOT device must not measure anything =="
o=$(run FAKE_THERMAL="Thermal Status: 3")
ck "hot device: exits non-zero"               "$([ "$(f1 "$o")" != 0 ] && echo nonzero)" nonzero
ck "  and the runner is NEVER invoked"        "$(f2 "$o")" 0
ck "  and no usable row is written"           "$(f3 "$o")" 0

echo "== a FAILED thermal read must not measure anything =="
o=$(run FAKE_THERMAL_RC=42)
ck "failed read: exits non-zero"              "$([ "$(f1 "$o")" != 0 ] && echo nonzero)" nonzero
ck "  and the runner is NEVER invoked"        "$(f2 "$o")" 0
ck "  and no usable row is written"           "$(f3 "$o")" 0

echo "== a CAPPED device must not measure anything =="
o=$(run FAKE_SCALING=1000)
ck "capped: exits non-zero"                   "$([ "$(f1 "$o")" != 0 ] && echo nonzero)" nonzero
ck "  and the runner is NEVER invoked"        "$(f2 "$o")" 0
ck "  and no usable row is written"           "$(f3 "$o")" 0

echo "== the argv array survives a SERIAL (the gate must not collapse it) =="
o=$(run SERIAL=fake-device)
ck "with SERIAL set, the cool control still completes" "$(f1 "$o")" 0
ck "  and still writes a usable row"          "$(f3 "$o")" 1

echo
echo "google-gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
