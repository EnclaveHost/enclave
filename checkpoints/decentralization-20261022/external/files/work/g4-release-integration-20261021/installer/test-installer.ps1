# test-installer.ps1 - LOCAL tests (pwsh 7.4 on Linux) of the install-host.ps1 compatibility patch. The EXACT function and block
# texts are taken from the patched file through the PowerShell AST (nothing retyped); Windows scheduled-task cmdlets are mocked;
# Clear-ReleaseContent runs against a real temp directory. The unpatched base (0dc5a801) is the negative control.
param([string]$Patched, [string]$Base)
$ErrorActionPreference = 'Stop'
$R = [ordered]@{}
function Check($name, $cond, $detail = '') { $R[$name] = $(if ($cond) { 'PASS' } else { "FAIL $detail" }) }
function Ast($file) { $t = $null; $e = $null; $a = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$t, [ref]$e); return @{ ast = $a; errors = @($e) } }
$P = Ast $Patched; $B = Ast $Base
Check 'parse.patched' ($P.errors.Count -eq 0) ($P.errors | Out-String); Check 'parse.base' ($B.errors.Count -eq 0)
function FnText($ast, $name) { ($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1).Extent.Text }
$text = [IO.File]::ReadAllText($Patched)
foreach ($f in 'Save-EnclaveTaskState', 'Clear-ReleaseContent', 'Allowed', 'Keep-OperatorPause', 'Restore-EnclaveTasks') { $src = FnText $P.ast $f; Check "extract.$f" ([bool]$src); . ([scriptblock]::Create($src)) }

# ---- the mocked Task Scheduler ----
$script:Tasks = @{}; $script:Log = [Collections.Generic.List[string]]::new()
function NewTask($n, $enabled, $state) { $script:Tasks[$n] = [pscustomobject]@{ TaskName = $n; State = $state; Settings = [pscustomobject]@{ Enabled = $enabled } } }
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) if ($TaskName) { $script:Tasks[$TaskName] } else { @($script:Tasks.Values) } }
function Stop-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $script:Log.Add("stop $TaskName"); if ($script:Tasks[$TaskName].State -eq 'Running') { $script:Tasks[$TaskName].State = 'Ready' } }
function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $script:Log.Add("start $TaskName"); $script:Tasks[$TaskName].State = 'Running' }
function Disable-ScheduledTask { param($TaskPath, $TaskName) $script:Log.Add("disable $TaskName"); $script:Tasks[$TaskName].Settings.Enabled = $false }
function Emit { param($a, $b, $c) $script:Log.Add("emit $a $b") }
function Fail { param($a, $b) throw "FAIL $a $b" }
function Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec) [pscustomobject]@{ ok = $true } }
function Start-Sleep { param($s) }

# root's live set (native 23:12Z): 8 tasks, all Running except Update; plus an operator-PAUSED Node and a stopped Relay variant
function LiveSet { $script:Tasks = @{}; $script:Log.Clear()
  foreach ($n in 'Card', 'enclave-host-services-hs2', 'Network', 'NetworkChecker', 'Node', 'Relay', 'Shield') { NewTask $n $true 'Running' }; NewTask 'Update' $true 'Ready' }

# T1 prior state recorded and every task but Update stopped
LiveSet; $priorTasks = Save-EnclaveTaskState
Check 'T1.recordedAllButUpdate' (@($priorTasks.Keys).Count -eq 7 -and -not $priorTasks.ContainsKey('Update'))
Check 'T1.stoppedAllButUpdate' ((@($script:Log | Where-Object { $_ -like 'stop *' }).Count -eq 7) -and -not ($script:Log -contains 'stop Update'))
Check 'T1.hs2RecordedRunning' ($priorTasks['enclave-host-services-hs2'].running -and $priorTasks['enclave-host-services-hs2'].enabled)

