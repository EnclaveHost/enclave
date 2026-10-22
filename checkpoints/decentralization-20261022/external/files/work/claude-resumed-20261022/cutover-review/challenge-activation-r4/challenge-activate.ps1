# challenge-activate.ps1 r3 (root reviews ROOT-INFLIGHT-REVIEW R1-R5 + r2 R2-incomplete) - ROOT-ONLY, PowerShell 5.1, run by a one-shot SYSTEM task (root-challenge-activation.py), never by its author.
# The PRIVACY half of the paired challenge activation on minipc: adds ONLY enclaveNetwork.challengeReplica (the natively validated
# block 2b644d22) to privacy-config.json and restarts the privacy agent ONCE so it loads it. The hs2 half (route-dns parallel TXT +
# service-tls declaration path, config 5f75562c) is root-hs2-parallel.py, run BEFORE this. Orders stay held; no CA, DNS delegation,
# publication, contract, wallet, VM, manager, node or task change.
# REUSE, never re-typed: every helper below is AST-extracted from the staged rpc-integrated cutover df2e58f2 (natively proven: bounded
# reader, CAS write + protected temp + exact ACL, privacy restart by pinned PID+start, fresh status, updater gate); the edit itself is
# root's reviewed edit-privacy-config.mjs 4d9c231e (CAS, enroll-format round trip, walletAdmission stays LAST, other bytes unchanged).
#  -Mode apply     pins -> render (node, protected temp) -> private backup -> CAS write -> restart privacy -> CORE verify (fresh enforcing
#                  status of THIS runner's channel generation, egress back) -> CHALLENGE verify (bounded) -> DONE | CHECK
#                  A CORE failure (or a crash after the write) runs ONE revert pass: exact bytes back by CAS, the replica child of the
#                  killed agent stopped by verified PID+start, privacy restarted, core verified -> ROLLED_BACK_* | RECOVERY_REQUIRED.
#                  A challenge-only failure is CHECK (the agent's supervised retry continues); root decides; -Mode rollback undoes it.
#  -Mode rollback  the same single revert pass for a DONE/CHECK run (its journaled before/after/backup).
# r2: R1 only the exact prepared sha is our own write (anything else is 'unknown-write': refused, never overwritten); R2 the core is
# the EXACT expected deployment ids (running, granted, routed, unexpired map), never a count; R3 an explicit forward + recovery budget
# (refused before any change if it does not fit; forward waits are capped so the recovery reserve is never consumed; nothing after the
# core is verified triggers a revert); R4 a stopped orphan must be PROVEN gone (PID+start, bounded) and the replica ports free, else
# RECOVERY_REQUIRED; R5 127.0.0.1:31053 must be the driver-PROVEN tunnel listener (PID+start) or a root-permitted absence.
# r3 (root review of r2 f096aed4, R2 incomplete): IdsState is ONE verdict with root's postflight W3+W4 semantics (postflight.py 5ebbf5e7
# CHAN/BIND/HOST texts and their predicates): the CURRENT channel (this runner, the doc's generation, fresh, applied, error null,
# 0 <= status age < 5000 ms) AND per id the exact appRef/configCid binding (compared here, booleans only), live wallet/lease/proof deadlines.
# Journal: <Stage>\challenge-<RunId>.jsonl, one JSON line per step: shas, PIDs, start times, counts, decisions; never a config value,
# key, proof key or log line.
param([ValidateSet('apply','rollback')][string]$Mode = 'apply', [Parameter(Mandatory=$true)][string]$ParamsFile, [Parameter(Mandatory=$true)][string]$ParamsSha)
$phase = 'pins'; $before = $null; $script:RevertState = $null; $Fwd = $false
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $T0 = Get-Date
$pb = [IO.File]::ReadAllBytes($ParamsFile)
if ((-join ([Security.Cryptography.SHA256]::Create().ComputeHash($pb) | ForEach-Object { $_.ToString('x2') })) -ne $ParamsSha) { exit 4 }
$PRM = [Text.Encoding]::UTF8.GetString($pb) | ConvertFrom-Json
$Stage = [string]$PRM.stage; $Run = [string]$PRM.runId; $BoundSec = [int]$PRM.boundSec
$TR = [string]$PRM.testRoot; if ($TR -and $env:OS -eq 'Windows_NT') { exit 5 }      # the mock hook can never run on Windows
# ---- reuse: the sha-pinned cutover's functions, parsed from the SAME bytes that were hashed
$cb0 = [IO.File]::ReadAllBytes((Join-Path $Stage 'node-hold-cutover.ps1'))
if ((-join ([Security.Cryptography.SHA256]::Create().ComputeHash($cb0) | ForEach-Object { $_.ToString('x2') })) -ne [string]$PRM.cutoverSha) { exit 6 }
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($cb0), [ref]$tk, [ref]$er); if ($er.Count) { exit 6 }
foreach ($fn in 'Iso','Left','NowS','Lim','NeedForward','Now','NowMs','IsoMs','ShaBytes','Sha','Log','Final','Invoke-BoundedQuery','Query','PollRoom','Utc','ProcessRows',
                'ById','NodeProcs','Privacy','Listeners','Known','Status','EgressApps','LogFrom','Readers','PrivDir','ProtectedTemp','CasWrite','RestoreOne',
                'RestartPrivacy','FreshStatus','UpdateDecision','UpdateState','HostState','ReadinessNumber') {
  $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true)); if ($f.Count -ne 1) { exit 6 }
  . ([scriptblock]::Create($f[0].Extent.Text)) }
