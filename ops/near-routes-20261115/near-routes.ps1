# NucBox, 2026-11-15: near routes (main 1b06202c3) and the enrollment cadence (main 206f85fd5) on the files this box
# runs, and enclaveNetwork.nearRoutes true in its network agent's configuration. README.md beside this file has what
# the three replaced files are made from and what was checked.
#
# Run by near-routes.sh, which writes $mode='...' in front of this text and feeds the whole of it to PowerShell as ONE
# script block: a syntax error anywhere means nothing runs. Every mode ends with a line that starts DONE or STOP; the
# caller goes by that line, not by the exit status.
#
# What runs where on this box:
#   \Enclave\Node     run-node.cmd loop    node.exe C:\Program Files\Enclave\control\windows\node\agent.mjs (source
#                                          files; network-enroll.mjs is imported when the node starts)
#   \Enclave\Network  run-network.cmd loop node.exe C:\Program Files\Enclave\network\privacy-agent.mjs (one bundle);
#                                          the loop starts it again 10 s after it ends
# The Shield manager (\Enclave\Shield, 127.0.0.1:8091) is never touched here.
#
# Order, and why. The node's enrollment pass compares the enclaveNetwork section of privacy-config.json with the one it
# would write and, when they differ, replaces it and ends the agent. The installed network-enroll.mjs does not know
# nearRoutes: it would remove the field within five minutes. So:
#   node    the two node files, then the Node task alone. The apps' VMs keep running (the node adopts them by name).
#   agent   only with the new node running: the bundle, the field, then the agent process. Every circuit of every app
#           on the box is built again; the apps have no route for the 10 s and until the first chain read.
#
# Guards. A file is replaced only when it is, by SHA-256, the file this release was made from, and its replacement is
# the staged file with its own SHA-256. The replaced file stays beside it with the suffix in $stamp. A mode that finds
# anything else stops with nothing changed. A task that was ended is always started again. A step that does not
# come up puts the previous files back itself and says so.
$ErrorActionPreference='Stop'
$root='C:\ProgramData\Enclave'
$dir="$root\near-routes-20261115"
$tp='\Enclave\'
$nodeExe='C:\Program Files\Enclave\runtime\node\node.exe'
$cfg="$root\network\privacy-config.json"
$statusFile="$root\network\state\status.json"
$nlog="$root\logs\node.log"
$netlog="$root\logs\network.log"
$stamp='before-near-routes-20261115'
$marker="$dir\node-restarted.json"
$helper="$dir\set-near-routes.cjs"
$helperSha='97483089f274b27797de979c99980e0917c40ac17fbac10d37da6a563a2cbd8a'
$private='key|secret|token|password'
# target, staged copy, the installed file (bytes, sha256), the file of this release (bytes, sha256)
$bundle=@{ name='privacy-agent.mjs'; target='C:\Program Files\Enclave\network\privacy-agent.mjs'; staged="$dir\network\privacy-agent.mjs"
  oldBytes=2951587; old='5f463944507f8c447daad847c0588fb111ee9f4427dcaa76458162df12ed6366'
  newBytes=2956624; new='576d69da448d7a86239717c88e9eb06d5dfa30b88981cfca7a4cb4062fe06ee8' }
$nodeAgent=@{ name='agent.mjs'; target='C:\Program Files\Enclave\control\windows\node\agent.mjs'; staged="$dir\node\agent.mjs"
  oldBytes=93212; old='a41ca4cd59252d6a00648fda88232e97fe92049c8142dc1bf7910ae38ecae1a4'
  newBytes=92268; new='f262b30eccc719cba58b0f9b6d59b1880f91450fb4046c0a0ce1adfef4553eac' }
$nodeEnroll=@{ name='network-enroll.mjs'; target='C:\Program Files\Enclave\control\windows\node\network-enroll.mjs'; staged="$dir\node\network-enroll.mjs"
  oldBytes=16963; old='5c01acb17aa538f9407d7c09176930222284ea6296bb8f0aedeb576e5ae4e0da'
  newBytes=21210; new='3ba1282c1303044e7ed8ed0fbeaf71fb5cef70836c1d9d0497a3101525b86a09' }
$all=@($bundle,$nodeAgent,$nodeEnroll)

function Utc { (Get-Date).ToUniversalTime().ToString('HH:mm:ssZ') }
function Cut($s,$n) { $s=[string]$s; $s.Substring(0,[Math]::Min($n,$s.Length)) }
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function KeepOf($f) { "$($f.target).$stamp" }

