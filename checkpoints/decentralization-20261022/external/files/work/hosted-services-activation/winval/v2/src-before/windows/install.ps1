#Requires -RunAsAdministrator
# Compare-and-swap install of Windows stage @LABEL@. ADDS files, directories (ACLs only on those it creates) and one
# scheduled task \Enclave\enclave-host-services-@LABEL@ with NO trigger (manual start only: stage 1 is not enabled at
# boot). Changes no existing file, task, service, firewall rule or provider setting. Starts nothing.
#   windows\install.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' -ListenersFile .\listeners.txt
param([Parameter(Mandatory = $true)][string]$NodeExe, [Parameter(Mandatory = $true)][string]$ListenersFile)
. (Join-Path $PSScriptRoot 'common.ps1')
Test-StageSums
$inputs = Get-Content -Raw -LiteralPath (Join-Path $Stage 'STAGE-INPUTS.json') | ConvertFrom-Json
if ($inputs.packagesCurrent -ne $true -and $env:ALLOW_TEST_STAGE -ne '1') { Fail 'this is a TEST stage (its packages were not current with its tree): refusing to install' }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Fail "no node at $NodeExe" }
$major = [int](& $NodeExe -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Fail "node $major at $NodeExe; >= 22 required" }
if ($env:ProgramFiles -ne 'C:\Program Files' -or $env:ProgramData -ne 'C:\ProgramData') { Fail 'the stage paths assume C:\Program Files and C:\ProgramData' }
$rerun = Test-Path -LiteralPath $Receipt
$files = @()
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'bin') -File) { $files += , @($f.FullName, "$Opt\bin\$($f.Name)") }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'packages') -File) { $files += , @($f.FullName, "$Opt\packages\$($f.Name)") }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'windows') -File) { $files += , @($f.FullName, "$Opt\windows\$($f.Name)") }
$files += , @((Join-Path $Stage 'ACTIVATION-WINDOWS.txt'), "$Opt\ACTIVATION-WINDOWS.txt")
$files += , @((Join-Path $Stage 'STAGE-SHA256SUMS'), "$Opt\STAGE-SHA256SUMS")
$files += , @((Join-Path $Stage 'data\bootstrap-manifest.json'), "$Data\bootstrap-manifest.json")
# compare-and-swap: a first install finds every target absent; a re-run finds exactly this stage's bytes
foreach ($p in $files) {
  if (Test-Path -LiteralPath $p[1]) {
    if (-not $rerun) { Fail "refusing: $($p[1]) already exists and no install receipt of this stage is present" }
    if ((Sha $p[0]) -ne (Sha $p[1])) { Fail "refusing: $($p[1]) differs from this stage" }
  }
}
if (-not $rerun) {
  foreach ($d in $Opt, $Root) { if (Test-Path -LiteralPath $d) { Fail "refusing: $d already exists" } }
  if (Get-Task) { Fail "refusing: the scheduled task $TaskPath$TaskName already exists" }
}
$receipt = New-Object System.Collections.Generic.List[string]
if ($rerun) { foreach ($l in Get-Content -LiteralPath $Receipt) { if ($l -like 'dir *') { $receipt.Add($l) } } }
else {
  foreach ($d in 'C:\Program Files\Enclave', 'C:\Program Files\Enclave\host-services', $Opt, "$Opt\bin", "$Opt\packages", "$Opt\windows",
                 'C:\ProgramData\Enclave', 'C:\ProgramData\Enclave\host-services', $Root, $Cfg, $Data, "$Data\artifacts", "$Data\policy-import", $State) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null; $receipt.Add("dir $d") }
  }
  # this stage's own directories only: SYSTEM and Administrators full, LOCAL SERVICE read; the state directory writable by it
  & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${LocalService}:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls $Root failed" }
  & icacls.exe $State /grant:r "${LocalService}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls $State failed" }
}
foreach ($p in $files) {
  if (-not (Test-Path -LiteralPath $p[1])) { Copy-Item -LiteralPath $p[0] -Destination $p[1] }
  $receipt.Add("file $(Sha $p[1]) $($p[1])")
}
# the exact configuration: the stage's public spec + this host's listener capture (refuses a port in use)
if (-not $rerun) {
  & $NodeExe "$Opt\bin\stage-tool.mjs" gen-config --spec (Join-Path $Stage 'config\spec.windows.json') --listeners $ListenersFile --out "$Cfg\host-services.json"
  if ($LASTEXITCODE -ne 0) { Fail 'gen-config refused (a port in use, or a malformed spec)' }
  $sup = Get-Content -Raw -LiteralPath (Join-Path $Stage 'config\supervisor.template.json') | ConvertFrom-Json
  $sup.node = $NodeExe
  [IO.File]::WriteAllText("$Cfg\supervisor.json", ($sup | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
}
$receipt.Add("file $(Sha "$Cfg\host-services.json") $Cfg\host-services.json")
$receipt.Add("file $(Sha "$Cfg\supervisor.json") $Cfg\supervisor.json")
& "$Opt\bin\hostsvc-supervisor.exe" check "$Cfg\supervisor.json"
if ($LASTEXITCODE -ne 0) { Fail 'the supervisor refuses supervisor.json' }
$check = & $NodeExe "$Opt\bin\host-services-runner.mjs" check "$Cfg\host-services.json" | Out-String
if ($LASTEXITCODE -ne 0) { Fail "the runner refuses the configuration: $check" }
$j = $check | ConvertFrom-Json
if (-not $j.ok -or @($j.warnings).Count -gt 0) { Fail "the runner check reported warnings: $($j.warnings -join '; ')" }
if (-not (Get-Task)) {
  $action = New-ScheduledTaskAction -Execute "$Opt\bin\hostsvc-supervisor.exe" -Argument ('run "' + $Cfg + '\supervisor.json"') -WorkingDirectory $State
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
}
$receipt.Add("task $TaskPath$TaskName $Opt\bin\hostsvc-supervisor.exe")
[IO.File]::WriteAllLines($Receipt, $receipt)
Write-Output "installed Windows stage $Label ($(if ($rerun) { 're-run, unchanged' } else { 'first install' })); receipt $Receipt"
Write-Output 'NOT started and no boot trigger. Next: windows\fill-data.ps1 artifacts ..., windows\fill-data.ps1 policy, windows\start.ps1'
