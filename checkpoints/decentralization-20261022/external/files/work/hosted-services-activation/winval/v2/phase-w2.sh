#!/bin/bash
# W2 mechanism run (queue 256; ssh/scp only here). Creates the NEW install-validation root (refuses if it exists), puts
# the FINAL archive's supervisor exe and the test-only jobprobe.exe in it, runs w2-probe, downloads the evidence.
# The root is KEPT for the W9 install run (same root); cleanup is the last W9 step.
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
OUT=results-w2; rm -rf "$OUT"; mkdir -p "$OUT"
capacity_gate || { echo "NOT STARTED: capacity"; exit 9; }
task_snapshot "$OUT/tasks-before.txt"; echo "tasks before: $(wc -l < "$OUT/tasks-before.txt")"
SUP=../../stage-r2/enclave-host-services-hs2-windows/bin/hostsvc-supervisor.exe
mkdir -p upload/w2/state
python3 - <<'PY'
import json
V='C:\\ProgramData\\Enclave\\host-services-install-validation-20261021'
json.dump({"node": V+"\\bin\\jobprobe.exe", "nodeArgs": [], "runner": V+"\\w2\\runner-placeholder", "config": V+"\\w2\\scenario.json",
  "workDir": V+"\\w2\\state", "jobMemoryMiB": 300, "cpuPercent": 150, "activeProcesses": 16, "restartSec": 10,
  "startLimitBurst": 1, "startLimitIntervalSec": 600, "stopTimeoutSec": 30,
  "stopEvent": "Global\\Enclave-host-services-instval20261021-w2-stop", "log": V+"\\w2\\state\\supervisor.log"},
  open('upload/w2/supervisor.json','w'), indent=2)
PY
ps_remote "
\$V = '$VAL'
if (Test-Path -LiteralPath \$V) { 'REFUSED: the validation root already exists'; exit 7 }
New-Item -ItemType Directory -Path \$V | Out-Null
& icacls.exe \$V /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if (\$LASTEXITCODE -ne 0) { 'icacls failed'; exit 7 }
foreach (\$d in 'bin', 'harness', 'w2', 'w2\state') { New-Item -ItemType Directory -Path (Join-Path \$V \$d) | Out-Null }
'created ' + \$V
" || exit 7
scp -q "${SSHOPT[@]}" "$SUP" ../dist/jobprobe.exe "minipc:$VAL_SFTP/bin/" 2>/dev/null
scp -q "${SSHOPT[@]}" upload/w2/supervisor.json "minipc:$VAL_SFTP/w2/" 2>/dev/null
want="bin\\hostsvc-supervisor.exe=$(sha256sum < "$SUP" | cut -c1-64);bin\\jobprobe.exe=$(sha256sum < ../dist/jobprobe.exe | cut -c1-64);w2\\supervisor.json=$(sha256sum < upload/w2/supervisor.json | cut -c1-64)"
ps_remote "\$bad = 0; foreach (\$kv in '$want'.Split(';')) { \$k, \$v = \$kv.Split('='); if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path '$VAL' \$k)).Hash.ToLower() -ne \$v) { 'HASH MISMATCH ' + \$k; \$bad++ } else { 'verified ' + \$k + ' ' + \$v } }; if (\$bad) { exit 4 }
& '$VAL\bin\hostsvc-supervisor.exe' check '$VAL\w2\supervisor.json'; if (\$LASTEXITCODE) { 'supervisor check refused'; exit 4 }; 'supervisor check ok'" || exit 4
run_ps harness/w2-probe.ps1 400 "$OUT/w2-probe.json"; rc=$?
scp -q -r "${SSHOPT[@]}" "minipc:$VAL_SFTP/w2/state/*" "$OUT/" 2>/dev/null; ls "$OUT"
task_snapshot "$OUT/tasks-after.txt"; diff "$OUT/tasks-before.txt" "$OUT/tasks-after.txt" && echo "task list/state/actions unchanged"
exit $rc
