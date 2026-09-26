# nodeonly-dryrun.tests.ps1 - hvnode-install.ps1 -NodeOnly -DryRun reaches NO stop, start or rewrite (enclave-87's hard rule,
# 09-26: a -DryRun of a production script against live state is only safe if the DryRun branch is PROVEN inert; this
# proves it with stubs, never against a box).
#   pwsh -NoProfile -File nodeonly-dryrun.tests.ps1 [-Script <path to hvnode-install.ps1>]     exit 0 = all ok
# HOW: the REAL `if ($NodeOnly) { … }` block and the real RunLoop/Sha256Of are read out of hvnode-install.ps1's syntax tree and
# run in a CHILD pwsh per case (the block ends in `exit`), after recording stubs shadow every cmdlet it could reach
# (functions win over cmdlets; the recorder is RecCall, never `R`, which is an alias of Invoke-History and would win): Get-ScheduledTask, Invoke-RestMethod, Stop-ScheduledTask, Start-ScheduledTask, Stop-Process,
# Start-Sleep, Get-CimInstance, Copy-Item, Set-Content - and StageNodeTree (no tar, no npm). Each stub appends its name to a
# record file. Cases:
#   dry      -DryRun: exit 0, "DRY RUN", and NONE of Stop-ScheduledTask/Stop-Process/Start-ScheduledTask/Set-Content/
#            Copy-Item/Get-CimInstance recorded.
#   real     the POSITIVE CONTROL (no -DryRun): the same stubs DO record Stop-ScheduledTask, Set-Content of run-node.cmd and
#            Start-ScheduledTask, and it ends "NODE-ONLY INSTALLED" - so an empty record in `dry` is not a blind stub.
#   mutant   the DryRun branch's `exit 0` removed from the extracted block: run as `dry`, it MUST record Stop-ScheduledTask
#            (the assertion catches the regression it exists for). mutant 2: the exit moved below the first stop (enclave-5d).
#            mutant 3: an UNSTUBBED Remove-Item before the exit (enclave-bf): the dry case also snapshots the fixture root
#            (every file's path + sha256) before and after and requires them equal, so ANY write is seen, stubbed or not.
param([string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'hvnode-install.ps1'))
$ErrorActionPreference = 'Stop'
$fail = 0
function Check([bool]$ok, [string]$what) { if ($ok) { Write-Output "ok   $what" } else { Write-Output "FAIL $what"; $script:fail++ } }

$tok = $null; $err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Script).Path, [ref]$tok, [ref]$err)
if ($err.Count) { throw "hvnode-install.ps1 does not parse: $($err[0].Message)" }
function FnText([string]$name) {
  $f = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $false))
  if ($f.Count -ne 1) { throw "hvnode-install.ps1 has $($f.Count) top-level definitions of $name" }
  $f[0].Extent.Text
}
# the top-level `if ($NodeOnly) { ... }`: its clause body (the statement block), as text
$ifs = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -eq '$NodeOnly' })
if ($ifs.Count -ne 1) { throw "hvnode-install.ps1 has $($ifs.Count) top-level `if (`$NodeOnly)` statements" }
$block = $ifs[0].Clauses[0].Item2.Extent.Text
$real = @{ RunLoop = (FnText 'RunLoop'); Sha256Of = (FnText 'Sha256Of') }
Check ($block -match '(?s)if \(\$DryRun\) \{.*?exit 0') 'the extracted block has a DryRun branch that exits'

