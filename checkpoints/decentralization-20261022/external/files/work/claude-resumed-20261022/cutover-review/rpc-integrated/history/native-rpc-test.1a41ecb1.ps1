# rpc-integrated NATIVE fixture (ROOT-ONLY; Windows PowerShell 5.1). Exercises the EXACT functions/assignments of the staged
# rpc-integrated cutover (AST-extracted, never re-typed): RunNodeEdit, ShaBytes, Sha, ProtectedTemp, CasWrite, RestoreOne, the
# $RPC5/$RPC_L12/$RPC_L5/$LATIN1 constants and the pre-stop renderer $js.
# LIVE READS ONLY: run-node.cmd bytes (in memory: plan + hashes + line numbers; never written, copied or printed) and its SDDL.
# WRITES ONLY inside -Stage: a SYNTHETIC launcher skeleton (no live content) for the CAS write/restore round trip, and a SYNTHETIC
# privacy config for the native node.exe render. No task, process, service, VM or live config is touched.
param([string]$Stage, [string]$RunNodePath = 'C:\ProgramData\Enclave\run-node.cmd', [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
      [string]$NodeSha = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3', [switch]$LocalMock,
      [string]$ExpectOld = '3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686', [string]$ExpectNew = '0fdc3699228c9d7a4c2e971d05804b49f978a56a4c1d9f7a06f3546f3ced09fd')
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $sw = [Diagnostics.Stopwatch]::StartNew(); $BOUND_SEC = 120
$out = [ordered]@{ pass = $false; readOnlyLive = $true; boundSec = $BOUND_SEC }
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
$CUT_PIN = 'b3869dd0c82338c687825678935e4f103a1118442bdc0e0f4640a1f7888d64a7'
$OLD = $ExpectOld; $NEW = $ExpectNew; if (-not $LocalMock -and ($OLD -ne '3366a005f8530903c83a334053280f41ed904df09133e92505c44f558acb6686' -or $NEW -ne '0fdc3699228c9d7a4c2e971d05804b49f978a56a4c1d9f7a06f3546f3ced09fd')) { throw 'the live pins are fixed outside -LocalMock' }
foreach ($n in 'Stop-Process','Start-Process','Start-ScheduledTask','Stop-ScheduledTask','Register-ScheduledTask','Unregister-ScheduledTask','Stop-Service','Start-Service','Restart-Service','Stop-VM','Start-VM') {
  . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n is forbidden in this fixture' }")) }
function Bound($what) { if ($sw.Elapsed.TotalSeconds -gt $BOUND_SEC) { throw "fixture bound $BOUND_SEC s exceeded before $what" } }
$src = Join-Path $Stage 'cutover.ps1'
$h = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLower(); $out.cutoverPinned = ($h -eq $CUT_PIN); if (-not $out.cutoverPinned -and -not $LocalMock) { throw 'staged cutover is not the pinned bytes' }
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($src, [ref]$tk, [ref]$er); $out.parseErrors = $er.Count; $out.psVersion = $PSVersionTable.PSVersion.ToString()
if ($er.Count) { throw 'cutover parse errors' }
foreach ($fn in 'ShaBytes','RunNodeEdit','Sha','ProtectedTemp','CasWrite','RestoreOne','NeedForward') {
  $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true)); if ($f.Count -ne 1) { throw "missing $fn" }
  . ([scriptblock]::Create($f[0].Extent.Text)) }
foreach ($v in '$RPC5','$RPC_L12','$RPC_L5','$LATIN1','$js') {
  $a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq $v }, $true)); if ($a.Count -ne 1) { throw "missing $v" }
  . ([scriptblock]::Create($a[0].Extent.Text)) }
$Fwd = $false; $TR = ''

# ---- 1 LIVE launcher, read-only: the exact in-memory plan the cutover makes before its stop
Bound 'live plan'
$PRM = [pscustomobject]@{ runNodeNewSha = $NEW }
$raw = [IO.File]::ReadAllBytes($RunNodePath); $live = [ordered]@{ sha = (ShaBytes $raw); bytes = $raw.Length }
$live.latin1RoundTripExact = ((ShaBytes ($LATIN1.GetBytes($LATIN1.GetString($raw)))) -eq $live.sha)
$e = RunNodeEdit $raw; $live.plan = [ordered]@{ ok = $e.ok; why = $e.why; line12 = $e.line12; line5 = $e.line5; removed = $e.removed; newSha = $e.newSha }
$raw = $null; $e = $null                                          # live bytes dropped; nothing of them leaves this process
if (-not $LocalMock) { $sd = (Get-Acl -LiteralPath $RunNodePath).Sddl; $live.sddl = $sd; $live.daclAutoInherited = ([regex]::Match($sd, 'D:([A-Z]*)\(').Groups[1].Value -match 'AI') }
$out.live = $live
$liveOk = $live.sha -eq $OLD -and $live.latin1RoundTripExact -and $live.plan.ok -and $live.plan.newSha -eq $NEW -and $live.plan.removed -eq 96 -and ($LocalMock -or $live.daclAutoInherited)

