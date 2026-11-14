# NucBox, 2026-11-13: stage and load the native desktop release SVN19 (de9e87e3...), whose controller carries the
# KVM Box page with the terminal, the one Start/Stop button and the corrected Open desktop link.
#
# Run by desktop-svn19.sh, which writes $mode='...' (and $want=N for settled) in front of this text and feeds the
# whole of it to PowerShell as ONE script block: a syntax error anywhere means nothing runs. Every mode ends with a
# line that starts DONE, STOP or SETTLED; the caller goes by that line, not by the exit status.
#
# C:\ProgramData\Enclave\run-node.cmd and run-shield.cmd each call the release's native-desktop-env.cmd before their
# restart loop, so a release is selected by that one line and takes effect when the task is ended and started again.
# The two are never restarted close together. A restarted manager lists the app VMs as recovered and, until none is
# left, does not know its RAM and refuses every launch, the node's readiness witness included. A node that has been
# up for a while gives each recovered VM a fresh boot (the SVN18 switch at 20:24Z on 2026-11-13: about eight
# minutes). A node restarted just before has no witness yet, cannot get one, serves only its operator's apps and
# holds every other app until its lease lapses (the SVN19 switch at 23:53Z: Node, then the manager 90 s later; the
# last lease lapsed 29 minutes after). So: the Shield manager first, the settled mode until it says yes, then the Node.
#
# Guards: a mode that changes anything first requires both tasks under \Enclave\, the staged files with their sizes
# and SHA-256, and the launcher line in the state it expects; otherwise it stops with nothing changed. The task is
# always started again, also when a step in between fails. A launcher is put back by the reverse of the same edit.
#
# The controller component is not staged here. The node fetches it by CID as a CAR and hashes every block
# (windows/node/fetch-cid.py), asking in order the sources in artifact-gateways.json beside that script: the local
# replica on 127.0.0.1:18191, the four edges on 8189 and the gateway app. The replica and the edges hold a fixed set
# and answer 404 for an app's component (on 2026-11-13 the edges did so for the SVN18 controller too), so it arrives
# from the gateway app. The fetch mode runs that same script with that same list and checks what it wrote.
$ErrorActionPreference='Stop'
$old='a2272bcd8f7d5db883ae212ee1cb499a8bf100f9cc6f23073e61b68343f185f9'
$new='de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e'
$root='C:\ProgramData\Enclave'
$rel="$root\native-desktop\releases"
$dir="$rel\$new"
$tp='\Enclave\'
$sf="$root\run-shield.cmd"
$nf="$root\run-node.cmd"
$slog="$root\logs\shield.log"
$nlog="$root\logs\node.log"
$stamp='bak-20261113-before-svn19'
$fetcher='C:\Program Files\Enclave\control\windows\node\fetch-cid.py'
$cid='bafybeidkdt5kv3bkyygeyofbkoo3abqd2oi7o5wgcsbrkodmjf5q3zzub4'
$controller='b3eb82bce8822d26ecbfb654b73a603debf9cde460845ff29a02c69a9f4e4704'
$private='key|secret|token|password'
# name = bytes, sha256. shielded-bridge.exe is the SVN18 release's file, copied on the box.
$files=[ordered]@{
  'native-igvm.bin'=@(86616932,'de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e')
  'root.iso'=@(592719872,'fe27094279df44123c8e5cac6118860957b34092049d90e987bd694e1df67105')
  'hashes.iso'=@(4739072,'fcbe54bc8190f8d5ca7bac35c060ee9f3f5543e22c4ba68824cca71b2972e09e')
  'profile.json'=@(1066,'aa5cb74b0beeebff1fcb1aa6aaac4fb876f9ec823acf46b4fcdbc94a1433c1e8')
  'desktop-config.json'=@(3524,'fc564428a4c50f108aaa6e70723c9216bf9652498efa6afa4ff177f866746440')
  'desktop-release.json'=@(644,'fa61b80ac94710d5bc28759f3df65b20387eee04464ba74ac73aeaacca675b54')
  'native-desktop-env.cmd'=@(755,'f3c03189586ec51daa85441c508e6fc5b2bc74d156f702dfef094ca49baaa451')
  'shielded-bridge.exe'=@(271360,'cc751de67c7d303f989367e1ac5ed5eb316f2b13cd10be74ff44256551d18d73')
}
# desktop-config.json names this medium where it already is; it is not copied
$models="$rel\2e801d0fde8259b29a44e53d7854dab2ddaeed7f8db8578e00bec0fde734bff3\models.iso"
$modelsBytes=2566148096

