#!/usr/bin/env python3
"""rpc-integrated: apply ONLY the RPC-override repair to the root-accepted cutover 943a5f01 (exact bytes asserted).
  * run-node.cmd: the hand-added 3-host BASE_RPCS line 12 (96 bytes) is removed IN MEMORY before the stop (plan refuses before any
    disruption), then written with the same backup/CAS/protected-temp/ACL path as the other configs while the node is PROVEN stopped.
  * privacy-config.json: the existing pre-stop render also sets chain.rpc to the SAME 5 URLs, same order (network-enroll's exact
    JSON comparison then finds nothing to switch: no second privacy-agent restart).
  * revert: flag -> run-node -> block, each CAS + ACL-kept; the node is started only on all three exact before-bytes.
  * the revert floor is re-derived (+5 s: one more CAS restore + two hash reads) = 555.
Usage: python3 compose-rpc.py   (reads base/node-hold-cutover.ps1, writes helper/node-hold-cutover.ps1)"""
import hashlib, pathlib
R = pathlib.Path(__file__).resolve().parent
BASE_SHA = '943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093'
s = (R / 'base/node-hold-cutover.ps1').read_text()
assert hashlib.sha256(s.encode()).hexdigest() == BASE_SHA, 'base is not the accepted 943a5f01'
def rep(a, b):
    global s
    assert s.count(a) == 1, ('anchor not unique/present', a[:90]); s = s.replace(a, b, 1)

rep("# ROOT revision 2026-10-22 + cutover-review (one revert pass, poll room, bracketed readiness):",
    "# ROOT revision 2026-10-22 + cutover-review (one revert pass, poll room, bracketed readiness) + rpc-integrated (run-node RPC override removed, chain.rpc = the same 5, both restored on revert):")
rep("""#                  4 node-config.local.cmd += "set ENCLAVE_NETWORK_WALLET_HOLD=1" (byte append, exact backup, ACL kept)
""", """#                  4 node-config.local.cmd += "set ENCLAVE_NETWORK_WALLET_HOLD=1" (byte append, exact backup, ACL kept)
#                  4b run-node.cmd: the hand-added 3-host BASE_RPCS override (line 12, 96 bytes) removed (exact backup, CAS, ACL
#                    kept), planned in memory BEFORE the stop; privacy-config.json chain.rpc was set to the SAME 5 in step 3
""")
rep("""#     b  the node's flag restored FIRST (CAS against the journaled after-sha; exact before-bytes; re-read)
""", """#     b  the node's flag restored FIRST (CAS against the journaled after-sha; exact before-bytes; re-read)
#     b2 run-node.cmd restored (same CAS/ACL rules) - the old launcher, before the old configuration can start
""")
# ---- constants and in-memory edit (never logged: the launcher may carry private settings; only hashes/line numbers leave)
rep("""$AGENT_PAT = '*\\control\\windows\\node\\agent.mjs*'; $RUN_PAT = '*\\Enclave\\run-node.cmd*'; $FLAG = 'set ENCLAVE_NETWORK_WALLET_HOLD=1'
""", """$AGENT_PAT = '*\\control\\windows\\node\\agent.mjs*'; $RUN_PAT = '*\\Enclave\\run-node.cmd*'; $FLAG = 'set ENCLAVE_NETWORK_WALLET_HOLD=1'
# RPC REPAIR (rpc-availability 2026-10-22): the node's 5 public Base RPCs = chain.mjs's default = run-node.cmd line 5 =
# node-config.local.cmd. run-node.cmd line 12 re-sets 3 of them right before the launch; removing exactly that line lets line 5
# reach the node. privacy-config.json chain.rpc gets the identical list (network-enroll compares JSON.stringify exactly).
$RPC5 = @('https://base-rpc.publicnode.com', 'https://base.gateway.tenderly.co', 'https://base-public.nodies.app', 'https://base.drpc.org', 'https://mainnet.base.org')
$RPC_L12 = 'set "BASE_RPCS=https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org"'
$RPC_L5 = 'set "BASE_RPCS=' + ($RPC5 -join ',') + '"'
$LATIN1 = [Text.Encoding]::GetEncoding(28591)        # byte-exact round trip: no byte is re-encoded
""")
rep("""function Sha($p) {""", """function ShaBytes([byte[]]$b) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
# run-node.cmd minus EXACTLY its line-12 override, in memory -> ok/why/line12/line5/removed/newSha (+ bytes, never logged)
function RunNodeEdit([byte[]]$raw) {
  $r = [ordered]@{ ok = $false; why = '' }; $txt = $LATIN1.GetString($raw)
  $m12 = [regex]::Matches($txt, '(?m)^' + [regex]::Escape($RPC_L12) + '\\r\\n'); $m5 = [regex]::Matches($txt, '(?m)^' + [regex]::Escape($RPC_L5) + '\\r\\n')
  if ($m12.Count -ne 1 -or $m5.Count -ne 1) { $r.why = "line shapes: $($m12.Count) three-host / $($m5.Count) five-host lines"; return $r }
  $r.line12 = ([regex]::Matches($txt.Substring(0, $m12[0].Index), "`n")).Count + 1; $r.line5 = ([regex]::Matches($txt.Substring(0, $m5[0].Index), "`n")).Count + 1
  $next = ($txt.Substring($m12[0].Index + $m12[0].Length) -split "`r`n", 2)[0]
  if ($r.line12 -ne 12 -or $r.line5 -ne 5 -or $next -notmatch 'agent\\.mjs') { $r.why = 'the override is not line 12 directly before the agent launch, or the 5-host line is not line 5'; return $r }
  $nb = $LATIN1.GetBytes($txt.Remove($m12[0].Index, $m12[0].Length)); $r.removed = $raw.Length - $nb.Length; $r.newSha = ShaBytes $nb
  if ($r.removed -ne 96 -or $r.newSha -ne [string]$PRM.runNodeNewSha) { $r.why = "the edited launcher is not the pinned one ($($r.removed) bytes removed)"; return $r }
  $r.bytes = $nb; $r.ok = $true; return $r }
function Sha($p) {""")
# ---- BeforeStop: the launcher is pinned like the two configs (operator edits during preparation refuse before the stop)
rep("""    if ((Sha $CFG) -ne [string]$PRM.cfgSha -or (Sha $LOCAL) -ne [string]$PRM.localSha) { return 'a config changed during preparation; nothing stopped' }""",
    """    if ((Sha $CFG) -ne [string]$PRM.cfgSha -or (Sha $LOCAL) -ne [string]$PRM.localSha -or (Sha $RUNNODE) -ne [string]$PRM.runNodeSha) { return 'a config changed during preparation; nothing stopped' }""")
