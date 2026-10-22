# challenge-activate.ps1 - ROOT-ONLY, PowerShell 5.1, run by a one-shot SYSTEM task (root-challenge-activation.py), never by its author.
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
                'RestartPrivacy','FreshStatus','UpdateDecision','UpdateState') {
  $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true)); if ($f.Count -ne 1) { exit 6 }
  . ([scriptblock]::Create($f[0].Extent.Text)) }
$PD = $(if ($TR) { $TR } else { 'C:\ProgramData\Enclave' }); $NET = Join-Path $PD 'network'; $CFG = Join-Path $NET 'privacy-config.json'
$STATE = Join-Path $NET 'state'; $WALLET = Join-Path $NET 'wallet-admission.json'; $NODELOG = Join-Path (Join-Path $PD 'logs') 'network.log'   # LogFrom: the PRIVACY agent's log
$HS2CFG = $(if ($TR) { Join-Path $TR 'hs2-config.json' } else { 'C:\ProgramData\Enclave\host-services\hs2\config\host-services.json' })
$NODE = $(if ($TR) { [string]$PRM.testNode } else { [string]$PRM.nodeExe })
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'; $ADMIN_SIDS = @('S-1-5-18', 'S-1-5-32-544')
$J = Join-Path $Stage ("challenge-$Run.jsonl"); $PRIV = Join-Path $Stage 'private'
$DECL = [string]$PRM.declarationFile; $REL = [string]$PRM.release.dir; $P = $PRM.ports
$PATS = @('challenge replica serving:', 'challenge replica not started', 'challenge replica STOPPED', 'challenge replica restart refused')
# ---- challenge-specific reads (no secret: the declaration's proof key is never read out)
function DeclState { try { $d = [IO.File]::ReadAllText($DECL) | ConvertFrom-Json; [ordered]@{ state = [string]$d.state; pid = $d.pid; expiresAt = $d.expiresAt
    dns = [string]$d.release.dnsSha256 } } catch { if (Test-Path -LiteralPath $DECL) { 'unreadable' } else { 'absent' } } }
function Owner([int]$port) { $l = @(Listeners $port); if ($l.Count -eq 0) { return $null }; if ($l.Count -ne 1) { return 'many' }
  $p = @(ById ([int]$l[0].OwningProcess))
  if ($p.Count -ne 1) { return 'unknown' }
  [ordered]@{ pid = [int]$p[0].ProcessId; parent = [int]$p[0].ParentProcessId; name = [string]$p[0].Name; start = (Utc $p[0]); release = ([string]$p[0].CommandLine -like ('*' + $REL + '*')) } }
# the replica child(ren) of a privacy agent: node.exe running THIS release's dns.mjs whose parent is that agent
function ReplicaChildren($agentPid) {
  $all = $(if ($TR) { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20) } else { @(ProcessRows "Name='node.exe'") })
  @($all | Where-Object { [int]$_.ParentProcessId -eq [int]$agentPid -and [string]$_.CommandLine -like ('*' + $REL + '*dns.mjs*') } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } }) }
# a replica child orphaned by a killed agent keeps 18353/18354 (dns.mjs has no parent watch): stop it by its verified PID+start only
function StopOrphans($oldAgentPid) { $done = @()
  foreach ($c in @(ReplicaChildren $oldAgentPid)) {
    $now = @(ReplicaChildren $oldAgentPid | Where-Object { $_.pid -eq $c.pid -and $_.start -eq $c.start })
    if ($now.Count -eq 1) { try { Stop-Process -Id $c.pid -Force } catch {}; $done += "$($c.pid)@$($c.start)" } }
  return ,$done }
function CoreUp($n, $egressBefore, [int]$waitSec) {   # fresh enforcing status of the node's CURRENT channel generation, then egress back
  $gen = $(try { [string]([IO.File]::ReadAllText($WALLET) | ConvertFrom-Json).generation } catch { $null })
  $r = [ordered]@{ generationKnown = [bool]$gen; enforcing = $false; egress = -1 }
  if (-not $gen) { return $r }
  $r.enforcing = [bool](FreshStatus 90 (IsoMs $n.start) 'enforcing' $gen)
  $lim = (Get-Date).AddSeconds((Lim $waitSec))
  do { $r.egress = EgressApps; if ($r.egress -ge $egressBefore) { break }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $lim)
  return $r }
