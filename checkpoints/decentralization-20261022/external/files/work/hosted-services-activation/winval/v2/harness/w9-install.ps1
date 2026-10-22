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
function Tail([string]$text, [int]$n = 1500) { if ($text.Length -gt $n) { '...' + $text.Substring($text.Length - $n) } else { $text } }
# a stage script, in this process; its exit code and its whole output as ONE plain string (never a provider-decorated object)
function Stage([string]$script, [hashtable]$a) {
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  $threw = $false
  $out = try { & "$S\windows\$script" @a *>&1 | ForEach-Object { [string]$_ } } catch { $threw = $true; 'TERMINATING: ' + [string]$_ }
  # a terminating error does not set an exit code: it is reported as rc -1, never as success
  [ordered]@{ rc = $(if ($threw -or (($out | Out-String) -match 'TERMINATING: ')) { -1 } else { [int]$global:LASTEXITCODE }); out = [string](($out | Out-String).Trim()) }
}
function Ours { @(Get-Process | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -and $p.StartsWith($V, 'OrdinalIgnoreCase') } | ForEach-Object { '' + $_.Id + ' ' + $_.ProcessName }) }
function TaskInfo {
  $t = Get-ScheduledTask -TaskPath '\' -TaskName $TN -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  [ordered]@{ path = [string]$t.TaskPath; name = [string]$t.TaskName; state = [string]$t.State; user = [string]$t.Principal.UserId
    logonType = [string]$t.Principal.LogonType; runLevel = [string]$t.Principal.RunLevel; triggers = @($t.Triggers | Where-Object { $_ }).Count   # @($null).Count is 1
    execute = [string]$t.Actions[0].Execute; arguments = [string]$t.Actions[0].Arguments; workDir = [string]$t.Actions[0].WorkingDirectory }
}
function AclOf([string]$p) {
  $a = Get-Acl -LiteralPath $p
  [ordered]@{ protected = [bool]$a.AreAccessRulesProtected
    rules = @($a.Access | ForEach-Object { '{0} {1} {2} inherited={3}' -f [string]$_.IdentityReference, [string]$_.FileSystemRights, [string]$_.AccessControlType, [bool]$_.IsInherited }) }
}
function ReceiptCheck {
  $problems = @(); $n = 0
  foreach ($l in [IO.File]::ReadAllLines("$IR\root\config\install-receipt.txt")) {
    if ($l -match '^file ([0-9a-f]{64}) (.+)$') { $n++
      if (-not $Matches[2].StartsWith("$IR\", 'OrdinalIgnoreCase')) { $problems += "outside the root: $($Matches[2])" }
      elseif ((Get-FileHash -Algorithm SHA256 -LiteralPath $Matches[2]).Hash.ToLower() -ne $Matches[1]) { $problems += "hash: $($Matches[2])" } }
    elseif ($l -match '^dir (.+)$') { if (-not $Matches[1].StartsWith($IR, 'OrdinalIgnoreCase')) { $problems += "dir outside the root: $($Matches[1])" } }
    elseif ($l -ne 'complete' -and $l -notmatch ('^task \\' + [regex]::Escape($TN) + ' ')) { $problems += "unexpected receipt line: $l" }
  }
  $all = [IO.File]::ReadAllLines("$IR\root\config\install-receipt.txt")
  if ($all[-1] -ne 'complete') { $problems += 'the receipt does not end with complete' }
  [ordered]@{ files = $n; problems = $problems }
}
$fxProc = $null
try {
  Mark 'start'
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force       # THIS process only; the machine policy is untouched
  Check 'pre: the isolated root and our task do not exist yet' ((-not (Test-Path -LiteralPath $IR)) -and -not (TaskInfo)) $null

  # 1. guards, on common.ps1 alone (it writes nothing): each must refuse; the production defaults are unchanged
  $guard = "$W\guard\guard.ps1"
  $cases = [ordered]@{
    'InstallRoot without TaskName'               = @{ InstallRoot = $IR }
    'TaskName without InstallRoot'               = @{ TaskName = $TN }
    'inside the production ProgramData root'     = @{ InstallRoot = 'C:\ProgramData\Enclave\host-services\hs2-iso'; TaskName = $TN }
    'an ancestor of the production root'         = @{ InstallRoot = 'C:\ProgramData\Enclave'; TaskName = $TN }
    'non-canonical (..)'                         = @{ InstallRoot = "$W\x\..\install"; TaskName = $TN }
    'not under C:\ProgramData'                   = @{ InstallRoot = 'C:\Program Files\EnclaveIso'; TaskName = $TN }
    'trailing backslash'                         = @{ InstallRoot = "$IR\"; TaskName = $TN }
    'the production task name'                   = @{ InstallRoot = $IR; TaskName = 'enclave-host-services-hs2' }
    'a task name with a path separator'          = @{ InstallRoot = $IR; TaskName = 'a\b' }
  }
  $g = [ordered]@{}
  foreach ($k in $cases.Keys) { $a = $cases[$k]; $r = & { $ErrorActionPreference = 'Continue'; & $guard @a *>&1 | ForEach-Object { [string]$_ } }; $g[$k] = [ordered]@{ rc = [int]$LASTEXITCODE; out = Tail (($r | Out-String).Trim()) 300 } }
  Check 'W9 guards: every unsafe -InstallRoot/-TaskName is refused (exit 3) by common.ps1' (@($g.Values | Where-Object { $_.rc -ne 3 }).Count -eq 0) $g
  $global:LASTEXITCODE = 0
  $okIso = & { $ErrorActionPreference = 'Continue'; & $guard -InstallRoot $IR -TaskName $TN *>&1 | ForEach-Object { [string]$_ } }
  $okIsoRc = [int]$LASTEXITCODE
  $global:LASTEXITCODE = 0
  $okProd = & { $ErrorActionPreference = 'Continue'; & $guard *>&1 | ForEach-Object { [string]$_ } }
  $okProdRc = [int]$LASTEXITCODE
  $isoTxt = ($okIso | Out-String).Trim(); $prodTxt = ($okProd | Out-String).Trim()
  Check 'W9 guards: the isolated paths resolve under the root; the defaults are still production' ($okIsoRc -eq 0 -and $okProdRc -eq 0 -and $isoTxt -like "*opt=$IR\program *" -and $isoTxt -like "*task=\$TN *" -and $prodTxt -like '*opt=C:\Program Files\Enclave\host-services\hs2 root=C:\ProgramData\Enclave\host-services\hs2 task=\Enclave\enclave-host-services-hs2 event=hs2') ([ordered]@{ isolated = $isoTxt; production = $prodTxt })
  Check 'W9 guards wrote nothing' ((-not (Test-Path -LiteralPath $IR)) -and -not (Test-Path -LiteralPath 'C:\ProgramData\Enclave\host-services') -and -not (Test-Path -LiteralPath 'C:\Program Files\Enclave\host-services') -and -not (Test-Path -LiteralPath 'C:\ProgramData\Enclave\host-services\hs2-iso')) $null

  # 2. the fixture world (loopback chain + policy carrier + synthetic artifacts) for THIS install root
  $fxProc = Start-Process -FilePath $NODE -ArgumentList @("$W\fixtures\fixture-world.mjs", '--install', $FX, "$S\packages", "$W\fixtures\app-static.json", "$IR\program\packages", "$IR\root\state", "$IR\root\data") -WindowStyle Hidden -PassThru
  Check 'fixture world up' (Wait-Until { Test-Path -LiteralPath "$FX\world.json" } 60) $null
  $world = [IO.File]::ReadAllText("$FX\world.json") | ConvertFrom-Json

  $iso = @{ InstallRoot = $IR; TaskName = $TN }
  # 3a. an install that FAILS after writing (the runner refuses a wrong package pin): its partial receipt lets rollback
  #     undo exactly what it created; a re-install over it is refused
  $BAD = "$W\fixture-bad"
  New-Item -ItemType Directory -Path $BAD | Out-Null
  Copy-Item -LiteralPath "$FX\bootstrap-manifest.json" -Destination "$BAD\bootstrap-manifest.json"
  $badCfg = [IO.File]::ReadAllText("$FX\host-services.json") -replace '"package":\s*"sha256:[0-9a-f]{64}"', ('"package": "sha256:' + ('0' * 64) + '"')
  [IO.File]::WriteAllText("$BAD\host-services.json", $badCfg, (New-Object System.Text.UTF8Encoding $false))
  $r = Stage 'install.ps1' (@{ NodeExe = $NODE; FixtureDir = $BAD } + $iso)
  $partial = @(if (Test-Path -LiteralPath "$IR\root\config\install-receipt.txt") { [IO.File]::ReadAllLines("$IR\root\config\install-receipt.txt") })
  Check 'W9 failed install: refused (exit 3) after writing; its receipt lists what it created and is not complete' ($r.rc -eq 3 -and $r.out -match 'runner refuses' -and $partial.Count -gt 10 -and $partial[-1] -ne 'complete' -and -not (TaskInfo)) ([ordered]@{ out = Tail $r.out 500; receiptLines = $partial.Count; last = $(if ($partial.Count) { $partial[-1] } else { $null }) })
  $r = Stage 'install.ps1' (@{ NodeExe = $NODE; FixtureDir = $FX } + $iso)
  Check 'W9 failed install: a new install over it is refused (exit 3, did not complete)' ($r.rc -eq 3 -and $r.out -match 'did not complete') (Tail $r.out 400)
  $r = Stage 'rollback.ps1' $iso
  Check 'W9 failed install: rollback removes exactly what it created (exit 0; the isolated root is gone)' ($r.rc -eq 0 -and -not (Test-Path -LiteralPath $IR) -and -not (TaskInfo)) (Tail $r.out 600)

  # 3. the real install
  $r = Stage 'install.ps1' (@{ NodeExe = $NODE; FixtureDir = $FX } + $iso)
  Check 'W9 install: exit 0' ($r.rc -eq 0) (Tail $r.out)
  $ti = TaskInfo
  Check 'W9 install: one task \<name>, LOCAL SERVICE, no trigger, Ready (not started), action = the installed supervisor' ($null -ne $ti -and $ti.path -eq '\' -and $ti.user -match 'LOCAL SERVICE' -and $ti.triggers -eq 0 -and $ti.state -eq 'Ready' -and $ti.execute -eq "$IR\program\bin\hostsvc-supervisor.exe") $ti
  $rc1 = ReceiptCheck
  Check 'W9 install: every receipt file is inside the root and matches its recorded sha256' ($rc1.files -gt 20 -and $rc1.problems.Count -eq 0) $rc1
  $stageSums = @{}; foreach ($l in [IO.File]::ReadAllLines("$S\STAGE-SHA256SUMS")) { if ($l -match '^([0-9a-f]{64})  (.+)$') { $stageSums[$Matches[2]] = $Matches[1] } }
  $mism = @(); foreach ($rel in 'bin/hostsvc-supervisor.exe', 'bin/host-services-runner.mjs', 'bin/stage-tool.mjs', 'windows/install.ps1', 'windows/rollback.ps1', 'ACTIVATION-WINDOWS.txt') {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath ("$IR\program\" + ($rel -replace '/', '\'))).Hash.ToLower() -ne $stageSums[$rel]) { $mism += $rel } }
  Check 'W9 install: installed bytes are the stage''s (STAGE-SHA256SUMS)' ($mism.Count -eq 0) $mism
  $acl = [ordered]@{ root = AclOf $IR; state = AclOf "$IR\root\state"; bin = AclOf "$IR\program\bin" }
  $rootRules = $acl.root.rules -join ' | '
  Check 'W9 install: ACL - nothing inherited at the root; SYSTEM/Administrators full, LOCAL SERVICE read; state LOCAL SERVICE modify' ($acl.root.protected -and $rootRules -match 'SYSTEM FullControl' -and $rootRules -match 'Administrators FullControl' -and $rootRules -match 'LOCAL SERVICE ReadAndExecute' -and @($acl.root.rules).Count -eq 3 -and ($acl.state.rules -join ' | ') -match 'LOCAL SERVICE Modify') $acl
  $sup = [IO.File]::ReadAllText("$IR\root\config\supervisor.json") | ConvertFrom-Json
  Check 'W9 install: supervisor.json names only the isolated root, its own stop event, the production limits' ($sup.runner -eq "$IR\program\bin\host-services-runner.mjs" -and $sup.config -eq "$IR\root\config\host-services.json" -and $sup.workDir -eq "$IR\root\state" -and $sup.stopEvent -match '^Global\\Enclave-host-services-hs2-[0-9a-f]{8}-stop$' -and $sup.jobMemoryMiB -eq 1024 -and $sup.cpuPercent -eq 150) ([ordered]@{ runner = [string]$sup.runner; config = [string]$sup.config; stopEvent = [string]$sup.stopEvent; jobMemoryMiB = $sup.jobMemoryMiB; cpuPercent = $sup.cpuPercent; node = [string]$sup.node })
  Check 'W9 install started nothing (only the fixture world runs)' (@(Ours | Where-Object { $_ -notmatch ('^' + $fxProc.Id + ' ') }).Count -eq 0) @(Ours)

  # 4. idempotent re-run
  $receiptBefore = [IO.File]::ReadAllText("$IR\root\config\install-receipt.txt")
  $r = Stage 'install.ps1' (@{ NodeExe = $NODE; FixtureDir = $FX } + $iso)
  Check 'W9 re-run: exit 0, "re-run, unchanged", the same receipt' ($r.rc -eq 0 -and $r.out -match 're-run, unchanged' -and [IO.File]::ReadAllText("$IR\root\config\install-receipt.txt") -eq $receiptBefore) (Tail $r.out 400)

  # 5. public data, start, health
  $r = Stage 'fill-data.ps1' (@{ What = 'artifacts'; ToolArgs = @('--from-dir', "$FX\artifacts") } + $iso)
  Check 'W9 fill-data artifacts (every object kept only after its sha256 matched)' ($r.rc -eq 0) (Tail $r.out 600)
  $r = Stage 'start.ps1' (@{ WaitSeconds = 240 } + $iso)
  Check 'W9 start: the task runs and stage-1 health is all PASS' ($r.rc -eq 0 -and $r.out -notmatch '(?m)^FAIL') (Tail $r.out 2500)
  $ti = TaskInfo
  Check 'W9 start: the task is Running as LOCAL SERVICE' ($null -ne $ti -and $ti.state -eq 'Running') $ti

  # 6. fixture ban / unban (fixture chain only)
  $null = Invoke-RestMethod -Method Post -Uri "$($world.control)/ban" -TimeoutSec 20
  $hb = $null
  $banned = Wait-Until { $script:hb = Stage 'health.ps1' $iso; $script:hb.rc -eq 2 -and $script:hb.out -match 'banned by platform policy' } 120
  Check 'W9 fixture ban: health fails on the gate; the task stays Running' ($banned -and (TaskInfo).state -eq 'Running') (Tail $(if ($hb) { $hb.out } else { '' }) 1200)
  $null = Invoke-RestMethod -Method Post -Uri "$($world.control)/unban" -TimeoutSec 20
  $r = Stage 'health.ps1' (@{ WaitSeconds = 180 } + $iso)
  Check 'W9 fixture unban: health PASS again' ($r.rc -eq 0) (Tail $r.out 1200)

  # 7. stop
  $r = Stage 'stop.ps1' $iso
  $slog = [IO.File]::ReadAllText("$IR\root\state\supervisor.log")
  Check 'W9 stop: exit 0, graceful (runner stopped (0), job not terminated), no stage port listening, task Ready' ($r.rc -eq 0 -and $slog -match 'runner stopped \(0\)' -and $slog -notmatch 'terminating the job' -and (TaskInfo).state -eq 'Ready') ([ordered]@{ out = Tail $r.out 600; supervisorLog = Tail $slog 1500 })
  Check 'W9 stop: no process of the install remains' (Wait-Until { @(Ours | Where-Object { $_ -notmatch ('^' + $fxProc.Id + ' ') }).Count -eq 0 } 20) @(Ours)

  # 8. compare-and-swap: a changed installed file is refused by a re-run and KEPT by rollback (exit 4)
  $tamper = "$IR\program\ACTIVATION-WINDOWS.txt"
  Add-Content -LiteralPath $tamper -Value 'changed after install (W9 test)'
  $r = Stage 'install.ps1' (@{ NodeExe = $NODE; FixtureDir = $FX } + $iso)
  Check 'W9 CAS: a re-run refuses a changed installed file (exit 3)' ($r.rc -eq 3 -and $r.out -match 'differs from this stage') (Tail $r.out 400)
  $r = Stage 'rollback.ps1' $iso
  $left1 = @(Get-ChildItem -LiteralPath $IR -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($IR.Length) } | Sort-Object)
  Check 'W9 rollback with a changed file: exit 4; the task, state, data and every unchanged file removed; the changed file and the receipt KEPT' ($r.rc -eq 4 -and -not (TaskInfo) -and (Test-Path -LiteralPath $tamper) -and -not (Test-Path -LiteralPath "$IR\root\state") -and -not (Test-Path -LiteralPath "$IR\root\data\artifacts") -and ($left1 -join ',') -eq '\program\ACTIVATION-WINDOWS.txt,\root\config\install-receipt.txt') ([ordered]@{ out = Tail $r.out 600; left = $left1 })

  # 9. restore the original bytes; rollback again: exactly the pre-install state
  Copy-Item -LiteralPath "$S\ACTIVATION-WINDOWS.txt" -Destination $tamper -Force
  $r = Stage 'rollback.ps1' $iso
  Check 'W9 rollback after restoring the file: exit 0; the isolated root and the task are gone' ($r.rc -eq 0 -and -not (Test-Path -LiteralPath $IR) -and -not (TaskInfo)) (Tail $r.out 600)
} catch {
  Check 'harness: no unexpected error' $false ([string]$_ + ' at ' + [string]$_.InvocationInfo.PositionMessage)
} finally {
  if ($fxProc -and -not $fxProc.HasExited) {
    try { $null = Invoke-RestMethod -Method Post -Uri "$($world.control)/shutdown" -TimeoutSec 10 } catch { }
    $null = $fxProc.WaitForExit(15000)
  }
  Check 'end: no process of ours remains; our task is absent' (Wait-Until { @(Ours).Count -eq 0 } 20) ([ordered]@{ ours = @(Ours); task = TaskInfo })
  Mark 'done'
  [ordered]@{ results = $results } | ConvertTo-Json -Depth 6
  if (@($results.Values | Where-Object { -not $_.ok }).Count) { exit 2 } else { exit 0 }
}
