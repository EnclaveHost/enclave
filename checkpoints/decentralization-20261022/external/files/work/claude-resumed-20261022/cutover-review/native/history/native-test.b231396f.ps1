# cutover-review NATIVE validation fixture for the frozen cutover candidate 943a5f01 (ROOT-ONLY; Windows PowerShell 5.1).
# READ-ONLY on every live entity: it never stops, starts, kills, restarts or edits a node, privacy agent, manager, task, VM or
# config. Live work = process/listener/host-state READS through the candidate's own bounded child queries, plus direct
# Get-ScheduledTask/Get-ScheduledTaskInfo/Get-VM/Get-FileHash reads for the before/after preservation check.
# The two simulated tests (mocked clock/processes/task requests) run in child processes behind sim-guard tripwires and are
# CONTROL-FLOW evidence only. Nothing here exercises StopNode/StartNode/RestartPrivacy/Revert on a live entity, so this is
# NOT a native full-revert proof. Output: counts, PIDs, process start times, public task states and file hashes only.
param([string]$Stage, [switch]$StaticOnly)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$Fixture = [Diagnostics.Stopwatch]::StartNew(); $FIXTURE_SEC = 870; $LIVE_SEC = 240; $CHILD_MS = 120000   # 30 static + 5 children x 120 + live 240 = 870
function Bound($what, $needSec) { if ($Fixture.Elapsed.TotalSeconds + $needSec -gt $FIXTURE_SEC) { throw "fixture bound $FIXTURE_SEC s cannot fit $what" } }
$PIN = [ordered]@{ 'cutover.ps1' = '943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093'
  'sim-guard.ps1' = 'f98cfbaf7802e2f6fb5be001748c2fecd5c82a17096c668e348364f8a0770973'
  'native-path-test.ps1' = 'acf28de25471dc912538bbcce546a1c32aece89d4f7ccd32af6c927e220f56a6'
  'readiness-cadence-test.ps1' = 'e150efa594100bd6ce9cfe4fa8a23a1c4b397c7d9420d0f905a549fa1d107054' }
# ROOT-UPDATE (root read-only snapshot 2026-10-22T01:44:55Z): drift is REPORTED, never repaired
$ROOT_SNAPSHOT = [ordered]@{ runNode = '3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686'
  localConfig = '85698d20b4f8fb494c8620aeb80d5b4fbd2ec637ef40c7fa02693ba41ee2aa73'
  privacyConfig = 'd5810879c79d0cd173c5fb837b09def6205c6bea1cb0849f0f7cd33c27286752'
  privacyAgent = '7ef4e2303d841e86269d3bbb7ce5f43a5ead5b0d2f2898f9b69774da1ac13147'
  nodeAgent = 'c223c0435d859f0bde0d496a2eb1e8a2db4af44a47e32bf653710244c5ccd2ba' }
$LIVE_FILES = [ordered]@{ runNode = 'C:\ProgramData\Enclave\run-node.cmd'; localConfig = 'C:\ProgramData\Enclave\node-config.local.cmd'
  privacyConfig = 'C:\ProgramData\Enclave\network\privacy-config.json'; privacyAgent = 'C:\Program Files\Enclave\network\privacy-agent.mjs'
  nodeAgent = 'C:\Program Files\Enclave\control\windows\node\agent.mjs' }
function FileSha256($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function TextSha($s) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s)) | ForEach-Object { $_.ToString('x2') }) }
$out = [ordered]@{ pass = $false; mode = $(if ($StaticOnly) { 'static-only' } else { 'native' }); fixtureBoundSec = $FIXTURE_SEC; liveBoundSec = $LIVE_SEC }
# any terminating error still emits the ONE result line (nothing here mutates, so there is nothing to undo)
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message; $out.fixtureElapsedSec = [math]::Round($Fixture.Elapsed.TotalSeconds, 1)
  $out | ConvertTo-Json -Compress -Depth 8; exit 3 }

# ---------------------------------------------------------------- 1 tripwires: no mutating command can run in THIS process
$FORBIDDEN = @('Stop-Process','Start-Process','Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask',
  'Register-ScheduledTask','Unregister-ScheduledTask','Start-VM','Stop-VM','Restart-Service','Stop-Service','Start-Service','Restart-Computer',
  'Set-Acl','Set-Content','Add-Content','Out-File','Remove-Item','Move-Item','Copy-Item','New-Item','Rename-Item','Invoke-WebRequest')
