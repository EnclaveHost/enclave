# child-test.ps1 - REAL child processes (Linux pwsh 7) through the helper's three bounded process functions: a read that overruns
# its budget is killed and its exit confirmed; a task request is confirmed only by exit 0, a hang/throw is 'unknown'; a swap child
# that hangs is killed (timedOut, no decision), a wrong script sha never runs (exit 3), a crash is reported with its code.
# The task cmdlets come from a fake ScheduledTasks module on PSModulePath (Linux has none). Not native Windows evidence.
param([string]$Helper)
$ErrorActionPreference = 'Stop'; $t = $null; $e = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Helper), [ref]$t, [ref]$e); if ($e.Count) { throw 'parse errors' }
foreach ($n in 'Invoke-BoundedQuery', 'Invoke-TaskCommand', 'Invoke-SwapChild') {
  $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)); if ($f.Count -ne 1) { throw "missing $n" }
  . ([scriptblock]::Create($f[0].Extent.Text)) }
function Assert($v, $m) { if (-not $v) { throw $m } }
function Gone($id) { -not (Get-Process -Id $id -ErrorAction SilentlyContinue) }
$w = Join-Path ([IO.Path]::GetTempPath()) ('child-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); [void](New-Item -ItemType Directory $w)
try {
  # 1 bounded reads
  $r = Invoke-BoundedQuery { 21 * 2 } 10000; Assert ($r.ok -and @($r.value)[0] -eq 42 -and $r.childExited) 'a fast read'
  $r = Invoke-BoundedQuery { Start-Sleep -Seconds 30; 1 } 4000
  Assert (-not $r.ok -and $r.timedOut -and $r.childExited -and $r.elapsedMs -lt 4500 -and (Gone $r.childId)) "an overrunning read was not killed inside its budget ($($r.elapsedMs) ms)"
  $r = Invoke-BoundedQuery { throw 'x' } 10000; Assert (-not $r.ok -and $r.reason -eq 'query process failed') 'a failing read'
  $bad = $false; try { $null = Invoke-BoundedQuery { 1 } 2000 } catch { $bad = $true }; Assert $bad 'a budget without cleanup room'
  # 2 task requests (fake module)
  $m = Join-Path $w 'ScheduledTasks'; [void](New-Item -ItemType Directory $m)
  Set-Content (Join-Path $m 'ScheduledTasks.psm1') @'
function Stop-ScheduledTask { param($TaskPath, $TaskName) Add-Content $env:FAKE_TASK_LOG "Stop $TaskPath$TaskName"; switch ($env:FAKE_TASK_MODE) { 'hang' { Start-Sleep -Seconds 60 } 'throw' { throw 'the service did not answer' } } }
function Start-ScheduledTask { param($TaskPath, $TaskName) Add-Content $env:FAKE_TASK_LOG "Start $TaskPath$TaskName"; switch ($env:FAKE_TASK_MODE) { 'hang' { Start-Sleep -Seconds 60 } 'throw' { throw 'x' } } }
'@
  $env:PSModulePath = $w + [IO.Path]::PathSeparator + $env:PSModulePath; $env:FAKE_TASK_LOG = Join-Path $w 'task.log'
  $env:FAKE_TASK_MODE = 'ok'; $c = Invoke-TaskCommand 'Stop' '\Enclave\' 'Node' 15000
  Assert ($c.responseConfirmed -and $c.outcome -eq 'response-confirmed' -and (Get-Content $env:FAKE_TASK_LOG) -contains 'Stop \Enclave\Node') 'a confirmed stop'
  $env:FAKE_TASK_MODE = 'hang'; $c = Invoke-TaskCommand 'Start' '\Enclave\' 'Node' 4000
  Assert (-not $c.responseConfirmed -and $c.outcome -eq 'unknown' -and $c.timedOut -and $c.childExited -and $c.elapsedMs -lt 4500 -and (Gone $c.childId)) "a hung request ($($c.elapsedMs) ms)"
  $env:FAKE_TASK_MODE = 'throw'; $c = Invoke-TaskCommand 'Stop' '\Enclave\' 'Node' 15000
  Assert (-not $c.responseConfirmed -and $c.outcome -eq 'unknown' -and -not $c.timedOut) 'a throwing request is unknown, never not-started'
  # 3 swap children (a stand-in swap script pinned by sha; TR off, so no prelude)
  $script:TR = ''
  $fake = Join-Path $w 'swap.ps1'
  Set-Content $fake @'
param($Mode, $Target, $WorkDir, $OldSha, $NewFile, $NewSha, $ExpectCurrent, $Node)
if ($Mode -eq 'hang') { Start-Sleep -Seconds 60 }
if ($Mode -eq 'crash') { exit 7 }
[ordered]@{ decision = "applied (test $Target)" } | ConvertTo-Json -Compress; exit 0
'@
  $fsha = (Get-FileHash -Algorithm SHA256 -LiteralPath $fake).Hash.ToLower()
  $script:PRM = [pscustomobject]@{ bundleSwap = [pscustomobject]@{ path = $fake; sha = $fsha }; testPrelude = $null }
  $c = Invoke-SwapChild @{ Mode = 'apply'; Target = "it's quoted" } 15000
  Assert ($c.exited -and $c.exitCode -eq 0 -and $c.decision -eq "applied (test it's quoted)") "a decision ($($c.decision))"
  $c = Invoke-SwapChild @{ Mode = 'hang' } 4000
  Assert ($c.timedOut -and $c.exited -and $null -eq $c.decision -and $c.elapsedMs -lt 4500 -and (Gone $c.childId)) "a hung swap child ($($c.elapsedMs) ms)"
  $c = Invoke-SwapChild @{ Mode = 'crash' } 15000; Assert ($c.exitCode -eq 7 -and $null -eq $c.decision) 'a crashed swap child'
  $script:PRM.bundleSwap.sha = '0' * 64
  $c = Invoke-SwapChild @{ Mode = 'apply' } 15000; Assert ($c.exitCode -eq 3 -and $null -eq $c.decision) 'a script that is not the pinned bytes ran'
  $bad = $false; try { $null = Invoke-SwapChild @{ Mode = 'x' } 31000 } catch { $bad = $true }; Assert $bad 'a swap budget above 30 s'
  [ordered]@{ passed = 13 } | ConvertTo-Json -Compress
} finally { Remove-Item -Recurse -Force $w }