function Recovery($what, $x) { $x.recovery = $what; $x.cfgSha = $(try { Sha $CFG } catch { 'unreadable' })
  $x.privacy = $(try { @(Privacy) } catch { 'unknown: ' + $_.Exception.Message }); Final ("RECOVERY_REQUIRED: $what") $x }
# ONE revert pass: exact bytes back, then (if the agent ever ran with the block) restart it and verify the core
function Revert($why, $agentRanWithBlock) {
  $script:RevertState = 'started'
  $x = [ordered]@{ step = 'revert'; why = $why }
  $x.cfg = RestoreOne 'cfg'
  if ($x.cfg -notin 'restored', 'already before' -or (Sha $CFG) -ne $before.cfg.before) { Recovery "privacy-config.json was not restored ($($x.cfg)); the privacy agent was NOT restarted again" $x }
  if (-not $agentRanWithBlock -and $x.cfg -eq 'already before') { $script:RevertState = 'complete'; $x.restart = 'not needed (the agent never loaded the block)'; return $x }
  $cur = @(Privacy); if ($cur.Count -ne 1) { Recovery "the config IS restored, but not exactly one privacy agent ($($cur.Count)); not restarted" $x }
  $off = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 })
  $n = RestartPrivacy $cur[0] 90; $x.privacy = $n
  if (-not $n) { Recovery 'the config IS restored; the privacy agent did not come back within 90 s' $x }
  $x.orphansStopped = StopOrphans $cur[0].pid
  $x.core = CoreUp $n $egressBefore 120
  if (-not $x.core.enforcing -or $x.core.egress -lt $egressBefore) { Recovery 'the config IS restored and the agent restarted, but the wallet channel / egress did not verifiably return' $x }
  $x.challengeLogSinceRestart = LogFrom $off $PATS
  $script:RevertState = 'complete'; return $x }
trap {
  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }
  if ($phase -eq 'pins') { $x.final = 'CRASHED in phase pins: nothing was changed; root decides'; Log $x; exit 1 }
  if ($script:RevertState -eq 'complete') { $x.final = "ROLLED_BACK_CHECK: the revert completed but a later check failed ($($x.error)); root decides"; Log $x; exit 1 }
  if ($script:RevertState) { Recovery "the revert itself failed ($($x.error)); no second pass" $x }
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
$s = Status; $o.statusFresh = [bool]($s -and ((NowMs) - [int64]$s.updatedAt) -lt 5000); $o.statusRunner = [string]$s.walletAdmission.runner
if (-not $o.statusFresh -or $o.statusRunner -ne [string]$PRM.runner) { $why += 'the privacy status is not fresh, or not enforcing THIS runner' }
$egressBefore = EgressApps; $o.egressBefore = $egressBefore; if ($egressBefore -lt 0) { $why += 'egress-routes.json unreadable' }
$t = @(Listeners ([int]$P.tunnel)); $o.tunnel = 'absent'
if ($t.Count -gt 0) { $ow = Owner ([int]$P.tunnel); $o.tunnel = $ow; if (-not ($ow -is [System.Collections.IDictionary]) -or $ow.name -ne 'sshd.exe') { $why += "127.0.0.1:$($P.tunnel) is owned by something other than sshd ($($ow | ConvertTo-Json -Compress)): route-dns would merge its TXT" } }
elseif ([string]$PRM.tunnelPolicy -eq 'sshd-required') { $why += "127.0.0.1:$($P.tunnel) has no listener and the params require the tunnel" }
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
if ($Mode -eq 'rollback') {
  $before = @{ cfg = @{ before = [string]$PRM.before.cfg.before; after = [string]$PRM.before.cfg.after; backup = [string]$PRM.before.cfg.backup } }
  $phase = 'configs'; $r = Revert 'explicit rollback' $true
  $r.declaration = DeclState; $r.ports = [ordered]@{ dns = (Owner ([int]$P.dns)); api = (Owner ([int]$P.api)); front = (Owner ([int]$P.front)) }
  $clean = -not $r.ports.dns -and -not $r.ports.api -and -not $r.ports.front
  Final $(if ($clean) { 'ROLLED_BACK: challengeReplica removed (exact before-bytes), privacy agent restarted on them, wallet channel and egress verified, replica ports free' }
          else { 'ROLLED_BACK_CHECK: config restored and the core verified, but a replica port is still held (see ports): root decides' }) $r }

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
try { $w = CasWrite $CFG ([string]$PRM.cfgSha) $prepared; $before.cfg.after = $w.after
      Log ([ordered]@{ step = 'config'; after = $w.after; aclKept = $w.aclKept }); if (-not $w.aclKept) { throw 'the config ACL changed' } }
