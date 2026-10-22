# Own only this stage's exact scheduled task. No process enumeration or command-line substring termination.
param([Parameter(Mandatory)][string]$CanaryDir, [switch]$Apply, [switch]$Stop)
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = if ($Stop) { 'manager-stop' } else { 'manager-start' }
if ((Require-Approval $CanaryDir $step -Apply:$Apply) -ne $true) { return }
$stage = Get-Content -LiteralPath (Join-Path $CanaryDir 'stage.json') -Raw | ConvertFrom-Json
if ($stage.format -cne 'enclave-shield-hardware-canary-stage/2' -or $stage.commit -cnotmatch '^[0-9a-f]{40}$' -or
    $stage.port -ne 18091 -or $stage.canaryDir -cne [IO.Path]::GetFullPath($CanaryDir) -or $stage.prefix -cne $CanaryPrefix -or
    $stage.marker -cne 'enclave-canary-vbslike-domain') { throw 'invalid canary stage' }
$expectedDir = "C:\ProgramData\Enclave\staging\canary-$($stage.commit.Substring(0,8))"
if ($CanaryDir -cne $expectedDir) { throw 'unexpected stage directory' }
$cmdFile = Join-Path $CanaryDir 'canary-env.cmd'
if ($stage.managerCommandSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    (Get-FileHash -LiteralPath $cmdFile -Algorithm SHA256).Hash.ToLower() -cne $stage.managerCommandSha256) { throw 'manager command changed after staging' }
$taskPath = '\Enclave-Canary\'; $taskName = "Manager-$($stage.commit.Substring(0,8))"
$exe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$arguments = '/d /s /c ""' + $cmdFile + '""'
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  $actions = @($task.Actions)
  if ($actions.Count -ne 1 -or $actions[0].Execute -ine $exe -or $actions[0].Arguments -cne $arguments -or
      @('SYSTEM','S-1-5-18') -notcontains $task.Principal.UserId) { throw 'existing scheduled task is not this stage; nothing changed' }
}
if ($Stop) {
  if ($task) { Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName }
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $listeners = @(Get-NetTCPConnection -LocalPort 18091 -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($listeners.Count) { throw 'canary port still has a listener; no processes killed and task retained for review' }
  if ($task) { Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false }
  Write-Output 'this stage manager stopped; production tasks unchanged'; return
}
if (@(Get-NetTCPConnection -LocalPort 18091 -State Listen -ErrorAction SilentlyContinue).Count) { throw 'canary port is already occupied; verify or stop its owner before starting' }
if (-not $task) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
Write-Output "started $taskPath$taskName; verify scope before creating any test VM"
