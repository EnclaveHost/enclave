# W9: the REAL Windows stage installer, end to end, in an ISOLATED root and task namespace on minipc (root-authorized:
# C:\ProgramData\Enclave\host-services-install-validation-20261021 and task names containing
# EnclaveHostServicesInstallValidation-20261021). Fixture chain only (loopback, throwaway key); no production path, task,
# port, key, env or DB. Stage scripts run IN THIS PROCESS after a PROCESS-scope execution-policy bypass (never the machine
# policy), exactly as ACTIVATION-WINDOWS.txt tells root to run them.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$V    = 'C:\ProgramData\Enclave\host-services-install-validation-20261021'
$W    = "$V\w9"
$S    = "$W\stage\enclave-host-services-hs2-windows"
$IR   = "$W\install"
$TN   = 'EnclaveHostServicesInstallValidation-20261021-hs2'
$FX   = "$W\fixture"
$NODE = "$W\node\node.exe"
$plog = "$W\harness-progress.log"
$results = [ordered]@{}
function Mark([string]$m) { Add-Content -LiteralPath $plog -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $m) }
function Check([string]$name, [bool]$ok, $detail) { $results[$name] = [ordered]@{ ok = $ok; detail = $detail }; Mark ("{0} {1}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name) }
function Wait-Until([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { try { if (& $cond) { return $true } } catch { }; Start-Sleep -Milliseconds 500 }
  return $false
}
function Tail([string]$s, [int]$n = 1500) { $s = [string]$s; if ($s.Length -gt $n) { '...' + $s.Substring($s.Length - $n) } else { $s } }
# a stage script, in this process; its exit code and its whole output as ONE plain string (never a provider-decorated object)
function Stage([string]$script, [hashtable]$a) {
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  $out = try { & "$S\windows\$script" @a *>&1 | ForEach-Object { [string]$_ } } catch { 'TERMINATING: ' + [string]$_ }
  [ordered]@{ rc = [int]$global:LASTEXITCODE; out = [string](($out | Out-String).Trim()) }
}
function Ours { @(Get-Process | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -and $p.StartsWith($V, 'OrdinalIgnoreCase') } | ForEach-Object { '' + $_.Id + ' ' + $_.ProcessName }) }
function TaskInfo {
  $t = Get-ScheduledTask -TaskPath '\' -TaskName $TN -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  [ordered]@{ path = [string]$t.TaskPath; name = [string]$t.TaskName; state = [string]$t.State; user = [string]$t.Principal.UserId
    logonType = [string]$t.Principal.LogonType; runLevel = [string]$t.Principal.RunLevel; triggers = @($t.Triggers).Count
    execute = [string]$t.Actions[0].Execute; arguments = [string]$t.Actions[0].Arguments; workDir = [string]$t.Actions[0].WorkingDirectory }
}
function AclOf([string]$p) {
  $a = Get-Acl -LiteralPath $p
  [ordered]@{ protected = [bool]$a.AreAccessRulesProtected
    rules = @($a.Access | ForEach-Object { '{0} {1} {2} inherited={3}' -f [string]$_.IdentityReference, [string]$_.FileSystemRights, [string]$_.AccessControlType, [bool]$_.IsInherited }) }
}
function ReceiptCheck {
  $bad = @(); $n = 0
  foreach ($l in [IO.File]::ReadAllLines("$IR\root\config\install-receipt.txt")) {
    if ($l -match '^file ([0-9a-f]{64}) (.+)$') { $n++
      if (-not $Matches[2].StartsWith("$IR\", 'OrdinalIgnoreCase')) { $bad += "outside the root: $($Matches[2])" }
      elseif ((Get-FileHash -Algorithm SHA256 -LiteralPath $Matches[2]).Hash.ToLower() -ne $Matches[1]) { $bad += "hash: $($Matches[2])" } }
    elseif ($l -match '^dir (.+)$') { if (-not $Matches[1].StartsWith($IR, 'OrdinalIgnoreCase')) { $bad += "dir outside the root: $($Matches[1])" } }
    elseif ($l -notmatch ('^task \\' + [regex]::Escape($TN) + ' ')) { $bad += "unexpected receipt line: $l" }
  }
  [ordered]@{ files = $n; problems = $bad }
}

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$before = [ordered]@{ W = $W; S = $S; IR = $IR; FX = $FX; NODE = $NODE; TN = $TN }
$guard = "$W\guard\guard.ps1"
$r = & { $ErrorActionPreference = 'Continue'; & $guard -InstallRoot $IR *>&1 | ForEach-Object { [string]$_ } }
$after = [ordered]@{ W = $W; S = $S; IR = $IR; FX = $FX; NODE = $NODE; TN = $TN }
"before: " + (($before.GetEnumerator() | ForEach-Object { $_.Key + '=' + [string]$_.Value }) -join ' | ')
"after:  " + (($after.GetEnumerator() | ForEach-Object { $_.Key + '=' + [string]$_.Value }) -join ' | ')
