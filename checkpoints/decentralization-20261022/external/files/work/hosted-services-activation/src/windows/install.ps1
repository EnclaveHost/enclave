#Requires -RunAsAdministrator
# Compare-and-swap install of Windows stage @LABEL@. ADDS files, directories (ACLs only on those it creates) and one
# scheduled task \Enclave\enclave-host-services-@LABEL@ with NO trigger (manual start only: stage 1 is not enabled at
# boot). Changes no existing file, task, service, firewall rule or provider setting. Starts nothing.
#   windows\install.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' -ListenersFile .\listeners.txt
# ISOLATED (validation) install: add -InstallRoot <new dir under C:\ProgramData> -TaskName <name>, and optionally
# -FixtureDir <dir> holding a fixture host-services.json + bootstrap-manifest.json that replace the production
# configuration and manifest (never allowed without -InstallRoot). Every other step is the same.
param([Parameter(Mandatory = $true)][string]$NodeExe, [string]$ListenersFile = '', [string]$InstallRoot = '', [string]$TaskName = '', [string]$FixtureDir = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Use-StageRoot
if ($FixtureDir -and -not $Isolated) { Fail '-FixtureDir is only for an isolated install (-InstallRoot, -TaskName)' }
if ($FixtureDir) {
  if (-not [IO.Path]::IsPathRooted($FixtureDir) -or [IO.Path]::GetFullPath($FixtureDir) -ne $FixtureDir) { Fail "-FixtureDir must be a canonical absolute path (got '$FixtureDir')" }
  foreach ($f in 'host-services.json', 'bootstrap-manifest.json') { if (-not (Test-Path -LiteralPath "$FixtureDir\$f" -PathType Leaf)) { Fail "no $f in $FixtureDir" } }
  $fx = Get-Content -Raw -LiteralPath "$FixtureDir\host-services.json" | ConvertFrom-Json
  if ($fx.packagesDir -ne "$Opt\packages" -or $fx.stateRoot -ne $State) { Fail "the fixture configuration is not for this install root ($Opt\packages, $State)" }
} elseif (-not $ListenersFile) { Fail '-ListenersFile is required (the listener capture gen-config checks the ports against)' }
Test-StageSums
$inputs = Get-Content -Raw -LiteralPath (Join-Path $Stage 'STAGE-INPUTS.json') | ConvertFrom-Json
if ($inputs.packagesCurrent -ne $true -and $env:ALLOW_TEST_STAGE -ne '1') { Fail 'this is a TEST stage (its packages were not current with its tree): refusing to install' }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Fail "no node at $NodeExe" }
$major = [int](Invoke-Tool $NodeExe @('-p', "process.versions.node.split('.')[0]"))
if ($major -lt 22) { Fail "node $major at $NodeExe; >= 22 required" }
if ($env:ProgramFiles -ne 'C:\Program Files' -or $env:ProgramData -ne 'C:\ProgramData') { Fail 'the stage paths assume C:\Program Files and C:\ProgramData' }
# The receipt is written AS install goes (dirs, then each file, config, task) and ends with the line `complete`, so a
# failed install can always be undone exactly by rollback.ps1. A re-run is only a re-run of a COMPLETE install.
$rerun = Test-Path -LiteralPath $Receipt
if ($rerun -and @(Get-Content -LiteralPath $Receipt)[-1] -ne 'complete') {
  Fail "an earlier install did not complete ($Receipt): run windows\rollback.ps1 (it removes exactly what that install created), then install again" }