function Utc { (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ') }
function Cut($s,$n) { $s=[string]$s; $s.Substring(0,[Math]::Min($n,$s.Length)) }

# '' when every staged file is present with its size and SHA-256, else what is wrong
function Staged {
  $bad=@()
  foreach ($n in $files.Keys) {
    $p="$dir\$n"
    if (-not (Test-Path -LiteralPath $p)) { $bad+="$n is missing"; continue }
    $len=(Get-Item -LiteralPath $p).Length
    if ($len -ne $files[$n][0]) { $bad+="$n has $len bytes"; continue }
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne $files[$n][1]) { $bad+="$n has another SHA-256" }
  }
  if (-not (Test-Path -LiteralPath $models)) { $bad+='models.iso is missing' }
  elseif ((Get-Item -LiteralPath $models).Length -ne $modelsBytes) { $bad+='models.iso has another size' }
  $bad -join '; '
}

function Tasks {
  $s=Get-ScheduledTask -TaskPath $tp -TaskName Shield -ErrorAction SilentlyContinue
  $n=Get-ScheduledTask -TaskPath $tp -TaskName Node -ErrorAction SilentlyContinue
  if ($null -eq $s -or $null -eq $n) { return 'the tasks \Enclave\Shield and \Enclave\Node were not both found' }
  ''
}

# which release a launcher's one env line names: 'old', 'new', or what else was found
function Names($f) {
  $l=@(Get-Content -LiteralPath $f | Where-Object { $_ -match 'native-desktop-env\.cmd' })
  if ($l.Count -ne 1) { return "$($l.Count) lines call native-desktop-env.cmd" }
  if ($l[0].Contains("releases\$old\native-desktop-env.cmd")) { return 'old' }
  if ($l[0].Contains("releases\$new\native-desktop-env.cmd")) { return 'new' }
  'another release'
}

function Point($f,$from,$to) {
  $t=[IO.File]::ReadAllText($f)
  $n=$t.Replace("releases\$from\native-desktop-env.cmd","releases\$to\native-desktop-env.cmd")
  if ($n -eq $t) { throw "the line to change was not found in $f" }
  [IO.File]::WriteAllText($f,$n,(New-Object Text.ASCIIEncoding))
}

function Keep($f) { $b="$f.$stamp"; if (-not (Test-Path -LiteralPath $b)) { Copy-Item -LiteralPath $f -Destination $b } }

function Health { try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 5).Content | ConvertFrom-Json } catch { $null } }
function HealthLine($h) { if ($h) { "canStart=$($h.canStart) desktop.ready=$($h.desktop.ready) igvm=$(Cut $h.desktop.igvmSha256 12) inventory=$($h.inventory | ConvertTo-Json -Compress)" } else { 'no answer' } }
function WaitHealth($tries) { $h=$null; for ($i=0; $i -lt $tries -and -not $h; $i++) { Start-Sleep -Seconds 3; $h=Health }; $h }

# running app VMs the manager lists, the desktop not counted; -1 when the manager does not answer
function AppVms {
  try { $v=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 8).Content | ConvertFrom-Json } catch { return -1 }
  $l=$v; if ($v.vms) { $l=$v.vms }
  @(@($l) | Where-Object { $_.status -eq 'running' -and $_.image -ne $old -and $_.image -ne $new }).Count
}

