# node-hold-cutover.ps1 - the COORDINATED switch-on of the non-destructive wallet hold on minipc (PowerShell 5.1).
# Prepared by Claude 60543494 for ROOT; never run by its author. Executed ONLY from hash-verified bytes by a one-shot SYSTEM
# task (root-node-hold.py --cutover / --rollback-cutover), so an SSH disconnect cannot interrupt it. Bounded (-BoundSec).
# Every step appends ONE JSON line to <Stage>\cutover-<RunId>.jsonl (hashes, PIDs, times, counts, decisions; never a config
# value, key or log line).
#
# WHY THIS ORDER (G7): the node agent is STOPPED before the privacy agent starts enforcing the channel, and is started again
# only after the enforcement is VERIFIED. So the new node never meets an UNKNOWN wallet policy while the network could not
# acknowledge a hold, and a stopped node retires nothing. The cost is a bounded app-traffic outage: from the privacy-agent
# restart until the node's first tick re-grants (the channel starts EMPTY).
#
#  -Mode cutover   1 pins: control/network files == new; node cmd+agent, manager, privacy agent == pinned PID+start;
#                    run-node.cmd, node-config.local.cmd, privacy-config.json == pinned sha; no wallet file; status.json
#                    without walletAdmission. Snapshots: VM set, other \Enclave\ tasks' processes, node.log length.
#                  2 STOP the Node task (identity re-verified before any kill).                     [nothing changed yet]
#                  3 privacy-config.json enclaveNetwork.walletAdmission = {file} appended LAST (exact backup, ACL kept)
#                  4 node-config.local.cmd += "set ENCLAVE_NETWORK_WALLET_HOLD=1"  (exact backup, ACL kept)
#                    (this order: a crash/reboot between 3 and 4 boots a node WITHOUT a channel, never one holding on a
#                    network that does not enforce; the Node task's boot trigger starts it either way)
#                  5 restart the privacy agent (pinned PID+start); the \Enclave\Network task starts it in ~10 s
#                  6 VERIFY it enforces: fresh status with walletAdmission for THIS runner, no document yet, egress map
#                    EMPTY (every app's egress withheld) -> else R1: restore 3+4 exactly, restart it again, start the node
#                  7 START the Node task; a new agent answers on 127.0.0.1:9600
#                  8 VERIFY the channel: wallet-admission.json's generation == the agent's applied generation, fresh
#                    -> else R2: stop the node again, restore 3+4 exactly, restart the privacy agent, start the node
#                  9 OBSERVE (no rollback): the expected ids granted; KEPT/retired/spawned counts in NEW node.log lines
#                 10 POST: VM set, manager, other tasks' processes unchanged; the channel file's ACL (writers)
#  -Mode rollback  explicit (root): configs back to the EXACT journaled before-bytes (CAS against the journaled after-shas),
#                  with the node stopped while the network config changes; then the node started. Control/network FILE
#                  rollbacks are separate (root-node-hold.py --rollback control|network); with the flag gone they are inert.
param([ValidateSet('cutover','rollback')][string]$Mode = 'cutover', [Parameter(Mandatory=$true)][string]$ParamsFile, [Parameter(Mandatory=$true)][string]$ParamsSha)
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
$NODE = $(if ($TR) { [string]$PRM.testNode } else { 'C:\Program Files\Enclave\runtime\node\node.exe' }); $NODELOG = Join-Path (Join-Path $PD 'logs') 'node.log'
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'; $FLAG = 'set ENCLAVE_NETWORK_WALLET_HOLD=1'
$J = Join-Path $Stage ("cutover-$Run.jsonl"); $PRIV = Join-Path $Stage 'private'
# a pinned start time as its exact ISO text: Windows PowerShell 5.1 keeps JSON strings as strings, PowerShell 6+ turns ISO
# strings into DateTime; both normalise to the same 'o' text
function Iso($v) { if ($v -is [datetime]) { $v.ToUniversalTime().ToString('o') } else { [string]$v } }
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
function Now { (Get-Date).ToUniversalTime().ToString('o') }
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
  if ($c.Count -ne 1) { return '' }; $p = ById $c[0].OwningProcess; "$($p.ProcessId)@$(Utc $p)" }