$files = @()
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'bin') -File) { $files += , @($f.FullName, "$Opt\bin\$($f.Name)") }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'packages') -File) { $files += , @($f.FullName, "$Opt\packages\$($f.Name)") }
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Stage 'windows') -File) { $files += , @($f.FullName, "$Opt\windows\$($f.Name)") }
$files += , @((Join-Path $Stage 'ACTIVATION-WINDOWS.txt'), "$Opt\ACTIVATION-WINDOWS.txt")
$files += , @((Join-Path $Stage 'STAGE-SHA256SUMS'), "$Opt\STAGE-SHA256SUMS")
$files += , @($(if ($FixtureDir) { "$FixtureDir\bootstrap-manifest.json" } else { Join-Path $Stage 'data\bootstrap-manifest.json' }), "$Data\bootstrap-manifest.json")
# compare-and-swap: a first install finds every target absent; a re-run finds exactly this stage's bytes
foreach ($p in $files) {
  if (Test-Path -LiteralPath $p[1]) {
    if (-not $rerun) { Fail "refusing: $($p[1]) already exists and no install receipt of this stage is present" }
    if ((Sha $p[0]) -ne (Sha $p[1])) { Fail "refusing: $($p[1]) differs from this stage" }
  }
}
if (-not $rerun) {
  if ($Isolated) {
    if (Test-Path -LiteralPath $Isolated) { Fail "refusing: $Isolated already exists (an isolated install creates its root)" }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $Isolated) -PathType Container)) { Fail "the parent of $Isolated does not exist" }
  }
  foreach ($d in $Opt, $Root) { if (Test-Path -LiteralPath $d) { Fail "refusing: $d already exists" } }
  if (Get-Task) { Fail "refusing: the scheduled task $TaskPath$TaskName already exists" }
}
# NOT $receipt: PowerShell names are case-insensitive and $Receipt is the receipt's PATH (common.ps1)
$receiptLines = New-Object System.Collections.Generic.List[string]
function Save-Receipt { [IO.File]::WriteAllLines($Receipt, [string[]]$receiptLines) }
if ($rerun) { foreach ($l in Get-Content -LiteralPath $Receipt) { if ($l -like 'dir *') { $receiptLines.Add($l) } } }
else {
  $parents = if ($Isolated) { @($Isolated) } else { @('C:\Program Files\Enclave', 'C:\Program Files\Enclave\host-services') }
  $mids = if ($Isolated) { @() } else { @('C:\ProgramData\Enclave', 'C:\ProgramData\Enclave\host-services') }
  foreach ($d in @($parents) + @($Opt, "$Opt\bin", "$Opt\packages", "$Opt\windows") + @($mids) + @($Root, $Cfg, $Data, "$Data\artifacts", "$Data\policy-import", $State)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null; $receiptLines.Add("dir $d") }
  }
  Save-Receipt
  if ($Isolated) {
    # the isolated root replaces Program Files too: SYSTEM and Administrators full, LOCAL SERVICE read, nothing inherited
    Invoke-Tool icacls.exe @($Isolated, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "${LocalService}:(OI)(CI)RX") | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "icacls $Isolated failed" }
  }
  # this stage's own directories only: SYSTEM and Administrators full, LOCAL SERVICE read; the state directory writable by it
  Invoke-Tool icacls.exe @($Root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "${LocalService}:(OI)(CI)RX") | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls $Root failed" }
  Invoke-Tool icacls.exe @($State, '/grant:r', "${LocalService}:(OI)(CI)M") | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "icacls $State failed" }
}
foreach ($p in $files) {
  if (-not (Test-Path -LiteralPath $p[1])) { Copy-Item -LiteralPath $p[0] -Destination $p[1] }
  $receiptLines.Add("file $(Sha $p[1]) $($p[1])")
  if (-not $rerun) { Save-Receipt }
}
# the exact configuration: the stage's public spec + this host's listener capture (refuses a port in use)
if (-not $rerun) {
  if ($FixtureDir) { Copy-Item -LiteralPath "$FixtureDir\host-services.json" -Destination "$Cfg\host-services.json" }
  else {
    Invoke-Tool $NodeExe @("$Opt\bin\stage-tool.mjs", 'gen-config', '--spec', (Join-Path $Stage 'config\spec.windows.json'), '--listeners', $ListenersFile, '--out', "$Cfg\host-services.json")
    if ($LASTEXITCODE -ne 0) { Fail 'gen-config refused (a port in use, or a malformed spec)' }
  }
  $receiptLines.Add("file $(Sha "$Cfg\host-services.json") $Cfg\host-services.json"); Save-Receipt
  $sup = Get-Content -Raw -LiteralPath (Join-Path $Stage 'config\supervisor.template.json') | ConvertFrom-Json
  $sup.node = $NodeExe
  if ($Isolated) {
    $sup.runner = "$Opt\bin\host-services-runner.mjs"; $sup.config = "$Cfg\host-services.json"; $sup.workDir = $State
    $sup.log = "$State\supervisor.log"; $sup.stopEvent = "Global\Enclave-host-services-$EventLabel-stop"
  }
  [IO.File]::WriteAllText("$Cfg\supervisor.json", ($sup | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
  $receiptLines.Add("file $(Sha "$Cfg\supervisor.json") $Cfg\supervisor.json"); Save-Receipt
} else {
  $receiptLines.Add("file $(Sha "$Cfg\host-services.json") $Cfg\host-services.json")
  $receiptLines.Add("file $(Sha "$Cfg\supervisor.json") $Cfg\supervisor.json")
}
Invoke-Tool "$Opt\bin\hostsvc-supervisor.exe" @('check', "$Cfg\supervisor.json")
if ($LASTEXITCODE -ne 0) { Fail 'the supervisor refuses supervisor.json' }
$check = Invoke-Tool $NodeExe @("$Opt\bin\host-services-runner.mjs", 'check', "$Cfg\host-services.json") | Out-String
if ($LASTEXITCODE -ne 0) { Fail "the runner refuses the configuration: $check" }
$j = $check | ConvertFrom-Json
if (-not $j.ok -or @($j.warnings).Count -gt 0) { Fail "the runner check reported warnings: $($j.warnings -join '; ')" }
if (-not (Get-Task)) {
  $action = New-ScheduledTaskAction -Execute "$Opt\bin\hostsvc-supervisor.exe" -Argument ('run "' + $Cfg + '\supervisor.json"') -WorkingDirectory $State
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
}
$receiptLines.Add("task $TaskPath$TaskName $Opt\bin\hostsvc-supervisor.exe")
$receiptLines.Add('complete')
Save-Receipt
Write-Output "installed Windows stage $Label ($(if ($rerun) { 're-run, unchanged' } else { 'first install' })); receipt $Receipt"
if ($Isolated) { Write-Output "ISOLATED install: root $Isolated, task $TaskPath$TaskName, stop event Global\Enclave-host-services-$EventLabel-stop" }
Write-Output 'NOT started and no boot trigger. Next: windows\fill-data.ps1 artifacts ..., windows\fill-data.ps1 policy, windows\start.ps1'