function ReadFrom($log,$mark) {
  $fs=[IO.File]::Open($log,'Open','Read','ReadWrite')
  try { if ($mark -lt 0 -or $fs.Length -lt $mark) { $mark=0 }; $null=$fs.Seek($mark,'Begin'); (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
}
function Show($text,$skip,$count) { @($text -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch $private -and (-not $skip -or $_ -notmatch $skip) }) | Select-Object -First $count | ForEach-Object { '  ' + (Cut $_.TrimEnd() 230) } }

# End a task with its restart loop and the process the loop runs, then start the task. The start is in finally:
# whatever fails in between, the task is not left stopped.
function Cycle($name,$loop,$port,$proc) {
  try {
    Stop-ScheduledTask -TaskPath $tp -TaskName $name -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match $loop } | ForEach-Object { "  ending the task's restart loop, pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { "  ending the listener on $port, pid $($_.OwningProcess)"; Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    if ($proc) { Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $proc } | ForEach-Object { "  ending pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Seconds 2
  } finally {
    Start-ScheduledTask -TaskPath $tp -TaskName $name
    "  task $name started $(Utc)"
  }
}
function CycleShield { Cycle 'Shield' 'run-shield' 8091 $null }
function CycleNode { Cycle 'Node' 'run-node' 9600 'Enclave\\control\\windows\\node\\agent\.mjs' }

# the node's own line that it is listed in the registry, written after $mark; '' if none within $seconds
function WaitListed($mark,$seconds) {
  for ($i=0; $i -lt $seconds; $i+=5) {
    Start-Sleep -Seconds 5
    $l=@((ReadFrom $nlog $mark) -split "`n" | Where-Object { $_ -match 'registry: listed as' }) | Select-Object -Last 1
    if ($l) { return (Cut $l.TrimEnd() 150) }
  }
  ''
}

function Guard {
  $t=Tasks; if ($t) { return $t }
  $s=Staged; if ($s) { return "the release is not staged: $s" }
  ''
}

function Do-Prepare {
  if (-not (Test-Path -LiteralPath $rel)) { 'STOP: the releases folder was not found; nothing changed'; return }
  if (-not (Test-Path -LiteralPath $dir)) {
    $null=New-Item -ItemType Directory -Path $dir
    # as the SVN18 release folder: SYSTEM and Administrators only, nothing inherited
    $null=& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
    "created $dir"
  }
  "DONE prepare"
}

function Do-Verify {
  if (-not (Test-Path -LiteralPath $dir)) { 'STOP: the release folder does not exist'; return }
  $b="$dir\shielded-bridge.exe"
  if (-not (Test-Path -LiteralPath $b)) { Copy-Item -LiteralPath "$rel\$old\shielded-bridge.exe" -Destination $b; 'copied shielded-bridge.exe from the SVN18 release' }
  $s=Staged
  if ($s) { "STOP: $s"; return }
  foreach ($n in $files.Keys) { "  $n  $($files[$n][0]) bytes  $(Cut $files[$n][1] 16)" }
  "DONE staged $new"
}

function Do-Status {
  $t=Tasks; if ($t) { "tasks: $t" } else { "tasks: Shield " + (Get-ScheduledTask -TaskPath $tp -TaskName Shield).State + ", Node " + (Get-ScheduledTask -TaskPath $tp -TaskName Node).State }
  "run-node.cmd names:   " + (Names $nf)
  "run-shield.cmd names: " + (Names $sf)
  "manager: " + (HealthLine (Health))
  "app VMs running (desktop not counted): " + (AppVms)
  if (Test-Path -LiteralPath $dir) { $s=Staged; if ($s) { "staged: NO: $s" } else { 'staged: yes, every file with its size and SHA-256' } } else { 'staged: NO: the release folder does not exist' }
  "DONE status"
}

# Can this box get the controller the way the node will: its fetcher, its source list, every block hashed? Writes
# one file under the caller's TEMP and removes it. Changes nothing the node or the manager reads.
function Do-Fetch {
  $ErrorActionPreference='Continue'
  $py=Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { 'STOP: no python on PATH; nothing changed'; return }
  if (-not (Test-Path -LiteralPath $fetcher)) { 'STOP: the node fetcher is not where it is expected; nothing changed'; return }
  $out=Join-Path $env:TEMP "svn19-controller-$PID.wasm"
  $said=@(& $py.Source $fetcher $cid $out 67108864 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch $private })
  $code=$LASTEXITCODE
  $got=$null
  if (Test-Path -LiteralPath $out) { $got=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower(); $bytes=(Get-Item -LiteralPath $out).Length; Remove-Item -LiteralPath $out -Force }
  if ($code -eq 0 -and $got -eq $controller) { "DONE fetch $bytes bytes, SHA-256 $(Cut $got 16), by the node's fetcher through its own source list"; return }
  $said | Select-Object -First 4 | ForEach-Object { '  ' + (Cut $_ 600) }
  if ($got) { "STOP: the fetcher wrote other bytes ($(Cut $got 16)); nothing changed" } else { 'STOP: the node fetcher could not get the controller from any of its sources; nothing changed' }
}