catch { $err = $_.Exception.Message; if (-not $before.cfg.after -and (Sha $CFG) -ne $before.cfg.before) { $before.cfg.after = (Sha $CFG) }
        $r = Revert "config write failed: $err" $false; $r.error = $err
        Final 'ROLLED_BACK_R0: the config write failed; the exact before-bytes are back (the agent never loaded the block)' $r }

# ---------------------------------------------------------------- the ONE privacy restart (pinned PID+start), CORE verified
$phase = 'restart'
$logOffset = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 })
$n = RestartPrivacy ([ordered]@{ pid = [int]$PRM.privacy.pid; start = (Iso $PRM.privacy.start) }) 90
$core = $(if ($n) { CoreUp $n $egressBefore 120 } else { $null })
Log ([ordered]@{ step = 'privacy-restart'; newPid = $n.pid; newStart = $n.start; core = $core; configAsWritten = ((Sha $CFG) -eq $before.cfg.after) })
if (-not $n -or -not $core.enforcing -or $core.egress -lt $egressBefore) {
  $r = Revert "CORE: agent back=$([bool]$n) enforcing=$($core.enforcing) egress=$($core.egress)/$egressBefore" $true
  Final 'ROLLED_BACK_CORE: the agent with the block did not verifiably carry the wallet channel/egress; the exact before-bytes are back and the core verified' $r }

# ---------------------------------------------------------------- the challenge service (optional; bounded; never a revert by itself)
$phase = 'challenge'
$lim = (Get-Date).AddSeconds((Lim ([int]$PRM.challengeWaitSec))); $ch = $null
do { $lc = LogFrom $logOffset $PATS; $d = DeclState; $pd2 = Owner ([int]$P.dns); $pf = Owner ([int]$P.front)
     $ok = $lc['challenge replica serving:'] -ge 1 -and $d -is [System.Collections.IDictionary] -and $d.state -eq 'serving' -and [int]$d.pid -eq $n.pid -and
           $pf -is [System.Collections.IDictionary] -and $pf.pid -eq $n.pid -and $pd2 -is [System.Collections.IDictionary] -and $pd2.parent -eq $n.pid -and $pd2.release
     if ($ok) { break }; Start-Sleep -Seconds 5 } while ((Get-Date) -lt $lim)
$post = [ordered]@{ step = 'post'; log = $lc; declaration = $d; dnsOwner = $pd2; apiOwner = (Owner ([int]$P.api)); frontOwner = $pf
  configAsWritten = ((Sha $CFG) -eq $before.cfg.after); privacyUnchanged = $(try { $q = @(Privacy); $q.Count -eq 1 -and $q[0].pid -eq $n.pid -and $q[0].start -eq $n.start } catch { $false })
  nodeUnchanged = $(try { $q = NodeProcs; $q.agent.Count -eq 1 -and $q.agent[0].pid -eq [int]$PRM.node.agentPid -and $q.agent[0].start -eq (Iso $PRM.node.agentStart) } catch { $false })
  tunnel = $(if (@(Listeners ([int]$P.tunnel)).Count) { Owner ([int]$P.tunnel) } else { 'absent' }); before = $before.cfg }
$post.apiOk = $post.apiOwner -is [System.Collections.IDictionary] -and $post.apiOwner.parent -eq $n.pid
$phase = 'verified'
$done = $ok -and $post.apiOk -and $post.configAsWritten -and $post.privacyUnchanged -and $post.nodeUnchanged -and $lc['challenge replica STOPPED'] -eq 0
Final $(if ($done) { 'DONE: challengeReplica configured, privacy agent restarted once with the wallet channel and egress verified, the replica serving (declaration serving, DNS/API child + front owned by the new agent); orders held' }
        else { 'CHECK: the core is verified (wallet channel, egress) but the challenge replica is not verifiably serving within the bound (supervised retry continues): see post; root decides; -Mode rollback undoes it' }) $post
