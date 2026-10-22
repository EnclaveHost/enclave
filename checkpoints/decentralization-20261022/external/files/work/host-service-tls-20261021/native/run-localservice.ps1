# PREPARED FOR ROOT REVIEW - not yet reviewed or approved; NOT run by Claude. ONE-SHOT: run the native G3 harness ONCE as NT AUTHORITY\LOCAL SERVICE, the identity
# the hs2 service-tls role runs as. Windows PowerShell 5.1, elevated. Invoke with:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File run-localservice.ps1 -BundlePath <uploaded bundle> -NodeSha256 <hex>
# -NodeSha256: read it first, read-only: (Get-FileHash -Algorithm SHA256 'C:\Program Files\nodejs\node.exe').Hash
# What it creates, ALL owned by this run (unique id) and removed in `finally`, whatever happens:
#   task    \Enclave\g3-native-once-<runId>   (the EXISTING \Enclave\ folder hs2 uses; unique leaf; refused if it exists)
#   dir     C:\ProgramData\Enclave\host-services\hs2\state\g3-native-<runId>   (inherits the hs2 state ACL; refused if it exists)
# Kept after the run: the receipt copy C:\ProgramData\Enclave\staging\g3-native-receipt-<runId>.json
# Exit 0 only if ALL hold: node and bundle hashes pinned; the task ran and returned 0 within 120 s; the receipt says pass
# true and user LOCAL SERVICE; the task is unregistered and the run directory removed.
param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$NodeSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$PinnedBundleSha = '6853dd16e824c5a546b01ba87e227af440d8a39b5f29fefb7fb642609cb16524'
$PinnedNodeExe = 'C:\Program Files\nodejs\node.exe'
$PinnedNodeVersion = 'v24.16.0'
$StateRoot = 'C:\ProgramData\Enclave\host-services\hs2\state'
$Staging = 'C:\ProgramData\Enclave\staging'
$RunId = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$TaskFolder = '\Enclave\'
$TaskLeaf = 'g3-native-once-' + $RunId
$RunDir = Join-Path $StateRoot ('g3-native-' + $RunId)
$ReceiptCopy = Join-Path $Staging ('g3-native-receipt-' + $RunId + '.json')
$Summary = [ordered]@{ runId = $RunId; task = $TaskFolder + $TaskLeaf; runDir = $RunDir; pass = $false }
function Sha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }

$registered = $false
$createdDir = $false
try {
  # pins first: nothing is created unless node and the bundle are the reviewed bytes
  if ((Sha $PinnedNodeExe) -ne $NodeSha256.ToLowerInvariant()) { throw 'node.exe is not the pinned sha256' }
  $ver = (& $PinnedNodeExe --version 2>$null | Out-String).Trim()
  if ($ver -ne $PinnedNodeVersion) { throw ('node version ' + $ver + ' is not ' + $PinnedNodeVersion) }
  if ((Sha $BundlePath) -ne $PinnedBundleSha) { throw 'the bundle is not the pinned sha256' }
  if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) { throw 'hs2 state directory missing' }
  if (Test-Path -LiteralPath $RunDir) { throw 'run directory already exists' }
  if (Get-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -ErrorAction SilentlyContinue) { throw 'task already exists' }

  New-Item -ItemType Directory -Path $RunDir | Out-Null
  $createdDir = $true
  $RunBundle = Join-Path $RunDir 'g3-native.bundle.mjs'
  Copy-Item -LiteralPath $BundlePath -Destination $RunBundle
  if ((Sha $RunBundle) -ne $PinnedBundleSha) { throw 'the copied bundle is not the pinned sha256' }

  $action = New-ScheduledTaskAction -Execute $PinnedNodeExe -Argument ('"' + $RunBundle + '" "' + $RunDir + '"') -WorkingDirectory $RunDir
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -DontStopOnIdleEnd
  Register-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -Action $action -Principal $principal -Settings $settings | Out-Null
  $registered = $true
  Start-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf
  $t0 = Get-Date
  do {
    Start-Sleep -Seconds 2
    $state = [string](Get-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf).State
  } while (($state -eq 'Running' -or $state -eq 'Queued') -and ((Get-Date) - $t0).TotalSeconds -lt 120)
  if ($state -eq 'Running' -or $state -eq 'Queued') {
    Stop-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf
    $Summary.timedOut = $true
  }
  $Summary.taskResult = [int64](Get-ScheduledTaskInfo -TaskPath $TaskFolder -TaskName $TaskLeaf).LastTaskResult

  $receiptFile = Get-ChildItem -LiteralPath $RunDir -Filter 'g3-native-receipt-*.json' -File | Sort-Object Name | Select-Object -Last 1
  if ($receiptFile) {
    $raw = Get-Content -LiteralPath $receiptFile.FullName -Raw
    Set-Content -LiteralPath $ReceiptCopy -Value $raw -Encoding UTF8
    $Summary.receiptCopy = $ReceiptCopy
    $r = $raw | ConvertFrom-Json
    $Summary.receiptPass = [bool]$r.pass
    $Summary.receiptUser = [string]$r.user
    $Summary.receiptNode = [string]$r.node
  } else { $Summary.receipt = 'missing' }
} catch {
  $Summary.error = [string]$_.Exception.Message
} finally {
  # cleanup of this run's OWN objects only (exact task path+name, exact directory)
  if ($registered) {
    try { Stop-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -Confirm:$false } catch { $Summary.cleanupTaskError = [string]$_.Exception.Message }
  }
  $Summary.taskRemoved = -not [bool](Get-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -ErrorAction SilentlyContinue)
  if ($createdDir) {
    try { Remove-Item -LiteralPath $RunDir -Recurse -Force } catch { $Summary.cleanupDirError = [string]$_.Exception.Message }
  }
  $Summary.dirRemoved = -not (Test-Path -LiteralPath $RunDir)
}
$Summary.pass = (-not $Summary.Contains('error')) -and (-not $Summary.Contains('timedOut')) -and $Summary.Contains('taskResult') -and ($Summary.taskResult -eq 0) -and
  $Summary.Contains('receiptPass') -and $Summary.receiptPass -and ($Summary.receiptUser -match '^(LOCAL SERVICE|LocalService)$') -and $Summary.taskRemoved -and $Summary.dirRemoved
'RESULT ' + ($Summary | ConvertTo-Json -Compress)
if ($Summary.pass) { exit 0 } else { exit 1 }