$PD = $(if ($TR) { $TR } else { 'C:\ProgramData\Enclave' }); $NET = Join-Path $PD 'network'; $CFG = Join-Path $NET 'privacy-config.json'
$STATE = Join-Path $NET 'state'; $WALLET = Join-Path $NET 'wallet-admission.json'; $NODELOG = Join-Path (Join-Path $PD 'logs') 'network.log'   # LogFrom: the PRIVACY agent's log
$HS2CFG = $(if ($TR) { Join-Path $TR 'hs2-config.json' } else { 'C:\ProgramData\Enclave\host-services\hs2\config\host-services.json' })
$NODE = $(if ($TR) { [string]$PRM.testNode } else { [string]$PRM.nodeExe })
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'; $ADMIN_SIDS = @('S-1-5-18', 'S-1-5-32-544')
$J = Join-Path $Stage ("challenge-$Run.jsonl"); $PRIV = Join-Path $Stage 'private'
$DECL = [string]$PRM.declarationFile; $REL = [string]$PRM.release.dir; $P = $PRM.ports
# R3: source-derived budget (the reused bounded calls; fs/log work as an allowance, not a guarantee):
#   forward  = privacy restart 90 + fresh status 90 + exact-ids wait 120 + local writes 30                                  = 330
#   recovery = restore 15 + privacy restart 90 + orphan exit proof 30 + fresh status 90 + exact-ids wait 120 + ports 30 + 45 = 420
#   (+30 margin) -> 450. The run REFUSES before any change unless Left >= forward + recovery; forward waits are capped at Left - recovery.
$FORWARD_SEC = [int]$PRM.forwardSec; $RECOVERY_SEC = [int]$PRM.recoverySec
function ForwardLeft { (Left) - $RECOVERY_SEC }
$WANT = @($PRM.expectedIds | ForEach-Object { ([string]$_).ToLower() } | Sort-Object -Unique)
$PATS = @('challenge replica serving:', 'challenge replica not started', 'challenge replica STOPPED', 'challenge replica restart refused')
# ---- challenge-specific reads (no secret: the declaration's proof key is never read out)
function DeclState { try { $d = [IO.File]::ReadAllText($DECL) | ConvertFrom-Json; [ordered]@{ state = [string]$d.state; pid = $d.pid; expiresAt = $d.expiresAt
    dns = [string]$d.release.dnsSha256 } } catch { if (Test-Path -LiteralPath $DECL) { 'unreadable' } else { 'absent' } } }
function Owner([int]$port) { $l = @(Listeners $port); if ($l.Count -eq 0) { return $null }; if ($l.Count -ne 1) { return 'many' }
  $p = @(ById ([int]$l[0].OwningProcess))
  if ($p.Count -ne 1) { return 'unknown' }
  [ordered]@{ pid = [int]$p[0].ProcessId; parent = [int]$p[0].ParentProcessId; name = [string]$p[0].Name; start = (Utc $p[0]); release = ([string]$p[0].CommandLine -like ('*' + $REL + '*')) } }
# the replica child(ren) of a privacy agent: node.exe running THIS release's dns.mjs whose parent is that agent
function ReplicaChildren($agentPid) {   # R4: ONLY that agent's own children are queried (no unrelated process listing)
  $f = "Name='node.exe' AND ParentProcessId=" + [int]$agentPid
  $all = $(if ($TR) { @(Get-CimInstance Win32_Process -Filter $f -OperationTimeoutSec 20) } else { @(ProcessRows $f) })
  @($all | Where-Object { [int]$_.ParentProcessId -eq [int]$agentPid -and [string]$_.CommandLine -like ('*' + $REL + '*dns.mjs*') } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } }) }
