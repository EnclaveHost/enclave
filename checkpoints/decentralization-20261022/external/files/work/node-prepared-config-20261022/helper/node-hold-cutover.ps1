# ROOT revision 2026-10-22: config rendering precedes the stop; decision fixes verified in Linux mocks only; native timing and renewal readiness remain activation blockers.
# node-hold-cutover.ps1 - the COORDINATED switch-on of the non-destructive wallet hold on minipc (PowerShell 5.1).
# Prepared by Claude 60543494 for ROOT; never run by its author. G4 + AI final package (work/g4-node-ai-final-20261021: 9d's
# frozen g4-node-final-package-20261021 2984c6f2 + the AI precondition, apply-ai-precondition.py f9a97362): + root review G-UPD (\Enclave\Update running or due inside the window REFUSES), N2 ($phase set before anything the
# scope-wide trap can see), N3 (READ principals of the temp directories: SYSTEM/Administrators only, else REFUSED). Executed ONLY from hash-verified bytes by a one-shot SYSTEM
# task (root-node-hold.py --cutover / --rollback-cutover), so an SSH disconnect cannot interrupt it. Bounded (-BoundSec).
# Every step appends ONE JSON line to <Stage>\cutover-<RunId>.jsonl (hashes, PIDs, times, counts, decisions; never a config
# value, key or log line).
#
# WHY THIS ORDER (G7): the node agent is STOPPED before the privacy agent starts enforcing the channel, and is started again
# only after the enforcement is VERIFIED. So the new node never meets an UNKNOWN wallet policy while the network could not
# acknowledge a hold, and a stopped node retires nothing. The cost is a bounded app-traffic outage: from the privacy-agent
# restart until the node's first tick re-grants (the channel starts EMPTY).
# LEASE DEADLINE (PROPOSAL, node-lease-window-review-20261021; replaces the helper's static ">= 20 min at preflight"): the pins
# read every expected id's leaseUntil from the running node, again immediately before stopping it; the cutover is refused unless forward + revert + margin fit before
# the first one ends. Forward waits preserve the configured recovery reserve; its native adequacy is NOT proven by this script.
#
#  -Mode cutover   1 pins: control/network files == new; node cmd+agent, manager, privacy agent == pinned PID+start;
#                    Hyper-V VM set (Get-VM Id|Name|State) and the manager's instances (id|name|status) == the preflight's
#                    (unavailable REFUSES); run-node.cmd, node-config.local.cmd, privacy-config.json == pinned sha; no
#                    wallet file; status.json fresh without walletAdmission. Snapshots: other \Enclave\ tasks' processes.
#                  2 STOP the Node task (fresh lease guard after identity checks; mutation phase set first)
#                  3 privacy-config.json enclaveNetwork.walletAdmission = {file} appended LAST (exact backup, ACL kept;
#                    the edit temp carries the config's exact ACL BEFORE any byte enters it, removed in finally)
#                  4 node-config.local.cmd += "set ENCLAVE_NETWORK_WALLET_HOLD=1" (byte append, exact backup, ACL kept)
#                  5 restart the privacy agent (pinned PID+start); the \Enclave\Network task starts it in ~10 s
#                  6 VERIFY it enforces: a status written by the NEW agent (updatedAt >= its start), fresh, walletAdmission
#                    of THIS runner, no document yet, egress map EMPTY; both configs re-read == the written shas
#                  7 START the Node task; a new agent completes a lease/adoption pass, exposed on its own 127.0.0.1:9600 listener
#                  8 VERIFY the channel: wallet-admission.json's generation == the agent's applied generation, fresh
#                  9 OBSERVE the re-grants; POST: Hyper-V set, manager instances + process, other tasks, channel-file
#                    writers (SYSTEM/Administrators only) and NEW node.log line counts decide DONE vs DONE_CHECK
#  Any failure after step 2 goes through ONE coordinator, REVERT (R0 config write, R1 not enforcing, R2 no channel, a crash,
#  and -Mode rollback alike):
#     a  the node PROVEN stopped (stopped again if it runs; if that cannot be proven: STOP, nothing else touched)
#     b  the node's flag restored FIRST (CAS against the journaled after-sha; exact before-bytes; re-read)
#     c  only then the network block (same); re-read
#     d  the privacy agent restarted; a FRESH status from the NEW agent WITHOUT walletAdmission; both configs re-read
#     e  only then the node started (and it must answer)
#   Any refusal in a..e stops there with RECOVERY_REQUIRED and a description of the ACTUAL state; the node is NOT started and
#   network enforcement is NOT dropped before the flag is gone. Only a complete a..e is reported as ROLLED_BACK.
param([ValidateSet('cutover','rollback')][string]$Mode = 'cutover', [Parameter(Mandatory=$true)][string]$ParamsFile, [Parameter(Mandatory=$true)][string]$ParamsSha)
# N2: the trap below is scope-wide (it also catches errors raised BEFORE its line): it must already see phase 'pins' (nothing
# changed: no fallback) and no before-state
$phase = 'pins'; $before = $null; $LeaseEnd = $null; $Fwd = $false
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $T0 = Get-Date
$pb = [IO.File]::ReadAllBytes($ParamsFile)          # ONE read: hashed, then parsed from the same bytes
if ((-join ([Security.Cryptography.SHA256]::Create().ComputeHash($pb) | ForEach-Object { $_.ToString('x2') })) -ne $ParamsSha) { exit 4 }
$PRM = [Text.Encoding]::UTF8.GetString($pb) | ConvertFrom-Json
$Stage = [string]$PRM.stage; $Run = [string]$PRM.runId; $BoundSec = [int]$PRM.boundSec
# testRoot/testNode: ONLY the mock harness (tools/cutover-mock.ps1) sets them, inside the sha-pinned params; root's helper never does
$TR = [string]$PRM.testRoot
if ($TR -and $env:OS -eq 'Windows_NT') { exit 5 }      # the mock hook can never run on a real Windows host
$PD = $(if ($TR) { $TR } else { 'C:\ProgramData\Enclave' }); $NET = Join-Path $PD 'network'; $CFG = Join-Path $NET 'privacy-config.json'; $LOCAL = Join-Path $PD 'node-config.local.cmd'
$RUNNODE = Join-Path $PD 'run-node.cmd'; $WALLET = Join-Path $NET 'wallet-admission.json'; $STATE = Join-Path $NET 'state'
# the node.exe that edits the config: the PINNED binary root's native writer proof ran (nodeExe/nodeSha in the hashed params,
# C:\Program Files\nodejs\node.exe b3094d0b, 21:29Z) - the one 605's NTFS ACL fixture writes with; refused below if it differs
$NODE = $(if ($TR) { [string]$PRM.testNode } else { [string]$PRM.nodeExe }); $NODELOG = Join-Path (Join-Path $PD 'logs') 'node.log'
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'; $FLAG = 'set ENCLAVE_NETWORK_WALLET_HOLD=1'
$ADMIN_SIDS = @('S-1-5-18', 'S-1-5-32-544')          # the only principals allowed to WRITE the wallet channel file
$J = Join-Path $Stage ("cutover-$Run.jsonl"); $PRIV = Join-Path $Stage 'private'
# a pinned start time as its exact ISO text: Windows PowerShell 5.1 keeps JSON strings as strings, PowerShell 6+ turns ISO
# strings into DateTime; both normalise to the same 'o' text
function Iso($v) { if ($v -is [datetime]) { $v.ToUniversalTime().ToString('o') } else { [string]$v } }
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
# LEASE DEADLINE (node-lease-window-review-20261021): $LeaseEnd = the earliest leaseUntil (chain epoch s) of the expected ids,
# read from the running node at the pins. While the node is stopped nothing renews, and a lease that lapses meanwhile is a
# retired VM on the next tick. LeaseLeft = the seconds the FORWARD path may still spend so that a revert started now (each
# recovery budget: lease.revertSec) has a reserved interval before the first lease ends. The renewal margin is provisional;
# The readiness gate requires a completed lease pass for every expected app, including any due renewal and running adoption.
# The forward FreshStatus and channel waits are capped by it ($Fwd); the new node is started only with lease.startNodeSec left.
# Forward paths reserve recovery against BOTH deadlines. In recovery, Lim uses the remaining global budget.
# The 330-second parameter floor is necessary, not a native timing proof. DO NOT ACTIVATE this revision on mocks alone.
function NowS { [DateTimeOffset]::new((Get-Date).ToUniversalTime()).ToUnixTimeSeconds() }
function LeaseLeft { if ($null -eq $LeaseEnd) { return 0 }; $LeaseEnd - (NowS) - [int]$PRM.lease.marginSec - [int]$PRM.lease.revertSec }
function ForwardLeft { [math]::Min(((Left) - [int]$PRM.lease.revertSec), (LeaseLeft)) }
function Lim($limitSec) { $l = [math]::Min($limitSec, (Left)); if ($Fwd) { $l = [math]::Min($l, (ForwardLeft)) }; return [math]::Max(0, $l) }
function NeedForward { if ($Fwd -and (ForwardLeft) -le 0) { throw 'forward deadline reached; reserved recovery time must not be consumed' } }
# Re-read AFTER identity checks, immediately before Stop-ScheduledTask. No mutation on unknown/short leases.
function BeforeStop {
  try {
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state'
    $ids = @($PRM.expectedIds); if (-not $ids.Count) { return 'no expected deployments' }
    $ends = @()
    foreach ($id in $ids) {
      $rows = @($h.deployments | Where-Object { [string]$_.id -eq [string]$id })
      if ($rows.Count -ne 1 -or [string]$rows[0].status -ne 'running') { return 'a deployment is missing, duplicated, or not running' }
      $v = $rows[0].leaseUntil
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -or
          [double]::IsNaN([double]$v) -or [double]::IsInfinity([double]$v) -or [double]$v -le 0 -or [math]::Floor([double]$v) -ne [double]$v) { return 'a lease deadline is invalid' }
      $ends += [int64]$v
    }
    $script:LeaseEnd = ($ends | Measure-Object -Minimum).Minimum
    if ((Sha $CFG) -ne [string]$PRM.cfgSha -or (Sha $LOCAL) -ne [string]$PRM.localSha) { return 'a config changed during preparation; nothing stopped' }
    if ((ForwardLeft) -lt [int]$PRM.lease.forwardMinSec) { return 'lease/global forward budget insufficient immediately before stop' }
    return $null
  } catch { return 'fresh lease read unavailable immediately before stop' }
}
function Now { (Get-Date).ToUniversalTime().ToString('o') }
function NowMs { [DateTimeOffset]::new((Get-Date).ToUniversalTime()).ToUnixTimeMilliseconds() }
function IsoMs($s) { [DateTimeOffset]::Parse((Iso $s)).ToUnixTimeMilliseconds() }
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function Log($o) { $o.at = (Now); $o.sec = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1)
  [IO.File]::AppendAllText($J, (($o | ConvertTo-Json -Compress -Depth 6) + "`n")) }