# ---- RestoreOne knows the launcher
rep("""  $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG }); $b = $before[$k]; $cur = Sha $path""",
    """  $path = $(if ($k -eq 'local') { $LOCAL } elseif ($k -eq 'runNode') { $RUNNODE } else { $CFG }); $b = $before[$k]; $cur = Sha $path""")
# ---- Revert: flag -> launcher -> block; the start requires all three before-bytes
rep("""  $x.cfg = RestoreOne 'cfg'""", """  $x.runNode = RestoreOne 'runNode'
  if ($x.runNode -notin 'restored', 'already before' -or (Sha $RUNNODE) -ne $before.runNode.before) {
    Recovery "the node launcher was not restored ($($x.runNode)); the flag IS restored; the network block is KEPT; the node stays STOPPED" $x }
  $x.cfg = RestoreOne 'cfg'""")
rep("""  if ((Sha $LOCAL) -ne $before.local.before -or (Sha $CFG) -ne $before.cfg.before -or -not (NodeStopped)) {""",
    """  if ((Sha $LOCAL) -ne $before.local.before -or (Sha $RUNNODE) -ne $before.runNode.before -or (Sha $CFG) -ne $before.cfg.before -or -not (NodeStopped)) {""")
rep("""      $x.unchanged = ((Sha $LOCAL) -eq [string]$PRM.localSha -and (Sha $CFG) -eq [string]$PRM.cfgSha)""",
    """      $x.unchanged = ((Sha $LOCAL) -eq [string]$PRM.localSha -and (Sha $CFG) -eq [string]$PRM.cfgSha -and (Sha $RUNNODE) -eq [string]$PRM.runNodeSha)""")