function Others { $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 30)
  @(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' -and $_.TaskName -ne 'Network' } | Sort-Object TaskName | ForEach-Object {
    $f = [regex]::Match([string]$_.Actions[0].Arguments + ' ' + [string]$_.Actions[0].Execute, '[^"\\ ]+\.(cmd|ps1|mjs|exe|json)').Value
    $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId)@$(Utc $_)" } })
    "$($_.TaskName)=$([string]$_.State):$($ps -join '+')" }) -join ',' }
function Vms { try { @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { "$($_.id)|$($_.name)" } | Sort-Object) -join ',' } catch { 'unavailable' } }
function AgentUp { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/deployments').StatusCode -eq 200 } catch { $false } }
function Status { try { [IO.File]::ReadAllText((Join-Path $STATE 'status.json')) | ConvertFrom-Json } catch { $null } }
function EgressApps { try { @(([IO.File]::ReadAllText((Join-Path $STATE 'egress-routes.json')) | ConvertFrom-Json).apps.PSObject.Properties).Count } catch { -1 } }
function NowMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function LogFrom($offset, $pats) {   # COUNTS of patterns in node.log lines written after $offset (never the lines)
  $o = [ordered]@{}; foreach ($k in $pats) { $o[$k] = 0 }
  try { $fs = [IO.File]::Open($NODELOG, 'Open', 'Read', 'ReadWrite,Delete'); try { if ($fs.Length -lt $offset) { $offset = 0 }; [void]$fs.Seek($offset, 'Begin')
        $t = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
        foreach ($k in $pats) { $o[$k] = ([regex]::Matches($t, [regex]::Escape($k))).Count } } catch { $o.error = 'node.log unreadable' }
  return $o }
function PrivDir { if ($TR) { [void][IO.Directory]::CreateDirectory($PRIV); return }   # mock harness only (no Windows ACL API)
  if (-not (Test-Path -LiteralPath $PRIV)) { $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
    foreach ($s in 'S-1-5-18', 'S-1-5-32-544') { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    [void][IO.Directory]::CreateDirectory($PRIV, $ds) } }
# CAS write of ONE config file: $bytes into a temp that already carries the target's ACL, then [IO.File]::Replace
function CasWrite($path, $expect, [byte[]]$bytes) {
  if ((Sha $path) -ne $expect) { throw "CAS refused: $path is not the expected sha" }
  $acl = Get-Acl -LiteralPath $path; $tmp = $path + '.nh-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [IO.File]::WriteAllBytes($tmp, [byte[]]@()); Set-Acl -LiteralPath $tmp -AclObject $acl; [IO.File]::WriteAllBytes($tmp, $bytes)
  [IO.File]::Replace($tmp, $path, [NullString]::Value); Set-Acl -LiteralPath $path -AclObject $acl
  return [ordered]@{ after = (Sha $path); aclKept = ((Get-Acl -LiteralPath $path).Sddl -eq $acl.Sddl) } }
function StopNode($cmd, $agent) {   # node-restart.ps1's stop half: identity re-verified before Stop-ScheduledTask / Stop-Process
  if (-not (Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0) -or -not (Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid)) { return 'identity changed; nothing stopped' }
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
  $d = (Get-Date).AddSeconds(30); while ((Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
  if (Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0) { return 'the run-node cmd.exe did not stop' }
  $d = (Get-Date).AddSeconds(30); while ((Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
  if (Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid) { Stop-Process -Id $agent.pid -Force
    $d = (Get-Date).AddSeconds(10); while ((Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
    if (Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid) { return 'the old agent is still running' } }
  if (@((NodeProcs).agent).Count -ne 0) { return 'another node agent is running' }
  return 'stopped' }
function StartNode($limitSec) {   # -> the new {cmd, agent} answering on 9600, or $null
  Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'; $lim = (Get-Date).AddSeconds([math]::Min($limitSec, (Left))); $n = $null
  while (-not $n -and (Get-Date) -lt $lim) { $q = NodeProcs; if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { $n = $q } else { Start-Sleep -Milliseconds 500 } }
  while ($n -and -not (AgentUp) -and (Get-Date) -lt $lim) { Start-Sleep -Seconds 1 }
  if ($n -and (AgentUp)) { return [ordered]@{ cmd = $n.cmd[0]; agent = $n.agent[0] } }; return $null }
function RestartPrivacy($pin, $limitSec) {   # stop THE pinned privacy agent; the Network task starts it again
  $pa = @(Privacy); if ($pa.Count -ne 1 -or $pa[0].pid -ne $pin.pid -or $pa[0].start -ne $pin.start) { return $null }
  Stop-Process -Id $pin.pid -Force; $lim = (Get-Date).AddSeconds([math]::Min($limitSec, (Left))); $n = $null
  while (-not $n -and (Get-Date) -lt $lim) { Start-Sleep -Seconds 2; $n = @(Privacy | Where-Object { $_.pid -ne $pin.pid }) | Select-Object -First 1 }
  return $n }
function Enforcing($limitSec, $runner, $wantGeneration) {  # the agent's status: fresh, walletAdmission of THIS runner
  $lim = (Get-Date).AddSeconds([math]::Min($limitSec, (Left))); $s = $null
  while ((Get-Date) -lt $lim) { $s = Status; $w = $s.walletAdmission
    if ($s -and $w -and [string]$w.runner -eq $runner -and ((NowMs) - [int64]$s.updatedAt) -lt 5000 -and
        ($(if ($wantGeneration) { [string]$w.generation -eq $wantGeneration -and $w.fresh -eq $true } else { $w.fresh -ne $true }))) { return $true }
    Start-Sleep -Seconds 1 }
  return $false }
function RestoreConfigs($before) {  # exact before-bytes back (CAS: current == the journaled after-sha)
  $r = [ordered]@{}
  foreach ($k in 'local', 'cfg') { $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); $b = $before[$k]
    if ((Sha $path) -eq $b.before) { $r[$k] = 'already before' } else {
      $bytes = [IO.File]::ReadAllBytes($b.backup); if ((Sha $b.backup) -ne $b.before) { $r[$k] = 'REFUSED: backup is not the before sha'; continue }
      try { $w = CasWrite $path $b.after $bytes; $r[$k] = $(if ($w.after -eq $b.before) { 'restored' } else { 'AMBIGUOUS' }) } catch { $r[$k] = 'REFUSED: ' + $_.Exception.Message } } }
  return $r }

# ANY unexpected terminating error still ends in a CONSISTENT state, by phase: node only stopped -> started again;
# configs touched -> exact before-bytes back, the privacy agent restarted, the node started (old behaviour); after the
# channel is verified -> nothing (the node runs as designed). Never a new node + flag with a network that is not enforcing.
$phase = 'pins'
trap {
  $e = $_.Exception.Message; $x = [ordered]@{ phase = $phase; error = $e }
  try {
    if ($phase -eq 'node-started') { $q = NodeProcs; if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1) { $x.stopAgain = StopNode $q.cmd[0] $q.agent[0] } }
    if ($phase -in 'configs', 'enforcing', 'node-started') { $x.restore = RestoreConfigs $before; $cur = @(Privacy); if ($cur.Count -eq 1) { $x.privacyAgain = (RestartPrivacy $cur[0] 90).pid } }
    if ($phase -in 'stopped', 'configs', 'enforcing', 'node-started') { $x.nodeUp = [bool](StartNode 150) }
  } catch { $x.trapError = $_.Exception.Message }
  $x.final = "CRASHED in phase $phase (consistent fallback attempted, see fields; root decides)"; Log $x; exit 1 }
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
$mg = Manager; $o.manager = $mg; if ($mg -ne [string]$PRM.manager) { $why += 'the manager is not the pinned PID+start' }
$pa = @(Privacy); $o.privacy = $pa; if ($pa.Count -ne 1 -or $pa[0].pid -ne [int]$PRM.privacy.pid -or $pa[0].start -ne (Iso $PRM.privacy.start)) { $why += 'the privacy agent is not the pinned PID+start' }
$vms0 = Vms; $others0 = Others; $o.vmCount = $(if ($vms0 -eq 'unavailable') { -1 } else { @($vms0 -split ',' | Where-Object { $_ }).Count })
if ($vms0 -ne [string]$PRM.vms) { $why += 'the VM set is not the preflight set' }
$logOffset = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 }); $o.nodeLogOffset = $logOffset
if ($Mode -eq 'cutover') {
  if ((Sha $LOCAL) -ne [string]$PRM.localSha) { $why += 'node-config.local.cmd is not the pinned sha' }
  if ((Sha $CFG) -ne [string]$PRM.cfgSha) { $why += 'privacy-config.json is not the pinned sha' }
  if ((Sha $WALLET) -ne 'absent') { $why += 'a wallet-admission.json already exists' }
  if ([IO.File]::ReadAllText($LOCAL) -match 'ENCLAVE_NETWORK_WALLET_HOLD') { $why += 'node-config.local.cmd already names the flag' }
  $s = Status; if (-not $s -or $s.walletAdmission -or ((NowMs) - [int64]$s.updatedAt) -gt 5000) { $why += 'status.json is not fresh, or already reports walletAdmission' }
  $o.egressAppsBefore = EgressApps
} else {
  foreach ($k in 'local', 'cfg') { $b = $PRM.before.$k; if ((Sha ([string]$b.backup)) -ne [string]$b.before) { $why += "the $k backup is not its before sha" }
    $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); $now = Sha $path; if ($now -ne [string]$b.after -and $now -ne [string]$b.before) { $why += "$k changed since the cutover (neither its after nor its before sha): root decides" } } }
if ($why.Count) { Final ('REFUSED: ' + ($why -join '; ')) $o }
Log $o
$before = @{ local = @{ before = [string]$PRM.localSha; after = ''; backup = '' }; cfg = @{ before = [string]$PRM.cfgSha; after = ''; backup = '' } }
if ($Mode -eq 'rollback') { foreach ($k in 'local', 'cfg') { $b = $PRM.before.$k; $before[$k] = @{ before = [string]$b.before; after = [string]$b.after; backup = [string]$b.backup } } }

# ---------------------------------------------------------------- stop the node (both modes)
$st = StopNode ([ordered]@{ pid = [int]$PRM.node.cmdPid; start = (Iso $PRM.node.cmdStart) }) ([ordered]@{ pid = [int]$PRM.node.agentPid; start = (Iso $PRM.node.agentStart) })
Log ([ordered]@{ step = 'stop-node'; decision = $st; vmsUnchanged = ((Vms) -eq $vms0) })
if ($st -ne 'stopped') { Final "FAILED_NODE_STOP: $st (no config changed; NOTHING started - root decides)" ([ordered]@{}) }
$phase = 'stopped'

if ($Mode -eq 'rollback') {
  $phase = 'configs'; $r = RestoreConfigs $before; Log ([ordered]@{ step = 'restore-configs'; result = $r })
  $n = RestartPrivacy ([ordered]@{ pid = [int]$PRM.privacy.pid; start = (Iso $PRM.privacy.start) }) 90
  $plain = $false; $lim = (Get-Date).AddSeconds(60); while ($n -and -not $plain -and (Get-Date) -lt $lim) { $s = Status; $plain = $s -and -not $s.walletAdmission -and ((NowMs) - [int64]$s.updatedAt) -lt 5000; if (-not $plain) { Start-Sleep 1 } }
  Log ([ordered]@{ step = 'privacy-restart'; newPid = $n.pid; statusWithoutWallet = $plain })
  $phase = 'verified'; $nn = StartNode 150
  $post = [ordered]@{ step = 'post'; nodeUp = [bool]$nn; vmsUnchanged = ((Vms) -eq $vms0); managerUnchanged = ((Manager) -eq $mg); othersUnchanged = ((Others) -eq $others0)
                      log = (LogFrom $logOffset @('isolated domain retired', 'isolation spawned', 'is KEPT', 'wallet hold channel')) }
  $ok = ($r.local -in 'restored', 'already before') -and ($r.cfg -in 'restored', 'already before') -and $plain -and $nn
  Final $(if ($ok) { 'ROLLED_BACK: flag and walletAdmission block gone (exact before-bytes), network not enforcing, node started' } else { 'ROLLBACK_INCOMPLETE: see the steps (root decides)' }) $post }

# ---------------------------------------------------------------- cutover: configs (node stopped)
$phase = 'configs'
PrivDir
$lb = [IO.File]::ReadAllBytes($LOCAL); $before.local.backup = Join-Path $PRIV "node-config.local.cmd.before-$Run"; [IO.File]::WriteAllBytes($before.local.backup, $lb)
$cb = [IO.File]::ReadAllBytes($CFG); $before.cfg.backup = Join-Path $PRIV "privacy-config.json.before-$Run"; [IO.File]::WriteAllBytes($before.cfg.backup, $cb)
Log ([ordered]@{ step = 'backups'; local = (Sha $before.local.backup); cfg = (Sha $before.cfg.backup); localBackup = $before.local.backup; cfgBackup = $before.cfg.backup })
try {
  # the NETWORK block first, the node's flag second: a crash or reboot between them leaves a node WITHOUT a channel (the old
  # behaviour; the new enroll then drops the block) - never a node holding on a network that is not enforcing
  # node's own JSON: walletAdmission LAST in enclaveNetwork (what network-enroll 6bd0a858 writes, so its next pass is a no-op)
  $js = "const fs=require('fs');const [p,t,f]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,'utf8'));const e=c.enclaveNetwork;" +
        "if(!e||typeof e!=='object')throw new Error('no enclaveNetwork');delete e.walletAdmission;e.walletAdmission={file:f};fs.writeFileSync(t,JSON.stringify(c,null,2)+String.fromCharCode(10));"
  $tmp = $CFG + '.nh-edit-' + [guid]::NewGuid().ToString('N').Substring(0, 8); [IO.File]::WriteAllBytes($tmp, [byte[]]@())
  $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; $null = & $NODE -e $js $CFG $tmp $WALLET 2>&1; $rc = $LASTEXITCODE; $ErrorActionPreference = $ea
  if ($rc -ne 0) { Remove-Item -LiteralPath $tmp -Force; throw 'the config edit failed' }
  $w = CasWrite $CFG $before.cfg.before ([IO.File]::ReadAllBytes($tmp)); Remove-Item -LiteralPath $tmp -Force; $before.cfg.after = $w.after
  Log ([ordered]@{ step = 'config'; after = $w.after; aclKept = $w.aclKept })
  # BYTE-level append (the file's existing bytes are never re-encoded)
  $sep = $(if ($lb.Length -eq 0 -or ($lb.Length -ge 2 -and $lb[$lb.Length - 2] -eq 13 -and $lb[$lb.Length - 1] -eq 10)) { '' } else { "`r`n" })
  $add = [Text.Encoding]::ASCII.GetBytes($sep + $FLAG + "`r`n"); $nb = New-Object byte[] ($lb.Length + $add.Length)
  [Array]::Copy($lb, $nb, $lb.Length); [Array]::Copy($add, 0, $nb, $lb.Length, $add.Length)
  $w = CasWrite $LOCAL $before.local.before $nb; $before.local.after = $w.after
  Log ([ordered]@{ step = 'flag'; after = $w.after; aclKept = $w.aclKept })
} catch {
  $r = RestoreConfigs $before; $nn = StartNode 150
  Final 'R0_CONFIG_WRITE_FAILED: configs restored, node started (old behaviour: no flag, no block)' ([ordered]@{ error = $_.Exception.Message; restore = $r; nodeUp = [bool]$nn }) }

# ---------------------------------------------------------------- the network enforces BEFORE the node runs
$phase = 'enforcing'
$n = RestartPrivacy ([ordered]@{ pid = [int]$PRM.privacy.pid; start = (Iso $PRM.privacy.start) }) 90
$enf = $n -and (Enforcing 90 ([string]$PRM.runner) $null); $eg = EgressApps
Log ([ordered]@{ step = 'privacy-restart'; newPid = $n.pid; newStart = $n.start; enforcing = $enf; egressApps = $eg; privacyScript = $(if ($TR) { 'test' } else { Sha 'C:\Program Files\Enclave\network\privacy-agent.mjs' }) })
if (-not $enf -or $eg -ne 0) {
  $r = RestoreConfigs $before; $n2 = $null; $cur = @(Privacy); if ($cur.Count -eq 1) { $n2 = RestartPrivacy $cur[0] 90 }; $nn = StartNode 150
  Final 'ROLLED_BACK_R1: the network did not verifiably enforce the channel; configs restored exactly, privacy agent restarted, node started (old behaviour)' ([ordered]@{ restore = $r; privacyAgain = $n2.pid; nodeUp = [bool]$nn; vmsUnchanged = ((Vms) -eq $vms0) }) }

# ---------------------------------------------------------------- start the node; verify ITS channel is what the network applies
$phase = 'node-started'
$nn = StartNode 150
$gen = $null; $ok = $false
if ($nn) { $lim = (Get-Date).AddSeconds([math]::Min(120, (Left)))
  while (-not $ok -and (Get-Date) -lt $lim) { try { $gen = [string]([IO.File]::ReadAllText($WALLET) | ConvertFrom-Json).generation } catch { $gen = $null }
    $ok = $gen -and (Enforcing 3 ([string]$PRM.runner) $gen); if (-not $ok) { Start-Sleep 1 } } }
Log ([ordered]@{ step = 'start-node'; nodeUp = [bool]$nn; agent = $nn.agent; channelGeneration = $gen; applied = $ok })
if (-not $ok) {
  $st2 = $(if ($nn) { StopNode $nn.cmd $nn.agent } else { 'not running' })
  $r = RestoreConfigs $before; $n2 = $null; $cur = @(Privacy); if ($cur.Count -eq 1) { $n2 = RestartPrivacy $cur[0] 90 }; $nn2 = StartNode 150
  Final 'ROLLED_BACK_R2: the new node did not run a channel the network applies; node stopped again, configs restored exactly, privacy agent restarted, node started (old behaviour)' ([ordered]@{ stopAgain = $st2; restore = $r; privacyAgain = $n2.pid; nodeUp = [bool]$nn2; vmsUnchanged = ((Vms) -eq $vms0) }) }

# ---------------------------------------------------------------- observe the re-grants (no rollback: an UNKNOWN is HELD on ACK)
$phase = 'verified'
$want = @($PRM.expectedIds); $lim = (Get-Date).AddSeconds([math]::Min(240, (Left))); $missing = $want
while ($missing.Count -and (Get-Date) -lt $lim) { $s = Status; $al = @($s.walletAdmission.allows); $missing = @($want | Where-Object { $al -notcontains $_ }); if ($missing.Count) { Start-Sleep 2 } }
$acl = Get-Acl -LiteralPath $WALLET
$writers = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x116) } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
$post = [ordered]@{ step = 'post'; missingGrants = $missing; egressApps = (EgressApps); vmsUnchanged = ((Vms) -eq $vms0); managerUnchanged = ((Manager) -eq $mg); othersUnchanged = ((Others) -eq $others0)
                    walletWriters = $writers; walletOwner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
                    log = (LogFrom $logOffset @('isolated domain retired', 'isolation spawned', 'is KEPT', 'wallet hold channel OFF', 'not kept:')) }
$clean = $post.vmsUnchanged -and $post.managerUnchanged -and $post.log['isolated domain retired'] -eq 0 -and $post.log['isolation spawned'] -eq 0 -and $post.log['wallet hold channel OFF'] -eq 0
Final $(if ($clean -and -not $missing.Count) { 'DONE: enforcing, channel applied, every expected id re-granted, same VMs' } elseif ($clean) { 'DONE_PARTIAL: enforcing and same VMs; some ids not re-granted yet (held on UNKNOWN, or slow): see missingGrants' } else { 'DONE_CHECK: see post (root decides; nothing automatic)' }) $post
