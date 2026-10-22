#!/bin/bash
# Remove ONLY the install-validation root (exact path) after the evidence is downloaded; refuse if any process of ours
# runs or any task of our namespace exists. Then prove it is gone and the task list is unchanged.
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
[ -s results-w9/w9-install.json ] && [ -s results-w2/results.json ] || { echo "REFUSED: evidence not downloaded"; exit 7; }
ps_remote "
\$r = '$VAL'
if (@(Get-Process | Where-Object { \$p = \$null; try { \$p = \$_.Path } catch { }; \$p -and \$p.StartsWith(\$r, 'OrdinalIgnoreCase') }).Count) { 'REFUSED: a process of ours is running'; exit 7 }
if (@(Get-ScheduledTask | Where-Object { \$_.TaskName -like '*EnclaveHostServicesInstallValidation-20261021*' -or \$_.TaskPath -like '*EnclaveHostServicesInstallValidation-20261021*' }).Count) { 'REFUSED: a task of our namespace exists'; exit 7 }
\$n = @(Get-ChildItem -LiteralPath \$r -Recurse -Force -File).Count
Remove-Item -LiteralPath \$r -Recurse -Force
'removed ' + \$n + ' file(s); root exists now: ' + (Test-Path -LiteralPath \$r)
'host-services* under C:\ProgramData\Enclave: ' + (@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave' -Force | Where-Object { \$_.Name -like 'host-services*' } | ForEach-Object Name) -join ', ')
'C:\Program Files\Enclave\host-services exists: ' + (Test-Path -LiteralPath 'C:\Program Files\Enclave\host-services')
" || exit 7
task_snapshot results-w9/tasks-final.txt; diff results-w2/tasks-before.txt results-w9/tasks-final.txt && echo "task list/state/actions identical to before W2 (first native step of this round)"