# a replica child orphaned by a killed agent keeps 18353/18354 (dns.mjs has no parent watch): stop it by its verified PID+start only
# R4: the stop is never assumed: each (PID, start) must be PROVEN absent within a bounded wait; a failed or ambiguous stop is reported
function Alive($c) { $p = @(ById $c.pid); [bool]($p.Count -eq 1 -and (Utc $p[0]) -eq $c.start) }
function StopOrphans($oldAgentPid, [int]$waitSec = 30) {
  $r = [ordered]@{ found = @(); stopErrors = @(); alive = @(); gone = $false }
  $kids = @(ReplicaChildren $oldAgentPid); $r.found = @($kids | ForEach-Object { "$($_.pid)@$($_.start)" })
  foreach ($c in $kids) { if (Alive $c) { try { Stop-Process -Id $c.pid -Force } catch { $r.stopErrors += "$($c.pid): $($_.Exception.Message)" } } }
  $lim = (Get-Date).AddSeconds((Lim $waitSec))
  do { $al = @($kids | Where-Object { Alive $_ }); if (-not $al.Count -or -not (PollRoom $lim)) { break }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $lim)
  $r.alive = @($al | ForEach-Object { "$($_.pid)@$($_.start)" }); $r.gone = ($al.Count -eq 0); return $r }
# R4: after a revert no replica may hold its ports (bounded wait for the OS to release them)
function PortsFree([int]$waitSec = 30) { $lim = (Get-Date).AddSeconds((Lim $waitSec))
  do { $o = [ordered]@{ dns = (Owner ([int]$P.dns)); api = (Owner ([int]$P.api)); front = (Owner ([int]$P.front)) }
       if (-not $o.dns -and -not $o.api -and -not $o.front) { return [ordered]@{ free = $true; owners = $o } }
       if (-not (PollRoom $lim)) { break }; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $lim)
  return [ordered]@{ free = $false; owners = $o } }