foreach ($n in $FORBIDDEN) { . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n is forbidden in the read-only fixture' }")) }

# ---------------------------------------------------------------- 2 exact staged bytes, and every staged script parses
$pins = [ordered]@{}; foreach ($k in $PIN.Keys) { $pins[$k] = ((FileSha256 (Join-Path $Stage $k)) -eq $PIN[$k]) }
$out.pins = $pins; if (@($pins.Values | Where-Object { -not $_ }).Count) { $out.error = 'staged bytes are not the pinned candidate'; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
$parse = [ordered]@{}; $asts = @{}
foreach ($k in @($PIN.Keys) + 'native-test.ps1') { $tk = $null; $er = $null
  $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Stage $k), [ref]$tk, [ref]$er); $parse[$k] = $er.Count }
$out.parseErrors = $parse; $out.psVersion = $PSVersionTable.PSVersion.ToString()
if (@($parse.Values | Where-Object { $_ -ne 0 }).Count) { $out.error = 'parse errors'; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }

# ---------------------------------------------------------------- 3 extract ONLY read-only/bounded functions from the candidate
$READ = @('Iso','Left','Lim','NowS','NowMs','IsoMs','Invoke-BoundedQuery','Query','PollRoom','Utc','ProcessRows','ById','Same','NodeProcs','Privacy',
          'Listeners','Manager','HostState','Vms','HyperV','Known','ReadinessNumber','LeaseReady','OwnsAgentPort','AgentUp','Sha')
$MUTATORS = @('StopNode','StartNode','RestartPrivacy','NodeTask','Invoke-TaskCommand','Revert','Recovery','RestoreOne','CasWrite','ProtectedTemp','PrivDir',
              'Final','Log','WaitNodeGone','BeforeStop','Identity','Others')
$calls = @{}
foreach ($name in $READ) {
  $f = @($asts['cutover.ps1'].FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true))
  if ($f.Count -ne 1) { throw "function missing or duplicated: $name" }
  foreach ($c in $f[0].FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) { $cn = $c.GetCommandName(); if ($cn) { $calls[$cn] = $true } }
  . ([scriptblock]::Create($f[0].Extent.Text)) }