function Final($decision, $o) { $o.final = $decision; Log $o; exit 0 }
function Utc($p) { $p.CreationDate.ToUniversalTime().ToString('o') }
function ById($procId) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 20 }
function Same($procId, $start, $name, $pat, $parent) {
  $p = ById $procId
  return [bool]($p -and (Utc $p) -eq $start -and [string]$p.Name -eq $name -and [string]$p.CommandLine -like $pat -and ($parent -eq 0 -or [int]$p.ParentProcessId -eq $parent)) }
function NodeProcs {
  $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $RUN_PAT })
  $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $AGENT_PAT })
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = (Utc $_) } }) } }
function Privacy { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -match 'privacy-agent\.mjs' } |
  ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } }) }
function Manager { $c = @(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -ne 1) { return 'unavailable' }; $p = ById $c[0].OwningProcess; if (-not $p) { return 'unavailable' }; "$($p.ProcessId)@$(Utc $p)" }
function Others { $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 30)
  @(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' -and $_.TaskName -ne 'Network' } | Sort-Object TaskName | ForEach-Object {
    $f = [regex]::Match([string]$_.Actions[0].Arguments + ' ' + [string]$_.Actions[0].Execute, '[^"\\ ]+\.(cmd|ps1|mjs|exe|json)').Value
    $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId)@$(Utc $_)" } })
    "$($_.TaskName)=$([string]$_.State):$($ps -join '+')" }) -join ',' }