function ReadJ($p) { try { [IO.File]::ReadAllText($p) | ConvertFrom-Json } catch { $null } }
# the reused HostState reader (same bounded Query, same URL) with walletHeld also projected: postflight W4 'notHeld'
function HostRows([double]$limitSec = 10) {
  if ($TR) { return (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state') }
  Query {
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state'
    [ordered]@{ deployments = @($h.deployments | ForEach-Object { [ordered]@{id=$_.id;status=$_.status;leaseUntil=$_.leaseUntil;walletHeld=$_.walletHeld} }) }
  } $limitSec }
function Live($x, [int64]$now) { (ReadinessNumber $x) -and [int64]$x -gt $now }
# R2 (r3): ONE verdict over the EXACT expected deployment ids (bound by the driver to a fresh root receipt), never a count:
#  channel  wallet-admission.json version 1, THIS runner, a generation, 0 < expiresIn <= 31 s; status.json version 2, 0 <= age < 5000 ms,
#           walletAdmission of THIS runner with the doc's CURRENT generation, fresh, applied, error null, unexpired   (postflight W2/W3)
#  per id   the doc's allow carries appRef AND configCid EQUAL to the id's own expectation file (compared HERE; only booleans leave),
#           0 < validUntil <= 90 s, granted in status, exactly one status app with live walletUntil/leaseUntil/proofUntil, routed with
#           proxies in an unexpired egress map whose id set EQUALS them, exactly one RUNNING node record, walletHeld false, live node lease (W4)
function IdsState {
  $v = [ordered]@{ ok = $false }; $n = NowMs
  $d = ReadJ $WALLET; $s = Status; $c = ReadJ $CFG; $e = ReadJ (Join-Path $STATE 'egress-routes.json'); $w = $s.walletAdmission
  $ch = [ordered]@{ docVersion = [bool]($d -and (ReadinessNumber $d.version) -and $d.version -eq 1); docRunner = [bool]($d -and [string]$d.runner -ceq [string]$PRM.runner)
    docUnexpired = [bool]($d -and (Live $d.expiresAt $n) -and ([int64]$d.expiresAt - $n) -le 31000)
    statusVersion = [bool]($s -and (ReadinessNumber $s.version) -and $s.version -eq 2)
    statusAge = [bool]($s -and (ReadinessNumber $s.updatedAt) -and ($n - [int64]$s.updatedAt) -ge 0 -and ($n - [int64]$s.updatedAt) -lt 5000)
    runner = [bool]($w -and [string]$w.runner -ceq [string]$PRM.runner)
    generation = [bool]($w -and $d -and [string]$d.generation -and [string]$w.generation -ceq [string]$d.generation)
    fresh = [bool]($w -and $w.fresh -is [bool] -and $w.fresh); applied = [bool]($w -and $w.applied -is [bool] -and $w.applied)
    errorNull = [bool]($w -and $null -eq $w.error); unexpired = [bool]($w -and (Live $w.expiresAt $n)); egressUnexpired = [bool]($e -and (Live $e.expiresAt $n)) }
  $v.channelBad = @($ch.Keys | Where-Object { -not $ch[$_] })
  $eg = @($e.apps.PSObject.Properties | Where-Object { @($_.Value.proxies).Count -gt 0 } | ForEach-Object { $_.Name.ToLower() } | Sort-Object -Unique)
  $sa = @($w.allows | ForEach-Object { ([string]$_).ToLower() })
  $h = $null; try { $h = HostRows 10 } catch { if ($script:QueryCleanupFailed) { throw }; $v.hostState = 'unreadable' }
  $v.egressMissing = @($WANT | Where-Object { $eg -notcontains $_ }); $v.egressExtra = @($eg | Where-Object { $WANT -notcontains $_ })
  $v.idsBad = @(foreach ($id in $WANT) { $b = @()
    $a = $(if ($d -and $d.allows) { $d.allows.$id })
    if (-not $a) { $b += 'docAllow' } else {
      if (-not (Live $a.validUntil $n) -or ([int64]$a.validUntil - $n) -gt 90000) { $b += 'validUntil' }
      $ex = @($c.apps | Where-Object { ([string]$_.deploymentId).ToLower() -ceq $id }); $p = $(if ($ex.Count -eq 1 -and [string]$ex[0].expectedFile) { ReadJ ([string]$ex[0].expectedFile) })
      if (-not $p) { $b += 'expectation' } else {
        if (-not [string]$p.appRef -or [string]$a.appRef -cne [string]$p.appRef) { $b += 'appRef' }
        if (-not [string]$p.configCid -or [string]$a.configCid -cne [string]$p.configCid) { $b += 'configCid' } } }
    if ($sa -cnotcontains $id) { $b += 'statusAllow' }
    $ap = @($s.apps | Where-Object { ([string]$_.deploymentId).ToLower() -ceq $id })
    if ($ap.Count -ne 1) { $b += 'statusApp' } else { foreach ($k in 'walletUntil', 'leaseUntil', 'proofUntil') { if (-not (Live $ap[0].$k $n)) { $b += $k } } }
    if ($eg -cnotcontains $id) { $b += 'egress' }
    $hr = @($h.deployments | Where-Object { ([string]$_.id).ToLower() -ceq $id })
    if ($hr.Count -ne 1 -or [string]$hr[0].status -cne 'running') { $b += 'nodeRunning' } else {
      if (-not ($hr[0].walletHeld -is [bool]) -or $hr[0].walletHeld) { $b += 'notHeld' }
      if (-not (Live $hr[0].leaseUntil (NowS))) { $b += 'nodeLease' } }
    if ($b.Count) { [ordered]@{ id = $id; bad = $b } } })
  $v.ok = $WANT.Count -gt 0 -and $WANT.Count -eq @($PRM.expectedIds).Count -and -not @($WANT | Where-Object { $_ -cnotmatch '^0x[0-9a-f]{64}$' }).Count -and
          -not $v.hostState -and -not $v.channelBad.Count -and -not $v.egressMissing.Count -and -not $v.egressExtra.Count -and -not $v.idsBad.Count
  return $v }
function CoreUp($n, [int]$waitSec) {   # fresh enforcing status of the node's CURRENT channel generation, then the exact ids
  $gen = $(try { [string]([IO.File]::ReadAllText($WALLET) | ConvertFrom-Json).generation } catch { $null })
  $r = [ordered]@{ generationKnown = [bool]$gen; enforcing = $false; ids = $null; ok = $false }
  if (-not $gen) { return $r }
  $r.enforcing = [bool](FreshStatus 90 (IsoMs $n.start) 'enforcing' $gen); if (-not $r.enforcing) { return $r }
  $lim = (Get-Date).AddSeconds((Lim $waitSec))
  do { $r.ids = IdsState; if ($r.ids.ok -or -not (PollRoom $lim)) { break }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $lim)
  $r.ok = [bool]$r.ids.ok; return $r }
function Recovery($what, $x) { $x.recovery = $what; $x.cfgSha = $(try { Sha $CFG } catch { 'unreadable' })
  $x.privacy = $(try { @(Privacy) } catch { 'unknown: ' + $_.Exception.Message }); Final ("RECOVERY_REQUIRED: $what") $x }
# ONE revert pass: exact bytes back, then (if the agent ever ran with the block) restart it and verify the core
function Revert($why, $agentRanWithBlock) {
  $script:RevertState = 'started'; $script:Fwd = $false              # R3: the recovery reserve is the revert's own budget
  $x = [ordered]@{ step = 'revert'; why = $why; leftSec = [math]::Round((Left), 1) }
  $x.cfg = RestoreOne 'cfg'
  if ($x.cfg -notin 'restored', 'already before' -or (Sha $CFG) -ne $before.cfg.before) { Recovery "privacy-config.json was not restored ($($x.cfg)); the privacy agent was NOT restarted again" $x }
  if (-not $agentRanWithBlock -and $x.cfg -eq 'already before') { $x.ports = PortsFree 15; if (-not $x.ports.free) { Recovery 'the config IS before, but a replica port is held' $x }
    $script:RevertState = 'complete'; $x.restart = 'not needed (the agent never loaded the block)'; return $x }
  $cur = @(Privacy); if ($cur.Count -ne 1) { Recovery "the config IS restored, but not exactly one privacy agent ($($cur.Count)); not restarted" $x }
  $off = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 })
  $n = RestartPrivacy $cur[0] 90; $x.privacy = $n
  if (-not $n) { Recovery 'the config IS restored; the privacy agent did not come back within 90 s' $x }
  $x.orphans = StopOrphans $cur[0].pid 30
  if (-not $x.orphans.gone) { Recovery 'the config IS restored and the agent restarted, but a replica child of the killed agent is NOT proven gone (it may still serve DNS)' $x }
  $x.core = CoreUp $n 120
  if (-not $x.core.ok) { Recovery 'the config IS restored and the agent restarted, but the exact expected ids are not verifiably running/granted/routed' $x }
  $x.ports = PortsFree 30; if (-not $x.ports.free) { Recovery 'the config IS restored, but a replica port is still held after the revert' $x }
  $x.challengeLogSinceRestart = LogFrom $off $PATS
  $script:RevertState = 'complete'; return $x }
