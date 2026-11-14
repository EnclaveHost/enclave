# NucBox, 2026-11-14: stage and load the native desktop release SVN20 (08f69fa4...), whose controller carries the
# KVM Box page that names the app's own public name as the PC to add in Moonlight. Made from desktop-svn19.ps1,
# which has the history behind each rule here.
#
# Run by desktop-svn20.sh, which writes $mode='...' (and $want=N for settled) in front of this text and feeds the
# whole of it to PowerShell as ONE script block: a syntax error anywhere means nothing runs. Every mode ends with a
# line that starts DONE, STOP or SETTLED; the caller goes by that line, not by the exit status.
#
# C:\ProgramData\Enclave\run-node.cmd and run-shield.cmd each call the release's native-desktop-env.cmd before their
# restart loop, so a release is selected by that one line and takes effect when the task is ended and started again.
# The two are never restarted close together. A restarted manager lists the app VMs as recovered and, until none is
# left, does not know its RAM and refuses every launch, the node's readiness witness included. A node that has been
# up for a while gives each recovered VM a fresh boot (about eight minutes on 2026-11-13). A node restarted just
# before has no witness yet, cannot get one, serves only its operator's apps and holds every other app until its
# lease lapses (about half an hour on 2026-11-13). So: the Shield manager first, the settled mode until it says yes,
# then the Node.
#
# Guards: a mode that changes anything first requires both tasks under \Enclave\, the staged files with their sizes
# and SHA-256, and the launcher line in the state it expects; otherwise it stops with nothing changed. The task is
# always started again, also when a step in between fails. A launcher is put back by the reverse of the same edit.
#
# The controller component is not staged here. The node fetches it by CID as a CAR and hashes every block
# (windows/node/fetch-cid.py), asking in order the sources in artifact-gateways.json beside that script: the local
# replica on 127.0.0.1:18191, the four edges on 8189 and the gateway app. The replica and the edges hold a fixed set
# and answer 404 for an app's component, so it arrives from the gateway app. The fetch mode runs that same script
# with that same list and checks what it wrote.
#
# The host's own Shield policy (hostpolicy). The node and the network agent admit a desktop guest from
# C:\Program Files\Enclave\network\admitted-shield-policy.json (ENCLAVE_NETWORK_SHIELD_POLICY in node-config.cmd), which
# names one desktop release and one controller. The node reads it on every enrollment pass; the agent reads it once,
# when it starts. A host that loads a release this file does not name launches the desktop and admits neither the
# release nor the controller; the node then gives up on the deployment (2026-11-14 03:43Z). hostpolicy replaces that
# file from the release folder's shield-policy.json and ends the agent process; the \Enclave\Network task's loop
# starts it again after 10 s, which is what the node itself does when the agent's configuration moves. Neither the
# Node nor the Shield manager is restarted. While the agent is down (about 10 s) and until its first agreeing chain
# read, the apps on this box have no route.
$ErrorActionPreference='Stop'
$old='de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e'
$new='08f69fa415268c0211ec6867ad3b334aa62c56cb5bb8ed67257e876e9910747b'
$root='C:\ProgramData\Enclave'
$rel="$root\native-desktop\releases"
$dir="$rel\$new"
$tp='\Enclave\'
$sf="$root\run-shield.cmd"
$nf="$root\run-node.cmd"
$slog="$root\logs\shield.log"
$nlog="$root\logs\node.log"
$stamp='bak-20261114-before-svn20'
$fetcher='C:\Program Files\Enclave\control\windows\node\fetch-cid.py'
$cid='bafybeig564vcjghux3gnfgzpcdddtxl6mlvrzelmhe7qnapi7ejnsmpoxa'
$controller='e05247f88eb521d48507ff49bb88d16b5bba2df75fb2794b2082382ae7506630'
$private='key|secret|token|password'
$pol='C:\Program Files\Enclave\network\admitted-shield-policy.json'
$polKeep="$pol.before-native-svn20-20261114"
$polOld='a0e735027bb3d04cfb037574485206673a7cda8f7b81eda73d43eac7d995e3ee'
$polNew='54fed2c8eadd809770103ee63efdfd99540611efcfe0d99f3362b4f13c3ce60e'
$polStaged="$dir\shield-policy.json"
$netlog="$root\logs\network.log"
$kvm='9a28642b'
# name = bytes, sha256. shielded-bridge.exe is the file the SVN19 release has, copied on the box from its folder.
$files=[ordered]@{
  'native-igvm.bin'=@(86616932,'08f69fa415268c0211ec6867ad3b334aa62c56cb5bb8ed67257e876e9910747b')
  'root.iso'=@(592719872,'1874a48475b0d3f44e55a9a17c61f0b20f9f7ccce730a2ff0a1dfc9bd92fda8b')
  'hashes.iso'=@(4739072,'2c3060d4c8ef0177dd3acdff239c616c3f6e3b8ed5a324b7861aa88b41daddbc')
  'profile.json'=@(1066,'8f494c3b1c4ffd1c8416c1e6c2660ed0a01969327aa4f8960f5cbf0f1b828e44')
  'desktop-config.json'=@(3524,'258006e76e565090cb7ce83504a85bc5eefe3f4dcecf4dcd0a0fa12280d55829')
  'desktop-release.json'=@(644,'04a3e6c7230b2965d52ed40fdd1c457f892a54956ff642be6797df95903bafbd')
  'native-desktop-env.cmd'=@(775,'e74f25db96d148a7db57f99870b7964f1bcc1af4f1c25e9f83655e67facbe9b0')
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

function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function PolicyName($h) { if ($h -eq $polNew) { 'SVN20' } elseif ($h -eq $polOld) { 'SVN19 (previous)' } else { "another file $(Cut $h 16)" } }
function Agents { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }) }
# 'after' when the one agent process started after the policy file was last written, else why it has not read it
function AgentRead {
  $a=@(Agents)
  if ($a.Count -ne 1) { return "$($a.Count) agent processes when" }
  if ((Get-Process -Id $a[0].ProcessId).StartTime -gt (Get-Item -LiteralPath $pol).LastWriteTime) { 'after' } else { 'BEFORE' }
}

