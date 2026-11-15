# NucBox, 2026-11-15: the network agent with its ingress on a thread of its own (network/ingress-thread-host.mjs): three
# files in C:\Program Files\Enclave\network - the agent's bundle and the native-startup overlay, each the installed file
# with the change carried onto it (agent-bundle.py), and the thread's own file, new. Run by agent-ingress-thread.sh,
# which writes $mode='...' in front of this text. Modes: status, prepare, verify (read only or a new folder), swap, revert.
# A file is replaced only when it is, by SHA-256, the file this was made for, and its replacement is the staged file
# with its own SHA-256; the replaced files stay beside them. swap puts the previous files back itself when the new agent
# does not come up.
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Enclave'
$dir="$root\ingress-thread-20261115"
$net='C:\Program Files\Enclave\network'
# name, the installed file's SHA-256 ('' = not there before), the new file's SHA-256
$files=@(
 @('ingress-thread.mjs','','53420fcd61673be458193cfcc59bba6cb53f5470b00580f21ae88fac92a8ad87'),
 @('native-startup-overlay.mjs','cff1a0425f10d1488b1834a856bea4570c72aa0544c73dc238169dd5d7a20edf','62723ec4e99e09dbe0876a8ed75f08383c26b25c560eee798ece5a20a6094ddf'),
 @('privacy-agent.mjs','018082345a1058f0f9dd478b61a0b9ba2877dee5717761ae4b9f0f0bd31927b8','3b86e03e0d8664c11808a5bfcaf92330b625f7523ee1fe8f8164f329b206474b'))