trap {
  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }
  if ($phase -eq 'pins') { $x.final = 'CRASHED in phase pins: nothing was changed; root decides'; Log $x; exit 1 }
  if ($script:RevertState -eq 'complete') { $x.final = "ROLLED_BACK_CHECK: the revert completed but a later check failed ($($x.error)); root decides"; Log $x; exit 1 }
  if ($script:RevertState) { Recovery "the revert itself failed ($($x.error)); no second pass" $x }
  # R3: after the core is verified nothing is reverted automatically (the challenge part is optional and unbudgeted)
  if ($phase -in 'challenge', 'verified') { $x.final = "CHECK: the core was verified; an exception in phase ${phase} ($($x.error)): no automatic revert; root decides; -Mode rollback undoes it"; Log $x; exit 1 }
  try { $r = Revert "crash in phase ${phase}: $($x.error)" ($phase -in 'restart', 'challenge'); Final 'ROLLED_BACK_AFTER_CRASH: privacy-config restored exactly; the agent restarted on it and the wallet channel verified' $r }
  catch { $x.final = "RECOVERY_REQUIRED: the fallback itself failed ($($_.Exception.Message))"; Log $x; exit 1 } }

# ---------------------------------------------------------------- pins (read-only)
$lock = Join-Path $Stage ("challenge-$Mode-$Run.lock")
try { $fs = [IO.File]::Open($lock, 'CreateNew', 'Write'); $fs.Close() } catch { Log ([ordered]@{ step = 'lock'; decision = 'REFUSED: this run id already ran (lock exists)' }); exit 0 }
$o = [ordered]@{ step = 'pins'; mode = $Mode }; $why = @()
foreach ($k in 'blockSha', 'editSha') { $f = $(if ($k -eq 'blockSha') { 'challengeReplica.json' } else { 'edit-privacy-config.mjs' }); if ((Sha (Join-Path $Stage $f)) -ne [string]$PRM.$k) { $why += "the staged $f is not the pinned bytes" } }
$o.cfgSha = Sha $CFG
$c = $null; try { $c = [IO.File]::ReadAllText($CFG) | ConvertFrom-Json } catch {}
$en = @($c.enclaveNetwork.PSObject.Properties.Name); $o.enKeys = $en
if ((@($c.chain.rpc) -join ',') -ne (@($PRM.chainRpc) -join ',')) { $why += 'privacy-config chain.rpc is not the 5 pinned RPCs (the control cutover is not in place)' }
if ($en -notcontains 'walletAdmission') { $why += 'no walletAdmission: activate only after the verified control cutover' }
$pa = @(Privacy); $o.privacy = $pa
if ($pa.Count -ne 1 -or $pa[0].pid -ne [int]$PRM.privacy.pid -or $pa[0].start -ne (Iso $PRM.privacy.start)) { $why += 'the privacy agent is not the pinned PID+start' }
$np = NodeProcs; $o.node = $np
if ($np.cmd.Count -ne 1 -or $np.agent.Count -ne 1 -or $np.cmd[0].pid -ne [int]$PRM.node.cmdPid -or $np.cmd[0].start -ne (Iso $PRM.node.cmdStart) -or
    $np.agent[0].pid -ne [int]$PRM.node.agentPid -or $np.agent[0].start -ne (Iso $PRM.node.agentStart)) { $why += 'the node cmd/agent are not the pinned identities (no concurrent node change)' }