# Replace the policy file in one step from $source. File.Replace keeps the replaced file's access list.
function PutPolicy($source) {
  $tmp="$pol.new"
  [IO.File]::WriteAllBytes($tmp,[IO.File]::ReadAllBytes($source))
  try { [IO.File]::Replace($tmp,$pol,[NullString]::Value) } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

# End the network agent and wait for the one its task starts. $script:agentWhy is '' when a new agent is running and
# has not exited in its first 40 s, else what happened. $script:circuit says whether its control circuit came up
# within three minutes; that also needs a provider's chain read and is reported, not required.
function RestartAgent {
  $script:agentWhy=''; $script:circuit=$false
  $mark=(Get-Item -LiteralPath $netlog).Length
  $was=@(Agents | ForEach-Object { $_.ProcessId })
  foreach ($p in $was) { "  ending the network agent, pid $p $(Utc)"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  $now=$null
  for ($i=0; $i -lt 90 -and -not $now; $i+=3) { Start-Sleep -Seconds 3; $now=Agents | Where-Object { $was -notcontains $_.ProcessId } | Select-Object -First 1 }
  if (-not $now) { $script:agentWhy='no new agent process within 90 s'; return }
  "  network agent started, pid $($now.ProcessId) $(Utc)"
  Start-Sleep -Seconds 40
  for ($i=0; $i -lt 140 -and -not $script:circuit; $i+=5) { $script:circuit=[bool]((ReadFrom $netlog $mark) -match 'control circuit up'); if (-not $script:circuit) { Start-Sleep -Seconds 5 } }
  $text=ReadFrom $netlog $mark
  '--- network.log since the restart'
  Show $text $null 16
  @($text -split "`n" | Where-Object { $_ -match 'chain authorization|lease\(s\)' -and $_ -notmatch $private }) | Select-Object -Last 3 | ForEach-Object { '  ' + (Cut $_.TrimEnd() 200) }
  if (@(Agents | Where-Object { $_.ProcessId -eq $now.ProcessId }).Count -ne 1) { $script:agentWhy='the new agent did not stay up' }
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
    # as the SVN19 release folder: SYSTEM and Administrators only, nothing inherited
    $null=& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
    "created $dir"
  }
  "DONE prepare"
}

function Do-Verify {
  if (-not (Test-Path -LiteralPath $dir)) { 'STOP: the release folder does not exist'; return }
  $b="$dir\shielded-bridge.exe"
  if (-not (Test-Path -LiteralPath $b)) { Copy-Item -LiteralPath "$rel\$old\shielded-bridge.exe" -Destination $b; 'copied shielded-bridge.exe from the SVN19 release' }
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
  "host policy: " + (PolicyName (Sha $pol)) + ", written " + (Get-Item -LiteralPath $pol).LastWriteTimeUtc.ToString('MM-dd HH:mm:ssZ')
  "network agent started: " + (AgentRead) + " the host policy was written"
  "DONE status"
}

# Can this box get the controller the way the node will: its fetcher, its source list, every block hashed? Writes
# one file under the caller's TEMP and removes it. Changes nothing the node or the manager reads.
function Do-Fetch {
  $ErrorActionPreference='Continue'
  $py=Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { 'STOP: no python on PATH; nothing changed'; return }
  if (-not (Test-Path -LiteralPath $fetcher)) { 'STOP: the node fetcher is not where it is expected; nothing changed'; return }
  $out=Join-Path $env:TEMP "svn20-controller-$PID.wasm"
  $said=@(& $py.Source $fetcher $cid $out 67108864 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -notmatch $private })
  $code=$LASTEXITCODE
  $got=$null
  if (Test-Path -LiteralPath $out) { $got=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower(); $bytes=(Get-Item -LiteralPath $out).Length; Remove-Item -LiteralPath $out -Force }
  if ($code -eq 0 -and $got -eq $controller) { "DONE fetch $bytes bytes, SHA-256 $(Cut $got 16), by the node's fetcher through its own source list"; return }
  $said | Select-Object -First 4 | ForEach-Object { '  ' + (Cut $_ 600) }
  if ($got) { "STOP: the fetcher wrote other bytes ($(Cut $got 16)); nothing changed" } else { 'STOP: the node fetcher could not get the controller from any of its sources; nothing changed' }
}