# the manager's instances (its own id, deployment name, status) and Hyper-V's authoritative VM identity (GUID, name, state)
function Vms { try { @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { "$($_.id)|$($_.name)|$($_.status)" } | Sort-Object) -join ',' } catch { 'unavailable' } }
function HyperV { try { @(Get-VM -ErrorAction Stop | ForEach-Object { "$($_.Id)|$($_.Name)|$($_.State)" } | Sort-Object) -join ',' } catch { 'unavailable' } }
function Known($v) { $v -and $v -ne 'unavailable' }      # 'unavailable' never compares as unchanged
function ReadinessNumber($v) {
  return [bool](($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -and
    -not [double]::IsNaN([double]$v) -and -not [double]::IsInfinity([double]$v) -and
    [double]$v -ge 0 -and [double]$v -le 9007199254740991 -and [math]::Floor([double]$v) -eq [double]$v)
}
function LeaseReady($h, $sinceMs) {
  $r = $h.leaseReadiness; $now = NowMs; $ids = @($PRM.expectedIds)
  if (-not $r) { return $false }
  foreach ($key in 'sequence','startedAt','completedAt') { if (-not (ReadinessNumber $r.$key)) { return $false } }
  if (-not $ids.Count -or -not $r -or $r.inFlight -ne $false -or [int64]$r.sequence -le 0 -or
      [int64]$r.startedAt -lt $sinceMs -or [int64]$r.completedAt -lt [int64]$r.startedAt -or
      [int64]$r.completedAt -gt $now -or $now - [int64]$r.completedAt -ge 5000) { return $false }
  foreach ($id in $ids) {
    $checks = @($r.deployments | Where-Object { [string]$_.id -eq [string]$id })
    $rows = @($h.deployments | Where-Object { [string]$_.id -eq [string]$id })
    if ($checks.Count -ne 1 -or $rows.Count -ne 1) { return $false }
    $c = $checks[0]; $d = $rows[0]
    foreach ($key in 'sequence','observedAt','checkedAt','leaseUntil') { if (-not (ReadinessNumber $c.$key)) { return $false } }
    if (-not (ReadinessNumber $d.leaseUntil)) { return $false }
    if ([string]$c.status -ne 'ready' -or [string]$d.status -ne 'running' -or [string]$c.runner -ne [string]$PRM.runner -or
        [int64]$c.sequence -ne [int64]$r.sequence -or [int64]$c.observedAt -lt [int64]$r.startedAt -or
        [int64]$c.checkedAt -lt [int64]$c.observedAt -or [int64]$c.checkedAt -gt [int64]$r.completedAt -or
        [double]$c.leaseUntil -ne [double]$d.leaseUntil -or [double]$c.leaseUntil -le (NowS) + [int]$PRM.lease.marginSec) { return $false }
  }
  return $true
}
function AgentUp($agent) {
  try {
    # Bind the loopback listener to the process whose identity StartNode just discovered.
    $listeners = @(Get-NetTCPConnection -LocalPort 9600 -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or [int]$listeners[0].OwningProcess -ne [int]$agent.pid) { return $false }
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state'
    return (LeaseReady $h (IsoMs $agent.start))
  } catch { return $false }
}
function Status { try { [IO.File]::ReadAllText((Join-Path $STATE 'status.json')) | ConvertFrom-Json } catch { $null } }
function EgressApps { try { @(([IO.File]::ReadAllText((Join-Path $STATE 'egress-routes.json')) | ConvertFrom-Json).apps.PSObject.Properties).Count } catch { -1 } }
function LogFrom($offset, $pats) {   # COUNTS of patterns in node.log lines written after $offset (never the lines)
  $o = [ordered]@{}; foreach ($k in $pats) { $o[$k] = 0 }
  try { $fs = [IO.File]::Open($NODELOG, 'Open', 'Read', 'ReadWrite,Delete'); try { if ($fs.Length -lt $offset) { $o.rotated = $true; $offset = 0 }; [void]$fs.Seek($offset, 'Begin')
        $t = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
        foreach ($k in $pats) { $o[$k] = ([regex]::Matches($t, [regex]::Escape($k))).Count } } catch { $o.error = 'node.log unreadable' }
  return $o }
function Writers($path) {   # principals with any write right on $path, and its owner
  $a = Get-Acl -LiteralPath $path
  [ordered]@{ writers = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x116) } |
                          ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
              owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value } }