function Do-Count { $n=AppVms; if ($n -lt 0) { 'STOP: the manager does not answer; nothing changed' } else { "DONE count $n" } }

# Has the host come back after a restart: the manager reports the wanted release ready ($to='old' for SVN18, else
# SVN19), lists no partition it only recovered, knows its RAM again, and the node has logged no recovery, held,
# spawned or refused launch and no witness failure for two minutes. $want is the count from before, shown only: an
# app whose lease lapsed during the wait may run on another host now. Reads only.
function Do-Settled {
  $rel=$new; if ($to -eq 'old') { $rel=$old }
  $h=Health
  $rec=-1; $n=-1
  try {
    $v=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 8).Content | ConvertFrom-Json
    $l=@($v); if ($v.vms) { $l=@($v.vms) }
    $rec=@($l | Where-Object { $_.recovered -eq $true -or $_.unattributed -eq $true }).Count
    $n=@($l | Where-Object { $_.recovered -ne $true -and $_.status -eq 'running' -and $_.image -ne $old -and $_.image -ne $new }).Count
  } catch { }
  $mgr=[bool]($h -and $h.desktop.ready -eq $true -and $h.desktop.igvmSha256 -eq $rel)
  $ram=[bool]($h -and $h.physicalMemory -and ($null -ne $h.physicalMemory.allocatedMiB))
  $t=ReadFrom $nlog ((Get-Item -LiteralPath $nlog).Length-400000)
  $last=@($t -split "`n" | Where-Object { $_ -notmatch '9a28642b' -and $_ -match 'restart recovery|isolation held|isolation spawned|no ready partition|manager health unavailable|/health is not known|readiness witness' }) | Select-Object -Last 1
  $quiet=99999
  if ($last -and $last -match '^(\d\d):(\d\d):(\d\d) ') {
    $now=(Get-Date).ToUniversalTime()
    $at=$now.Date.AddHours([int]$matches[1]).AddMinutes([int]$matches[2]).AddSeconds([int]$matches[3])
    if ($at -gt $now.AddMinutes(2)) { $at=$at.AddDays(-1) }
    $quiet=[int]($now-$at).TotalSeconds
  }
  $ok=$mgr -and ($rec -eq 0) -and $ram -and ($quiet -ge 120)
  "SETTLED " + $(if ($ok) { 'yes' } else { 'no' }) + " manager=" + $(if ($mgr) { 'ready' } else { 'NOT on the release' }) + " recovered=$rec ram=" + $(if ($ram) { 'known' } else { 'unknown' }) + " quietSeconds=$quiet appVms=$n before=$want $(Utc)"
}