function Do-Count { $n=AppVms; if ($n -lt 0) { 'STOP: the manager does not answer; nothing changed' } else { "DONE count $n" } }

# Has the host come back after a restart: the manager reports the wanted release ready ($to='old' for SVN19, else
# SVN20), lists no partition it only recovered, knows its RAM again, and the node has logged no recovery, held,
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

function Do-StagedPolicy {
  if ((Test-Path -LiteralPath $polStaged) -and (Sha $polStaged) -eq $polNew) { "DONE policy staged $(Cut $polNew 16)" } else { 'STOP: the release folder has no shield-policy.json with the prepared SHA-256' }
}

# Put $to in place of $from as the host's Shield policy, from $source, and restart the network agent on it. $back
# holds the bytes of $from, for the way back if the agent does not stay up on the new file.
function Set-HostPolicy($from,$to,$source,$back) {
  $t=Get-ScheduledTask -TaskPath $tp -TaskName Network -ErrorAction SilentlyContinue
  if ($null -eq $t -or $t.State -ne 'Running') { 'STOP: the task \Enclave\Network is not running; nothing changed'; return }
  $n=@(Agents).Count
  if ($n -ne 1) { "STOP: $n network agent processes found, one expected; nothing changed"; return }
  if (-not (Test-Path -LiteralPath $source) -or (Sha $source) -ne $to) { "STOP: $source is not the policy to install; nothing changed"; return }
  $live=Sha $pol
  "before: the host policy is $(PolicyName $live); the agent started $(AgentRead) it was written"
  $fresh=$false
  if ($live -eq $to) {
    if ((AgentRead) -eq 'after') { "DONE hostpolicy (the file is already $(PolicyName $to) and the agent started after it was written)"; return }
    'the file is already this policy but the agent is older than the file: restarting the agent only'
  } elseif ($live -ne $from) { 'STOP: the host policy is neither the previous nor the new file; nothing changed'; return }
  else {
    if ($to -eq $polNew -and -not (Test-Path -LiteralPath $polKeep)) { Copy-Item -LiteralPath $pol -Destination $polKeep }
    if (-not (Test-Path -LiteralPath $back) -or (Sha $back) -ne $from) { "STOP: $back is not the policy in place now, so there would be no way back; nothing changed"; return }
    try { PutPolicy $source } catch { "STOP: the policy file could not be replaced ($(Cut $_.Exception.Message 160)); the host policy is $(PolicyName (Sha $pol)) and the agent was not restarted"; return }
    if ((Sha $pol) -ne $to) { "STOP: the policy file reads back as $(PolicyName (Sha $pol)); the agent was not restarted"; return }
    $fresh=$true
    "the host policy is now $(PolicyName $to)"
  }
  RestartAgent
  $c=$(if ($script:circuit) { 'its control circuit is up' } else { 'its control circuit was NOT up within three minutes' })
  if (-not $script:agentWhy) { "DONE hostpolicy $(Cut $to 16): the agent runs on it; $c"; return }
  if (-not $fresh) { "STOP: $($script:agentWhy); the policy file was not changed by this run"; return }
  "$($script:agentWhy): putting the previous policy back"
  $why=$script:agentWhy
  PutPolicy $back
  RestartAgent
  "STOP: $why on the new policy; the host policy is back to $(PolicyName (Sha $pol)) and " + $(if ($script:agentWhy) { "the agent: $($script:agentWhy)" } else { 'the agent runs on it' })
}