$uv = $null; try { $uv = UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw } }; $o.updateTask = $uv; $ur = UpdateDecision $uv; if ($ur) { $why += $ur }
$s = Status; $o.statusFresh = [bool]($s -and (ReadinessNumber $s.updatedAt) -and ((NowMs) - [int64]$s.updatedAt) -ge 0 -and ((NowMs) - [int64]$s.updatedAt) -lt 5000); $o.statusRunner = [string]$s.walletAdmission.runner
if (-not $o.statusFresh -or $o.statusRunner -ne [string]$PRM.runner) { $why += 'the privacy status is not fresh, or not enforcing THIS runner' }
$egressBefore = EgressApps; $o.egressBefore = $egressBefore; if ($egressBefore -lt 0) { $why += 'egress-routes.json unreadable' }
# R5: a process NAME proves nothing. Only the listener the driver PROVED (sshd.exe path, enc-ctl-tunnel owner, sshd service parent,
# managed Match block + keys restriction, loopback-only bind, SOA through it; pinned here by PID+start) or a ROOT-PERMITTED absence
function TunnelState { $t = @(Listeners ([int]$P.tunnel)); if (-not $t.Count) { return 'absent' }; Owner ([int]$P.tunnel) }
$o.tunnel = TunnelState; $tm = [string]$PRM.tunnel.mode
if ($tm -eq 'proven') { if (-not ($o.tunnel -is [System.Collections.IDictionary]) -or $o.tunnel.pid -ne [int]$PRM.tunnel.pid -or $o.tunnel.start -ne (Iso $PRM.tunnel.start)) { $why += "127.0.0.1:$($P.tunnel) is not the driver-proven tunnel listener (PID+start)" } }
elseif ($tm -eq 'absent-permitted') { if ($o.tunnel -ne 'absent') { $why += "127.0.0.1:$($P.tunnel) has a listener, but only a root-permitted ABSENCE was pinned" } }
else { $why += 'the 127.0.0.1:31053 tunnel identity is UNPROVEN (no proven listener and no root coverage permission): activation withheld' }
if ($WANT.Count -eq 0 -or $WANT.Count -ne @($PRM.expectedIds).Count) { $why += 'no exact expected deployment ids bound (an empty or duplicated set would be a vacuous core check)' }
else { $o.ids = IdsState; if (-not $o.ids.ok) { $why += 'the exact expected ids are not all running/granted/routed now, on the current channel with their exact binding and live deadlines (see ids)' } }
if ($FORWARD_SEC -lt 330 -or $RECOVERY_SEC -lt 450) { $why += 'the forward/recovery budget is below the source-derived 330/450 s' }
if ($Mode -eq 'apply') {
  if ($o.cfgSha -ne [string]$PRM.cfgSha) { $why += 'privacy-config.json is not the pinned sha' }
  if ($en -contains 'challengeReplica') { $why += 'challengeReplica is already configured' }
  if ((@($en) -join ',') -ne (@($PRM.enKeys) -join ',')) { $why += 'the enclaveNetwork keys differ from the fresh preflight' }
  foreach ($k in 'dns', 'api', 'front') { $l = @(Listeners ([int]$P.$k)); if ($l.Count) { $why += "port $($P.$k) ($k) is already in use by pid $($l[0].OwningProcess)" } }
  if ((Sha $HS2CFG) -ne [string]$PRM.hs2ConfigSha) { $why += 'hs2 is not on the parallel-TXT config 5f75562c: run root-hs2-parallel.py --execute first' }
  if ((Sha (Join-Path $REL 'dns.mjs')) -ne [string]$PRM.release.dnsSha256 -or (Sha (Join-Path $REL 'network-runtime.bundle.mjs')) -ne [string]$PRM.release.runtimeBundleSha256) { $why += 'the installed replica release is not the pinned dns/runtime bytes' }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $DECL))) { $why += 'the declaration directory is missing (prerequisite install 31492)' }
  $o.declaration = DeclState; if ($o.declaration -is [System.Collections.IDictionary] -and $o.declaration.state -eq 'serving') { $why += 'a serving declaration already exists' }
  if (-not $TR -and (Sha $NODE) -ne [string]$PRM.nodeSha) { $why += 'node.exe is not the root-proven binary' }
  $df = [regex]::Match([string](Get-Acl -LiteralPath $CFG).Sddl, 'D:([A-Z]*)\(').Groups[1].Value; if ($df -notmatch 'AI') { $why += "privacy-config.json DACL is not auto-inherited (D:$df)" }
  $nr = Readers $NET; if (@(@($nr.readers) + @($nr.fileInheritReaders) | Where-Object { $ADMIN_SIDS -notcontains $_ }).Count) { $why += 'the network directory is readable by more than SYSTEM/Administrators' }
} else {
  $b = $PRM.before.cfg; if ((Sha ([string]$b.backup)) -ne [string]$b.before) { $why += 'the backup is not its before sha' }
  if ($o.cfgSha -ne [string]$b.after -and $o.cfgSha -ne [string]$b.before) { $why += 'privacy-config.json is neither the activation after nor before sha: root decides' } }
