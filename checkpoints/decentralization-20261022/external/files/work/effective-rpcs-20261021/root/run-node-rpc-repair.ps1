# run-node-rpc-repair.ps1 - ROOT ONLY. Remove the ONE hand-added 3-host BASE_RPCS override (line 12) from
# C:\ProgramData\Enclave\run-node.cmd, with exactly ONE node-agent restart (task \Enclave\Node).
# Derived from release-source/activation/node-restart.ps1 (beac40d9): the same pins, identity re-checks, stop/start order,
# pause bound and before/after comparisons. The swap happens ONLY while the Node task's run-node cmd.exe is GONE, because
# cmd.exe re-reads a running batch file at its saved byte offset, and 96 fewer bytes would make it run text from the
# middle of a line.
# PREPARED by claude e49af456, 2026-10-21. UNTESTED (the dev host has no PowerShell): root reviews, then runs it from
# hash-verified bytes like node-restart.ps1. PowerShell 5.1. Output: ONE line of JSON (hashes, PIDs, start times, booleans,
# measured times); never a config value or command line.
#   -Mode plan      read-only: CAS + the exact line shape + the in-memory new sha (must equal -ExpectNewSha)
#   -Mode repair    pins (agent/cmd/manager PID+start, run-node 3366a005, new 0fdc3699) -> Stop-ScheduledTask Node -> cmd gone
#                   -> agent gone -> backup + temp (same ACL) + verify + File.Replace -> verify -> Start-ScheduledTask
#                   -> new agent, the child of the new cmd -> 127.0.0.1:9600 answers. A failed swap restores the backup
#                   (or leaves the old file) and STILL starts the task, so the node comes back on the old settings.
#   -Mode rollback  the same stop/start around restoring the backup (CAS: current == new sha, backup == old sha)
param([ValidateSet('plan','repair','rollback')][string]$Mode = 'plan',
      [string]$ExpectOldSha = '3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686',
      [string]$ExpectNewSha = '0fdc3699228c9d7a4c2e971d05804b49f978a56a4c1d9f7a06f3546f3ced09fd',
      [int]$ExpectAgentPid = 0, [string]$ExpectAgentStart = '', [int]$ExpectCmdPid = 0, [string]$ExpectCmdStart = '',
      [int]$ExpectManagerPid = 0, [string]$ExpectManagerStart = '', [int]$MaxPauseSec = 120, [int]$BoundSec = 240)
$ErrorActionPreference = 'Stop'
$PD = 'C:\ProgramData\Enclave'; $RUN = Join-Path $PD 'run-node.cmd'; $T0 = Get-Date
$BAKDIR = Join-Path $PD '.rpc-repair-20261021'; $BAK = Join-Path $BAKDIR 'run-node.cmd.3366a005'
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'
$ENC = [Text.Encoding]::GetEncoding(28591)   # Latin-1: a byte-exact round trip, no re-encoding
$P3 = '(?m)^[ \t]*set "BASE_RPCS=https://base-rpc\.publicnode\.com,https://base\.drpc\.org,https://mainnet\.base\.org"[ \t]*\r\n'
$P5 = '(?m)^[ \t]*set "BASE_RPCS=https://base-rpc\.publicnode\.com,https://base\.gateway\.tenderly\.co,https://base-public\.nodies\.app,https://base\.drpc\.org,https://mainnet\.base\.org"[ \t]*\r\n'
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
function Done($o) { $o.mode = $Mode; $o.seconds = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1); $o | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function ShaBytes($x) { $h = [Security.Cryptography.SHA256]::Create(); (($h.ComputeHash($x) | ForEach-Object { $_.ToString('x2') }) -join '') }
function Utc($p) { $p.CreationDate.ToUniversalTime().ToString('o') }
function ById($procId) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 20 }
function Same($procId, $start, $name, $pat, $parent) {
  $p = ById $procId
  return [bool]($p -and (Utc $p) -eq $start -and [string]$p.Name -eq $name -and [string]$p.CommandLine -like $pat -and ($parent -eq 0 -or [int]$p.ParentProcessId -eq $parent)) }
function Procs {
  $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $RUN_PAT })
  $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $AGENT_PAT })
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = (Utc $_) } }) } }
function Manager {
  $c = @(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -ne 1) { return [ordered]@{ pid = 0; start = ''; listeners = $c.Count } }
  $p = ById $c[0].OwningProcess; [ordered]@{ pid = [int]$p.ProcessId; start = (Utc $p); listeners = 1 } }
function Others {
  $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 30)
  @(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' } | Sort-Object TaskName | ForEach-Object {
    $f = [regex]::Match([string]$_.Actions[0].Arguments, '[^"\\]+\.(cmd|ps1|mjs|exe)').Value
    $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId)@$(Utc $_)" } })
    "$($_.TaskName)=$([string]$_.State):$($ps -join '+')" }) -join ',' }
