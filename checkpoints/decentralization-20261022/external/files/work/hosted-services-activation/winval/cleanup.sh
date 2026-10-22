#!/bin/bash
# Remove ONLY our validation root (exact path) after the evidence is downloaded; refuse if any process of ours runs or any
# validation task exists. Then prove it is gone. Nothing else on minipc is touched.
set -uo pipefail
cd "$(dirname "$0")"; . ./lib.sh
[ -s results-run4/w1-procs.json ] && [ -s results-run3/w6-real.json ] || { echo "REFUSED: evidence not downloaded"; exit 7; }
ps_remote "
\$r = 'C:\ProgramData\Enclave\host-services-validation-20261021'
if (@(Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -and \$_.ExecutablePath.StartsWith(\$r, 'OrdinalIgnoreCase') }).Count) { 'REFUSED: a process of ours is running'; exit 7 }
if (@(Get-ScheduledTask | Where-Object { \$_.TaskName -like 'EnclaveHostServicesValidation-20261021*' }).Count) { 'REFUSED: a validation task exists'; exit 7 }
\$n = @(Get-ChildItem -LiteralPath \$r -Recurse -Force -File).Count
Remove-Item -LiteralPath \$r -Recurse -Force
'removed ' + \$n + ' file(s); root exists now: ' + (Test-Path -LiteralPath \$r)
'Enclave dir now: ' + ((Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave' -Force | ForEach-Object Name) -join ', ')
@(Get-ScheduledTask | Where-Object { \$_.TaskPath -like '*Enclave*' } | ForEach-Object { \$_.TaskPath + \$_.TaskName + ' [' + \$_.State + ']' }) -join '; '
"