if ($why.Count) { Final ('REFUSED: ' + ($why -join '; ')) $o }
Log $o
if ((Left) -lt ($FORWARD_SEC + $RECOVERY_SEC)) { Final "REFUSED: $([math]::Floor((Left))) s left < forward $FORWARD_SEC + recovery $RECOVERY_SEC; nothing was changed" ([ordered]@{}) }
if ($Mode -eq 'rollback') {
  $before = @{ cfg = @{ before = [string]$PRM.before.cfg.before; after = [string]$PRM.before.cfg.after; backup = [string]$PRM.before.cfg.backup } }
  $phase = 'configs'; $r = Revert 'explicit rollback' $true
  $r.declaration = DeclState
  Final 'ROLLED_BACK: challengeReplica removed (exact before-bytes), privacy agent restarted on them, the killed agent''s replica child proven gone, the exact ids running/granted/routed, replica ports free' $r }

# ---------------------------------------------------------------- render with node BEFORE any change (protected temp, then memory)
$prepared = $null; $edit = $null
try {
  $edit = ProtectedTemp $CFG '.ca-edit-'
  $ea = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $out = & $NODE (Join-Path $Stage 'edit-privacy-config.mjs') $CFG $edit (Join-Path $Stage 'challengeReplica.json') ([string]$PRM.cfgSha) ([string]$PRM.blockSha) 2>$null; $rc = $LASTEXITCODE }
  finally { $ErrorActionPreference = $ea }
  if ($rc -ne 0) { throw 'the edit helper refused' }
  $res = @($out | Where-Object { $_ -like '{*' })[-1] | ConvertFrom-Json
  $prepared = [IO.File]::ReadAllBytes($edit)
  if ((ShaBytes $prepared) -ne [string]$res.after -or [string]$res.before -ne [string]$PRM.cfgSha) { throw 'the rendered bytes are not what the helper reported' }
  $k = @($res.enclaveNetworkKeys); if ($k[-1] -ne 'walletAdmission' -or $k[-2] -ne 'challengeReplica') { throw 'the rendered key order is not ..., challengeReplica, walletAdmission' }
} catch { Final ('REFUSED: the challengeReplica render failed before any change (' + $_.Exception.Message + ')') ([ordered]@{}) }
finally { if ($edit -and (Test-Path -LiteralPath $edit)) { Remove-Item -LiteralPath $edit -Force } }
Log ([ordered]@{ step = 'render'; after = (ShaBytes $prepared); keys = $k })

# ---------------------------------------------------------------- the ONE config write (private backup, CAS, exact ACL)
$phase = 'configs'
PrivDir
$cb = [IO.File]::ReadAllBytes($CFG); $bk = Join-Path $PRIV "privacy-config.json.before-challenge-$Run"; [IO.File]::WriteAllBytes($bk, $cb)
$before = @{ cfg = @{ before = [string]$PRM.cfgSha; after = ''; backup = $bk } }
Log ([ordered]@{ step = 'backup'; sha = (Sha $bk); backup = $bk })
if ((Sha $bk) -ne [string]$PRM.cfgSha) { Final 'REFUSED: the backup is not the pinned before sha; nothing was written' ([ordered]@{}) }
$Fwd = $true                                                    # R3: forward waits from here on never consume the recovery reserve
try { $w = CasWrite $CFG ([string]$PRM.cfgSha) $prepared; $before.cfg.after = $w.after
      Log ([ordered]@{ step = 'config'; after = $w.after; aclKept = $w.aclKept }); if (-not $w.aclKept) { throw 'the config ACL changed' } }