# N3: principals that can READ what is created in $path: effective READ on the directory itself (root's gate for the network
# directory), and READ ACEs that new FILES inherit (ObjectInherit). ReadData 0x1, GENERIC_ALL 0x10000000, GENERIC_READ (sign bit)
function Readers($path) {
  $rules = @((Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
  $rd = { param($r) $v = [int]$r.FileSystemRights; (($v -band 0x10000001) -ne 0) -or ($v -lt 0) }
  [ordered]@{ readers = @($rules | Where-Object { -not ([string]$_.PropagationFlags -match 'InheritOnly') -and (& $rd $_) } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
              fileInheritReaders = @($rules | Where-Object { ([string]$_.InheritanceFlags -match 'ObjectInherit') -and (& $rd $_) } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) } }
function PrivDir { if ($TR) { [void][IO.Directory]::CreateDirectory($PRIV); return }   # mock harness only (no Windows ACL API)
  if (-not (Test-Path -LiteralPath $PRIV)) { $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
    foreach ($s in $ADMIN_SIDS) { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    [void][IO.Directory]::CreateDirectory($PRIV, $ds) } }
# an EMPTY temp beside $ref that carries $ref's exact ACL BEFORE any byte is written into it (verified), or a throw
function ProtectedTemp($ref, $tag) {
  $acl = Get-Acl -LiteralPath $ref; $tmp = $ref + $tag + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [IO.File]::WriteAllBytes($tmp, [byte[]]@())
  try { Set-Acl -LiteralPath $tmp -AclObject $acl
        if ((Get-Acl -LiteralPath $tmp).Sddl -ne $acl.Sddl -or (Get-Item -LiteralPath $tmp).Length -ne 0) { throw 'the temp file does not carry the config ACL' } }
  catch { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }; throw }
  return $tmp }
# CAS write of ONE config file: $bytes into a protected temp, then [IO.File]::Replace; the temp never outlives the call
function CasWrite($path, $expect, [byte[]]$bytes) {
  NeedForward
  if ((Sha $path) -ne $expect) { throw "CAS refused: $path is not the expected sha" }
  $acl = Get-Acl -LiteralPath $path; $tmp = ProtectedTemp $path '.nh-'
  try { [IO.File]::WriteAllBytes($tmp, $bytes); if ((Sha $path) -ne $expect) { throw "CAS refused: $path changed during the write" }
        [IO.File]::Replace($tmp, $path, [NullString]::Value); Set-Acl -LiteralPath $path -AclObject $acl }
  finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
  return [ordered]@{ after = (Sha $path); aclKept = ((Get-Acl -LiteralPath $path).Sddl -eq $acl.Sddl) } }
function WaitNodeGone($pin, $name, $pat, $parent, $limitSec) {
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  while ((Get-Date) -lt $lim) {
    $same = Same $pin.pid $pin.start $name $pat $parent
    # A query that returns too late is not proof obtained inside this budget.
    if ((Get-Date) -ge $lim) { return $false }
    if (-not $same) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function StopNode($cmd, $agent) {
  if (-not (Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0) -or -not (Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid)) { return 'identity changed; nothing stopped' }
  if ($Fwd -and $phase -eq 'pins') { $refusal = BeforeStop; if ($refusal) { return ('REFUSED: ' + $refusal) } }
  # A task API may stop the task and then throw. Mark the mutation boundary BEFORE invoking it.
  if ($phase -eq 'pins') { $script:phase = 'stopping' }
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
  if (-not (WaitNodeGone $cmd 'cmd.exe' $RUN_PAT 0 30)) { return 'the run-node cmd.exe did not verifiably stop inside its budget' }
  if (-not (WaitNodeGone $agent 'node.exe' $AGENT_PAT $cmd.pid 30)) {
    NeedForward
    $same = Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid
    NeedForward
    if ($same) {
      Stop-Process -Id $agent.pid -Force
      if (-not (WaitNodeGone $agent 'node.exe' $AGENT_PAT $cmd.pid 10)) { return 'the old agent did not verifiably stop inside its budget' }
    }
  }
  if (@((NodeProcs).agent).Count -ne 0) { return 'another node agent is running' }
  return 'stopped'
}
function NodeStopped { $q = NodeProcs; return ($q.cmd.Count -eq 0 -and $q.agent.Count -eq 0) }
function StartNode($limitSec) {   # -> new process identities AND completed per-app lease/adoption evidence inside the available budget
  $budget = Lim $limitSec; if ($budget -le 0) { return $null }
  $lim = (Get-Date).AddSeconds($budget); $n = $null
  Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
  while (-not $n -and (Get-Date) -lt $lim) {
    $q = NodeProcs; if ((Get-Date) -ge $lim) { return $null }
    if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { $n = $q } else { Start-Sleep -Milliseconds 500 }
  }
  while ($n -and (Get-Date) -lt $lim) {
    $up = AgentUp $n.agent[0]
    if ((Get-Date) -ge $lim) { return $null }
    if ($up) { return [ordered]@{ cmd = $n.cmd[0]; agent = $n.agent[0] } }
    Start-Sleep -Seconds 1
  }
  return $null
}
function RestartPrivacy($pin, $limitSec) {
  $budget = Lim $limitSec; if ($budget -le 0) { return $null }
  $lim = (Get-Date).AddSeconds($budget)
  $pa = @(Privacy)
  # The identity query consumes this same budget; do not kill anything after it expired.
  if ((Get-Date) -ge $lim -or ($Fwd -and (ForwardLeft) -le 0) -or $pa.Count -ne 1 -or $pa[0].pid -ne $pin.pid -or $pa[0].start -ne $pin.start) { return $null }
  Stop-Process -Id $pin.pid -Force
  while ((Get-Date) -lt $lim) {
    Start-Sleep -Seconds 2; if ((Get-Date) -ge $lim) { break }
    $n = @(Privacy | Where-Object { $_.pid -ne $pin.pid -or $_.start -ne $pin.start })
    if ((Get-Date) -ge $lim) { return $null }
    if ($n.Count -eq 1) { return $n[0] }
  }
  return $null
}
# the NEW agent's own status (updatedAt >= its process start), fresh (< 5 s): enforcing THIS runner's channel (with or
# without a document of $wantGeneration), or (-plain) NOT enforcing
function FreshStatus($limitSec, $sinceMs, $mode, $wantGeneration) {
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  while ((Get-Date) -lt $lim) { $s = Status
    if ((Get-Date) -ge $lim) { return $false }
    if ($s -and [int64]$s.updatedAt -ge $sinceMs -and ((NowMs) - [int64]$s.updatedAt) -lt 5000) { $w = $s.walletAdmission
      if ($mode -eq 'plain' -and -not $w) { return $true }
      if ($mode -eq 'enforcing' -and $w -and [string]$w.runner -eq [string]$PRM.runner -and
          $(if ($wantGeneration) { [string]$w.generation -eq $wantGeneration -and $w.fresh -eq $true } else { $w.fresh -ne $true })) { return $true } }
    Start-Sleep -Seconds 1 }
  return $false }
function RestoreOne($k) {   # the exact before-bytes of ONE file, CAS against its journaled after-sha; -> outcome text
  $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); $b = $before[$k]; $cur = Sha $path
  if ($cur -eq $b.before) { return 'already before' }
  if (-not $b.backup -or (Sha $b.backup) -ne $b.before) { return 'REFUSED: the backup is missing or not the before sha' }
  if (-not $b.after -or $cur -ne $b.after) { return 'REFUSED: the file is neither its before nor its journaled after sha (changed by someone else)' }
  try { $w = CasWrite $path $b.after ([IO.File]::ReadAllBytes($b.backup)) } catch { return 'REFUSED: ' + $_.Exception.Message }
  if ($w.after -ne $b.before) { return 'AMBIGUOUS: written, but the file is not the before sha' }
  if (-not $w.aclKept) { return 'REFUSED: restored bytes, but the ACL changed' }
  return 'restored' }
function Recovery($what, $x) { $x.recovery = $what; $x.nodeStopped = (NodeStopped); $x.localSha = (Sha $LOCAL); $x.cfgSha = (Sha $CFG)
  # root's manual deadline: with the node stopped, the first lease lapses (its VM is retired on the next tick) at leaseFirstEnd
  $x.leaseFirstEnd = $LeaseEnd; $x.leaseSecLeft = $(if ($null -ne $LeaseEnd) { $LeaseEnd - (NowS) } else { $null })
  Final ("RECOVERY_REQUIRED: $what") $x }
# THE coordinator (see the header): every fallback and the explicit rollback. Returns the evidence of a COMPLETE revert, or
# ends the run with RECOVERY_REQUIRED (never starts the node, never drops enforcement before the flag is gone).
function Revert($why) {
  $script:Fwd = $false                                  # the revert's own waits are never cut by the lease deadline
  $x = [ordered]@{ step = 'revert'; why = $why; leaseLeft = (LeaseLeft) }
  $q = NodeProcs
  if ($q.cmd.Count -or $q.agent.Count) {
    $x.stop = $(if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { StopNode $q.cmd[0] $q.agent[0] } else { 'the node processes are not one identifiable cmd+agent' }) }
  if (-not (NodeStopped)) { Recovery "the node could not be proven stopped ($($x.stop)); NO config was touched by the revert" $x }
  $x.local = RestoreOne 'local'
  if ($x.local -notin 'restored', 'already before' -or (Sha $LOCAL) -ne $before.local.before) {
    Recovery "the node flag was not restored ($($x.local)); the network block is KEPT (enforcement unchanged); the node stays STOPPED" $x }
  $x.cfg = RestoreOne 'cfg'
  if ($x.cfg -notin 'restored', 'already before' -or (Sha $CFG) -ne $before.cfg.before) {
    Recovery "the network block was not restored ($($x.cfg)); the flag IS restored; the node stays STOPPED (the network may still enforce)" $x }
  $cur = @(Privacy)
  if ($cur.Count -ne 1) { Recovery "not exactly one privacy agent ($($cur.Count)); both configs ARE restored; the node stays STOPPED" $x }
  $n = RestartPrivacy $cur[0] 90; $x.privacy = $n
  if (-not $n) { Recovery 'the privacy agent did not come back; both configs ARE restored; the node stays STOPPED' $x }
  $x.plain = FreshStatus 90 (IsoMs $n.start) 'plain' $null
  if (-not $x.plain) { Recovery 'no fresh status WITHOUT walletAdmission from the new privacy agent; both configs ARE restored; the node stays STOPPED' $x }
  if ((Sha $LOCAL) -ne $before.local.before -or (Sha $CFG) -ne $before.cfg.before -or -not (NodeStopped)) {
    Recovery 'a config or the node changed after the restore; the node is NOT started by this run' $x }
  $nn = StartNode 150; $x.nodeUp = [bool]$nn
  if (-not $nn) { Recovery 'both configs ARE restored and the network does not enforce, but the started node did not answer' $x }
  return $x }
function Identity($o) {   # the post-check of everything this run must not have changed
  $o.hypervUnchanged = (Known $hv0) -and ((HyperV) -eq $hv0); $o.managerVmsUnchanged = (Known $vms0) -and ((Vms) -eq $vms0)
  $o.managerUnchanged = (Known $mg) -and ((Manager) -eq $mg); $o.othersUnchanged = ((Others) -eq $others0)
  return ($o.hypervUnchanged -and $o.managerVmsUnchanged -and $o.managerUnchanged -and $o.othersUnchanged) }

# a terminating error still goes through the SAME coordinator (or, before any change / after verification, through nothing)
# ($phase = 'pins' and $before = $null are set right after param(): N2)
trap {
  $script:Fwd = $false
  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }
  if ($phase -in 'pins', 'verified') { $x.final = "CRASHED in phase ${phase}: no fallback ($(if ($phase -eq 'pins') { 'nothing was changed' } else { 'the channel was already verified' })); root decides"; Log $x; exit 1 }
  try {
    if ($phase -eq 'stopped') {   # the node is stopped, no config was touched: the original state, proven, then started
      $x.unchanged = ((Sha $LOCAL) -eq [string]$PRM.localSha -and (Sha $CFG) -eq [string]$PRM.cfgSha)
      $s = Status; $x.plain = [bool]($s -and -not $s.walletAdmission -and ((NowMs) - [int64]$s.updatedAt) -lt 5000)
      if (-not ($x.unchanged -and $x.plain -and (NodeStopped))) { Recovery 'crash with the node stopped; the configs or the network status are not the original ones, so the node is NOT started' $x }
      $x.nodeUp = [bool](StartNode 150); if (-not $x.nodeUp) { Recovery 'crash with the node stopped and nothing else changed; the restarted node did not answer' $x }
      Final "CRASHED_RESTORED: crash in phase $phase before any config change; the original state verified and the node started" $x }
    $r = Revert "crash in phase $phase"; $r.error = $x.error
    $r.identityUnchanged = Identity $r
    Final $(if ($r.identityUnchanged) { "ROLLED_BACK_AFTER_CRASH: crash in phase $phase; flag then block restored exactly, the network verified not enforcing, node started" }
            else { "ROLLED_BACK_AFTER_CRASH_CHECK: configs restored and node started, but an identity check failed (see fields)" }) $r
  } catch { $x.final = "RECOVERY_REQUIRED: the fallback itself failed ($($_.Exception.Message)); see the steps"; Log $x; exit 1 } }

# ---------------------------------------------------------------- common pins
$lock = Join-Path $Stage ("$Mode-$Run.lock")
try { $fs = [IO.File]::Open($lock, 'CreateNew', 'Write'); $fs.Close() } catch { Log ([ordered]@{ step = 'lock'; decision = 'REFUSED: this run id already ran (lock exists)' }); exit 0 }
$o = [ordered]@{ step = 'pins'; mode = $Mode; runner = [string]$PRM.runner }
$why = @()
foreach ($f in $PRM.files) { if ((Sha ([string]$f.path)) -ne [string]$f.sha) { $why += "file not as pinned: $($f.path)" } }
if ((Sha $RUNNODE) -ne [string]$PRM.runNodeSha) { $why += 'run-node.cmd is not the pinned file' }
$np = NodeProcs; $o.node = $np
if ($np.cmd.Count -ne 1 -or $np.agent.Count -ne 1 -or $np.cmd[0].pid -ne [int]$PRM.node.cmdPid -or $np.cmd[0].start -ne (Iso $PRM.node.cmdStart) -or
    $np.agent[0].pid -ne [int]$PRM.node.agentPid -or $np.agent[0].start -ne (Iso $PRM.node.agentStart) -or $np.agent[0].parent -ne $np.cmd[0].pid) { $why += 'the node cmd/agent are not the pinned identities' }
$mg = Manager; $o.manager = $mg; if (-not (Known $mg) -or $mg -ne [string]$PRM.manager) { $why += 'the manager is unavailable or not the pinned PID+start' }
$pa = @(Privacy); $o.privacy = $pa; if ($pa.Count -ne 1 -or $pa[0].pid -ne [int]$PRM.privacy.pid -or $pa[0].start -ne (Iso $PRM.privacy.start)) { $why += 'the privacy agent is not the pinned PID+start' }
$vms0 = Vms; $hv0 = HyperV; $others0 = Others
$o.vmCount = $(if (Known $vms0) { @($vms0 -split ',' | Where-Object { $_ }).Count } else { -1 }); $o.hypervCount = $(if (Known $hv0) { @($hv0 -split ',' | Where-Object { $_ }).Count } else { -1 })
if (-not (Known $vms0) -or $vms0 -ne [string]$PRM.vms) { $why += 'the manager instance set is unavailable or not the preflight set' }
if (-not (Known $hv0) -or $hv0 -ne [string]$PRM.hyperv) { $why += 'the Hyper-V VM set (Get-VM) is unavailable or not the preflight set' }
$logOffset = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 }); $o.nodeLogOffset = $logOffset
# G-UPD (root review): \Enclave\Update (update-host.ps1, SYSTEM, hourly) ends a newer release's install with Start-ScheduledTask
# \Enclave\Node and \Enclave\Network, i.e. it can start the node OUTSIDE this coordinator. Refuse when it runs or is due before
# this run's bound (+60 s). An unreadable task info is a terminating error in phase 'pins' (nothing changed).
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
if ($u) { $ui = Get-ScheduledTaskInfo -InputObject $u; $o.updateTask = [ordered]@{ state = [string]$u.State; next = $(if ($ui.NextRunTime) { $ui.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) }
  if ([string]$u.State -eq 'Running' -or ($ui.NextRunTime -and $ui.NextRunTime -lt (Get-Date).AddSeconds($BoundSec + 60))) { $why += 'the \Enclave\Update task runs or is due inside this window' } }
# N3 (root review): the config temps are created EMPTY with the inherited ACL, then Set-Acl'd; nobody but SYSTEM/Administrators
# may be able to read in the directories where they are created (privacy-config.json's network dir: effective READ; the
# node-config.local.cmd dir: READ inherited by new files)
$nr = Readers $NET; $pr = Readers $PD; $o.networkDirReaders = $nr.readers; $o.networkDirFileInheritReaders = $nr.fileInheritReaders; $o.programDataFileInheritReaders = $pr.fileInheritReaders
if (@(@($nr.readers) + @($nr.fileInheritReaders) | Where-Object { $ADMIN_SIDS -notcontains $_ }).Count) { $why += 'the network directory is readable by more than SYSTEM/Administrators (N3)' }
if (@($pr.fileInheritReaders | Where-Object { $ADMIN_SIDS -notcontains $_ }).Count) { $why += 'new files in the Enclave data directory inherit READ for more than SYSTEM/Administrators (N3)' }
# LEASE DEADLINE (see LeaseLeft): every expected id must be a RUNNING record of THIS node with a numeric leaseUntil, read now from
# the node itself (127.0.0.1:9600/v1/host/state, the record the helper's coverage read uses). Cutover: refused unless the forward
# path keeps lease.forwardMinSec. Rollback: recorded only (its deadline is journaled for root's recovery), never a new refusal.
$lp = $PRM.lease; $o.lease = $null
if (-not $lp -or [int]$lp.marginSec -le 0 -or [int]$lp.revertSec -le 0 -or [int]$lp.forwardMinSec -le 0 -or [int]$lp.startNodeSec -le 0) { $why += 'the lease budget (lease.marginSec/revertSec/forwardMinSec/startNodeSec) is missing from the pinned params' }
else {
  $hs = $null; try { $hs = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state' } catch {}
  $by = @{}; foreach ($d in @($hs.deployments)) { if ($d) { $by[([string]$d.id).ToLower()] = $d } }
  $ends = @(); $bad = @()
  foreach ($i in @($PRM.expectedIds)) { $d = $by[([string]$i).ToLower()]; $v = $d.leaseUntil
    if ($d -and [string]$d.status -eq 'running' -and ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal])) { $ends += [pscustomobject]@{ id = [string]$i; end = [int64]$v } } else { $bad += [string]$i } }
  if (-not $hs) { $o.lease = 'unreadable'; if ($Mode -eq 'cutover') { $why += 'the node lease state (127.0.0.1:9600/v1/host/state) is unreadable: the lease deadline is unknown' } }
  elseif ($bad.Count) { $o.lease = [ordered]@{ notRunningOrNoLease = $bad }; if ($Mode -eq 'cutover') { $why += "expected ids without a running record and a numeric leaseUntil: $($bad -join ',')" } }
  else { $first = @($ends | Sort-Object end)[0]; $LeaseEnd = $first.end
    $o.lease = [ordered]@{ firstId = $first.id; firstEnd = $LeaseEnd; secLeft = $LeaseEnd - (NowS); forwardSec = (LeaseLeft); marginSec = [int]$lp.marginSec; revertSec = [int]$lp.revertSec; forwardMinSec = [int]$lp.forwardMinSec; startNodeSec = [int]$lp.startNodeSec }
    if ($Mode -eq 'cutover' -and (LeaseLeft) -lt [int]$lp.forwardMinSec) {
      $why += "lease deadline: the first lease ($($first.id.Substring(0, 10))) ends in $($LeaseEnd - (NowS)) s, this cutover needs >= $([int]$lp.forwardMinSec + [int]$lp.revertSec + [int]$lp.marginSec) s (forward + revert + margin): run it right after the next renewals" } } }
if ($Mode -eq 'cutover') {
  # This is only a NECESSARY floor: 90+90+150 are the explicit recovery waits alone.
  # Native stop/query/file overhead and renewal readiness STILL require separate proof before activation.
  if ($lp -and [int]$lp.revertSec -lt (90 + 90 + 150)) { $why += 'revert budget is shorter than its explicit 330-second waits (before native overhead)' }
  if ($lp -and ((Left) - [int]$lp.revertSec) -lt [int]$lp.forwardMinSec) { $why += 'global deadline leaves insufficient forward time after reserving recovery' }
  if ((Sha $LOCAL) -ne [string]$PRM.localSha) { $why += 'node-config.local.cmd is not the pinned sha' }
  if ((Sha $CFG) -ne [string]$PRM.cfgSha) { $why += 'privacy-config.json is not the pinned sha' }
  if ((Sha $WALLET) -ne 'absent') { $why += 'a wallet-admission.json already exists' }
  if ([IO.File]::ReadAllText($LOCAL) -match 'ENCLAVE_NETWORK_WALLET_HOLD') { $why += 'node-config.local.cmd already names the flag' }
  if (-not $TR -and (-not $PRM.nodeExe -or -not $PRM.nodeSha -or (Sha $NODE) -ne [string]$PRM.nodeSha)) { $why += 'the node.exe for the config edit is not the pinned (root-proven) binary' }
  $s = Status; if (-not $s -or $s.walletAdmission -or ((NowMs) - [int64]$s.updatedAt) -gt 5000) { $why += 'status.json is not fresh, or already reports walletAdmission' }
  $nw = Writers $NET; $o.networkDirWriters = $nw.writers
  # both files this run rewrites must carry an AUTO-INHERITED DACL (D:AI / D:PAI): the form native-proven to round-trip
  # ProtectedTemp/CasWrite's exact-SDDL check (fixture 22:28Z). Any other form REFUSES here, before the node is stopped.
  foreach ($p in $CFG, $LOCAL) { $df = [regex]::Match([string](Get-Acl -LiteralPath $p).Sddl, 'D:([A-Z]*)\(').Groups[1].Value
    if ($df -notmatch 'AI') { $why += "$(Split-Path -Leaf $p) has a DACL that is not auto-inherited (D:$df): the exact ACL round-trip would refuse; root fixes that ACL first" } }
  if (@($nw.writers | Where-Object { $ADMIN_SIDS -notcontains $_ }).Count) { $why += 'the network directory (where the channel file is created) is writable by more than SYSTEM/Administrators' }
  $o.egressAppsBefore = EgressApps
} else {
  foreach ($k in 'local', 'cfg') { $b = $PRM.before.$k; if ((Sha ([string]$b.backup)) -ne [string]$b.before) { $why += "the $k backup is not its before sha" }
    $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); $now = Sha $path; if ($now -ne [string]$b.after -and $now -ne [string]$b.before) { $why += "$k changed since the cutover (neither its after nor its before sha): root decides" } } }