$statusFile="$root\network\state\status.json"
$netlog="$root\logs\network.log"
$private='key|secret|token|password'
function Target($f) { "$net\$($f[0])" }
function Keep($f) { "$net\$($f[0]).before-ingress-thread-20261115" }
function Staged($f) { "$dir\$($f[0])" }
function Have($f) { if (Test-Path -LiteralPath (Target $f)) { Sha (Target $f) } else { '' } }
# all three: 'new', 'old', or 'mixed'
function Which { $n=0; $o=0; foreach ($f in $files) { $h=Have $f; if ($h -eq $f[2]) { $n++ } elseif ($h -eq $f[1]) { $o++ } }; if ($n -eq 3) { 'new' } elseif ($o -eq 3) { 'old' } else { 'mixed' } }
function StagedOk { foreach ($f in $files) { if (-not ((Test-Path -LiteralPath (Staged $f)) -and (Sha (Staged $f)) -eq $f[2])) { return $false } }; $true }
function Put($source,$target) {
  $tmp="$target.ingress-thread-new"
  [IO.File]::WriteAllBytes($tmp,[IO.File]::ReadAllBytes($source))
  try { if (Test-Path -LiteralPath $target) { [IO.File]::Replace($tmp,$target,[NullString]::Value) } else { [IO.File]::Move($tmp,$target) } } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function PutNew { foreach ($f in $files) { Put (Staged $f) (Target $f) } }
function PutOld { foreach ($f in @($files[2],$files[1],$files[0])) { if ($f[1]) { Put (Keep $f) (Target $f) } else { Remove-Item -LiteralPath (Target $f) -Force -ErrorAction SilentlyContinue } } }
function Utc { (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ') }
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Agents { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }) }
function ReadFrom($log,$mark) { $fs=[IO.File]::Open($log,'Open','Read','ReadWrite'); try { [void]$fs.Seek([Math]::Max(0,$mark),'Begin'); (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() } }
function Lines($text,$pattern) { @($text -split "`n" | Where-Object { $_ -match $pattern -and $_ -notmatch $private }) }
function Status { try { Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json } catch { $null } }
function HealthyApps($s) { if (-not $s) { return -1 }; @(@($s.apps) | Where-Object { @($_.circuits | Where-Object { $_.healthy -eq $true }).Count -gt 0 }).Count }
function Loopback { $ErrorActionPreference='Continue'; @(& "$env:SystemRoot\System32\CheckNetIsolation.exe" LoopbackExempt -s 2>$null | Where-Object { ([string]$_).Trim().StartsWith('SID:') }).Count }
# the refresh rounds' cadence: seconds between the lines one idle app writes each round, over the log's last lines
function Cadence($text) {
  $t=@(Lines $text 'app policy 0x2215bad4' | ForEach-Object { [TimeSpan]::Parse($_.Substring(0,8)).TotalSeconds })
  if ($t.Count -lt 4) { return "rounds: $($t.Count) seen, too few to say" }
  $g=@(); for ($i=1; $i -lt $t.Count; $i++) { $d=$t[$i]-$t[$i-1]; if ($d -ge 0) { $g+=$d } }; $s=$g | Sort-Object
  "rounds: $($t.Count) seen, $([int]$s[[int]($s.Count/2)]) s apart at the median, $([int]$s[$s.Count-1]) s at most"
}
function RestartAgent {
  $script:why=''; $script:mark=(Get-Item -LiteralPath $netlog).Length
  $was=@(Agents | ForEach-Object { $_.ProcessId })
  foreach ($p in $was) { "  ending the network agent, pid $p $(Utc)"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  $now=$null
  for ($i=0; $i -lt 90 -and -not $now; $i+=3) { Start-Sleep -Seconds 3; $now=Agents | Where-Object { $was -notcontains $_.ProcessId } | Select-Object -First 1 }
  if (-not $now) { $script:why='no new agent process within 90 s'; return }
  "  network agent started, pid $($now.ProcessId) $(Utc)"; $script:started=$now.CreationDate
  $up=$false
  for ($i=0; $i -lt 300 -and -not $up; $i+=5) { Start-Sleep -Seconds 5; $up=[bool](@(Lines (ReadFrom $netlog $script:mark) 'control circuit up').Count) }
  if (@(Agents | Where-Object { $_.ProcessId -eq $now.ProcessId }).Count -ne 1) { $script:why='the new agent did not stay up'; return }
  if (-not $up) { $script:why='no control circuit within 300 s'; return }
  "  control circuit up $(Utc)"
}
function WaitApps($before) {
  $h=-1
  for ($i=0; $i -lt 420; $i+=10) { Start-Sleep -Seconds 10; if ((Get-Item -LiteralPath $statusFile).LastWriteTime -gt $script:started) { $h=HealthyApps (Status) }; if ($h -ge [Math]::Max(1,$before)) { break } }
  $h
}
function Do-Status {
  "NucBox $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))"
  "  agent files: $(switch (Which) { 'new' { 'with the ingress thread' } 'old' { 'as before (ingress on the agent''s main thread)' } default { 'neither set: ' + (($files | ForEach-Object { $_[0] + ' ' + (Have $_).PadRight(16).Substring(0,16).Trim() }) -join ', ') } })"
  "  staged: $(if (StagedOk) { 'yes' } else { 'no' })"
  $a=@(Agents); "  network agents: $($a.Count)$(if ($a.Count) { ', started ' + $a[0].CreationDate.ToUniversalTime().ToString('MM-dd HH:mm:ssZ') + ', threads ' + (Get-Process -Id $a[0].ProcessId).Threads.Count })"
  $s=Status; "  apps with a healthy circuit: $(HealthyApps $s) of $(@($s.apps).Count); loopback exemptions: $(Loopback) of 682"
  $len=(Get-Item -LiteralPath $netlog).Length; $t=ReadFrom $netlog ($len-400000)
  "  $(Cadence $t)"
  "  in the log's last 400 kB: $(@(Lines $t 'ingress thread').Count) lines about the ingress thread, $(@(Lines $t 'egress OFF').Count) egress OFF"
  @(Lines $t 'ingress thread') | Select-Object -Last 3 | ForEach-Object { '    ' + $_.Substring(0,[Math]::Min(160,$_.Length)) }
  'DONE status'
}
switch ($mode) {
  'status' { Do-Status }
  'prepare' { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null; "created $dir" }; 'DONE prepare' }
  'verify' { if (StagedOk) { 'DONE staged' } else { 'STOP: the staged files are not there or are not the prepared ones' } }
  'swap' {
    if ((Which) -eq 'new') { 'the files are already the new ones; nothing changed'; Do-Status; 'DONE swap'; break }
    if ((Which) -ne 'old') { 'STOP: the installed files are not the ones this was made for; nothing changed'; break }
    if (-not (StagedOk)) { 'STOP: the staged files are not the prepared ones; nothing changed'; break }
    if (@(Agents).Count -ne 1) { "STOP: $(@(Agents).Count) network agents run, one expected; nothing changed"; break }
    $before=HealthyApps (Status); "before: $before apps with a healthy circuit; loopback exemptions $(Loopback) of 682"
    $bad=$false; foreach ($f in $files) { if ($f[1]) { if (-not (Test-Path -LiteralPath (Keep $f))) { Copy-Item -LiteralPath (Target $f) -Destination (Keep $f) }; if ((Sha (Keep $f)) -ne $f[1]) { $bad=$true } } }
    if ($bad) { 'STOP: a kept copy is not the installed file; nothing changed'; break }
    PutNew; if ((Which) -ne 'new') { PutOld; 'STOP: the files did not verify after they were replaced; the previous ones are back, the agent was not restarted'; break }
    "the three files are in place $(Utc); the previous ones are beside them"
    RestartAgent
    if ($script:why) {
      "the new agent: $($script:why). Putting the previous files back"
      PutOld; RestartAgent
      "STOP: taken back; the agent runs the previous files$(if ($script:why) { ' (and: ' + $script:why + ')' })"; break
    }
    $h=WaitApps $before; "  apps with a healthy circuit: $h (before: $before) $(Utc)"
    $t=ReadFrom $netlog $script:mark
    "  since the restart: $(@(Lines $t 'ingress thread').Count) lines about the ingress thread, $(@(Lines $t 'egress OFF').Count) egress OFF"
    @(Lines $t 'ingress thread') | Select-Object -Last 3 | ForEach-Object { '    ' + $_.Substring(0,[Math]::Min(160,$_.Length)) }
    "  agent threads: $((Get-Process -Id (Agents)[0].ProcessId).Threads.Count); $(Cadence $t)"
    "  loopback exemptions: $(Loopback) of 682"
    'DONE swap'
  }
  'revert' {
    if ((Which) -eq 'old') { 'the files are the previous ones already; nothing changed'; 'DONE revert'; break }
    if ((Which) -ne 'new') { 'STOP: the installed files are neither set; nothing changed'; break }
    $bad=$false; foreach ($f in $files) { if ($f[1] -and -not ((Test-Path -LiteralPath (Keep $f)) -and (Sha (Keep $f)) -eq $f[1])) { $bad=$true } }
    if ($bad) { 'STOP: a kept copy is missing or not the previous file; nothing changed'; break }
    PutOld; "the previous files are back $(Utc)"
    RestartAgent; if ($script:why) { "STOP: $($script:why)"; break }
    'DONE revert'
  }
  default { "STOP: unknown mode $mode" }
}