# T2 the services section of the PATCHED file, run verbatim (from "$shieldOn" to the services Emit), with the live set
function ServicesBlock($file) {
  $t = [IO.File]::ReadAllText($file)
  $a = $t.IndexOf('$shieldOn = Allowed "Shield"'); $b = $t.IndexOf('if ($NoStart) {')
  $c = $t.IndexOf('foreach ($n in "Node", "Network") { if ($shieldOn'); $d = $t.IndexOf('Emit "services" "ok" ("Enclave Shield, the node', $c)
  return ($t.Substring($a, $b - $a) + "`n" + $t.Substring($c, $d - $c))
}
$block = ServicesBlock $Patched
LiveSet; $priorTasks = Save-EnclaveTaskState; $script:Log.Clear()
foreach ($n in "Shield", "Card", "Node", "Network") { Keep-OperatorPause $n }; if ((Allowed "Card")) { Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Card' }
. ([scriptblock]::Create($block))
Check 'T2.hs2Restarted' ($script:Log -contains 'start enclave-host-services-hs2')
Check 'T2.relayAndCheckerRestarted' (($script:Log -contains 'start Relay') -and ($script:Log -contains 'start NetworkChecker'))
Check 'T2.coreStarted' ((@('Shield', 'Node', 'Network') | Where-Object { $script:Log -notcontains "start $_" }).Count -eq 0)
Check 'T2.nothingDisabled' (-not ($script:Log | Where-Object { $_ -like 'disable *' }))

# T3 an operator-PAUSED Node (disabled) and a STOPPED Relay: Node is re-registered enabled by Task (-Force) -> disabled again, not
#    started; the stopped Relay stays stopped; a disabled third-party task is never enabled or started
LiveSet; $script:Tasks['Node'].Settings.Enabled = $false; $script:Tasks['Node'].State = 'Ready'; $script:Tasks['Relay'].State = 'Ready'
$script:Tasks['NetworkChecker'].Settings.Enabled = $false; $script:Tasks['NetworkChecker'].State = 'Ready'
$priorTasks = Save-EnclaveTaskState; $script:Log.Clear()
$script:Tasks['Node'].Settings.Enabled = $true                          # what Register-ScheduledTask -Force does in Task "Node"
foreach ($n in "Shield", "Card", "Node", "Network") { Keep-OperatorPause $n }
. ([scriptblock]::Create($block))
Check 'T3.pausedNodeDisabledAgain' (($script:Log -contains 'disable Node') -and -not $script:Tasks['Node'].Settings.Enabled)
Check 'T3.pausedNodeNotStarted' ($script:Log -notcontains 'start Node')
Check 'T3.networkStillStarted' ($script:Log -contains 'start Network')
Check 'T3.stoppedRelayLeftStopped' ($script:Log -notcontains 'start Relay')
Check 'T3.disabledCheckerUntouched' (($script:Log -notcontains 'start NetworkChecker') -and ($script:Log -notcontains 'disable NetworkChecker') -and -not $script:Tasks['NetworkChecker'].Settings.Enabled)

# T4 an operator-PAUSED Shield: nothing that needs the manager starts; the health wait is skipped; others restored
LiveSet; $script:Tasks['Shield'].Settings.Enabled = $false; $script:Tasks['Shield'].State = 'Ready'
$priorTasks = Save-EnclaveTaskState; $script:Log.Clear(); $script:Tasks['Shield'].Settings.Enabled = $true
foreach ($n in "Shield", "Card", "Node", "Network") { Keep-OperatorPause $n }
. ([scriptblock]::Create($block))
Check 'T4.pausedShieldNoCoreStart' ((@('Shield', 'Node', 'Network') | Where-Object { $script:Log -contains "start $_" }).Count -eq 0)
Check 'T4.hs2StillRestored' ($script:Log -contains 'start enclave-host-services-hs2')

# T5 a FRESH install (no prior tasks): unchanged behaviour - Shield, Node, Network start
$script:Tasks = @{}; $script:Log.Clear(); $priorTasks = Save-EnclaveTaskState
foreach ($n in 'Shield', 'Node', 'Network') { NewTask $n $true 'Ready' }
. ([scriptblock]::Create($block))
Check 'T5.freshInstallStartsCore' ((@('Shield', 'Node', 'Network') | Where-Object { $script:Log -notcontains "start $_" }).Count -eq 0)

# T6 Clear-ReleaseContent on a real temp Program Files\Enclave: release-owned content goes; managed roles stay; a role dir
#    INSIDE network\ is release content and goes (it is NOT protected by this patch)
$root = Join-Path ([IO.Path]::GetTempPath()) ("pf-" + [guid]::NewGuid().ToString('N')); [void](New-Item -ItemType Directory $root)
foreach ($d in 'runtime\node', 'control\windows\node', 'network', 'bin', 'guest', 'tray', 'tuna', 'host-services\hs2\bin', 'host-services\hs2\packages', 'challenge-replica\release-3e1560f94542', 'network\challenge-replica\release-3e1560f94542') { [void](New-Item -ItemType Directory -Force (Join-Path $root $d)) }
foreach ($f in 'manifest.json', 'update-host.ps1', 'uninstall-host.ps1', 'EnclaveSetup.exe', 'control\windows\node\host.mjs', 'host-services\hs2\bin\host-services-runner.mjs', 'challenge-replica\release-3e1560f94542\dns.mjs', 'network\challenge-replica\release-3e1560f94542\dns.mjs', 'network\privacy-agent.mjs') { Set-Content -LiteralPath (Join-Path $root $f) -Value 'x' }
Clear-ReleaseContent $root
Check 'T6.releaseDirsGone' ((@('runtime', 'control', 'network', 'bin', 'guest', 'tray', 'tuna') | Where-Object { Test-Path (Join-Path $root $_) }).Count -eq 0)
Check 'T6.topFilesGone' ((@('manifest.json', 'update-host.ps1', 'uninstall-host.ps1', 'EnclaveSetup.exe') | Where-Object { Test-Path (Join-Path $root $_) }).Count -eq 0)
Check 'T6.hs2Kept' (Test-Path (Join-Path $root 'host-services\hs2\bin\host-services-runner.mjs'))
Check 'T6.topLevelRoleDirKept' (Test-Path (Join-Path $root 'challenge-replica\release-3e1560f94542\dns.mjs'))
Check 'T6.roleDirUnderNetworkNOTKept' (-not (Test-Path (Join-Path $root 'network\challenge-replica')))
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue

# T7 NEGATIVE CONTROL: the BASE's full-install statement, run verbatim, deletes the managed hs2 install
$bt = [IO.File]::ReadAllText($Base); $stmt = '  if (Test-Path $PF) { Remove-Item $PF -Recurse -Force }'
Check 'T7.baseHasTheStatement' ($bt.Contains($stmt))
$PF = Join-Path ([IO.Path]::GetTempPath()) ("pf-" + [guid]::NewGuid().ToString('N')); [void](New-Item -ItemType Directory -Force (Join-Path $PF 'host-services\hs2\bin'))
Set-Content -LiteralPath (Join-Path $PF 'host-services\hs2\bin\host-services-runner.mjs') -Value 'x'
. ([scriptblock]::Create($stmt))
Check 'T7.baseDeletesHs2' (-not (Test-Path (Join-Path $PF 'host-services\hs2')))
# T8 NEGATIVE CONTROL: the base restarts only its own four tasks (no other \Enclave\ task is ever started again) and never
#    re-disables a Node it re-registered with -Force
$starts = [regex]::Matches($bt, 'Start-ScheduledTask -TaskPath "\\Enclave\\" -TaskName "?\$?(\w+)"?') | ForEach-Object { $_.Groups[1].Value }
Check 'T8.baseStartsOnlyItsOwn' ((@($starts).Count -ge 4) -and (@($starts | Where-Object { $_ -notin 'Card', 'Shield', 'Node', 'Network' }).Count -eq 0) -and $bt -notmatch 'enclave-host-services') ("starts: " + ($starts -join ','))
Check 'T8.baseHasNoPauseRestore' (-not ($bt -match 'Settings\.Enabled'))
# T9 the patch leaves the signed channel and identity protection of the updater/installer intact (text present, unchanged count)
foreach ($k in 'release-policy.json', 'ENCLAVE-IDENTITY-RECORD-V1', 'Reconfigure') { Check "T9.kept.$k" (([regex]::Matches($text, [regex]::Escape($k))).Count -eq ([regex]::Matches($bt, [regex]::Escape($k))).Count) }

$R | ConvertTo-Json -Compress
