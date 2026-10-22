# challenge-activation r4 NATIVE fixture (ROOT-ONLY; Windows PowerShell 5.1). Exercises the EXACT staged challenge-activate.ps1 functions
# (AST-extracted, never re-typed) plus the cutover functions it reuses, on objects THIS fixture owns: its own loopback listener, its own
# node.exe children (one with the replica command-line shape, one decoy, the edit helper), synthetic files in its own stage.
# No production process, task, listener, config or declaration is read for content or touched. Output: counts/booleans/PIDs only.
# r3: section 5 runs the exact IdsState verdict under PowerShell 5.1 JSON semantics on SYNTHETIC channel/status/egress/expectation files.
# r4 (root native review):
#  - BOUND is a real bound. Every section and every reused bounded wait runs inside BOUND - CLEANUP_SEC (the reused Left/Lim/Query
#    honour $BoundSec/$T0); a section that no longer fits refuses.
#  - Every process the fixture starts goes through Spawn: registered (in memory and in <Stage>\owned.jsonl: role, PID, start) right
#    after Start.
#  - The edit helper runs as a BOUNDED own child (RunOwned).
#  - ONE always-run finally kills what still runs and CONFIRMS each exit (bounded). The driver's cleanup re-checks owned.jsonl and
#    deletes the stage only after every registered process is confirmed gone.
param([string]$Stage, [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$NodeSha = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3')
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $sw = [Diagnostics.Stopwatch]::StartNew()
$BOUND = 150; $CLEANUP_SEC = 20; $BoundSec = $BOUND - $CLEANUP_SEC; $T0 = Get-Date
$out = [ordered]@{ pass = $false; boundSec = $BOUND }
$REG = Join-Path $Stage 'owned.jsonl'; $script:Owned = [Collections.ArrayList]::new()
$ownOk = $false; $orphOk = $false; $renderOk = $false; $declOk = $false; $idsOk = $false
$PINS = [ordered]@{ 'chact.ps1' = '850c1825e606359462b6119625b29f454dd4b0a78dfa4bd2fc27ada8c0aeb7a3'; 'node-hold-cutover.ps1' = 'df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8'
  'edit-privacy-config.mjs' = '4d9c231e624e9c51bc83e1e86b06816aa53a38a168752881a0ec71a879a8d511'; 'challengeReplica.json' = '2b644d22c3fe1517fcca13fd01c07363cd0f5f5a65ea7f16fb466d958d0b62ad' }
foreach ($n in 'Start-ScheduledTask','Stop-ScheduledTask','Register-ScheduledTask','Unregister-ScheduledTask','Stop-Service','Start-Service','Restart-Service','Stop-VM','Start-VM') {
  . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n is forbidden in this fixture' }")) }

# ---- own-process helpers (the pattern of the reviewed Invoke-BoundedQuery, df2e58f2, for a child that is not PowerShell)
function RegLine($o) { [IO.File]::AppendAllText($REG, (ConvertTo-Json -InputObject $o -Compress) + "`n") }
function StartUtc($p) { $p.StartTime.ToUniversalTime().ToString('o') }
function ArgLine([string[]]$argv) { @($argv | ForEach-Object { if ($_ -match '"' -or $_.EndsWith('\')) { throw 'an argument cannot be quoted safely' }; '"' + $_ + '"' }) -join ' ' }
function Spawn($role, [string]$exe, [string[]]$argv, [bool]$redirect) {
  $si = New-Object Diagnostics.ProcessStartInfo; $si.FileName = $exe; $si.Arguments = (ArgLine $argv); $si.UseShellExecute = $false; $si.CreateNoWindow = $true
  $si.RedirectStandardOutput = $redirect; $si.RedirectStandardError = $redirect
  $p = [Diagnostics.Process]::Start($si); [void]$script:Owned.Add([ordered]@{ role = $role; proc = $p; pid = $p.Id })
  $st = $(try { StartUtc $p } catch { 'unknown' }); RegLine ([ordered]@{ role = $role; pid = $p.Id; start = $st }); $p }
function KillOwned($p) { $p.Kill() }
function WaitOwned($p, [double]$ms) { try { $p.WaitForExit([int][math]::Max(0, $ms)) } catch { $false } }
# a bounded own child: waited at most $ms; on the deadline killed and its exit CONFIRMED (bounded). Output is read only from an EXITED
# child, with a bounded Wait (never an unbounded .Result). An unconfirmed exit is reported and retried by the final cleanup.
function RunOwned($role, [string]$exe, [string[]]$argv, [int]$ms) {
  $t = [Diagnostics.Stopwatch]::StartNew(); $r = [ordered]@{ role = $role; ok = $false; exit = $null; stdout = $null; reason = $null; timedOut = $false; exited = $false }
  if ($ms -lt 3000) { $r.reason = 'not enough time left to run and confirm cleanup'; return $r }
  try { $p = Spawn $role $exe $argv $true } catch { $r.reason = 'spawn failed: ' + $_.Exception.Message; return $r }
  $so = $p.StandardOutput.ReadToEndAsync(); $null = $p.StandardError.ReadToEndAsync()
  if (WaitOwned $p ($ms - 2000 - $t.ElapsedMilliseconds)) { $r.exited = $true; $r.exit = $p.ExitCode
    if ($so.Wait([int][math]::Max(0, $ms - $t.ElapsedMilliseconds))) { $r.stdout = $so.Result; $r.ok = $true } else { $r.reason = 'output not complete within the bound' } }
  else { $r.timedOut = $true; $r.reason = 'deadline'
    try { KillOwned $p } catch { $r.killError = $_.Exception.Message }
    $r.exited = [bool](WaitOwned $p ($ms - $t.ElapsedMilliseconds))
    if (-not $r.exited) { $r.reason = 'deadline; exit NOT confirmed (the final cleanup retries; the stage is kept until confirmed)' } }
  $r }
# the always-run cleanup of every REGISTERED own child (never any other process): kill what still runs, confirm each exit (bounded)
function CleanupOwned([double]$ms) {
  $t = [Diagnostics.Stopwatch]::StartNew(); $res = @()
  foreach ($c in @($script:Owned)) { $x = [ordered]@{ role = $c.role; pid = $c.pid; exited = $false }; $done = WaitOwned $c.proc 0
    if (-not $done) { try { KillOwned $c.proc } catch { $x.killError = $_.Exception.Message }; $done = WaitOwned $c.proc ([math]::Min(5000, $ms - $t.ElapsedMilliseconds)) }
    $x.exited = [bool]$done; $res += $x }
  $all = -not @($res | Where-Object { -not $_.exited }).Count
  try { RegLine ([ordered]@{ cleanup = 'fixture'; allExited = $all; children = @($res).Count }) } catch {}
  [ordered]@{ allExited = $all; children = $res } }
function Need($sec, $what) { if ((Left) -lt $sec) { throw "deadline: $what needs $sec s, $([math]::Floor((Left))) s left" } }

try {
  RegLine ([ordered]@{ role = 'fixture'; pid = $PID; start = (StartUtc (Get-Process -Id $PID)) })
  $pin = [ordered]@{}; foreach ($k in $PINS.Keys) { $pin[$k] = ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Stage $k)).Hash.ToLower() -eq $PINS[$k]) }
  $out.pins = $pin; if (@($pin.Values | Where-Object { -not $_ }).Count) { throw 'staged bytes are not the pinned files' }
  $parse = [ordered]@{}; $asts = @{}
  foreach ($k in 'chact.ps1', 'node-hold-cutover.ps1', 'native-challenge-test.ps1') { $tk = $null; $er = $null; $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Stage $k), [ref]$tk, [ref]$er); $parse[$k] = $er.Count }
  $out.parseErrors = $parse; $out.psVersion = $PSVersionTable.PSVersion.ToString(); if (@($parse.Values | Where-Object { $_ }).Count) { throw 'parse errors' }
  # the reuse list exactly as the activation script declares it: every name exists ONCE in the pinned cutover
  $reuseAst = @($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.ForEachStatementAst] -and $x.Variable.VariablePath.UserPath -eq 'fn' }, $true))[0]
  $names = @($reuseAst.Condition.FindAll({ param($x) $x -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
  $found = @($names | Where-Object { @($asts['node-hold-cutover.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $_ }.GetNewClosure(), $true)).Count -eq 1 })
  $out.reuse = [ordered]@{ names = $names.Count; foundOnceInCutover = $found.Count }
  foreach ($fn in $names) { . ([scriptblock]::Create(@($asts['node-hold-cutover.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true))[0].Extent.Text)) }
  foreach ($fn in 'DeclState', 'Owner', 'ReplicaChildren', 'Alive', 'StopOrphans', 'ReadJ', 'Live', 'IdsState') { . ([scriptblock]::Create(@($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true))[0].Extent.Text)) }
  $TR = ''; $Fwd = $false; $script:QueryCleanupFailed = $false
  $REL = Join-Path $Stage 'release-fixture'; [void][IO.Directory]::CreateDirectory($REL)

  # ---- 1 Owner: THIS fixture's own loopback listener, read through the bounded reader
  Need 10 'owner'
  $ls = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $ls.Start(); $port = ([Net.IPEndPoint]$ls.LocalEndpoint).Port
  try { $ow = Owner $port } finally { $ls.Stop() }
  $own = [ordered]@{ port = $port; pid = $ow.pid; isFixture = ($ow.pid -eq $PID); name = $ow.name; afterStopAbsent = ($null -eq (Owner $port)) }
  $out.owner = $own; $ownOk = $own.isFixture -and $own.afterStopAbsent

  # ---- 2 ReplicaChildren / StopOrphans: an own node child with the replica shape, plus a decoy; only the former is stopped by the
  #      function under test. Both are registered at spawn: a decoy-spawn failure still leaves the replica to the final cleanup.
  Need 45 'orphans'
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $NodeExe).Hash.ToLower() -ne $NodeSha) { throw 'node.exe is not the root-proven binary' }
  $rep = Spawn 'replica' $NodeExe @('-e', 'setTimeout(()=>{},90000)', (Join-Path $REL 'dns.mjs')) $false
  $decoy = Spawn 'decoy' $NodeExe @('-e', 'setTimeout(()=>{},90000)', 'decoy.mjs') $false
  Start-Sleep -Seconds 1
  # the query is parent-scoped (only THIS fixture's children) and the stop must be PROVEN by PID+start absence (bounded)
  $kids = @(ReplicaChildren $PID); $st = StopOrphans $PID 30
  $orph = [ordered]@{ found = $kids.Count; foundIsReplica = ($kids.Count -eq 1 -and $kids[0].pid -eq $rep.Id); provenGone = [bool]$st.gone; alive = @($st.alive).Count
    stopErrors = @($st.stopErrors).Count; replicaExited = $rep.HasExited; decoyAlive = -not $decoy.HasExited; afterwards = @(ReplicaChildren $PID).Count }
  $out.orphans = $orph; $orphOk = $orph.foundIsReplica -and $orph.provenGone -and $orph.alive -eq 0 -and $orph.replicaExited -and $orph.decoyAlive -and $orph.afterwards -eq 0

  # ---- 3 the reviewed edit helper under the native node.exe on a SYNTHETIC config, argv as the activation script passes it, run as a
  #      BOUNDED own child (remaining-deadline accounting, confirmed exit)
  Need 15 'render'
  $synCfg = Join-Path $Stage 'synthetic-privacy-config.json'; $outF = Join-Path $Stage 'synthetic-out.json'
  $syn = '{' + "`n" + '  "version": 2,' + "`n" + '  "chain": {' + "`n" + '    "rpc": [' + "`n" + '      "https://mainnet.base.org"' + "`n" + '    ]' + "`n" + '  },' + "`n" + '  "enclaveNetwork": {' + "`n" + '    "relay": "r",' + "`n" + '    "walletAdmission": {' + "`n" + '      "file": "C:\\w.json"' + "`n" + '    }' + "`n" + '  }' + "`n" + '}' + "`n"
  [IO.File]::WriteAllText($synCfg, $syn); $cs = (Get-FileHash -Algorithm SHA256 -LiteralPath $synCfg).Hash.ToLower()
  $ed = RunOwned 'edit' $NodeExe @((Join-Path $Stage 'edit-privacy-config.mjs'), $synCfg, $outF, (Join-Path $Stage 'challengeReplica.json'), $cs, $PINS['challengeReplica.json']) ([int][math]::Min(60000, 1000 * (Left)))
  $render = [ordered]@{ ok = $ed.ok; exit = $ed.exit; timedOut = $ed.timedOut; exited = $ed.exited; reason = $ed.reason }
  if ($ed.ok -and $ed.exit -eq 0) {
    $rj = @(@($ed.stdout -split "`r?`n") | Where-Object { $_ -like '{*' })[-1] | ConvertFrom-Json; $keys = @($rj.enclaveNetworkKeys)
    $render.lastTwo = ($keys[-2] + ',' + $keys[-1]); $render.shaMatches = ((Get-FileHash -Algorithm SHA256 -LiteralPath $outF).Hash.ToLower() -eq [string]$rj.after)
    $render.rpcKept = ((([IO.File]::ReadAllText($outF) | ConvertFrom-Json).chain.rpc -join ',') -eq 'https://mainnet.base.org') }
  $out.render = $render; $renderOk = $ed.ok -and $ed.exit -eq 0 -and $render.lastTwo -eq 'challengeReplica,walletAdmission' -and $render.shaMatches -and $render.rpcKept

  # ---- 4 DeclState on a SYNTHETIC serving declaration: state/pid only, the proof key never leaves
  Need 5 'declaration'
  $DECL = Join-Path $Stage 'synthetic-front.json'; [IO.File]::WriteAllText($DECL, '{"version":1,"state":"serving","pid":4242,"proofKey":"FIXTURE-PROOF-KEY","release":{"dnsSha256":"3e1560f9"},"expiresAt":1}')
  $d = DeclState; $declOk = $d.state -eq 'serving' -and $d.pid -eq 4242 -and -not ((ConvertTo-Json -InputObject $d -Compress) -like '*FIXTURE-PROOF-KEY*')
  $out.declaration = [ordered]@{ state = $d.state; pid = $d.pid; proofKeyAbsent = $declOk }

  # ---- 5 r3 IdsState: the EXACT verdict function over SYNTHETIC files in this stage, written as JSON text (as node writes them) and read
  #      back by PS 5.1 ConvertFrom-Json (Int64 deadlines, bool vs "true", null, JSON-escaped Windows paths). The node host-state reader is
  #      replaced by a synthetic projection parsed the way Query returns it (ConvertFrom-Json of a one-element array); 9600 is never read.
  Need 10 'ids'
  $IDD = Join-Path $Stage 'ids-fixture'; $STATE = Join-Path $IDD 'state'; [void][IO.Directory]::CreateDirectory($STATE)
  $WALLET = Join-Path $IDD 'wallet-admission.json'; $CFG = Join-Path $IDD 'ids-privacy-config.json'
  $RUNNER = '0x' + ('ab' * 32); $FIDS = @(('0x' + ('1' * 64)), ('0x' + ('2' * 64)), ('0x' + ('3' * 64)))
  $PRM = [pscustomobject]@{ runner = $RUNNER; expectedIds = $FIDS }; $WANT = @($FIDS)
  function HostRows($limitSec) { $script:HOSTSTUB }
  function IdsCase($name, [hashtable]$c) {
    $n = NowMs; $ns = NowS; $al = @(); $ap = @(); $hr = @(); $eg = @(); $apps = @()
    foreach ($i in $FIDS) { $k = $i.Substring(2, 1); $ef = Join-Path $IDD "expect-$k.json"
      [IO.File]::WriteAllText($ef, '{"appRef":"app-' + $k + '","configCid":"bafy-' + $k + '"}')
      $apps += '{"deploymentId":"' + $i + '","expectedFile":' + (ConvertTo-Json -InputObject $ef -Compress) + '}'
      $ar = $(if ($c.appRef -eq $i) { 'app-OTHER' } else { "app-$k" }); $vu = $(if ($c.validUntil -eq $i) { $n - 1000 } else { $n + 60000 })
      $al += '"' + $i + '":{"appRef":"' + $ar + '","configCid":"bafy-' + $k + '","validUntil":' + $vu + '}'
      $ap += '{"deploymentId":"' + $i + '","walletUntil":' + ($n + 600000) + ',"leaseUntil":' + ($n + 600000) + ',"proofUntil":' + ($n + 600000) + '}'
      $eg += '"' + $i + '":{"proxies":["127.0.0.1:1"],"dns":["1.1.1.1"]}'
      $hr += '{"id":"' + $i + '","status":"running","leaseUntil":' + ($ns + 3600) + ',"walletHeld":' + $(if ($c.held -eq $i) { 'true' } else { 'false' }) + '}' }
    [IO.File]::WriteAllText($CFG, '{"version":2,"apps":[' + ($apps -join ',') + ']}')
    [IO.File]::WriteAllText($WALLET, '{"version":1,"runner":"' + $RUNNER + '","generation":"g7","revision":5,"expiresAt":' + ($n + 30000) + ',"allows":{' + ($al -join ',') + '}}')
    $fr = $(if ($c.fresh) { $c.fresh } else { 'true' }); $up = $(if ($c.future) { $n + 60000 } else { $n - 500 })
    [IO.File]::WriteAllText((Join-Path $STATE 'status.json'), '{"version":2,"updatedAt":' + $up + ',"walletAdmission":{"runner":"' + $RUNNER + '","generation":"g7","revision":5,"fresh":' + $fr +
      ',"applied":true,"error":null,"expiresAt":' + ($n + 30000) + ',"allows":["' + ($FIDS -join '","') + '"]},"apps":[' + ($ap -join ',') + ']}')
    [IO.File]::WriteAllText((Join-Path $STATE 'egress-routes.json'), '{"version":1,"expiresAt":' + ($n + 30000) + ',"apps":{' + ($eg -join ',') + '}}')
    $script:HOSTSTUB = ConvertFrom-Json ('[{"deployments":[' + ($hr -join ',') + ']}]')
    $v = IdsState
    [ordered]@{ case = $name; ok = [bool]$v.ok; bad = ((@($v.channelBad) + @($v.idsBad | ForEach-Object { $_.id.Substring(0, 3) + ':' + ($_.bad -join '+') })) -join ',') } }
  $expect = [ordered]@{ normal = ''; wrongBinding = '0x1:appRef'; expiredGrant = '0x2:validUntil'; futureStatus = 'statusAge'; freshFalse = 'fresh'; freshString = 'fresh'; walletHeld = '0x3:notHeld' }
  $cases = @((IdsCase 'normal' @{}), (IdsCase 'wrongBinding' @{ appRef = $FIDS[0] }), (IdsCase 'expiredGrant' @{ validUntil = $FIDS[1] }), (IdsCase 'futureStatus' @{ future = $true }),
             (IdsCase 'freshFalse' @{ fresh = 'false' }), (IdsCase 'freshString' @{ fresh = '"true"' }), (IdsCase 'walletHeld' @{ held = $FIDS[2] }))
  foreach ($x in $cases) { $x.expected = ($x.bad -eq $expect[$x.case] -and $x.ok -eq ($x.case -eq 'normal')) }
  $out.ids = $cases; $idsOk = ($cases.Count -eq $expect.Count -and -not @($cases | Where-Object { -not $_.expected }).Count)

  $out.reuseOk = ($out.reuse.names -eq $out.reuse.foundOnceInCutover -and $out.reuse.names -ge 30)
} catch { $out.error = 'fixture error: ' + $_.Exception.Message }
finally {
  $cl = CleanupOwned ([math]::Max(3000, 1000 * ($BOUND - $sw.Elapsed.TotalSeconds)))
  $out.children = $cl; $out.queryCleanupFailed = [bool]$script:QueryCleanupFailed
  $out.ok = [ordered]@{ owner = [bool]$ownOk; orphans = [bool]$orphOk; render = [bool]$renderOk; declaration = [bool]$declOk; ids = [bool]$idsOk; reuse = [bool]$out.reuseOk; childrenExited = [bool]$cl.allExited }
  $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $out.notProven = 'No production entity is touched: no real privacy-config edit, privacy restart, replica start, route-dns merge or service-tls fronting is proven here; IdsState is proven on synthetic files only (the 9600 host-state reader HostRows is not exercised).'
  $out.pass = [bool](-not $out.error -and $ownOk -and $orphOk -and $renderOk -and $declOk -and $idsOk -and $out.reuseOk -and $cl.allExited -and -not $script:QueryCleanupFailed -and $sw.Elapsed.TotalSeconds -le $BOUND)
  $out | ConvertTo-Json -Compress -Depth 6
}
if (-not $out.pass) { exit 3 }