function Vms { try { @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [string]$_.id } | Sort-Object) -join ',' } catch { 'unavailable' } }
function AgentUp { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/deployments').StatusCode -eq 200 } catch { $false } }
# the edit, in memory: exactly one 3-host line at line 12, followed by the agent.mjs launch; exactly one 5-host line at line 5
function PlanEdit {
  $raw = [IO.File]::ReadAllBytes($RUN); $txt = $ENC.GetString($raw)
  $r = [ordered]@{ oldSha = (ShaBytes $raw); ok = $false; why = '' }
  $m3 = [regex]::Matches($txt, $P3); $m5 = [regex]::Matches($txt, $P5)
  if ($r.oldSha -ne $ExpectOldSha) { $r.why = 'run-node.cmd is not the pinned 3366a005 file'; return $r }
  if ($m3.Count -ne 1 -or $m5.Count -ne 1) { $r.why = "line shapes differ: $($m3.Count) three-host / $($m5.Count) five-host lines"; return $r }
  $at = $m3[0].Index; $r.line3 = ([regex]::Matches($txt.Substring(0, $at), "`n")).Count + 1
  $r.line5 = ([regex]::Matches($txt.Substring(0, $m5[0].Index), "`n")).Count + 1
  $nextLine = ($txt.Substring($at + $m3[0].Length) -split "`r`n", 2)[0]
  if ($r.line3 -ne 12 -or $r.line5 -ne 5 -or $nextLine -notmatch 'agent\.mjs') { $r.why = 'the override is not line 12 directly before the launch (or the 5-host line is not line 5)'; return $r }
  $newText = $txt.Remove($at, $m3[0].Length); $r.newBytes = $ENC.GetBytes($newText); $r.removed = $m3[0].Length
  $r.newSha = ShaBytes $r.newBytes
  if ($r.removed -ne 96 -or $r.newSha -ne $ExpectNewSha) { $r.why = "the computed new file is not the pinned one ($($r.newSha), $($r.removed) bytes)"; return $r }
  $r.ok = $true; return $r }
function PrivateDir {   # SYSTEM + Administrators only, like the cron-respawn private backup
  if (-not (Test-Path -LiteralPath $BAKDIR)) { New-Item -ItemType Directory -Path $BAKDIR | Out-Null }
  $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
  Set-Acl -LiteralPath $BAKDIR -AclObject $acl }
# writes $bytes over run-node.cmd: temp in the same directory with run-node.cmd's own ACL, verified, then File.Replace
function Install($bytes, $expect) {
  $tmp = Join-Path $PD ('run-node.cmd.tmp-' + $PID)
  try {
    # the DACL only (no owner change, which would need SeRestorePrivilege); File.Replace also keeps the target's ACL
    [IO.File]::WriteAllBytes($tmp, $bytes); $acl = Get-Acl -LiteralPath $tmp
    $acl.SetSecurityDescriptorSddlForm((Get-Acl -LiteralPath $RUN).GetSecurityDescriptorSddlForm('Access'), 'Access'); Set-Acl -LiteralPath $tmp -AclObject $acl
    if ((Sha $tmp) -ne $expect) { throw 'the temp file is not the expected bytes' }
    [IO.File]::Replace($tmp, $RUN, $null)
    return ((Sha $RUN) -eq $expect) }
  finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } } }

$t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'; $a = $t.Actions[0]
$o = [ordered]@{ taskState = [string]$t.State; actionExact = ([string]$a.Execute -eq 'cmd.exe' -and [string]$a.Arguments -eq ('/c "' + $RUN + '"') -and $t.Actions.Count -eq 1)
                 runNodeSha = (Sha $RUN); backupSha = (Sha $BAK); before = (Procs); manager = (Manager) }
if ($Mode -eq 'plan') { $e = PlanEdit; $o.plan = [ordered]@{ ok = $e.ok; why = $e.why; line3 = $e.line3; line5 = $e.line5; removed = $e.removed; newSha = $e.newSha }
  $o.decision = $(if ($e.ok) { 'plan ok' } else { 'plan refused: ' + $e.why }); Done $o }

$b = $o.before; $why = @()
if (-not $o.actionExact) { $why += 'the Node task action is not exactly cmd.exe /c run-node.cmd' }
if ($Mode -eq 'repair') { $e = PlanEdit; if (-not $e.ok) { $why += 'plan: ' + $e.why }; if ($o.backupSha -ne 'absent') { $why += 'a backup already exists (an earlier run): root inspects it first' } }
else { if ($o.runNodeSha -ne $ExpectNewSha) { $why += 'run-node.cmd is not the repaired 0fdc3699 file' }; if ($o.backupSha -ne $ExpectOldSha) { $why += 'the backup is not the 3366a005 file' } }
if ($b.cmd.Count -ne 1 -or $b.agent.Count -ne 1) { $why += "expected one run-node cmd and one agent, found $($b.cmd.Count)/$($b.agent.Count)" }
else {
  if ($b.cmd[0].pid -ne $ExpectCmdPid -or $b.cmd[0].start -ne $ExpectCmdStart) { $why += 'the run-node cmd.exe is not the pinned PID+start' }
  if ($b.agent[0].pid -ne $ExpectAgentPid -or $b.agent[0].start -ne $ExpectAgentStart -or $b.agent[0].parent -ne $b.cmd[0].pid) { $why += 'the agent is not the pinned PID+start+parent' } }
