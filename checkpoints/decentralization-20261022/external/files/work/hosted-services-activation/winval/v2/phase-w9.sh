#!/bin/bash
# W9 native run (queue 256; ssh/scp only here): the TEST Windows stage (isolated-root scripts) is extracted under the
# validation root and installed/started/health-checked/banned/unbanned/stopped/rolled back by its REAL scripts in an
# isolated root + task namespace (harness/w9-install.ps1). Every remote session has the watchdog (time + 1 GiB).
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
OUT=results-w9; rm -rf "$OUT"; mkdir -p "$OUT"
TAR=build-test/out/enclave-host-services-hs2-windows.tar
capacity_gate || { echo "NOT STARTED: capacity"; exit 9; }
task_snapshot "$OUT/tasks-before.txt"; echo "tasks before: $(wc -l < "$OUT/tasks-before.txt")"
ps_remote "
\$V = '$VAL'; \$W = \"\$V\w9\"
if (-not (Test-Path -LiteralPath \$V)) { 'REFUSED: the validation root is missing'; exit 7 }
if (@(Get-Process | Where-Object { \$p = \$null; try { \$p = \$_.Path } catch { }; \$p -and \$p.StartsWith(\$V, 'OrdinalIgnoreCase') }).Count) { 'REFUSED: a process of ours is running'; exit 7 }
if (Get-ScheduledTask -TaskName 'EnclaveHostServicesInstallValidation-20261021-hs2' -ErrorAction SilentlyContinue) { 'REFUSED: our task exists'; exit 7 }
if (Test-Path -LiteralPath \$W) { Remove-Item -LiteralPath \$W -Recurse -Force; 'previous w9 attempt removed (our files only)' }
foreach (\$d in '', 'stage', 'node', 'fixtures', 'guard') { New-Item -ItemType Directory -Path (Join-Path \$W \$d) -Force | Out-Null }
Copy-Item -LiteralPath 'C:\Program Files\nodejs\node.exe' -Destination \"\$W\node\node.exe\"
'w9 prepared; node ' + (& \"\$W\node\node.exe\" --version)
" || exit 7
scp -q "${SSHOPT[@]}" "$TAR" "minipc:$VAL_SFTP/w9/stage/" 2>/dev/null
scp -q "${SSHOPT[@]}" ../dist/fixture-world.mjs ../../capture/app-static.json "minipc:$VAL_SFTP/w9/fixtures/" 2>/dev/null
scp -q "${SSHOPT[@]}" harness/guard.ps1 "minipc:$VAL_SFTP/w9/guard/" 2>/dev/null
want="w9\\stage\\enclave-host-services-hs2-windows.tar=$(sha256sum < "$TAR" | cut -c1-64);w9\\fixtures\\fixture-world.mjs=$(sha256sum < ../dist/fixture-world.mjs | cut -c1-64);w9\\fixtures\\app-static.json=$(sha256sum < ../../capture/app-static.json | cut -c1-64);w9\\guard\\guard.ps1=$(sha256sum < harness/guard.ps1 | cut -c1-64)"
ps_remote "
\$bad = 0; foreach (\$kv in '$want'.Split(';')) { \$k, \$v = \$kv.Split('='); if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path '$VAL' \$k)).Hash.ToLower() -ne \$v) { 'HASH MISMATCH ' + \$k; \$bad++ } else { 'verified ' + \$k + ' ' + \$v } }; if (\$bad) { exit 4 }
\$s = '$VAL\w9\stage'
& \"\$env:SystemRoot\System32\tar.exe\" -xf \"\$s\enclave-host-services-hs2-windows.tar\" -C \$s; if (\$LASTEXITCODE) { 'tar failed'; exit 4 }
\$n = 0; \$bad = 0
foreach (\$f in @(Get-ChildItem -LiteralPath \"\$s\enclave-host-services-hs2-windows\windows\" -Filter *.ps1) + @(Get-Item -LiteralPath '$VAL\w9\guard\guard.ps1')) {
  \$t = \$null; \$e = \$null; [void][System.Management.Automation.Language.Parser]::ParseFile(\$f.FullName, [ref]\$t, [ref]\$e); \$n++
  if (\$e.Count) { \$bad++; foreach (\$x in \$e) { 'PARSE ERROR ' + \$f.Name + ':' + \$x.Extent.StartLineNumber + ' ' + \$x.Message } } }
'PowerShell ' + \$PSVersionTable.PSVersion + ': parsed ' + \$n + ' file(s), ' + \$bad + ' with errors'; if (\$bad) { exit 4 }
" || { echo "REFUSED: upload/extract/parse failed; nothing executed"; exit 4; }
echo "== watchdog self-test (bound 15 s; the script would sleep 90 s)"
t0=$(date +%s); run_ps harness/watchdog-test.ps1 15 "$OUT/watchdog-test.out"; echo "watchdog-test took $(( $(date +%s) - t0 )) s; output: $(cat "$OUT/watchdog-test.out")"
grep -q 'not ended' "$OUT/watchdog-test.out" && { echo "WATCHDOG FAILED: not running W9"; exit 6; }
echo "== W9"
run_ps harness/w9-install.ps1 1500 "$OUT/w9-install.json"; rc=$?
cat "$OUT/w9-install.json"
scp -q "${SSHOPT[@]}" "minipc:$VAL_SFTP/w9/harness-progress.log" "minipc:$VAL_SFTP/w9/fixture/world.json" "$OUT/" 2>/dev/null
cat "$OUT/harness-progress.log"
task_snapshot "$OUT/tasks-after.txt"; diff "$OUT/tasks-before.txt" "$OUT/tasks-after.txt" && echo "task list/state/actions unchanged"
ps_remote "@(Get-Process | Where-Object { \$p = \$null; try { \$p = \$_.Path } catch { }; \$p -and \$p.StartsWith('$VAL', 'OrdinalIgnoreCase') }).Count.ToString() + ' process(es) of ours left'; 'install root exists: ' + (Test-Path -LiteralPath '$VAL\w9\install'); 'free MiB ' + [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)"
exit $rc