# ---- pins: cutover pins the old launcher; rollback accepts its journaled before/after like the configs
rep("""if ((Sha $RUNNODE) -ne [string]$PRM.runNodeSha) { $why += 'run-node.cmd is not the pinned file' }""",
    """if ($Mode -eq 'cutover' -and (Sha $RUNNODE) -ne [string]$PRM.runNodeSha) { $why += 'run-node.cmd is not the pinned file' }
if ($Mode -eq 'cutover' -and [string]$PRM.runNodeNewSha -notmatch '^[0-9a-f]{64}$') { $why += 'the params do not pin the repaired run-node.cmd (runNodeNewSha)' }""")
rep("""  # Recoverable path: initial snapshot15 + StopNode135 + privacy snapshot15 + restart90 + plain status90
  # + final stopped snapshot15 + node readiness150 =510; add40 for local file/ACL/kill/log work and polling.""",
    """  # Recoverable path: initial snapshot15 + StopNode135 + privacy snapshot15 + restart90 + plain status90
  # + final stopped snapshot15 + node readiness150 =510; add40 for local file/ACL/kill/log work and polling (2 CAS restores);
  # rpc-integrated: +5 for the third CAS restore (run-node.cmd) and its two hash reads = 555. No bounded call was added.""")
rep("""  if ($lp -and [int]$lp.revertSec -lt 550) { $why += 'revert budget is shorter than the 550-second bounded-path allowance' }""",
    """  if ($lp -and [int]$lp.revertSec -lt 555) { $why += 'revert budget is shorter than the 555-second bounded-path allowance' }""")
rep("""  foreach ($p in $CFG, $LOCAL) { $df =""", """  foreach ($p in $CFG, $LOCAL, $RUNNODE) { $df =""")
rep("""  foreach ($k in 'local', 'cfg') { $b = $PRM.before.$k; if ((Sha ([string]$b.backup)) -ne [string]$b.before) { $why += "the $k backup is not its before sha" }
    $path = $(if ($k -eq 'local') { $LOCAL } else { $CFG });""",
    """  foreach ($k in 'local', 'runNode', 'cfg') { $b = $PRM.before.$k; if ((Sha ([string]$b.backup)) -ne [string]$b.before) { $why += "the $k backup is not its before sha" }
    $path = $(if ($k -eq 'local') { $LOCAL } elseif ($k -eq 'runNode') { $RUNNODE } else { $CFG });""")
rep("""$before = @{ local = @{ before = [string]$PRM.localSha; after = ''; backup = '' }; cfg = @{ before = [string]$PRM.cfgSha; after = ''; backup = '' } }
if ($Mode -eq 'rollback') { foreach ($k in 'local', 'cfg') {""",
    """$before = @{ local = @{ before = [string]$PRM.localSha; after = ''; backup = '' }; cfg = @{ before = [string]$PRM.cfgSha; after = ''; backup = '' }
            runNode = @{ before = [string]$PRM.runNodeSha; after = ''; backup = '' } }
if ($Mode -eq 'rollback') { foreach ($k in 'local', 'runNode', 'cfg') {""")
# ---- preparation: the render also sets chain.rpc; the launcher edit is planned in memory; both before the stop
rep("""$preparedCfgBytes = $null
if ($Mode -eq 'cutover') {""", """$preparedCfgBytes = $null; $preparedRunNode = $null
if ($Mode -eq 'cutover') {
  $rn = $null; try { $rn = RunNodeEdit ([IO.File]::ReadAllBytes($RUNNODE)) } catch {}
  if (-not $rn -or -not $rn.ok) { Final ('REFUSED: the run-node.cmd RPC override removal does not apply; nothing was stopped or changed (' + $(if ($rn) { $rn.why } else { 'unreadable' }) + ')') ([ordered]@{ line12 = $rn.line12; line5 = $rn.line5; removed = $rn.removed; newSha = $rn.newSha }) }
  $preparedRunNode = $rn.bytes""")
rep("""    $js = "const fs=require('fs');const [p,t,f]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,'utf8'));const e=c.enclaveNetwork;" +
          "if(!e||typeof e!=='object')throw new Error('no enclaveNetwork');delete e.walletAdmission;e.walletAdmission={file:f};fs.writeFileSync(t,JSON.stringify(c,null,2)+String.fromCharCode(10));\"""",
    """    $js = "const fs=require('fs');const [p,t,f,l]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,'utf8'));const e=c.enclaveNetwork;" +
          "if(!e||typeof e!=='object')throw new Error('no enclaveNetwork');delete e.walletAdmission;e.walletAdmission={file:f};" +
          "const r=String(l).split(',');if(r.length!==5||r.some(u=>!/^https:\\/\\/[a-z0-9.-]+$/.test(u)))throw new Error('rpc list');" +
          "if(!c.chain||typeof c.chain!=='object'||Array.isArray(c.chain)||!Array.isArray(c.chain.rpc))throw new Error('no chain.rpc');c.chain.rpc=r;" +
          "fs.writeFileSync(t,JSON.stringify(c,null,2)+String.fromCharCode(10));\"""")