$pwsh = (Get-Process -Id $PID).Path
# every file under the fixture root, as "relative path  sha256", sorted: equal before and after = NOTHING was written, by ANY
# cmdlet or .NET call, stubbed or not (enclave-bf's review: an unstubbed Remove-Item of node-config.cmd passed a record-only check)
function Snapshot([string]$root) {
  (@(Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
    $_.FullName.Substring($root.Length).TrimStart('/', '\') + '  ' + (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower()
  }) | Sort-Object) -join "`n"
}
function RunCase([string]$name, [bool]$dry, [string]$blockText) {
  $d = Join-Path ([IO.Path]::GetTempPath()) ("nodeonly-" + $name + "-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $d | Out-Null
  $root = Join-Path $d 'hvnode'; New-Item -ItemType Directory -Path $root | Out-Null
  $old = Join-Path (Join-Path $root '07fc4f55') 'windows/node'
  Set-Content -Path (Join-Path $root 'run-node.cmd') -Value @('@echo off', 'call "x"', "cd /d `"$old`"", ':loop')
  foreach ($f in 'node-config.cmd', 'run-manager.cmd', 'manager-config.cmd') { Set-Content -Path (Join-Path $root $f) -Value 'rem stub' }
  $rec = Join-Path $d 'calls.txt'; [IO.File]::WriteAllText($rec, '')
  $snapBefore = Snapshot $root
  $child = Join-Path $d 'case.ps1'
  $harness = @"
`$ErrorActionPreference = 'Stop'
`$REC = '$rec'
function RecCall([string]`$s) { [IO.File]::AppendAllText(`$REC, `$s + [Environment]::NewLine) }
function Note([string]`$m) { Write-Output "ok   `$m" }
function Die([string]`$m) { Write-Output "REFUSED: `$m"; exit 2 }
$($real.Sha256Of)
$($real.RunLoop)
function Get-ScheduledTask { param(`$TaskName, `$TaskPath, `$ErrorAction) RecCall "Get-ScheduledTask `$TaskName"; [pscustomobject]@{ State = `$(if (`$TaskName -eq 'EnclaveWindowsNode') { 'Disabled' } else { 'Running' }) } }
function Invoke-RestMethod { param(`$Uri, `$TimeoutSec, [switch]`$UseBasicParsing) RecCall "Invoke-RestMethod `$Uri"; [pscustomobject]@{ canStart = `$true } }
function Stop-ScheduledTask { param(`$TaskName, `$TaskPath, `$ErrorAction) RecCall "Stop-ScheduledTask `$TaskName" }
function Start-ScheduledTask { param(`$TaskName, `$TaskPath, `$ErrorAction) RecCall "Start-ScheduledTask `$TaskName"; `$script:started = `$true }
function Stop-Process { param(`$Id, [switch]`$Force, `$ErrorAction) RecCall "Stop-Process `$Id" }
function Start-Sleep { param(`$Seconds) }
function Get-CimInstance { param(`$ClassName, `$Filter) RecCall "Get-CimInstance `$Filter"
  if (`$script:started -and `$Filter -match 'node\.exe') { [pscustomobject]@{ ProcessId = 4242; CommandLine = "node `$(Join-Path (Join-Path `$Root `$c8) 'windows\node')\agent.mjs" } } }
function Copy-Item { param(`$LiteralPath, `$Destination, [switch]`$Force, `$ErrorAction) RecCall "Copy-Item `$LiteralPath" }
function Set-Content { param(`$Path, `$Value, `$Encoding, `$ErrorAction) RecCall "Set-Content `$Path" }
function StageNodeTree([bool]`$reuse) { RecCall 'StageNodeTree'; `$script:nodeDir = Join-Path (Join-Path `$Root `$c8) 'windows\node' }
`$Root = '$root'; `$c8 = 'abcdef12'; `$ManagerPort = 8091; `$LocalPort = 9600; `$NodeExe = 'node'
`$NodeOnly = `$true; `$DryRun = `$$($dry.ToString().ToLower())
if (`$NodeOnly) $blockText
"@
  [IO.File]::WriteAllText($child, $harness)
  $out = & $pwsh -NoProfile -NonInteractive -File $child 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $calls = @(Get-Content $rec | Where-Object { $_ })
  $snapAfter = Snapshot $root
  if ($env:KEEP) { Write-Output "kept $d" } else { Remove-Item -Recurse -Force $d }
  [pscustomobject]@{ code = $code; out = ($out -join "`n"); calls = $calls; runNode = (Join-Path $root 'run-node.cmd'); unchanged = ($snapBefore -eq $snapAfter) }
}
$writes = '^(Stop-ScheduledTask|Stop-Process|Start-ScheduledTask|Set-Content|Copy-Item|Get-CimInstance)\b'

# dry: nothing that stops, starts or rewrites
$r = RunCase 'dry' $true $block
Check ($r.code -eq 0) "dry: exit 0 (got $($r.code))"; if ($r.code -ne 0) { Write-Output ($r.out.Split("`n") | Select-Object -Last 8) }
Check ($r.out -match 'DRY RUN: every check passed') 'dry: says DRY RUN'
Check (@($r.calls | Where-Object { $_ -eq 'StageNodeTree' }).Count -eq 1) 'dry: staged the tree (the stub was reached)'
$bad = @($r.calls | Where-Object { $_ -match $writes })
Check ($bad.Count -eq 0) ("dry: NO stop/start/rewrite/process call" + $(if ($bad.Count) { " (got: " + ($bad -join '; ') + ")" } else { '' }))
Check $r.unchanged 'dry: the fixture root is BYTE-IDENTICAL before and after (no write by any means)'

# real: the positive control - the same stubs DO see the stop, the rewrite and the start
$r = RunCase 'real' $false $block
Check ($r.code -eq 0) "real: exit 0 (got $($r.code))"
Check (@($r.calls | Where-Object { $_ -eq 'Stop-ScheduledTask EnclaveHvNode' }).Count -eq 1) 'real: Stop-ScheduledTask EnclaveHvNode recorded'
Check (@($r.calls | Where-Object { $_ -like 'Set-Content *run-node.cmd' }).Count -eq 1) 'real: Set-Content run-node.cmd recorded'
Check (@($r.calls | Where-Object { $_ -eq 'Start-ScheduledTask EnclaveHvNode' }).Count -eq 1) 'real: Start-ScheduledTask EnclaveHvNode recorded'
Check ($r.out -match 'NODE-ONLY INSTALLED: 07fc4f55 -> abcdef12') 'real: NODE-ONLY INSTALLED'
Check (@($r.calls | Where-Object { $_ -match '^Stop-ScheduledTask EnclaveHvManager|^Start-ScheduledTask EnclaveHvManager' }).Count -eq 0) 'real: the manager task is never stopped or started'

# mutant: remove the DryRun branch's exit; the dry assertion must now catch it
$mut = [regex]::Replace($block, '(?s)(if \(\$DryRun\) \{.*?)exit 0', '$1# exit removed (mutant)')
Check ($mut -ne $block) 'mutant: the exit was removed from the DryRun branch'
$r = RunCase 'mutant' $true $mut
Check (@($r.calls | Where-Object { $_ -eq 'Stop-ScheduledTask EnclaveHvNode' }).Count -eq 1) 'mutant: a DryRun without its exit IS caught (Stop-ScheduledTask recorded)'

# mutant 2 (enclave-5d): the DryRun exit MOVED below the first Stop-ScheduledTask - it stops the node, then exits
$mut2 = [regex]::Replace($block, '(?s)(if \(\$DryRun\) \{.*?)exit 0', '$1# exit moved (mutant 2)')
$mut2 = [regex]::Replace($mut2, "(Stop-ScheduledTask -TaskName 'EnclaveHvNode'[^\n]*\n)", '$1  if ($DryRun) { exit 0 }' + "`n", 1)
Check ($mut2 -match '(?s)Stop-ScheduledTask[^\n]*\n\s*if \(\$DryRun\) \{ exit 0 \}') 'mutant 2: the exit now sits below the first Stop-ScheduledTask'
$r = RunCase 'mutant2' $true $mut2
Check (@($r.calls | Where-Object { $_ -eq 'Stop-ScheduledTask EnclaveHvNode' }).Count -eq 1) 'mutant 2: a DryRun that exits only after the stop IS caught'

# mutant 3 (enclave-bf): an UNSTUBBED write before the DryRun exit - Remove-Item of the live node-config.cmd. Only the snapshot
# can see it; the dry case's snapshot check must FAIL for it.
$mut3 = $block -replace '(\r?\n)(\s*)if \(\$DryRun\) \{', '$1$2Remove-Item -LiteralPath $nodeCfgCmd -Force$1$2if ($DryRun) {'
Check ($mut3 -match 'Remove-Item -LiteralPath \$nodeCfgCmd -Force\s*\r?\n\s*if \(\$DryRun\)') 'mutant 3: an unstubbed Remove-Item of node-config.cmd sits before the DryRun exit'
$r = RunCase 'mutant3' $true $mut3
Check (-not $r.unchanged) 'mutant 3: a DryRun that deletes node-config.cmd IS caught (the snapshot differs)'

if ($fail) { Write-Output "nodeonly-dryrun tests: $fail FAILED"; exit 1 }
Write-Output 'nodeonly-dryrun tests: ALL OK'