if ($o.manager.pid -ne $ExpectManagerPid -or $o.manager.start -ne $ExpectManagerStart) { $why += 'the manager is not the pinned PID+start' }
if ($MaxPauseSec -lt 30 -or $MaxPauseSec -gt 180) { $why += '-MaxPauseSec must be 30..180' }
if ($why.Count) { $o.decision = 'refused: ' + ($why -join '; '); Done $o }
$others0 = Others; $vms0 = Vms
if (-not (Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) -or -not (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid)) {
  $o.decision = 'refused: identity changed between the checks; nothing stopped'; Done $o }
$stop = Get-Date; $o.stoppedAt = $stop.ToUniversalTime().ToString('o')
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
if (Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) { $o.decision = 'FAILED: the run-node cmd.exe did not stop; nothing changed or started (root decides)'; Done $o }
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
if (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) {
  Stop-Process -Id $ExpectAgentPid -Force; $o.agentStoppedByVerifiedPid = $true
  $d = (Get-Date).AddSeconds(10); while ((Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
  if (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) { $o.decision = 'FAILED: the old agent is still running; nothing changed or started (root decides)'; Done $o } }
# THE SWAP: no run-node cmd.exe exists now (re-checked), so no batch is mid-file
$o.swap = 'not attempted'
if (@((Procs).cmd).Count -ne 0) { $o.swap = 'skipped: a run-node cmd.exe exists' }
else {
  try {
    if ($Mode -eq 'repair') {
      $e = PlanEdit
      if (-not $e.ok) { $o.swap = 'skipped: ' + $e.why }
      else {
        PrivateDir; Copy-Item -LiteralPath $RUN -Destination $BAK
        if ((Sha $BAK) -ne $ExpectOldSha) { $o.swap = 'skipped: the backup copy is not 3366a005' }
        elseif (Install $e.newBytes $ExpectNewSha) { $o.swap = 'repaired' }
        else { $o.swap = 'FAILED verify; restored: ' + [string](Install ([IO.File]::ReadAllBytes($BAK)) $ExpectOldSha) } } }
    else { $o.swap = $(if (Install ([IO.File]::ReadAllBytes($BAK)) $ExpectOldSha) { 'rolled back' } else { 'FAILED rollback verify' }) } }
  catch { $o.swap = 'FAILED: ' + $_.Exception.Message } }
$o.runNodeShaAfter = Sha $RUN
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$o.startedAt = (Get-Date).ToUniversalTime().ToString('o')
$limit = $stop.AddSeconds($MaxPauseSec); $n = $null
while (-not $n -and (Get-Date) -lt $limit -and (Left) -gt 0) {
  $q = Procs; $c1 = @($q.cmd | Where-Object { $_.pid -ne $ExpectCmdPid })
  $n = @($q.agent | Where-Object { $_.pid -ne $ExpectAgentPid -and $c1.Count -eq 1 -and $_.parent -eq $c1[0].pid }) | Select-Object -First 1
  if (-not $n) { Start-Sleep -Milliseconds 500 } }
$up = $false
while ($n -and -not $up -and (Get-Date) -lt $limit -and (Left) -gt 0) { $up = AgentUp; if (-not $up) { Start-Sleep -Seconds 1 } }
$o.agentUpAt = $(if ($up) { (Get-Date).ToUniversalTime().ToString('o') } else { $null })
$o.ingressPauseSec = [math]::Round(((Get-Date) - $stop).TotalSeconds, 1)
$o.after = (Procs); $m1 = Manager
$o.newAgent = [bool]$n; $o.agentAnswers = $up
$o.managerUnchanged = ($m1.pid -eq $o.manager.pid -and $m1.start -eq $o.manager.start)
$o.otherTasksUnchanged = ((Others) -eq $others0); $o.vmSetUnchanged = ((Vms) -eq $vms0)
$o.decision = $(if (-not $n -or -not $up) { "FAILED_PAUSE_BOUND: no answering new agent within $MaxPauseSec s of the stop (the task WAS started; swap: $($o.swap))" }
                elseif ($o.swap -notin @('repaired', 'rolled back')) { "restarted WITHOUT the change (swap: $($o.swap))" }
                elseif ($o.managerUnchanged -and $o.otherTasksUnchanged -and $o.vmSetUnchanged) { "$($o.swap); restarted: node agent only" }
                else { "$($o.swap); restarted, CHECK: see managerUnchanged / otherTasksUnchanged / vmSetUnchanged" }); Done $o