rep("""$null = & $NODE -e $js $CFG $edit $WALLET 2>&1;""", """$null = & $NODE -e $js $CFG $edit $WALLET ($RPC5 -join ',') 2>&1;""")
# ---- configs phase: the launcher's private backup, verified with the two others
rep("""Log ([ordered]@{ step = 'backups'; local = (Sha $before.local.backup); cfg = (Sha $before.cfg.backup); localBackup = $before.local.backup; cfgBackup = $before.cfg.backup })
if ((Sha $before.local.backup) -ne $before.local.before -or (Sha $before.cfg.backup) -ne $before.cfg.before) {""",
    """$rb = [IO.File]::ReadAllBytes($RUNNODE); $before.runNode.backup = Join-Path $PRIV "run-node.cmd.before-$Run"; [IO.File]::WriteAllBytes($before.runNode.backup, $rb)
Log ([ordered]@{ step = 'backups'; local = (Sha $before.local.backup); cfg = (Sha $before.cfg.backup); runNode = (Sha $before.runNode.backup); localBackup = $before.local.backup; cfgBackup = $before.cfg.backup; runNodeBackup = $before.runNode.backup })
if ((Sha $before.local.backup) -ne $before.local.before -or (Sha $before.cfg.backup) -ne $before.cfg.before -or (Sha $before.runNode.backup) -ne $before.runNode.before) {""")
rep("""  if (-not $w.aclKept) { throw 'the node-config ACL changed' }
} catch {""", """  if (-not $w.aclKept) { throw 'the node-config ACL changed' }
  # the launcher, still PROVEN stopped (no run-node cmd.exe can be mid-file): CAS on the pinned bytes, the planned edit only
  $w = CasWrite $RUNNODE $before.runNode.before $preparedRunNode; $before.runNode.after = $w.after
  Log ([ordered]@{ step = 'run-node'; after = $w.after; aclKept = $w.aclKept })
  if (-not $w.aclKept) { throw 'the run-node.cmd ACL changed' }
  if ($w.after -ne [string]$PRM.runNodeNewSha) { throw 'run-node.cmd is not the repaired bytes after the write' }
} catch {""")
rep("""  foreach ($k in 'local', 'cfg') { $p0 = $(if ($k -eq 'local') { $LOCAL } else { $CFG });""",
    """  foreach ($k in 'local', 'runNode', 'cfg') { $p0 = $(if ($k -eq 'local') { $LOCAL } elseif ($k -eq 'runNode') { $RUNNODE } else { $CFG });""")
rep("""$same = ((Sha $LOCAL) -eq $before.local.after -and (Sha $CFG) -eq $before.cfg.after)""",
    """$same = ((Sha $LOCAL) -eq $before.local.after -and (Sha $CFG) -eq $before.cfg.after -and (Sha $RUNNODE) -eq $before.runNode.after)""")