# 'installed' (the file this release was made from), 'new' (this release's), 'missing', or 'another file'
function State($f) {
  if (-not (Test-Path -LiteralPath $f.target)) { return 'missing' }
  $h=Sha $f.target
  if ($h -eq $f.old) { 'installed' } elseif ($h -eq $f.new) { 'new' } else { "another file ($(Cut $h 12))" }
}

# '' when every staged file is present with its size and SHA-256, else what is wrong
function Staged {
  $bad=@()
  foreach ($f in $all) {
    if (-not (Test-Path -LiteralPath $f.staged)) { $bad+="$($f.name) is missing"; continue }
    $len=(Get-Item -LiteralPath $f.staged).Length
    if ($len -ne $f.newBytes) { $bad+="$($f.name) has $len bytes"; continue }
    if ((Sha $f.staged) -ne $f.new) { $bad+="$($f.name) has another SHA-256" }
  }
  if (-not (Test-Path -LiteralPath $helper)) { $bad+='set-near-routes.cjs is missing' }
  elseif ((Sha $helper) -ne $helperSha) { $bad+='set-near-routes.cjs has another SHA-256' }
  $bad -join '; '
}

function Tasks {
  $a=Get-ScheduledTask -TaskPath $tp -TaskName Node -ErrorAction SilentlyContinue
  $b=Get-ScheduledTask -TaskPath $tp -TaskName Network -ErrorAction SilentlyContinue
  if ($null -eq $a -or $null -eq $b) { return 'the tasks \Enclave\Node and \Enclave\Network were not both found' }
  if (-not (Test-Path -LiteralPath $nodeExe)) { return 'node.exe was not found where this box keeps it' }
  ''
}
function Guard {
  $t=Tasks; if ($t) { return $t }
  $s=Staged; if ($s) { return "the release is not staged: $s" }
  ''
}

# The replaced file is kept once. A kept copy that is not the installed file means an earlier change this release
# knows nothing about: stop.
function Keep($f) {
  $k=KeepOf $f
  if (Test-Path -LiteralPath $k) { if ((Sha $k) -ne $f.old) { throw "the kept copy of $($f.name) is not the installed file" }; return }
  Copy-Item -LiteralPath $f.target -Destination $k
  if ((Sha $k) -ne $f.old) { throw "the copy kept of $($f.name) did not verify" }
}
# Replace $target in one step with the bytes of $source. File.Replace keeps the replaced file's access list.
function Put($source,$target) {
  $tmp="$target.near-new"
  [IO.File]::WriteAllBytes($tmp,[IO.File]::ReadAllBytes($source))
  try { [IO.File]::Replace($tmp,$target,[NullString]::Value) } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function PutNew($f) { Put $f.staged $f.target; if ((State $f) -ne 'new') { throw "$($f.name) did not verify after it was replaced" } }
function PutOld($f) { Put (KeepOf $f) $f.target; if ((State $f) -ne 'installed') { throw "$($f.name) did not verify after it was put back" } }

function ReadFrom($log,$mark) {
  $fs=[IO.File]::Open($log,'Open','Read','ReadWrite')
  try { if ($mark -lt 0 -or $fs.Length -lt $mark) { $mark=0 }; $null=$fs.Seek($mark,'Begin'); (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
}
function Lines($text,$pattern) { @($text -split "`n" | Where-Object { $_ -match $pattern -and $_ -notmatch $private }) }
function Mask($l) { Cut (([string]$l).TrimEnd() -replace '[0-9a-fA-F]{24,}','(hex)' -replace '(\d{1,3}\.){3}\d{1,3}','(addr)') 220 }

function NodeProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'Enclave\\control\\windows\\node\\agent\.mjs' }) }
function Agents { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }) }
function Started($p) { $p.CreationDate.ToUniversalTime().ToString('MM-dd HH:mm:ssZ') }

# VMs the manager lists and how many of them it holds as recovered or unattributed; count -1 when it does not answer
function Vms {
  try { $v=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 8).Content | ConvertFrom-Json } catch { return @{count=-1;held=0} }
  $l=@($v); if ($v.vms) { $l=@($v.vms) }
  @{count=$l.Count; held=@($l | Where-Object { $_.recovered -eq $true -or $_.unattributed -eq $true }).Count}
}

