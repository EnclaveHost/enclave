# cutover-review sim-guard: runs ONE frozen SIMULATED test (exact staged bytes, dot-sourced) behind tripwires.
# The simulated tests mock their clock, processes, task requests and queries; their results are CONTROL-FLOW evidence only,
# never native operation proof. Any live query, process, task, VM, network or file-mutation command reached from inside the
# simulation throws here before it can run. The tests' own mocks (defined later, same scope) replace the tripwires they need.
param([string]$Test, [string]$Source, [double]$ListenerSec = 10.5, [int]$Expect = -1)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
foreach ($n in 'Get-CimInstance','Get-WmiObject','Get-NetTCPConnection','Invoke-RestMethod','Invoke-WebRequest','Get-ScheduledTask','Get-ScheduledTaskInfo',
               'Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask','Register-ScheduledTask','Unregister-ScheduledTask',
               'Stop-Process','Start-Process','Get-VM','Start-VM','Stop-VM','Restart-Service','Stop-Service','Start-Service','Restart-Computer',
               'Set-Acl','Set-Content','Add-Content','Out-File','Remove-Item','New-Item','Move-Item','Copy-Item','Rename-Item',
               'Invoke-BoundedQuery','Invoke-TaskCommand') {
  . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n reached from a simulated test' }")) }
$leaf = Split-Path -Leaf $Test
# 'exit N' inside a dot-sourced script returns to this script with $LASTEXITCODE = N: propagate it (a failed check must fail)
$global:LASTEXITCODE = 0
if ($leaf -eq 'native-path-test.ps1') { . $Test -Source $Source }
elseif ($leaf -eq 'readiness-cadence-test.ps1') { . $Test -Source $Source -ListenerSec $ListenerSec -Expect $Expect }
else { throw 'sim-guard runs only native-path-test.ps1 or readiness-cadence-test.ps1' }
exit [int]$global:LASTEXITCODE