# Pin the Node to $to. While the manager loads the other release the node refuses the desktop only. Not within
# minutes of a manager restart: see the order at the top.
function Set-Node($from,$to) {
  $g=Guard; if ($g) { "STOP: $g; nothing changed"; return }
  $is=Names $nf
  $fresh=$false
  if ($is -eq $(if ($to -eq $new) { 'new' } else { 'old' })) {
    $l=Get-NetTCPConnection -LocalPort 9600 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($l -and (Get-Process -Id $l.OwningProcess).StartTime -gt (Get-Item -LiteralPath $nf).LastWriteTime) { "DONE node (run-node.cmd already names this release and the node started after it was written)"; return }
    'run-node.cmd already names this release but the node is older than the file: restarting it only'
  } elseif ($is -ne $(if ($from -eq $old) { 'old' } else { 'new' })) { "STOP: run-node.cmd names $is; nothing changed"; return }
  else { Keep $nf; Point $nf $from $to; $fresh=$true; "run-node.cmd now calls releases\$(Cut $to 12)...\native-desktop-env.cmd" }
  $mark=(Get-Item -LiteralPath $nlog).Length
  CycleNode
  $listed=WaitListed $mark 120
  '--- node.log since the restart'
  Show (ReadFrom $nlog $mark) 'isolation adopted' 22
  if ($listed) { "DONE node $(Cut $to 12): $listed"; return }
  if ($fresh) {
    'the node did not list itself within 120 s: putting run-node.cmd back'
    Point $nf $to $from
    $mark=(Get-Item -LiteralPath $nlog).Length
    CycleNode
    $again=WaitListed $mark 120
    "STOP: the node did not list itself on this release; run-node.cmd is back as it was and the node " + $(if ($again) { "is listed again: $again" } else { 'has NOT listed itself yet' })
  } else { 'STOP: the node did not list itself within 120 s; run-node.cmd was not edited by this run' }
}

# Load $to in the Shield manager. Every app VM is listed as recovered and gets a fresh boot from the node.
function Set-Shield($from,$to) {
  $g=Guard; if ($g) { "STOP: $g; nothing changed"; return }
  $is=Names $sf
  $h=Health
  $fresh=$false
  "before: " + (HealthLine $h) + ", app VMs " + (AppVms)
  if ($is -eq $(if ($to -eq $new) { 'new' } else { 'old' })) {
    if ($h -and $h.desktop.igvmSha256 -eq $to -and $h.desktop.ready -eq $true) { "DONE shield (the manager already reports this release ready)"; return }
    'run-shield.cmd already names this release but the manager does not report it ready: restarting it only'
  } elseif ($is -ne $(if ($from -eq $old) { 'old' } else { 'new' })) { "STOP: run-shield.cmd names $is; nothing changed"; return }
  elseif ($h -and $h.desktop.igvmSha256 -ne $from) { "STOP: the manager reports a release that run-shield.cmd does not name; nothing changed"; return }
  else { Keep $sf; Point $sf $from $to; $fresh=$true; "run-shield.cmd now calls releases\$(Cut $to 12)...\native-desktop-env.cmd" }
  $mark=(Get-Item -LiteralPath $slog).Length
  CycleShield
  $h=WaitHealth 30
  $tail=ReadFrom $slog $mark
  '--- shield.log since the restart'
  Show $tail $null 25
  "health: " + (HealthLine $h)
  if ($h -and $tail -notmatch 'REFUSING TO START' -and $h.desktop.igvmSha256 -eq $to -and $h.desktop.ready -eq $true) { "DONE shield $(Cut $to 12)"; return }
  if (-not $fresh) { 'STOP: the manager does not report this release ready; run-shield.cmd was not edited by this run'; return }
  'the manager does not report this release ready: putting run-shield.cmd back'
  Point $sf $to $from
  CycleShield
  $h=WaitHealth 30
  "STOP: the manager did not load this release; run-shield.cmd is back as it was and the manager reports " + (HealthLine $h)
}

switch ($mode) {
  'prepare'       { Do-Prepare }
  'verify'        { Do-Verify }
  'status'        { Do-Status }
  'fetch'         { Do-Fetch }
  'count'         { Do-Count }
  'settled'       { Do-Settled }
  'node'          { Set-Node $old $new }
  'shield'        { Set-Shield $old $new }
  'revert-node'   { Set-Node $new $old }
  'revert-shield' { Set-Shield $new $old }
  default         { "STOP: unknown mode '$mode'; nothing changed" }
}
