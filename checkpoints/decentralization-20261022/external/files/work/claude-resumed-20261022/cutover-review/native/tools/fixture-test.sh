#!/bin/bash
# Local fixture checks (Linux pwsh 7: syntax/static/simulated only; Windows 5.1 parse happens natively).
set -uo pipefail
cd "$(dirname "$0")/.."; W="$(cd ../../.. && pwd)"; PW="$W/node-hold-package-20261021/tools/pwsh/pwsh"; rc=0
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
for f in cutover.ps1 native-test.ps1 sim-guard.ps1 native-path-test.ps1 readiness-cadence-test.ps1; do cp "$f" "$S/"; done
echo "== static-only (pins, parse of all 5 scripts, read-only extraction scan)"; "$PW" -NoProfile -File native-test.ps1 -Stage "$S" -StaticOnly || rc=1
echo "== sim-guard native-path"; "$PW" -NoProfile -File sim-guard.ps1 -Test "$S/native-path-test.ps1" -Source "$S/cutover.ps1" || rc=1
echo "== sim-guard cadence 10.5 expect 60"; "$PW" -NoProfile -File sim-guard.ps1 -Test "$S/readiness-cadence-test.ps1" -Source "$S/cutover.ps1" -ListenerSec 10.5 -Expect 60 || rc=1
echo "== negative: cadence expect 61 must exit non-zero through the dot-source"; "$PW" -NoProfile -File sim-guard.ps1 -Test "$S/readiness-cadence-test.ps1" -Source "$S/cutover.ps1" -ListenerSec 10.5 -Expect 61 >/dev/null 2>&1 && { echo FAIL; rc=1; } || echo "ok (non-zero)"
echo "== negative: a live command inside a simulated test hits a tripwire"; N=$(mktemp -d); echo 'param([string]$Source) Get-CimInstance Win32_Process | Out-Null; "LIVE-CALL-COMPLETED"' > "$N/native-path-test.ps1"
out=$("$PW" -NoProfile -File sim-guard.ps1 -Test "$N/native-path-test.ps1" -Source x 2>&1); c=$?; rm -rf "$N"
if [ $c -ne 0 ] && grep -q 'TRIPWIRE: Get-CimInstance' <<<"$out" && ! grep -q LIVE-CALL-COMPLETED <<<"$out"; then echo "ok (tripwire, rc $c)"; else echo FAIL; rc=1; fi
echo "== negative: a changed staged byte refuses before anything else"; printf ' ' >> "$S/cutover.ps1"; "$PW" -NoProfile -File native-test.ps1 -Stage "$S" -StaticOnly >/dev/null 2>&1 && { echo FAIL; rc=1; } || echo "ok (refused)"
echo "== negative: a terminating error still emits ONE JSON result line (trap): native mode on Linux has no powershell.exe child"; T=$(mktemp -d); for f in cutover.ps1 native-test.ps1 sim-guard.ps1 native-path-test.ps1 readiness-cadence-test.ps1; do cp "$f" "$T/"; done
out=$("$PW" -NoProfile -File native-test.ps1 -Stage "$T" 2>/dev/null); c=$?; rm -rf "$T"; tail -1 <<<"$out" | cut -c1-160
if [ $c -eq 3 ] && tail -1 <<<"$out" | python3 -c 'import json,sys;d=json.loads(sys.stdin.read());assert d["pass"] is False and d["error"].startswith("fixture error")'; then echo "ok (json, rc 3)"; else echo FAIL; rc=1; fi
echo "== preservation logic (unobserved is never preserved)"; "$PW" -NoProfile -File tools/preservation-test.ps1 -Dir . || rc=1
echo "FIXTURE_RC=$rc"; exit $rc