rep("""$post.identityUnchanged = Identity $post
""", """$post.identityUnchanged = Identity $post
# the repair held: the launcher is the repaired bytes, chain.rpc is still the 5 (network-enroll may rewrite other parts of the
# config), and the privacy agent is still the one THIS run restarted (no second restart by network-enroll)
$post.runNodeAsWritten = ((Sha $RUNNODE) -eq [string]$PRM.runNodeNewSha)
$post.chainRpcAsWritten = $(try { (@(([IO.File]::ReadAllText($CFG) | ConvertFrom-Json).chain.rpc) -join ',') -eq ($RPC5 -join ',') } catch { $false })
$post.privacyUnchanged = $(try { $pp = @(Privacy); $pp.Count -eq 1 -and $pp[0].pid -eq $n.pid -and $pp[0].start -eq $n.start } catch { $false })
""")
rep("""$clean = $post.identityUnchanged -and $post.walletAclOk""", """$clean = $post.identityUnchanged -and $post.runNodeAsWritten -and $post.chainRpcAsWritten -and $post.privacyUnchanged -and $post.walletAclOk""")
# ---- G-UPD (root review RPC-INTEGRATED-ROOT-REVIEW, 2026-10-22): a coherent updater state ONLY, read through the bounded Query,
# at the pins AND again inside BeforeStop (the stop never proceeds on the initial read alone)
rep("""function BeforeStop {
  try {
    $h = HostState 10""", """# G-UPD: \\Enclave\\Update (hourly, SYSTEM) ends an install with Start-ScheduledTask Node. ACCEPTED ONLY: Ready + Settings.Enabled =
# boolean $true + a KNOWN next run later than now + BoundSec + 60 s; or Disabled + Enabled = boolean $false + no next run.
# REFUSED: Running / Queued (may run at once whatever its next time) / Unknown / any other state, no or unparseable next run,
# a non-boolean Enabled, a failed query and an ABSENT task (this host has one: absence is unexpected, never 'nothing to fear').
function UpdateDecision($v) {
  if ($null -eq $v -or $v -is [string]) { return 'the \\Enclave\\Update task is absent or unreadable' }
  $st = [string]$v.state; $en = $v.enabled; $nx = $v.next
  if ($st -in 'Running', 'Queued') { return "the \\Enclave\\Update task runs or is due inside this window (state $st)" }
  if (-not ($en -is [bool])) { return 'the \\Enclave\\Update task Enabled flag is not a boolean' }
  if ($st -eq 'Disabled') { if ($en -eq $false -and ($null -eq $nx -or [string]$nx -eq '')) { return $null }; return 'the \\Enclave\\Update task is Disabled but enabled or with a next run (incoherent)' }
  if ($st -ne 'Ready' -or $en -ne $true) { return "the \\Enclave\\Update task state $st / enabled $en is not accepted (only Ready+enabled or Disabled)" }
  if ($null -eq $nx -or [string]$nx -eq '') { return 'the \\Enclave\\Update task has no known next run' }
  $t = $null; try { $t = [DateTimeOffset]::Parse((Iso $nx)).UtcDateTime } catch {}
  if ($null -eq $t) { return 'the \\Enclave\\Update next run time is unparseable' }
  if ($t -lt (Get-Date).ToUniversalTime().AddSeconds($BoundSec + 60)) { return 'the \\Enclave\\Update task runs or is due inside this window' }
  return $null }
# read-only, through the bounded child reader (never an uncontrolled wait); a failed query is $null (refused by UpdateDecision)
function UpdateState([double]$limitSec = 10) {
  if ($TR) { $t = Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Update' -ErrorAction Stop; $i = Get-ScheduledTaskInfo -InputObject $t
    return [ordered]@{ state = [string]$t.State; enabled = $t.Settings.Enabled; next = $(if ($i.NextRunTime -is [datetime]) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) } }
  @(Query { $t = Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Update' -ErrorAction Stop; $i = Get-ScheduledTaskInfo -InputObject $t -ErrorAction Stop
    [ordered]@{ state = [string]$t.State; enabled = $t.Settings.Enabled; next = $(if ($i.NextRunTime -is [datetime]) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) } } $limitSec)[0] }
function BeforeStop {
  try {
    # the updater again, immediately before the stop (counted against the forward budget like the lease read below)
    $uv = $null; try { $uv = UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
    $ur = UpdateDecision $uv; if ($ur) { return $ur + '; nothing stopped' }
    $h = HostState 10""")
rep("""$u = Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Update' -ErrorAction SilentlyContinue
if ($u) { $ui = Get-ScheduledTaskInfo -InputObject $u; $o.updateTask = [ordered]@{ state = [string]$u.State; next = $(if ($ui.NextRunTime) { $ui.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) }
  if ([string]$u.State -eq 'Running' -or ($ui.NextRunTime -and $ui.NextRunTime -lt (Get-Date).AddSeconds($BoundSec + 60))) { $why += 'the \\Enclave\\Update task runs or is due inside this window' } }""",
"""# rpc-integrated G-UPD: only a coherent state passes (UpdateDecision); a failed or absent read REFUSES (was: silently accepted)
$uv = $null; try { $uv = UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
$o.updateTask = $uv; $ur = UpdateDecision $uv; if ($ur) { $why += $ur }""")
assert all(ord(ch) < 128 for ch in s), 'non-ASCII'
(R / 'helper').mkdir(exist_ok=True); (R / 'helper/node-hold-cutover.ps1').write_text(s)
print('rpc-integrated cutover', hashlib.sha256(s.encode()).hexdigest())