if ($why.Count) { Final ('REFUSED: ' + ($why -join '; ')) $o }
Log $o
$before = @{ local = @{ before = [string]$PRM.localSha; after = ''; backup = '' }; cfg = @{ before = [string]$PRM.cfgSha; after = ''; backup = '' } }
if ($Mode -eq 'rollback') { foreach ($k in 'local', 'cfg') { $b = $PRM.before.$k; $before[$k] = @{ before = [string]$b.before; after = [string]$b.after; backup = [string]$b.backup } } }

# Render with Node BEFORE stopping anything. Even a hung renderer cannot consume a stopped node's lease window.
# The scheduled task's overall bound still applies; a late result is refused by the fresh BeforeStop/global budget gate.
# Output remains in an ACL-protected temporary file, then process memory. The original config is never edited here.
$preparedCfgBytes = $null
if ($Mode -eq 'cutover') {
  $edit = $null
  try {
    $js = "const fs=require('fs');const [p,t,f]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,'utf8'));const e=c.enclaveNetwork;" +
          "if(!e||typeof e!=='object')throw new Error('no enclaveNetwork');delete e.walletAdmission;e.walletAdmission={file:f};fs.writeFileSync(t,JSON.stringify(c,null,2)+String.fromCharCode(10));"
    $edit = ProtectedTemp $CFG '.nh-edit-'
    $ea = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; $null = & $NODE -e $js $CFG $edit $WALLET 2>&1; $rc = $LASTEXITCODE }
    finally { $ErrorActionPreference = $ea }
    if ($rc -ne 0) { throw 'the config preparation failed' }
    $preparedCfgBytes = [IO.File]::ReadAllBytes($edit)
    if ($preparedCfgBytes.Length -eq 0) { throw 'the prepared config is empty' }
  } catch {
    Final 'REFUSED: config preparation failed before any process was stopped or live config changed' ([ordered]@{})
  } finally {
    if ($edit -and (Test-Path -LiteralPath $edit)) { Remove-Item -LiteralPath $edit -Force }
  }
}