# ---- 2 SYNTHETIC launcher in the stage: CAS write of the planned edit, then the revert's RestoreOne (+ a refused foreign change)
Bound 'stage CAS'
$skel = @('@echo off', 'call C:\ProgramData\Enclave\node-config.cmd', 'cd /d "C:\Program Files\Enclave\control"', ':loop', $RPC_L5) + @(0..5 | ForEach-Object { "set ENCLAVE_SETTING_$_=x" }) +
        @($RPC_L12, '"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"', 'echo node exited', 'ping -n 6 127.0.0.1 >nul', 'goto loop')
$sb = $LATIN1.GetBytes((($skel -join "`r`n") + "`r`n")); $RUNNODE = Join-Path $Stage 'run-node.cmd'; [IO.File]::WriteAllBytes($RUNNODE, $sb)
$so = ShaBytes $sb; $PRM = [pscustomobject]@{ runNodeNewSha = (ShaBytes $LATIN1.GetBytes((($skel -join "`r`n") + "`r`n").Replace($RPC_L12 + "`r`n", ''))) }
$bk = Join-Path $Stage 'run-node.cmd.before'; [IO.File]::WriteAllBytes($bk, $sb)
$cas = [ordered]@{}; $pe = RunNodeEdit $sb; $cas.planOk = $pe.ok
$w = CasWrite $RUNNODE $so $pe.bytes; $cas.writeAfterIsNew = ($w.after -eq [string]$PRM.runNodeNewSha); $cas.writeAclKept = [bool]$w.aclKept
$before = @{ runNode = @{ before = $so; after = $w.after; backup = $bk } }
$cas.restore = RestoreOne 'runNode'; $cas.restoredBytesExact = ((Sha $RUNNODE) -eq $so)
$cas.casRefusesStale = $(try { $null = CasWrite $RUNNODE $w.after $pe.bytes; $false } catch { $_.Exception.Message -like 'CAS refused*' })
[IO.File]::WriteAllBytes($RUNNODE, $pe.bytes); [IO.File]::AppendAllText($RUNNODE, "rem operator`r`n")
$cas.foreignChangeRefused = ((RestoreOne 'runNode') -like 'REFUSED: the file is neither*')
$cas.noTempLeft = (@(Get-ChildItem -LiteralPath $Stage -Force | Where-Object { $_.Name -like '*.nh-*' }).Count -eq 0)
$out.stageCas = $cas
$casOk = $cas.planOk -and $cas.writeAfterIsNew -and $cas.writeAclKept -and $cas.restore -eq 'restored' -and $cas.restoredBytesExact -and $cas.casRefusesStale -and $cas.foreignChangeRefused -and $cas.noTempLeft

# ---- 3 the pre-stop render with the NATIVE node.exe on a SYNTHETIC config: chain.rpc = the 5, walletAdmission last, nothing else
Bound 'render'
$rend = [ordered]@{ nodeSha = $(if (Test-Path -LiteralPath $NodeExe) { (Get-FileHash -Algorithm SHA256 -LiteralPath $NodeExe).Hash.ToLower() } else { 'absent' }) }
if (-not $LocalMock -and $rend.nodeSha -ne $NodeSha) { throw 'node.exe is not the root-proven binary' }
$cfgIn = Join-Path $Stage 'synthetic-config.json'; $cfgOut = Join-Path $Stage 'synthetic-config.out.json'; $wal = Join-Path $Stage 'wallet-admission.json'
$syn = [ordered]@{ version = 2; directory = 'x'; apps = @(); chain = [ordered]@{ addressBook = '0xab'; rpc = @('https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org') }; upstream = 'u'
                   enclaveNetwork = [ordered]@{ relay = 'r'; checkers = @('0x' + ('12' * 20)); apps = 'all'; control = $true } }
[IO.File]::WriteAllText($cfgIn, ($syn | ConvertTo-Json -Depth 6))
$ea = $ErrorActionPreference; try { $ErrorActionPreference = 'Continue'; $null = & $NodeExe -e $js $cfgIn $cfgOut $wal ($RPC5 -join ',') 2>&1; $rc = $LASTEXITCODE } finally { $ErrorActionPreference = $ea }
$rend.exitCode = $rc
if ($rc -eq 0) { $r = [IO.File]::ReadAllText($cfgOut) | ConvertFrom-Json
  $rend.chainRpcIsThe5InOrder = ((@($r.chain.rpc) -join ',') -eq ($RPC5 -join ',')); $rend.addressBookKept = ($r.chain.addressBook -eq '0xab')
  $rend.walletLast = ((@($r.enclaveNetwork.PSObject.Properties.Name) | Select-Object -Last 1) -eq 'walletAdmission' -and $r.enclaveNetwork.walletAdmission.file -eq $wal)
  $rend.topKeysKept = ((@($r.PSObject.Properties.Name) -join ',') -eq 'version,directory,apps,chain,upstream,enclaveNetwork') }
$out.render = $rend
$renderOk = $rc -eq 0 -and $rend.chainRpcIsThe5InOrder -and $rend.addressBookKept -and $rend.walletLast -and $rend.topKeysKept
$out.liveOk = [bool]$liveOk; $out.casOk = [bool]$casOk; $out.renderOk = [bool]$renderOk; $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$out.notProven = 'No task, process, live config or the full cutover ran: this proves the byte edit, CAS/ACL round trip and native render only.'
$out.pass = [bool]($liveOk -and $casOk -and $renderOk -and $sw.Elapsed.TotalSeconds -le $BOUND_SEC)
$out | ConvertTo-Json -Compress -Depth 6
if (-not $out.pass) { exit 3 }
