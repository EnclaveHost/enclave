# native-win (rev4): what can be proven NATIVELY on minipc about the host-service DNS path, each part labelled exactly.
# Prepared by e49 for ROOT to run ONCE as Administrator; e49 never runs it remotely. UNTESTED HERE (no PowerShell on the
# dev host): root reviews before running.
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-udp-fixture.ps1 -NewWgExe <new enclave-wg.exe> `
#     -WgTestExe <wg-udp-test.exe> -NodeExe <node.exe the agent uses> -Peer <a public DO provider guard ip:port> [-ReadOnly]
# COVERAGE (and what it is NOT):
#   R  read-only: binary hashes; every INSTALLED circuit policy grants no loopback UDP. Production is only read.
#   E1 POLICY ACCEPTANCE ONLY: the exact tunnel-mode policy wg-circuit-runtime circuitFirewallPolicies emits for a DNS
#      service circuit (UDP only to -Peer; loopback TCP incl. 127.0.0.1:18153) installs with the new enclave-wg.exe as the
#      program file, its OWN filters (the IDs in its manifest) appear and then disappear on remove; the rev2 loopback-UDP
#      shape is refused. The new binary is NOT executed in E1.
#   E2 SANDBOX GRANT SEMANTICS with node.exe (NOT the new binary): inside a real circuit AppContainer + WFP policy with one
#      granted loopback TCP port, TCP to it works, TCP to another loopback port and UDP to the granted port are blocked.
#   E3 THE NEW RELAY CODE, NATIVELY, UNSANDBOXED: wg-udp-test.exe (the network/wg tests, Windows build of the same source as
#      the new enclave-wg.exe) runs TestUDPIngress* - UDP 53 framed onto loopback TCP, two queries in flight from one
#      sender, EDNS/512 truncation, flood eviction - on real Windows sockets. In-process WireGuard devices, no peer, no
#      provider, no sandbox (its devices talk over loopback UDP, which a circuit sandbox forbids).
#   NOT COVERED (the remaining combined gate): the new enclave-wg.exe INSIDE the sandbox carrying DNS over a real tunnel.
#      The firewall admits only a PUBLIC WireGuard peer, so this needs a live provider: root's bounded canary at activation
#      (A5, one provider pinned to minipc; the provider's dns-probe log reads "answering"; dig @<front> is answered).
# Ephemeral state lives under "$env:ProgramData\Enclave\native win <random>" (a path WITH SPACES, to exercise quoting).
# Cleanup removes exactly the policies this script installed. A directory is deleted ONLY if it holds no firewall.json or
# its remove was verified; any other (remove failed, manifest unreadable, a throw before tracking, a timed-out process not
# confirmed stopped) is KEPT as the receipt and reported FAIL.
# Exit: 0 all PASS, 1 a FAIL, 2 refused.
param([Parameter(Mandatory)][string]$NewWgExe, [Parameter(Mandatory)][string]$WgTestExe, [Parameter(Mandatory)][string]$NodeExe,
      [Parameter(Mandatory)][string]$Peer, [string]$FirewallExe = "$env:ProgramFiles\Enclave\network\enclave-circuit-firewall.exe",
      [string]$CircuitRoot = "$env:ProgramData\Enclave\network\state\network-circuits", [switch]$ReadOnly)
$ErrorActionPreference = 'Stop'
$script:failed = 0
function Pass($m) { Write-Output "PASS $m" }
function Fail($m) { Write-Output "FAIL $m"; $script:failed = 1 }
function Refuse($m) { Write-Output "REFUSED: $m"; [Environment]::Exit(2) }
# CommandLineToArgvW quoting: each argument survives spaces, quotes and trailing backslashes exactly
function Quote-Arg([string]$a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $sb = New-Object System.Text.StringBuilder; [void]$sb.Append('"'); $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq [char]92) { $bs++; continue }
    if ($ch -eq [char]34) { [void]$sb.Append([string]::new([char]92, 2 * $bs + 1)); [void]$sb.Append([char]34); $bs = 0; continue }
    if ($bs) { [void]$sb.Append([string]::new([char]92, $bs)); $bs = 0 }
    [void]$sb.Append($ch) }
  [void]$sb.Append([string]::new([char]92, 2 * $bs)); [void]$sb.Append([char]34); return $sb.ToString() }
function Start-Native([string]$exe, [string[]]$argv) {   # throws if it cannot start (fatal for the caller)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (@($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi); if (-not $p) { throw "could not start $exe" }
  return @{ p = $p; o = $p.StandardOutput.ReadToEndAsync(); e = $p.StandardError.ReadToEndAsync() } }
$script:stuck = @()   # timed-out processes that could not be confirmed stopped: cleanup then deletes nothing
function Stop-Tree($h, [string]$what) {   # kill THIS process and its children (taskkill /T), then WAIT until it is gone
  try { $k = Start-Native "$env:SystemRoot\System32\taskkill.exe" @('/T', '/F', '/PID', "$($h.p.Id)"); [void]$k.p.WaitForExit(15000) } catch {}
  try { if (-not $h.p.HasExited) { $h.p.Kill() } } catch {}
  if (-not $h.p.WaitForExit(30000)) { $script:stuck += $what; Fail "timeout: $what (pid $($h.p.Id)) not confirmed stopped" } }
function Run([string]$exe, [string[]]$argv, [int]$sec = 30) {    # -> @{code; out}; a timeout is code -9 (tree killed, waited for)
  $h = Start-Native $exe $argv
  # Stop-Tree's FAIL line goes to the host, never into this function's return value
  if (-not $h.p.WaitForExit($sec * 1000)) { Stop-Tree $h ("$exe " + ($argv -join ' ')) | Out-Host; return @{ code = -9; out = "TIMEOUT after $sec s" } }
  $h.p.WaitForExit(); return @{ code = $h.p.ExitCode; out = ($h.o.Result + $h.e.Result) } }
function WfpXml { $f = Join-Path $env:TEMP ("wfp-" + [guid]::NewGuid() + ".xml")
  $r = Run "$env:SystemRoot\System32\netsh.exe" @('wfp', 'show', 'filters', "file=$f") 120
  if ($r.code -ne 0) { throw "netsh wfp show filters exit $($r.code)" }
  $x = [IO.File]::ReadAllText($f); Remove-Item -LiteralPath $f -Force; return $x }
function Exempt { return (Run "$env:SystemRoot\System32\CheckNetIsolation.exe" @('LoopbackExempt', '-s') 60).out }
function Owned([string]$manifest) {   # this fixture's OWN filter ids and AppContainer SID, from its manifest (throws if unreadable)
  $m = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
  if ($null -eq $m -or $null -eq $m.rules) { throw "no rules list in $manifest" }   # never let $null become one empty id
  return @{ ids = @(@($m.rules) | Where-Object { "$_" } | ForEach-Object { ("$_" -replace '[{}]', '').ToLower() }); sid = "$($m.appContainerSid)" } }
function Track([string]$d) {   # record ANY manifest an install left, readable or not ($null = unreadable: remove is still tried, never verified)
  if (-not (Test-Path -LiteralPath "$d\firewall.json")) { return }
  try { $owned[$d] = Owned "$d\firewall.json" } catch { $owned[$d] = $null; Fail "manifest $d\firewall.json unreadable ($_): its removal cannot be verified; the directory will be kept" } }
function OwnedPresent($own) { $x = (WfpXml).ToLower(); return @($own.ids | Where-Object { $x.Contains($_) }).Count }
function FreePort { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p }
function Hex32 { -join ((1..16) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
function WriteJson($path, $obj) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8 -Compress)) }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Refuse 'run as Administrator (the firewall tool installs WFP filters)' }
foreach ($f in @($NewWgExe, $WgTestExe, $NodeExe, $FirewallExe, "$PSScriptRoot\probe.mjs", "$PSScriptRoot\listener.mjs")) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Refuse "missing $f" } }
if ($Peer -notmatch '^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$') { Refuse '-Peer must be a public IPv4 ip:port' }
# quoting self-check (a native parser, node, must see exactly these arguments) - before anything is installed
$want = @('C:\Program Files\x y\z.exe', 'quote"inside', 'trail\', 'a b\\', '')
try { $r = Run $NodeExe (@('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $want) 30 } catch { Refuse "cannot launch $NodeExe : $_" }
if ($r.code -ne 0 -or $r.out -ne ($want | ConvertTo-Json -Compress)) { Refuse "argument quoting self-check failed: $($r.out)" }
Pass 'argument quoting: a native parser sees paths with spaces, quotes and trailing backslashes exactly'

# ---- R: read-only
foreach ($f in @($NewWgExe, $WgTestExe, $FirewallExe, $NodeExe, "$env:ProgramFiles\Enclave\network\enclave-wg.exe")) {
  if (Test-Path -LiteralPath $f) { Write-Output ("HASH {0} {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower(), $f) } }
$loopUdp = 0; $tunnels = 0
if (Test-Path -LiteralPath $CircuitRoot) {
  foreach ($c in Get-ChildItem -LiteralPath $CircuitRoot -Recurse -Filter 'firewall-config.json' -ErrorAction SilentlyContinue) {
    $j = Get-Content -Raw -LiteralPath $c.FullName | ConvertFrom-Json
    if ($j.tunnel) { $tunnels++ }
    foreach ($p in $j.programs) { foreach ($u in @($p.udp)) { if ("$u" -like '127.*') { $loopUdp++ } } } } }
Write-Output "NOTE installed circuit policies (read only): $tunnels tunnel-mode under $CircuitRoot"
if ($loopUdp -eq 0) { Pass 'R no installed circuit policy grants loopback UDP' } else { Fail "R $loopUdp loopback UDP grant(s) installed" }

# ---- E3 first (no install, no sandbox): the NEW relay code on real Windows sockets
$r = Run $WgTestExe @('-test.run', '^TestUDPIngress', '-test.v', '-test.count', '1', '-test.timeout', '120s') 150
$passes = @([regex]::Matches($r.out, '--- PASS: (TestUDPIngress\w+)') | ForEach-Object { $_.Groups[1].Value })
if ($r.code -eq 0 -and $passes.Count -ge 7 -and $r.out -notmatch '--- FAIL') { Pass ("E3 the new relay code natively on Windows ({0} tests): {1}" -f $passes.Count, ($passes -join ', ')) }
else { Fail "E3 wg-udp-test.exe exit $($r.code): $($r.out.Substring([Math]::Max(0, $r.out.Length - 600)))" }
if ($ReadOnly) { Write-Output "READONLY-RC=$script:failed"; [Environment]::Exit($script:failed) }

$root = Join-Path $env:ProgramData ("Enclave\native win " + (Hex32).Substring(0, 12)); $mine = @(); $listener = $null; $owned = @{}; $clean = @{}
try {
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'root-owned-fixture.txt'), $root) # ROOT recovery locator, before any fixture objects
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $ports = 1..5 | ForEach-Object { FreePort }
  # ---- E1: policy acceptance of the new binary's exact DNS service-circuit policy (not executed)
  $d1 = Join-Path $root ("enclave-circuit-" + (Hex32)); New-Item -ItemType Directory -Path $d1 | Out-Null; $mine += $d1
  Copy-Item -LiteralPath $NewWgExe -Destination "$d1\enclave-wg.exe"
  WriteJson "$d1\firewall-config.json" @{ directory = $d1; appContainer = $true; tunnel = $true; programs = @(@{ path = "$d1\enclave-wg.exe"; udp = @($Peer);
    connect = @("127.0.0.1:$($ports[0])", "127.0.0.1:$($ports[1])", '127.0.0.1:18153'); listen = @($ports[2], $ports[3], $ports[4]) }) }
  $r = Run $FirewallExe @('install', "$d1\firewall-config.json") 60
  Track $d1   # whatever the exit code: a failed install that wrote its manifest may have added filters
  if ($r.code -eq 0 -and $owned[$d1]) {
    $n = OwnedPresent $owned[$d1]
    if ($owned[$d1].ids.Count -gt 0 -and $n -eq $owned[$d1].ids.Count) { Pass "E1 the DNS service-circuit tunnel policy installs; all $n of ITS filters are present" } else { Fail "E1 owned filters present $n of $($owned[$d1].ids.Count)" }
  } else { Fail "E1 install exit $($r.code): $($r.out.Substring(0, [Math]::Min(400, $r.out.Length)))" }
  if ($owned.ContainsKey($d1)) {   # remove only what a manifest records; an install that wrote none added nothing
    $r = Run $FirewallExe @('remove', "$d1\firewall.json") 60
    if ($r.code -eq 0 -and $owned[$d1] -and (OwnedPresent $owned[$d1]) -eq 0) { Pass 'E1 removed: none of its filters remain'; $clean[$d1] = $true; $owned.Remove($d1) } else { Fail "E1 remove exit $($r.code) / filters left or unverifiable (finally retries, then keeps it)" } }
  # the rev2 shape (loopback UDP for DNS) is refused and leaves no manifest
  $d1n = Join-Path $root ("enclave-circuit-" + (Hex32)); New-Item -ItemType Directory -Path $d1n | Out-Null; $mine += $d1n
  Copy-Item -LiteralPath $NewWgExe -Destination "$d1n\enclave-wg.exe"
  WriteJson "$d1n\firewall-config.json" @{ directory = $d1n; appContainer = $true; tunnel = $true; programs = @(@{ path = "$d1n\enclave-wg.exe"; udp = @($Peer, '127.0.0.1:18153'); connect = @(); listen = @($ports[2]) }) }
  $r = Run $FirewallExe @('install', "$d1n\firewall-config.json") 60
  if ($r.code -ne 0 -and -not (Test-Path -LiteralPath "$d1n\firewall.json")) { Pass 'E1 a loopback-UDP grant is refused and installs nothing (why UDP 53 is framed onto TCP)' }
  else { Fail "E1 loopback UDP accepted (exit $($r.code))"; Track $d1n }
  # ---- E2: AppContainer + WFP grant semantics, observed from inside a sandbox (node.exe as worker.exe, NOT the new binary)
  $g = FreePort; $o = FreePort
  $listener = Start-Native $NodeExe @("$PSScriptRoot\listener.mjs", "$g", "$o")
  Start-Sleep -Milliseconds 800
  if ($listener.p.HasExited) { throw "the loopback listener exited at start: $($listener.e.Result)" }
  $d2 = Join-Path $root ("enclave-circuit-" + (Hex32)); New-Item -ItemType Directory -Path $d2 | Out-Null; $mine += $d2
  Copy-Item -LiteralPath $NodeExe -Destination "$d2\worker.exe"; Copy-Item -LiteralPath "$PSScriptRoot\probe.mjs" -Destination "$d2\probe.mjs"
  WriteJson "$d2\firewall-config.json" @{ directory = $d2; appContainer = $true; programs = @(@{ path = "$d2\worker.exe"; connect = @("127.0.0.1:$g"); listen = @() }) }
  $r = Run $FirewallExe @('install', "$d2\firewall-config.json") 60
  Track $d2
  if ($r.code -eq 0 -and $owned[$d2]) { Pass "E2 a worker-shaped sandbox with one loopback TCP grant installs ($($owned[$d2].ids.Count) filters)" }
  else { Fail "E2 install exit $($r.code)" }
  if ($owned[$d2]) {
    if ((Exempt).Contains($owned[$d2].sid)) { Pass 'E2 its loopback exemption is present' } else { Write-Output 'NOTE E2 exemption added at sandbox launch, not at install' }
    WriteJson "$d2\worker-sandbox.json" @{ directory = $d2; executable = "$d2\worker.exe"; args = @("$d2\probe.mjs", "$g", "$o") }
    $r = Run $FirewallExe @('sandbox', "$d2\worker-sandbox.json") 40
    $line = ($r.out -split "`n" | Where-Object { $_ -like '*"type":"probe"*' } | Select-Object -First 1)
    if (-not $line) { Fail "E2 no probe result (exit $($r.code)): $($r.out.Substring(0, [Math]::Min(400, $r.out.Length)))" } else {
      $pr = $line | ConvertFrom-Json
      if ($pr.tcpGranted) { Pass 'E2 TCP to the granted loopback port works from the sandbox' } else { Fail 'E2 granted TCP blocked' }
      if (-not $pr.tcpOther) { Pass 'E2 TCP to an ungranted loopback port is blocked' } else { Fail 'E2 ungranted TCP allowed' }
      if (-not $pr.udpGranted) { Pass 'E2 UDP to loopback is blocked under a TCP-only grant (the framing is required)' } else { Fail 'E2 loopback UDP allowed: the grant model differs from the tool source' } }
    $r = Run $FirewallExe @('remove', "$d2\firewall.json") 60
    if ($r.code -eq 0 -and (OwnedPresent $owned[$d2]) -eq 0 -and -not (Exempt).Contains($owned[$d2].sid)) { Pass 'E2 removed: none of its filters and no exemption remain'; $clean[$d2] = $true; $owned.Remove($d2) }
    else { Fail "E2 remove exit $($r.code) / owned filters or exemption left" } }
} catch { Fail "fatal: $_" }
finally {
  if ($listener -and -not $listener.p.HasExited) { Stop-Tree $listener 'loopback listener' }
  # remove whatever THIS script installed and could not remove above; nothing here may throw past a directory
  $kept = @()
  foreach ($d in @($owned.Keys)) {
    try {
      $r = Run $FirewallExe @('remove', "$d\firewall.json") 60
      if ($r.code -eq 0 -and $owned[$d] -and (OwnedPresent $owned[$d]) -eq 0) { $clean[$d] = $true; $owned.Remove($d) }
      else { $kept += $d; Fail "cleanup: $d NOT verified removed (exit $($r.code)); kept as the receipt" } }
    catch { $kept += $d; Fail "cleanup: $d remove could not be checked ($_); kept as the receipt" } }
  # a directory holding a manifest whose remove was never verified (unreadable, or a throw before it was tracked) is kept
  foreach ($d in $mine) { if ($kept -notcontains $d -and -not $clean[$d] -and (Test-Path -LiteralPath "$d\firewall.json")) { $kept += $d; Fail "cleanup: $d holds a firewall.json not verified removed; kept as the receipt" } }
  if ($script:stuck.Count) { Fail ("cleanup: process(es) not confirmed stopped ({0}); every fixture directory kept" -f ($script:stuck -join '; ')); $kept = @($mine) }
  foreach ($d in $mine) { if ($kept -notcontains $d -and (Test-Path -LiteralPath $d)) {
    try { Remove-Item -LiteralPath $d -Recurse -Force } catch { $kept += $d; Fail "cleanup: could not delete $d ($_)" } } }
  if (-not $kept.Count) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $kept.Count -and -not (Test-Path -LiteralPath $root)) { Pass 'cleanup: every fixture policy removed, the ephemeral directory gone' }
  elseif (-not $kept.Count) { Fail "cleanup: $root could not be deleted" }
  else { foreach ($d in $kept) { Write-Output "KEPT $d" } }
}
Write-Output "NATIVE-WIN-RC=$script:failed"; [Environment]::Exit($script:failed)