# ---------------------------------------------------------------- stop the node (both modes)
$Fwd = ($Mode -eq 'cutover')
$st = StopNode ([ordered]@{ pid = [int]$PRM.node.cmdPid; start = (Iso $PRM.node.cmdStart) }) ([ordered]@{ pid = [int]$PRM.node.agentPid; start = (Iso $PRM.node.agentStart) })
Log ([ordered]@{ step = 'stop-node'; decision = $st; nodeStopped = (NodeStopped) })
if ($st -like 'REFUSED:*') { Final $st ([ordered]@{ leaseFirstEnd = $LeaseEnd; forwardLeft = (ForwardLeft) }) }
if ($st -eq 'identity changed; nothing stopped') { Final 'REFUSED: the node identity changed before the stop; nothing was stopped or changed' ([ordered]@{}) }
if ($st -ne 'stopped' -or -not (NodeStopped)) { Recovery "the node could not be proven stopped before any change ($st); NO config changed; nothing started" ([ordered]@{}) }
$phase = 'stopped'

if ($Mode -eq 'rollback') {
  $phase = 'configs'; $r = Revert 'explicit rollback'
  $phase = 'verified'; $r.identityUnchanged = Identity $r
  $r.log = LogFrom $logOffset @('isolated domain retired', 'isolation spawned', 'is KEPT', 'wallet hold channel')
  Final $(if ($r.identityUnchanged) { 'ROLLED_BACK: flag then block restored to the exact before-bytes, the network verified not enforcing, node started, identities unchanged' }
          else { 'ROLLED_BACK_CHECK: configs restored and node started, but an identity check failed (see fields)' }) $r }

