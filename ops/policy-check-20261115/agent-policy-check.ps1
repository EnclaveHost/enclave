# NucBox, 2026-11-15: the network agent's bundle with rememberVerified (a successful owner-signature check is kept for
# ten minutes), in place of the one-hop release's bundle. Run by agent-policy-check.sh, which writes $mode='...' in
# front of this text. Modes: status, prepare, verify (read only or a new folder), swap, revert.
# A file is replaced only when it is, by SHA-256, the file this was made for, and its replacement is the staged file
# with its own SHA-256; the replaced file stays beside it. swap puts the previous file back itself when the new agent
# does not come up.
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Enclave'
$dir="$root\policy-check-20261115"
$target='C:\Program Files\Enclave\network\privacy-agent.mjs'
$staged="$dir\privacy-agent.mjs"
$old='9b9c028809a5d82197edad0e3568eab2ac62405aeb56ee9df5013bc93732709c'
$new='018082345a1058f0f9dd478b61a0b9ba2877dee5717761ae4b9f0f0bd31927b8'
$newBytes=2961488
$keep="$target.before-policy-check-20261115-9b9c0288"
$statusFile="$root\network\state\status.json"
$netlog="$root\logs\network.log"
$private='key|secret|token|password'
function Utc { (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ') }
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Which { $h=Sha $target; if ($h -eq $new) { 'new' } elseif ($h -eq $old) { 'old' } else { 'other' } }
function Put($source) {
  $tmp="$target.policy-check-new"
  [IO.File]::WriteAllBytes($tmp,[IO.File]::ReadAllBytes($source))
  try { [IO.File]::Replace($tmp,$target,[NullString]::Value) } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
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
  "  privacy-agent.mjs: $(switch (Which) { 'new' { 'the bundle with the kept signature check' } 'old' { 'the one-hop release''s bundle' } default { 'another file ' + (Sha $target).Substring(0,16) } })"
  "  staged: $(if ((Test-Path -LiteralPath $staged) -and (Sha $staged) -eq $new) { 'yes' } else { 'no' }); previous file kept: $(Test-Path -LiteralPath $keep)"
  $a=@(Agents); "  network agents: $($a.Count)$(if ($a.Count) { ', started ' + $a[0].CreationDate.ToUniversalTime().ToString('MM-dd HH:mm:ssZ') })"
  $s=Status; "  apps with a healthy circuit: $(HealthyApps $s) of $(@($s.apps).Count); loopback exemptions: $(Loopback) of 682"
  $len=(Get-Item -LiteralPath $netlog).Length; $t=ReadFrom $netlog ($len-400000)
  "  $(Cadence $t)"
  "  in the log's last 400 kB: $(@(Lines $t 'egress OFF').Count) egress OFF, $(@(Lines $t 'egress back').Count) egress back"
  'DONE status'
}
switch ($mode) {
  'status' { Do-Status }
  'prepare' { if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null; "created $dir" }; 'DONE prepare' }
  'verify' { if ((Test-Path -LiteralPath $staged) -and (Get-Item -LiteralPath $staged).Length -eq $newBytes -and (Sha $staged) -eq $new) { 'DONE staged' } else { 'STOP: the staged file is not there or is not the prepared one' } }
  'swap' {
    if ((Which) -eq 'new') { 'the bundle is already the new one; nothing changed'; Do-Status; 'DONE swap'; break }
    if ((Which) -ne 'old') { 'STOP: privacy-agent.mjs is not the one-hop release''s bundle; nothing changed'; break }
    if (-not ((Test-Path -LiteralPath $staged) -and (Sha $staged) -eq $new)) { 'STOP: the staged file is not the prepared one; nothing changed'; break }
    if (@(Agents).Count -ne 1) { "STOP: $(@(Agents).Count) network agents run, one expected; nothing changed"; break }
    $before=HealthyApps (Status); "before: $before apps with a healthy circuit; loopback exemptions $(Loopback) of 682"
    if (-not (Test-Path -LiteralPath $keep)) { Copy-Item -LiteralPath $target -Destination $keep }
    if ((Sha $keep) -ne $old) { 'STOP: the kept copy is not the one-hop release''s bundle; nothing changed'; break }
    Put $staged; if ((Which) -ne 'new') { Put $keep; 'STOP: the file did not verify after it was replaced; the previous one is back, the agent was not restarted'; break }
    "privacy-agent.mjs replaced $(Utc); the previous file is beside it"
    RestartAgent
    if ($script:why) {
      "the new agent: $($script:why). Putting the previous bundle back"
      Put $keep; RestartAgent
      "STOP: taken back; the agent runs the previous bundle$(if ($script:why) { ' (and: ' + $script:why + ')' })"; break
    }
    $h=WaitApps $before; "  apps with a healthy circuit: $h (before: $before) $(Utc)"
    $t=ReadFrom $netlog $script:mark
    "  since the restart: $(@(Lines $t 'egress back').Count) egress back, $(@(Lines $t 'egress OFF').Count) egress OFF"
    "  $(Cadence $t)"
    "  loopback exemptions: $(Loopback) of 682"
    'DONE swap'
  }
  'revert' {
    if ((Which) -eq 'old') { 'the bundle is the one-hop release''s already; nothing changed'; 'DONE revert'; break }
    if ((Which) -ne 'new') { 'STOP: privacy-agent.mjs is neither file; nothing changed'; break }
    if (-not ((Test-Path -LiteralPath $keep) -and (Sha $keep) -eq $old)) { 'STOP: the kept copy is missing or not the one-hop release''s bundle; nothing changed'; break }
    Put $keep; "privacy-agent.mjs is the one-hop release's bundle again $(Utc)"
    RestartAgent; if ($script:why) { "STOP: $($script:why)"; break }
    'DONE revert'
  }
  default { "STOP: unknown mode $mode" }
}