catch { $err = $_.Exception.Message
        # R1: ONLY the exact prepared bytes are our write; unchanged = nothing written; anything else is a FOREIGN change: 'unknown-write'
        # makes RestoreOne refuse (RECOVERY_REQUIRED) instead of overwriting it with the old backup
        if (-not $before.cfg.after) { $cur = Sha $CFG; $before.cfg.after = $(if ($cur -eq (ShaBytes $prepared)) { $cur } elseif ($cur -eq $before.cfg.before) { '' } else { 'unknown-write' }) }
        $r = Revert "config write failed: $err" $false; $r.error = $err
        Final 'ROLLED_BACK_R0: the config write failed; the exact before-bytes are back (the agent never loaded the block)' $r }

# ---------------------------------------------------------------- the ONE privacy restart (pinned PID+start), CORE verified
$phase = 'restart'
$logOffset = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 })
$n = RestartPrivacy ([ordered]@{ pid = [int]$PRM.privacy.pid; start = (Iso $PRM.privacy.start) }) 90
$core = $(if ($n) { CoreUp $n 120 } else { $null })
Log ([ordered]@{ step = 'privacy-restart'; newPid = $n.pid; newStart = $n.start; core = $core; configAsWritten = ((Sha $CFG) -eq $before.cfg.after) })
if (-not $n -or -not $core.ok) {
  $r = Revert "CORE: agent back=$([bool]$n) enforcing=$($core.enforcing) ids ok=$($core.ids.ok)" $true
  Final 'ROLLED_BACK_CORE: the agent with the block did not verifiably carry the wallet channel/egress; the exact before-bytes are back and the core verified' $r }

# ---------------------------------------------------------------- the challenge service (optional; bounded; never a revert by itself)
$phase = 'challenge'; $Fwd = $false                         # core verified: from here on nothing reverts automatically (R3)
$lim = (Get-Date).AddSeconds((Lim ([int]$PRM.challengeWaitSec))); $ch = $null
do { $lc = LogFrom $logOffset $PATS; $d = DeclState; $pd2 = Owner ([int]$P.dns); $pf = Owner ([int]$P.front)
     $ok = $lc['challenge replica serving:'] -ge 1 -and $d -is [System.Collections.IDictionary] -and $d.state -eq 'serving' -and [int]$d.pid -eq $n.pid -and
           $pf -is [System.Collections.IDictionary] -and $pf.pid -eq $n.pid -and $pd2 -is [System.Collections.IDictionary] -and $pd2.parent -eq $n.pid -and $pd2.release
     if ($ok) { break }; Start-Sleep -Seconds 5 } while ((Get-Date) -lt $lim)
$post = [ordered]@{ step = 'post'; log = $lc; declaration = $d; dnsOwner = $pd2; apiOwner = (Owner ([int]$P.api)); frontOwner = $pf
  configAsWritten = ((Sha $CFG) -eq $before.cfg.after); privacyUnchanged = $(try { $q = @(Privacy); $q.Count -eq 1 -and $q[0].pid -eq $n.pid -and $q[0].start -eq $n.start } catch { $false })
  nodeUnchanged = $(try { $q = NodeProcs; $q.agent.Count -eq 1 -and $q.agent[0].pid -eq [int]$PRM.node.agentPid -and $q.agent[0].start -eq (Iso $PRM.node.agentStart) } catch { $false })
  tunnel = (TunnelState); ids = (IdsState); before = $before.cfg }
$post.tunnelUnchanged = $(if ($tm -eq 'proven') { $post.tunnel -is [System.Collections.IDictionary] -and $post.tunnel.pid -eq [int]$PRM.tunnel.pid -and $post.tunnel.start -eq (Iso $PRM.tunnel.start) } else { $post.tunnel -eq 'absent' })
$post.apiOk = $post.apiOwner -is [System.Collections.IDictionary] -and $post.apiOwner.parent -eq $n.pid
$phase = 'verified'
$done = $ok -and $post.apiOk -and $post.tunnelUnchanged -and $post.ids.ok -and $post.configAsWritten -and $post.privacyUnchanged -and $post.nodeUnchanged -and $lc['challenge replica STOPPED'] -eq 0
Final $(if ($done) { 'DONE: challengeReplica configured, privacy agent restarted once with the wallet channel and egress verified, the replica serving (declaration serving, DNS/API child + front owned by the new agent); orders held' }
        else { 'CHECK: the core is verified (wallet channel, egress) but the challenge replica is not verifiably serving within the bound (supervised retry continues): see post; root decides; -Mode rollback undoes it' }) $post