# ---------------------------------------------------------------- cutover: configs (node stopped)
$phase = 'configs'
NeedForward
PrivDir
$lb = [IO.File]::ReadAllBytes($LOCAL); $before.local.backup = Join-Path $PRIV "node-config.local.cmd.before-$Run"; [IO.File]::WriteAllBytes($before.local.backup, $lb)
$cb = [IO.File]::ReadAllBytes($CFG); $before.cfg.backup = Join-Path $PRIV "privacy-config.json.before-$Run"; [IO.File]::WriteAllBytes($before.cfg.backup, $cb)
Log ([ordered]@{ step = 'backups'; local = (Sha $before.local.backup); cfg = (Sha $before.cfg.backup); localBackup = $before.local.backup; cfgBackup = $before.cfg.backup })
if ((Sha $before.local.backup) -ne $before.local.before -or (Sha $before.cfg.backup) -ne $before.cfg.before) { Revert 'a backup is not the pinned before sha' | Out-Null; Final 'ROLLED_BACK_R0: a backup did not match; nothing was written' ([ordered]@{}) }
try {
  # The prepared bytes were rendered while the existing node was still renewing leases.
  # Both the fresh stop guard and this CAS require the exact original config; no stale edit can overwrite an operator change.
  $w = CasWrite $CFG $before.cfg.before $preparedCfgBytes; $before.cfg.after = $w.after
  Log ([ordered]@{ step = 'config'; after = $w.after; aclKept = $w.aclKept })
  if (-not $w.aclKept) { throw 'the config ACL changed' }
  # BYTE-level append (the file's existing bytes are never re-encoded)
  $sep = $(if ($lb.Length -eq 0 -or ($lb.Length -ge 2 -and $lb[$lb.Length - 2] -eq 13 -and $lb[$lb.Length - 1] -eq 10)) { '' } else { "`r`n" })
  $add = [Text.Encoding]::ASCII.GetBytes($sep + $FLAG + "`r`n"); $nb = New-Object byte[] ($lb.Length + $add.Length)
  [Array]::Copy($lb, $nb, $lb.Length); [Array]::Copy($add, 0, $nb, $lb.Length, $add.Length)
  $w = CasWrite $LOCAL $before.local.before $nb; $before.local.after = $w.after
  Log ([ordered]@{ step = 'flag'; after = $w.after; aclKept = $w.aclKept })
  if (-not $w.aclKept) { throw 'the node-config ACL changed' }
} catch {
  $err = $_.Exception.Message
  # a write that may have landed is journaled as its CURRENT sha, so the revert's CAS can restore it (never a guess)
  foreach ($k in 'local', 'cfg') { $p0 = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); if (-not $before[$k].after -and (Sha $p0) -ne $before[$k].before) { $before[$k].after = 'unknown-write' } }
  $r = Revert "config write failed: $err"; $r.error = $err; $r.identityUnchanged = Identity $r
  Final 'ROLLED_BACK_R0: a config write failed; the revert restored the flag then the block exactly, verified the network not enforcing, and started the node (old behaviour)' $r
}