# One line from set-near-routes.cjs (SHOW / SAME / SET / STOP). It prints field names, never a value.
function Flag($m) {
  $ErrorActionPreference='Continue'
  $o=@(& $nodeExe $helper $cfg $m 2>$null | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
  if ($o.Count) { $o[-1].Trim() } else { 'STOP: the configuration tool printed nothing' }
}
function FlagOn { (Flag 'show') -match '^SHOW nearRoutes true \(after paceMbps\)' }
function FlagAbsent { (Flag 'show') -match '^SHOW nearRoutes absent' }

function Loopback {
  $ErrorActionPreference='Continue'
  @(& "$env:SystemRoot\System32\CheckNetIsolation.exe" LoopbackExempt -s 2>$null | Where-Object { ([string]$_).Trim().StartsWith('SID:') }).Count
}

function Status { try { Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json } catch { $null } }
# apps in the agent's status that have at least one healthy circuit; -1 when the status cannot be read
function HealthyApps($s) { if (-not $s) { return -1 }; @(@($s.apps) | Where-Object { @($_.circuits | Where-Object { $_.healthy -eq $true }).Count -gt 0 }).Count }
function Circuits {
  $s=Status
  if (-not $s) { '  the agent status could not be read'; return }
  "  agent status written $((Get-Item -LiteralPath $statusFile).LastWriteTimeUtc.ToString('HH:mm:ssZ')): $(@($s.apps).Count) apps, $(HealthyApps $s) with a healthy circuit"
  foreach ($a in @($s.apps)) {
    $n=0
    foreach ($c in @($a.circuits)) {
      $n++
      $r=''; if ($c.rttMs) { $r=" | host to guard $($c.rttMs.guard) ms, host to exit $($c.rttMs.exit) ms" }
      $b=''; if ($c.PSObject.Properties.Name -contains 'standby') { if ($c.standby) { $b=' STANDBY (not in the name)' } else { $b=' listed' } }
      "  $(Cut $a.deploymentId 10) circuit $n guard $($c.guard.region) -> exit $($c.exit.region) healthy=$($c.healthy)$b$r"
    }
  }
}

# End a task with its restart loop and the process the loop runs, then start the task. The start is in finally:
# whatever fails in between, the task is not left stopped.
function CycleNode {
  try {
    Stop-ScheduledTask -TaskPath $tp -TaskName Node -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'run-node' } | ForEach-Object { "  ending the task's restart loop, pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-NetTCPConnection -LocalPort 9600 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { "  ending the listener on 9600, pid $($_.OwningProcess)"; Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    NodeProcs | ForEach-Object { "  ending pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  } finally {
    Start-ScheduledTask -TaskPath $tp -TaskName Node
    "  task Node started $(Utc)"
  }
}
# the node's own line that it is listed in the registry, written after $mark; '' if none within $seconds
function WaitListed($mark,$seconds) {
  for ($i=0; $i -lt $seconds; $i+=5) {
    Start-Sleep -Seconds 5
    $l=Lines (ReadFrom $nlog $mark) 'registry: listed as' | Select-Object -Last 1
    if ($l) { return (Mask $l) }
  }
  ''
}

# End the network agent and wait for the one its task starts. $script:agentWhy is '' when a new agent is running, its
# control circuit came up within five minutes and it is still the same process, else what happened.
# $script:agentMark is where network.log stood before.
function RestartAgent {
  $script:agentWhy=''
  $script:agentMark=(Get-Item -LiteralPath $netlog).Length
  $was=@(Agents | ForEach-Object { $_.ProcessId })
  foreach ($p in $was) { "  ending the network agent, pid $p $(Utc)"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  $now=$null
  for ($i=0; $i -lt 90 -and -not $now; $i+=3) { Start-Sleep -Seconds 3; $now=Agents | Where-Object { $was -notcontains $_.ProcessId } | Select-Object -First 1 }
  if (-not $now) { $script:agentWhy='no new agent process within 90 s'; return }
  "  network agent started, pid $($now.ProcessId) $(Utc)"
  $script:agentStart=$now.CreationDate
  $up=$false
  for ($i=0; $i -lt 300 -and -not $up; $i+=5) { Start-Sleep -Seconds 5; $up=[bool](@(Lines (ReadFrom $netlog $script:agentMark) 'control circuit up').Count) }
  if (@(Agents | Where-Object { $_.ProcessId -eq $now.ProcessId }).Count -ne 1) { $script:agentWhy='the new agent did not stay up'; return }
  if (-not $up) { $script:agentWhy='no control circuit within 300 s'; return }
  "  control circuit up $(Utc)"
}
function AgentReport {
  $t=ReadFrom $netlog $script:agentMark
  "  since the restart: $(@(Lines $t 'egress back').Count) egress back, $(@(Lines $t 'egress OFF').Count) egress OFF, $(@(Lines $t 'panic: exit status').Count) helper refusals, $(@(Lines $t 'tunnel process exited').Count) tunnel exits"
  $m=Lines $t 'near routes: measured' | Select-Object -Last 1
  if ($m) { '  ' + (Mask $m) } else { '  no "near routes: measured" line since the restart' }
  Lines $t 'control circuit up|chain authorization|Enclave network:' | Select-Object -Last 4 | ForEach-Object { '  ' + (Mask $_) }
  Circuits
  "  loopback exemptions: $(Loopback) of 682"
}

function Do-Prepare {
  if (-not (Test-Path -LiteralPath $root)) { 'STOP: C:\ProgramData\Enclave was not found; nothing changed'; return }
  foreach ($d in @($dir,"$dir\network","$dir\node")) { if (-not (Test-Path -LiteralPath $d)) { $null=New-Item -ItemType Directory -Path $d; "created $d" } }
  # SYSTEM and Administrators only, nothing inherited
  $null=& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
  'DONE prepare'
}
function Do-Verify { $s=Staged; if ($s) { "STOP: $s" } else { 'DONE staged' } }

function Do-Status {
  "NucBox $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))"
  foreach ($f in $all) {
    $k=KeepOf $f; $kept='no kept copy'; if (Test-Path -LiteralPath $k) { if ((Sha $k) -eq $f.old) { $kept='previous file kept beside it' } else { $kept='a kept copy that is NOT the installed file' } }
    "  $($f.name): $(State $f) ($kept)"
  }
  $s=Staged; if ($s) { "  staged: NO ($s)" } else { '  staged: yes, all four files verify' }
  if (-not $s) { '  ' + (Flag 'show') }
  $n=@(NodeProcs); $a=@(Agents)
  "  node processes: $($n.Count)" + $(if ($n.Count) { ", started $(Started $n[0])" })
  "  network agents: $($a.Count)" + $(if ($a.Count) { ", started $(Started $a[0])" })
  if ($n.Count -eq 1) { foreach ($f in @($nodeAgent,$nodeEnroll)) { if ($n[0].CreationDate -lt (Get-Item -LiteralPath $f.target).LastWriteTime) { "  the node started BEFORE $($f.name) was last written: it does not run that file" } } }
  if ($a.Count -eq 1 -and $a[0].CreationDate -lt (Get-Item -LiteralPath $bundle.target).LastWriteTime) { '  the agent started BEFORE privacy-agent.mjs was last written: it does not run that file' }
  if (Test-Path -LiteralPath $marker) {
    $m=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    $t=ReadFrom $nlog ([long]$m.nodeLogOffset)
    "  node restarted by this release $($m.at); since then: $(@(Lines $t '\[network\] enrollment loop:').Count) enrollment loop error(s), $(@(Lines $t '\[network\] enrollment:').Count) enrollment error line(s), $(@(Lines $t 'registry: listed as').Count) listing line(s)"
    Lines $t '\[network\]' | Select-Object -Last 4 | ForEach-Object { '    ' + (Mask $_) }
  } else { '  node not restarted by this release (no marker)' }
  $v=Vms; if ($v.count -lt 0) { '  the Shield manager does not answer' } else { "  manager: $($v.count) VMs, $($v.held) recovered or unattributed" }
  "  loopback exemptions: $(Loopback) of 682"
  $m=Lines (ReadFrom $netlog ([Math]::Max(0,(Get-Item -LiteralPath $netlog).Length-20000000))) 'near routes: measured' | Select-Object -Last 1
  if ($m) { '  ' + (Mask $m) } else { '  no "near routes: measured" line in the agent log' }
  Circuits
  'DONE status'
}

function Do-Node {
  $g=Guard; if ($g) { "STOP: $g; nothing changed"; return }
  $a=State $nodeAgent; $e=State $nodeEnroll
  $n=@(NodeProcs)
  if ($n.Count -ne 1) { "STOP: expected one node process, found $($n.Count); nothing changed"; return }
  $restartOnly=$false
  if ($a -eq 'new' -and $e -eq 'new') {
    $newer=@(@($nodeAgent,$nodeEnroll) | Where-Object { $n[0].CreationDate -lt (Get-Item -LiteralPath $_.target).LastWriteTime }).Count
    if (-not $newer -and (Test-Path -LiteralPath $marker)) { "DONE node: both files are this release's and the node started after them ($(Started $n[0])); nothing changed"; return }
    $restartOnly=$true
  } elseif ($a -ne 'installed' -or $e -ne 'installed') { "STOP: agent.mjs is $a and network-enroll.mjs is $e, not the two files this release was made from; nothing changed"; return }
  $v=Vms
  if ($v.count -lt 0) { 'STOP: the Shield manager does not answer; the Node is not restarted beside a manager that is down; nothing changed'; return }
  if ($v.held -gt 0) { "STOP: the manager holds $($v.held) recovered or unattributed VM(s); the Node is not restarted until none is left; nothing changed"; return }
  "node process $($n[0].ProcessId), started $(Started $n[0]); manager lists $($v.count) VMs, none recovered"
  $mark=(Get-Item -LiteralPath $nlog).Length
  if (-not $restartOnly) {
    try { Keep $nodeAgent; Keep $nodeEnroll } catch { "STOP: $($_.Exception.Message); nothing changed"; return }
    try { PutNew $nodeEnroll; PutNew $nodeAgent }
    catch {
      "the files could not be replaced: $($_.Exception.Message)"
      foreach ($f in @($nodeAgent,$nodeEnroll)) { if ((State $f) -ne 'installed') { try { PutOld $f } catch { "  $($f.name) could NOT be put back: $($_.Exception.Message)" } } }
      "STOP: agent.mjs is $(State $nodeAgent), network-enroll.mjs is $(State $nodeEnroll); the Node was not restarted"; return
    }
    "agent.mjs and network-enroll.mjs replaced $(Utc); the previous files are beside them (.$stamp)"
  } else { 'both files are already this release; the node is older than they are: restarting it' }
  CycleNode
  $why=''
  $l=WaitListed $mark 360
  if (-not $l) { $why='the node did not list itself within 360 s' }
  else {
    "  $l"
    $p1=@(NodeProcs | ForEach-Object { $_.ProcessId })
    # the first look of the new enrollment loop is 60 s after the node starts
    Start-Sleep -Seconds 80
    $t=ReadFrom $nlog $mark
    $p=@(NodeProcs | ForEach-Object { $_.ProcessId })
    if (@(Lines $t '\[network\] enrollment loop:').Count) { $why='the new enrollment loop reported an error' }
    elseif ($p.Count -ne 1) { $why="$($p.Count) node processes" }
    elseif ($p1.Count -ne 1 -or $p1[0] -ne $p[0]) { $why='the node process did not stay the same one for 80 s' }
  }
  $t=ReadFrom $nlog $mark
  Lines $t '\[network\]|isolation adopted|registry:' | Select-Object -Last 12 | ForEach-Object { '  ' + (Mask $_) }
  if ($why) {
    "NOT UP: $why. Putting the previous files back $(Utc)"
    try { PutOld $nodeAgent; PutOld $nodeEnroll } catch { "STOP: the previous files could NOT be put back: $($_.Exception.Message). agent.mjs is $(State $nodeAgent), network-enroll.mjs is $(State $nodeEnroll)"; return }
    $mark2=(Get-Item -LiteralPath $nlog).Length
    CycleNode
    $l=WaitListed $mark2 360
    if ($l) { "  $l" } else { '  the node with the previous files did NOT list itself within 360 s either' }
    "STOP: $why; the previous node files are back and the Node was restarted with them"; return
  }
  $o=New-Object psobject -Property @{ at=(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'); nodeLogOffset=$mark }
  [IO.File]::WriteAllText($marker,($o | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
  $v=Vms; "manager: $($v.count) VMs, $($v.held) recovered or unattributed"
  "DONE node: listed, one node process, no enrollment loop error in its first passes"
}

# '' when the new node is what runs, else why not
function NodeIsNew {
  if ((State $nodeAgent) -ne 'new' -or (State $nodeEnroll) -ne 'new') { return "the node files are not this release's (agent.mjs $(State $nodeAgent), network-enroll.mjs $(State $nodeEnroll)): run the node step first" }
  $n=@(NodeProcs)
  if ($n.Count -ne 1) { return "expected one node process, found $($n.Count)" }
  foreach ($f in @($nodeAgent,$nodeEnroll)) { if ($n[0].CreationDate -lt (Get-Item -LiteralPath $f.target).LastWriteTime) { return "the node started before $($f.name) was written: run the node step first" } }
  if (((Get-Date)-$n[0].CreationDate).TotalSeconds -lt 120) { return 'the node has been up for less than two minutes: wait and run this again' }
  if (-not (Test-Path -LiteralPath $marker)) { return 'the node step left no marker: run the node step first' }
  $m=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if (@(Lines (ReadFrom $nlog ([long]$m.nodeLogOffset)) '\[network\] enrollment loop:').Count) { return 'the node logged an enrollment loop error since its restart' }
  ''
}

# the field off, the previous bundle back, the agent restarted
function UndoAgent {
  "  field: $(Flag 'off')"
  try { if ((State $bundle) -ne 'installed') { PutOld $bundle }; '  privacy-agent.mjs: the previous file is back' } catch { "  privacy-agent.mjs could NOT be put back: $($_.Exception.Message)" }
  RestartAgent
  if ($script:agentWhy) { "  the agent with the previous file: $($script:agentWhy)" } else { AgentReport }
}

function Do-Agent {
  $g=Guard; if ($g) { "STOP: $g; nothing changed"; return }
  $w=NodeIsNew; if ($w) { "STOP: $w; nothing changed"; return }
  $b=State $bundle
  $ag=@(Agents)
  if ($ag.Count -ne 1) { "STOP: expected one network agent, found $($ag.Count); nothing changed"; return }
  $show=Flag 'show'; "  $show"
  if ($show -notmatch '^SHOW ') { 'STOP: the configuration could not be read; nothing changed'; return }
  if ($show -notmatch 'paceMbps present') { 'STOP: the configuration has no paceMbps, the place the node writes nearRoutes after; nothing changed'; return }
  if ($b -eq 'new' -and (FlagOn) -and $ag[0].CreationDate -gt (Get-Item -LiteralPath $bundle.target).LastWriteTime -and $ag[0].CreationDate -gt (Get-Item -LiteralPath $cfg).LastWriteTime) {
    Circuits; 'DONE agent: the bundle and the field are in place and the agent started after both; nothing changed'; return }
  if ($b -ne 'installed' -and $b -ne 'new') { "STOP: privacy-agent.mjs is $b, not the file this release was made from; nothing changed"; return }
  if ($b -eq 'installed' -and -not (FlagAbsent)) { 'STOP: nearRoutes is already in the configuration beside the installed bundle; nothing changed'; return }
  $lb=Loopback
  if ($lb -gt 560) { "STOP: the loopback-exemption list holds $lb of 682; an agent restart adds the running circuits' entries. Run nucbox-loopback.sh prune first; nothing changed"; return }
  $before=HealthyApps (Status)
  "one agent, pid $($ag[0].ProcessId), started $(Started $ag[0]); apps with a healthy circuit: $before; loopback exemptions: $lb of 682"
  Circuits
  if ($b -eq 'installed') {
    try { Keep $bundle } catch { "STOP: $($_.Exception.Message); nothing changed"; return }
    try { PutNew $bundle } catch {
      "the bundle could not be replaced: $($_.Exception.Message)"
      if ((State $bundle) -ne 'installed') { try { PutOld $bundle } catch { "  it could NOT be put back: $($_.Exception.Message)" } }
      "STOP: privacy-agent.mjs is $(State $bundle); the agent was not restarted"; return
    }
    "privacy-agent.mjs replaced $(Utc); the previous file is beside it (.$stamp)"
  }
  $set=Flag 'on'; "  field: $set"
  if ($set -notmatch '^(SET on|SAME )') {
    try { PutOld $bundle; "STOP: the field could not be set; the previous bundle is back and the agent was not restarted" } catch { "STOP: the field could not be set and the previous bundle could NOT be put back: $($_.Exception.Message)" }
    return
  }
  RestartAgent
  if (-not $script:agentWhy) {
    # every app's circuits are built again; give them up to five minutes to be as many as before
    # $h stays -1 while the new agent has not written its status
    $h=-1
    for ($i=0; $i -lt 300; $i+=10) {
      Start-Sleep -Seconds 10
      if ((Get-Item -LiteralPath $statusFile).LastWriteTime -gt $script:agentStart) { $h=HealthyApps (Status) }
      if ($h -ge [Math]::Max(1,$before)) { break }
    }
    if ($h -eq 0) { $script:agentWhy="no app has a healthy circuit five minutes after the control circuit came up" }
  }
  if ($script:agentWhy) {
    "NOT UP: $($script:agentWhy). Taking the change back $(Utc)"
    Lines (ReadFrom $netlog $script:agentMark) '.' | Select-Object -Last 12 | ForEach-Object { '  ' + (Mask $_) }
    UndoAgent
    "STOP: $($script:agentWhy); the field is off, the previous bundle is back and the agent was restarted with it"; return
  }
  AgentReport
  if ($h -lt 0) { 'NOTE: the new agent has not written its status yet, so its circuits were not counted. Look again with the status mode; revert-agent takes the change back' }
  elseif ($h -lt $before) { "NOTE: $h apps have a healthy circuit, $before had one before. Look again with the status mode; revert-agent takes the change back" }
  if (-not (FlagOn)) { 'NOTE: nearRoutes is no longer true after paceMbps in the configuration: the node rewrote the section' }
  'DONE agent'
}

function Do-RevertAgent {
  $t=Tasks; if ($t) { "STOP: $t; nothing changed"; return }
  $b=State $bundle
  if (-not (Test-Path -LiteralPath $helper) -or (Sha $helper) -ne $helperSha) { 'STOP: set-near-routes.cjs is not staged; nothing changed'; return }
  if ($b -eq 'installed' -and (FlagAbsent)) { 'STOP: the installed bundle is in place and the field is absent: there is nothing to take back; nothing changed'; return }
  if ($b -ne 'installed') {
    if ($b -ne 'new') { "STOP: privacy-agent.mjs is $b, neither this release's file nor the one before it; nothing changed"; return }
    $k=KeepOf $bundle
    if (-not (Test-Path -LiteralPath $k) -or (Sha $k) -ne $bundle.old) { 'STOP: the kept copy of the previous bundle is missing or is another file; nothing changed'; return }
  }
  UndoAgent
  if ($script:agentWhy) { "STOP: $($script:agentWhy)"; return }
  'DONE revert-agent'
}

function Do-RevertNode {
  $t=Tasks; if ($t) { "STOP: $t; nothing changed"; return }
  if ((State $bundle) -ne 'installed') { 'STOP: the bundle of this release is still installed: run revert-agent first; nothing changed'; return }
  if ((Test-Path -LiteralPath $helper) -and -not (FlagAbsent)) { 'STOP: nearRoutes is still in the configuration and the previous node would remove it and restart the agent: run revert-agent first; nothing changed'; return }
  $a=State $nodeAgent; $e=State $nodeEnroll
  if ($a -eq 'installed' -and $e -eq 'installed') { 'STOP: both node files are the previous ones already; nothing changed'; return }
  foreach ($f in @($nodeAgent,$nodeEnroll)) { $k=KeepOf $f; if (-not (Test-Path -LiteralPath $k) -or (Sha $k) -ne $f.old) { "STOP: the kept copy of $($f.name) is missing or is another file; nothing changed"; return } }
  $v=Vms
  if ($v.count -lt 0 -or $v.held -gt 0) { "STOP: the Shield manager does not answer or holds recovered VMs ($($v.held)); nothing changed"; return }
  $mark=(Get-Item -LiteralPath $nlog).Length
  try { PutOld $nodeAgent; PutOld $nodeEnroll } catch { "STOP: $($_.Exception.Message). agent.mjs is $(State $nodeAgent), network-enroll.mjs is $(State $nodeEnroll); the Node was not restarted"; return }
  "the previous agent.mjs and network-enroll.mjs are back $(Utc)"
  CycleNode
  $l=WaitListed $mark 360
  if (-not $l) { 'STOP: the node with the previous files did not list itself within 360 s'; return }
  "  $l"
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  'DONE revert-node'
}

try {
  switch ($mode) {
    'prepare' { Do-Prepare }
    'verify' { Do-Verify }
    'status' { Do-Status }
    'node' { Do-Node }
    'agent' { Do-Agent }
    'revert-agent' { Do-RevertAgent }
    'revert-node' { Do-RevertNode }
    default { "STOP: unknown mode '$mode'" }
  }
} catch { "STOP: $($_.Exception.Message) (in $mode, line $($_.InvocationInfo.ScriptLineNumber))" }