$bad = @($calls.Keys | Where-Object { $FORBIDDEN -contains $_ -or $MUTATORS -contains $_ } | Sort-Object)
$out.static = [ordered]@{ extractedFunctions = $READ.Count; distinctCommands = $calls.Count; forbiddenOrMutatorCalls = $bad }
if ($bad.Count) { $out.error = 'an extracted function calls a mutating command'; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
if ($StaticOnly) { $out.pass = $true; $out | ConvertTo-Json -Compress -Depth 6; exit 0 }

# ---------------------------------------------------------------- 4 SIMULATED control-flow tests (child processes, tripwired, bounded)
function RunChild([string[]]$argv, [int]$ms) {
  $si = New-Object Diagnostics.ProcessStartInfo; $si.FileName = Join-Path $PSHOME 'powershell.exe'
  $si.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (($argv | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process; $p.StartInfo = $si; [void]$p.Start()
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($ms)) { try { $p.Kill() } catch {}; $gone = $p.WaitForExit(10000); $p.Dispose(); return [ordered]@{ ok = $false; reason = 'child timeout'; childExited = $gone } }
  $p.WaitForExit(); $code = $p.ExitCode; $p.Dispose()
  $last = @(([string]$o.Result) -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1
  $v = $null; try { $v = $last | ConvertFrom-Json } catch {}
  return [ordered]@{ ok = ($code -eq 0 -and $v); exitCode = $code; value = $v } }
$guard = Join-Path $Stage 'sim-guard.ps1'; $src = Join-Path $Stage 'cutover.ps1'
Bound 'simulated native-path' ($CHILD_MS / 1000 * 5 + $LIVE_SEC)
$np = RunChild @($guard, '-Test', (Join-Path $Stage 'native-path-test.ps1'), '-Source', $src) $CHILD_MS
$sim = [ordered]@{ scope = 'SIMULATED: mocked clock/processes/task requests/queries; control flow only, NOT native operation proof'
  nativePath = [ordered]@{ ok = [bool]$np.ok; exitCode = $np.exitCode; passed = $np.value.passed; total = $np.value.total; reason = $np.reason }; cadence = @() }
foreach ($L in '9.7', '10.5', '13', '15') { Bound "simulated cadence $L" ($CHILD_MS / 1000 + $LIVE_SEC)
  $cr = RunChild @($guard, '-Test', (Join-Path $Stage 'readiness-cadence-test.ps1'), '-Source', $src, '-ListenerSec', $L, '-Expect', '60') $CHILD_MS
  $sim.cadence += ,([ordered]@{ listenerSec = $L; ok = [bool]$cr.ok; readyWithin150 = $cr.value.readyWithin150; phases = $cr.value.phases; reason = $cr.reason }) }
$out.simulated = $sim
$simOk = $np.ok -and $np.value.passed -eq 6 -and $np.value.total -eq 6 -and @($sim.cadence | Where-Object { -not $_.ok -or $_.readyWithin150 -ne 60 }).Count -eq 0

# ---------------------------------------------------------------- 5 LIVE read-only checks through the candidate's own bounded readers
Bound 'live checks' $LIVE_SEC
$TR = ''; $Fwd = $false; $RUN_PAT = '*\Enclave\run-node.cmd*'; $AGENT_PAT = '*\control\windows\node\agent.mjs*'
$script:QueryCleanupFailed = $false; $BoundSec = $LIVE_SEC; $T0 = Get-Date        # Left()/Lim() cap EVERY live reader at $LIVE_SEC
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
if ($u) { $ui = Get-ScheduledTaskInfo -InputObject $u
  if ([string]$u.State -eq 'Running' -or ($ui.NextRunTime -and $ui.NextRunTime -lt (Get-Date).AddSeconds($LIVE_SEC + 60))) {
    $out.refused = 'the \Enclave\Update task runs or is due inside the live window; nothing was read'; $out.simulatedOk = [bool]$simOk; $out | ConvertTo-Json -Compress -Depth 8; exit 4 } }
function Snap {
  $vm = Vms; $hv = HyperV
  [ordered]@{ node = (NodeProcs); privacy = @(Privacy); manager = (Manager)
    tasks = (@(Get-ScheduledTask -TaskPath '\Enclave\' -ErrorAction Stop | Sort-Object TaskName | ForEach-Object { "$($_.TaskName)=$([string]$_.State)" }) -join ',')
    vmCount = $(if (Known $vm) { @($vm -split ',' | Where-Object { $_ }).Count } else { -1 }); vmSha = (TextSha $vm)
    hypervCount = $(if (Known $hv) { @($hv -split ',' | Where-Object { $_ }).Count } else { -1 }); hypervSha = (TextSha $hv)
    files = $($h = [ordered]@{}; foreach ($k in $LIVE_FILES.Keys) { $h[$k] = FileSha256 $LIVE_FILES[$k] }; $h) } }
$pre = Snap
$c = [ordered]@{}; $n = $pre.node
$c.nodeUnique = [bool]($n.cmd.Count -eq 1 -and $n.agent.Count -eq 1 -and $n.agent[0].parent -eq $n.cmd[0].pid)
if (-not $c.nodeUnique) { $out.live = [ordered]@{ checks = $c; node = $n }; $out.error = 'node cmd+agent identity is not unique'; $out | ConvertTo-Json -Compress -Depth 8; exit 3 }
$cmd = $n.cmd[0]; $agent = $n.agent[0]; $wrong = [ordered]@{ pid = [int]$cmd.pid; start = $agent.start }   # a REAL process that is not the owner
function Probe([scriptblock]$b) { try { & $b } catch { 'ERROR: ' + $_.Exception.Message } }
$c.sameCmd = Probe { Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0 }
$c.sameAgent = Probe { Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid }
$c.staleStartRejected = Probe { -not (Same $agent.pid '2000-01-01T00:00:00.0000000Z' 'node.exe' $AGENT_PAT $cmd.pid) }
$c.wrongPidSameRejected = Probe { -not (Same $cmd.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid) }
$sw = [Diagnostics.Stopwatch]::StartNew(); $c.ownsGenuine = Probe { OwnsAgentPort $agent ((Get-Date).AddSeconds((Lim 30))) }; $listenerMs = $sw.ElapsedMilliseconds
$c.ownsWrongPidRejected = Probe { -not (OwnsAgentPort $wrong ((Get-Date).AddSeconds((Lim 30)))) }
$sw.Restart(); $h0 = HostState 10; $hostMs = $sw.ElapsedMilliseconds
$ids = @($h0.deployments | Where-Object { [string]$_.status -eq 'running' } | ForEach-Object { [string]$_.id })
$PRM = [pscustomobject]@{ expectedIds = $ids; runner = 'readiness-must-come-from-the-node'; lease = [pscustomobject]@{ marginSec = 180 } }
$c.oldNodeHasNoLeaseReadiness = [bool](-not $h0.leaseReadiness)
$c.leaseReadyRejectsActualState = Probe { -not (LeaseReady $h0 (IsoMs $agent.start)) }
# AgentUp against the OLD production node, bounded: it must poll, run out of its own deadline, and refuse.
$realHostState = ${function:HostState}; $script:hostPolls = 0
function HostState([double]$limitSec = 10) { $script:hostPolls++; & $realHostState $limitSec }
$AGENTUP_SEC = 25
$sw.Restart(); $up = Probe { AgentUp $agent $AGENTUP_SEC }; $agentUpMs = $sw.ElapsedMilliseconds
$c.agentUpOldNodeRefuses = ($up -eq $false); $c.agentUpWithinBound = ($agentUpMs -le ($AGENTUP_SEC * 1000 + 5000)); $c.agentUpPolledHostState = ($script:hostPolls -ge 2)
$sw.Restart(); $upWrong = Probe { AgentUp $wrong 15 }; $agentUpWrongMs = $sw.ElapsedMilliseconds
$c.agentUpWrongPidRefuses = ($upWrong -eq $false)
$h1 = & $realHostState 10; $c.noReadinessAfterPolls = [bool](-not $h1.leaseReadiness)
$c.queryChildrenConfirmedGone = (-not $script:QueryCleanupFailed)
$post = Snap
$keep = [ordered]@{}; foreach ($k in 'node','privacy','manager','tasks','vmCount','vmSha','hypervCount','hypervSha','files') {
  $keep[$k] = ((ConvertTo-Json -InputObject $pre[$k] -Depth 6 -Compress) -eq (ConvertTo-Json -InputObject $post[$k] -Depth 6 -Compress)) }
$rs = [ordered]@{}; foreach ($k in $ROOT_SNAPSHOT.Keys) { $rs[$k] = ($post.files[$k] -eq $ROOT_SNAPSHOT[$k]) }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $running = @($h1.deployments | Where-Object { [string]$_.status -eq 'running' })
$out.live = [ordered]@{ scope = 'READ-ONLY on the production node, privacy agent, manager, tasks, VMs and configs'
  checks = $c; preserved = $keep; rootSnapshotMatch = $rs
  identity = [ordered]@{ cmdPid = $cmd.pid; cmdStart = $cmd.start; agentPid = $agent.pid; agentStart = $agent.start
    privacy = @($post.privacy | ForEach-Object { "$($_.pid)@$($_.start)" }); manager = $post.manager }
  tasks = $post.tasks; vmCount = $post.vmCount; hypervCount = $post.hypervCount; files = $post.files
  timing = [ordered]@{ listenerMs = $listenerMs; hostStateMs = $hostMs; agentUpMs = $agentUpMs; agentUpBoundSec = $AGENTUP_SEC; hostStatePolls = $script:hostPolls; agentUpWrongPidMs = $agentUpWrongMs }
  deployments = @($h1.deployments).Count; running = $running.Count
  minLeaseRemainingSec = $(if ($running.Count) { [int64](($running | ForEach-Object { [int64]$_.leaseUntil } | Measure-Object -Minimum).Minimum) - $now } else { $null })
  liveElapsedSec = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) }
$liveOk = @($c.Values | Where-Object { $_ -ne $true }).Count -eq 0 -and @($keep.Values | Where-Object { -not $_ }).Count -eq 0
$out.simulatedOk = [bool]$simOk; $out.liveOk = [bool]$liveOk; $out.fixtureElapsedSec = [math]::Round($Fixture.Elapsed.TotalSeconds, 1)
$out.notProven = 'No StopNode/StartNode/RestartPrivacy/Revert ran on a live entity: there is NO native full-revert or new-node readiness proof here.'
$out.pass = [bool]($simOk -and $liveOk -and $Fixture.Elapsed.TotalSeconds -le $FIXTURE_SEC)
$out | ConvertTo-Json -Compress -Depth 8
if (-not $out.pass) { exit 3 }