# ---------------------------------------------------------------- the network enforces BEFORE the node runs
$phase = 'enforcing'   # forward budgeting has been active since before the initial stop
$n = RestartPrivacy ([ordered]@{ pid = [int]$PRM.privacy.pid; start = (Iso $PRM.privacy.start) }) 90
$enf = $n -and (FreshStatus 90 (IsoMs $n.start) 'enforcing' $null); $eg = EgressApps
$same = ((Sha $LOCAL) -eq $before.local.after -and (Sha $CFG) -eq $before.cfg.after)
Log ([ordered]@{ step = 'privacy-restart'; newPid = $n.pid; newStart = $n.start; enforcing = $enf; egressApps = $eg; configsAsWritten = $same; leaseLeft = (LeaseLeft); privacyScript = $(if ($TR) { 'test' } else { Sha 'C:\Program Files\Enclave\network\privacy-agent.mjs' }) })
if (-not $enf -or $eg -ne 0 -or -not $same) {
  $r = Revert "R1: enforcing=$enf egressApps=$eg configsAsWritten=$same"; $r.identityUnchanged = Identity $r
  Final 'ROLLED_BACK_R1: the network did not verifiably enforce the channel (or a config changed); the revert restored the flag then the block exactly, verified the network not enforcing, and started the node (old behaviour)' $r }

# ---------------------------------------------------------------- start the node; verify ITS channel is what the network applies
# the new node is started only while its answer wait (lease.startNodeSec) still fits before the revert's deadline; otherwise the
# revert starts the OLD node now, while the margin still holds
if ((ForwardLeft) -lt [int]$PRM.lease.startNodeSec) {
  $r = Revert "LEASE/GLOBAL: $([math]::Floor((ForwardLeft))) s of forward time left before the lease deadline (< lease.startNodeSec)"; $r.identityUnchanged = Identity $r
  Final 'ROLLED_BACK_LEASE: the lease deadline left no time to start and verify the new node; the revert restored the flag then the block exactly, verified the network not enforcing, and started the node (old behaviour)' $r }
$phase = 'node-started'
$nn = StartNode 150
$gen = $null; $ok = $false
if ($nn) { $lim = (Get-Date).AddSeconds((Lim 120))
  while (-not $ok -and (Get-Date) -lt $lim) { try { $gen = [string]([IO.File]::ReadAllText($WALLET) | ConvertFrom-Json).generation } catch { $gen = $null }
    $ok = $gen -and (FreshStatus 3 (IsoMs $n.start) 'enforcing' $gen); if (-not $ok) { Start-Sleep 1 } } }
Log ([ordered]@{ step = 'start-node'; nodeUp = [bool]$nn; agent = $nn.agent; channelGeneration = $gen; applied = $ok; leaseLeft = (LeaseLeft) })
if (-not $ok) {
  $r = Revert 'R2: the new node did not run a channel the network applies'; $r.identityUnchanged = Identity $r
  Final 'ROLLED_BACK_R2: the new node did not run a channel the network applies; the revert stopped it, restored the flag then the block exactly, verified the network not enforcing, and started the node (old behaviour)' $r }

# ---------------------------------------------------------------- observe the re-grants (no rollback: an UNKNOWN is HELD on ACK)
$phase = 'verified'; $Fwd = $false
$want = @($PRM.expectedIds); $lim = (Get-Date).AddSeconds([math]::Min(240, (Left))); $missing = $want
while ($missing.Count -and (Get-Date) -lt $lim) { $s = Status; $al = @($s.walletAdmission.allows); $missing = @($want | Where-Object { $al -notcontains $_ }); if ($missing.Count) { Start-Sleep 2 } }
$wr = Writers $WALLET
$post = [ordered]@{ step = 'post'; missingGrants = $missing; egressApps = (EgressApps); walletWriters = $wr.writers; walletOwner = $wr.owner
                    log = (LogFrom $logOffset @('isolated domain retired', 'isolation spawned', 'is KEPT', 'wallet hold channel OFF', 'not kept:')) }
$post.identityUnchanged = Identity $post
$post.walletAclOk = (@($wr.writers | Where-Object { $ADMIN_SIDS -notcontains $_ }).Count -eq 0) -and ($ADMIN_SIDS -contains $wr.owner)
$clean = $post.identityUnchanged -and $post.walletAclOk -and -not $post.log.error -and $post.log['isolated domain retired'] -eq 0 -and $post.log['isolation spawned'] -eq 0 -and $post.log['wallet hold channel OFF'] -eq 0
Final $(if ($clean -and -not $missing.Count) { 'DONE: enforcing, channel applied, every expected id re-granted; Hyper-V VMs, manager instances, manager, other tasks unchanged; channel file writers SYSTEM/Administrators only' }
        elseif ($clean) { 'DONE_PARTIAL: as DONE, but some ids not re-granted yet (held on UNKNOWN, or slow): see missingGrants' }
        else { 'DONE_CHECK: enforcing and the channel applied, but a post-check failed (identity, channel-file ACL or node.log): see post; root decides, nothing automatic' }) $post