# Read only: the desktop VM the manager lists and what the node and the agent logged for KVM Box since $since
# (HH:mm:ss, today). Ends DONE launch STATUS, where STATUS is the VM's status, 'gave-up' or 'none'.
function Do-Launch {
  $st='none'
  try {
    $v=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 8).Content | ConvertFrom-Json
    $l=@($v); if ($v.vms) { $l=@($v.vms) }
    foreach ($d in @($l | Where-Object { $_.image -eq $new -or $_.cid -eq $cid })) {
      $st=[string]$d.status
      "desktop VM $(Cut $d.id 14): status=$($d.status) appReady=$($d.appReady) launching=$($d.launching) started=$($d.startedAt) reason=$(Cut $d.reason 140)"
    }
  } catch { 'the manager did not answer /vms' }
  if (-not $since) { $since='00:00:00' }
  $mine={ param($x) $x -match $kvm -and $x -notmatch $private -and $x.Length -ge 8 -and $x.Substring(0,8) -ge $since }
  $n=@((ReadFrom $nlog ((Get-Item -LiteralPath $nlog).Length-600000)) -split "`n" | Where-Object { & $mine $_ })
  $n | Select-Object -Last 12 | ForEach-Object { '  ' + (Cut $_.TrimEnd() 230) }
  @((ReadFrom $netlog ((Get-Item -LiteralPath $netlog).Length-600000)) -split "`n" | Where-Object { & $mine $_ }) | Select-Object -Last 6 | ForEach-Object { '  ' + (Cut $_.TrimEnd() 230) }
  if ($st -eq 'none' -and @($n | Where-Object { $_ -match 'giving up on' }).Count) { $st='gave-up' }
  "DONE launch $st $(Utc)"
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
  'staged-policy' { Do-StagedPolicy }
  'hostpolicy'    { Set-HostPolicy $polOld $polNew $polStaged $polKeep }
  'hostpolicy-revert' { Set-HostPolicy $polNew $polOld $polKeep $polStaged }
  'launch'        { Do-Launch }
  default         { "STOP: unknown mode '$mode'; nothing changed" }
}
