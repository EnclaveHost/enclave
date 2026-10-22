# policy-mock.ps1 - run node-policy-activation.ps1 UNCHANGED against a simulated nucbox on Linux pwsh 7 (tests only).
# Derived from root's cutover-review/candidate/tools/cutover-mock.ps1 (same cmdlet mocks, simulated clock, scratch root). Differences:
# the wallet hold is ALREADY enforced (the pinned node heartbeats generation G0 from gen0.txt); every node start writes a NEW
# generation EMPTY, then allows the expected ids; the node's gate reads node-config.local.cmd: "set ENCLAVE_PLATFORM_HOST_POLICY=
# production" turns it ON and, by scenario, it admits ("[host-policy] this host is ADMITTED"), stays unreadable, bans (persists
# node/platform-host-admission.json knownRefusal) or flaps once; the lease pass is READY only while an ON gate admits (host.mjs
# leaseServing). The privacy agent applies the current document (fresh while unexpired). The gate proof runs the REAL
# gate-proof.mjs in a real node child against tools/fake-bundle.mjs (scenario in fake-gate.json, written by the driver).
param([string]$Script, [string]$Root, [string]$ParamsFile, [string]$ParamsSha, [string]$Mode = 'activate', [string]$Scenario = 'ok')
$global:S = @{ clock = [datetime]::new(2026, 10, 22, 4, 30, 0, [DateTimeKind]::Utc); next = 50000; procs = [System.Collections.ArrayList]::new()
  respawnAt = $null; scenario = $Scenario; root = $Root; starts = 0; gens = @{}; rev = 0; admitted = $false; policyLogged = @{}
  runner = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'; ids = @(Get-Content (Join-Path $Root 'expected-ids.txt')) }
function global:SimMs { [DateTimeOffset]::new($global:S.clock).ToUnixTimeMilliseconds() }
function global:Proc($name, $cmd, $ppid, $procId = 0) { if (-not $procId) { $procId = $global:S.next++ }
  $o = [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $global:S.clock.AddMilliseconds($procId % 997); ExecutablePath = 'x' }
  [void]$global:S.procs.Add($o); return $o }
$st = Get-Content (Join-Path $Root 'procs.json') | ConvertFrom-Json
$global:S.next = 1 + [int](@($st | ForEach-Object { [int]$_.pid }) + 50000 | Measure-Object -Maximum).Maximum
foreach ($p in $st) { $o = Proc $p.name $p.cmd $p.ppid $p.pid; $o.CreationDate = $(if ($p.start -is [datetime]) { $p.start.ToUniversalTime() } else { [datetime]::Parse($p.start).ToUniversalTime() }) }
$a0 = @($global:S.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' })[0]; $global:S.gens[[int]$a0.ProcessId] = (Get-Content (Join-Path $Root 'gen0.txt')).Trim()
$global:S.agentAt = @{}; $global:S.agentAt[[int]$a0.ProcessId] = $global:S.clock.AddHours(-1)
function global:NodeLog($line) { Add-Content -LiteralPath (Join-Path $global:S.root 'logs/node.log') -Value ("$($global:S.clock.ToString('o')) $line") }
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds); Sim }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  $all = @($global:S.procs)
  if ($Filter -match "^Name='(.+)'$") { $n = $matches[1]; return @($all | Where-Object { $_.Name -eq $n }) }
  if ($Filter -match '^ProcessId=(\d+)$') { $i = [int]$matches[1]; return ($all | Where-Object { $_.ProcessId -eq $i } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
  if ($LocalPort -eq 9600) { $p=@($global:S.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }); return @($p | ForEach-Object { [pscustomobject]@{ OwningProcess = $_.ProcessId } }) }
  @([pscustomobject]@{ OwningProcess = 4001 }) }
function global:Get-VM { param($ErrorAction)
  $v = @(Get-Content (Join-Path $global:S.root 'hyperv.json') | ConvertFrom-Json)
  if ($global:S.scenario -eq 'vm-replaced' -and $global:S.starts -ge 1) { $v[0].Id = 'ffffffff-0000-0000-0000-000000000000' }
  return $v }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $t = foreach ($n in 'Card', 'Network', 'Node', 'Relay', 'Shield') { [pscustomobject]@{ TaskName = $n; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = "/c `"C:\ProgramData\Enclave\run-$($n.ToLower()).cmd`"" }) } }
  $t = @($t) + [pscustomobject]@{ TaskName = 'Update'; State = $(if ($global:S.scenario -eq 'update-running') { 'Running' } else { 'Ready' }); Settings = [pscustomobject]@{ Enabled = $true }
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\Enclave\update-host.ps1"' }) }
  if ($TaskName) { $t | Where-Object { $_.TaskName -eq $TaskName } } else { $t } }
function global:Get-ScheduledTaskInfo { param($InputObject, $ErrorAction)
  [pscustomobject]@{ NextRunTime = $global:S.clock.AddMinutes($(if ($global:S.scenario -eq 'update-due') { 5 } else { 45 })) } }
function global:Stop-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be stopped, not $TaskName" }
  $s = $global:S; $survive = ($s.scenario -eq 'agent-unkillable')
  foreach ($c in @($s.procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-node.cmd*' })) { $s.procs.Remove($c)
    if (-not $survive) { foreach ($a in @($s.procs | Where-Object { $_.ParentProcessId -eq $c.ProcessId })) { $s.procs.Remove($a) } } }
  SaveProcs; Add-Content (Join-Path $s.root 'node-stops.txt') ('stop ' + $s.clock.ToString('o'))
  if ($s.scenario -eq 'throw-after-task-stop' -and -not $s.stopCrash) { $s.stopCrash = $true; throw 'mock: stop completed but task response failed' } }
function global:Start-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be started" }
  $s = $global:S; $c = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"' 1
  $a = Proc 'node.exe' '"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"' $c.ProcessId
  $s.starts++; $s.agentAt[[int]$a.ProcessId] = $s.clock; $s.admitted = $false; $s.policyLogged = @{}
  $s.policyOn = ([IO.File]::ReadAllText((Join-Path $s.root 'node-config.local.cmd'))) -match '(?m)^set ENCLAVE_PLATFORM_HOST_POLICY=production\r?$'
  if (-not ($s.scenario -eq 'no-new-channel' -and $s.starts -eq 1)) {
    $s.gens[[int]$a.ProcessId] = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    NodeLog "wallet hold channel: C:\ProgramData\Enclave\network\wallet-admission.json, generation $($s.gens[[int]$a.ProcessId].Substring(0, 8)), written EMPTY (nothing is admitted on the network until a fresh allow)" }
  if ($s.scenario -eq 'retire-stale') { NodeLog '0x2215bad4 isolated domain retired (stale)' }
  if ($s.scenario -eq 'retire-expected') { NodeLog ($s.ids[0].Substring(0, 10) + ' isolated domain retired (mock)') }
  if ($s.scenario -match 'concurrent-local-edit' -and $s.starts -eq 1) { [IO.File]::AppendAllText((Join-Path $s.root 'node-config.local.cmd'), "rem concurrent operator change`r`n") }
  SaveProcs; Add-Content (Join-Path $s.root 'node-starts.txt') ('start ' + $s.clock.ToString('o') + ' policyOn=' + $s.policyOn) }
function global:SaveProcs { @($global:S.procs | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) |
  ConvertTo-Json -Depth 3 | Set-Content (Join-Path $global:S.root 'procs-state.json') }
function global:Stop-Process { param($Id, [switch]$Force)
  $s = $global:S; $p = $s.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1
  if (-not $p) { return }
  if ($p.CommandLine -match 'privacy-agent\.mjs') { Add-Content (Join-Path $s.root 'privacy-kills.txt') 'kill' }
  if ($p.CommandLine -like '*node\agent.mjs*' -and $s.scenario -eq 'agent-unkillable') { return }
  $s.procs.Remove($p); SaveProcs }
function global:Agent { @($global:S.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' })[0] }
function global:Ready {   # the node's lease pass: READY only while an ON gate admits (host.mjs leaseServing) and >= 5 s after its start
  $s = $global:S; $a = Agent; if (-not $a) { return $false }
  $age = ($s.clock - $s.agentAt[[int]$a.ProcessId]).TotalSeconds
  return ($age -ge 5 -and (-not $s.policyOn -or $s.admitted)) }
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -like '*8091/vms') { return [pscustomobject]@{ vms = @(Get-Content (Join-Path $global:S.root 'vms.json') | ConvertFrom-Json) } }
  if ($Uri -like '*9600/v1/host/state') {
    $s = $global:S; $a = Agent; if (-not $a) { throw 'mock: refused' }
    $records = @(Get-Content -Raw (Join-Path $s.root 'leases.json') | ConvertFrom-Json)
    if ($s.scenario -eq 'lease-short') { foreach ($r in $records) { $r.leaseUntil = [DateTimeOffset]::new($s.clock).ToUnixTimeSeconds() + 600 } }
    $ms = SimMs; $started = $s.agentAt[[int]$a.ProcessId]
    $ready = [pscustomobject]@{ sequence = 1; startedAt = [DateTimeOffset]::new($started).ToUnixTimeMilliseconds() + 1000; completedAt = $ms; inFlight = -not (Ready)
      deployments = @($records | ForEach-Object { [pscustomobject]@{ id = $_.id; sequence = 1; status = $(if (Ready) { 'ready' } else { 'not-ready' }); observedAt = $ms; checkedAt = $ms; leaseUntil = $_.leaseUntil; runner = $s.runner } }) }
    $recs = @($records | ForEach-Object { [pscustomobject]@{ id = $_.id; status = $_.status; leaseUntil = $_.leaseUntil; walletHeld = $false } })
    return [pscustomobject]@{ deployments = $recs; leaseReadiness = $ready } }
  throw "mock: no $Uri" }
function global:Get-Acl { param($LiteralPath)
  $a = [pscustomobject]@{ Sddl = $(if ($global:S.scenario -eq 'local-acl-no-ai' -and $LiteralPath -like '*node-config.local.cmd') { 'O:BAG:S-1-5-21-1-2-3-513D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)' } else { 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)' })
    Extra = ($global:S.scenario -eq 'wallet-acl-bad' -and $LiteralPath -like '*wallet-admission.json'); Bu = ($global:S.scenario -eq 'pd-inherit-read-bad' -and $LiteralPath.TrimEnd('\', '/') -eq $global:S.root.TrimEnd('\', '/')) }
  $a | Add-Member ScriptMethod GetAccessRules { param($x, $y, $z)
    $r = @([pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' },
           [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-544' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' })
    if ($this.Bu) { $r += [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 1179817; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-545' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' } }
    if ($this.Extra) { $r += [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 278; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-11' }; InheritanceFlags = 'None'; PropagationFlags = 'None' } }
    return $r }
  $a | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-18' } }
  return $a }
function global:Set-Acl { param($LiteralPath, $AclObject)
  $len = $(if (Test-Path -LiteralPath $LiteralPath) { (Get-Item -LiteralPath $LiteralPath).Length } else { -1 })
  Add-Content (Join-Path $global:S.root 'acl-log.txt') "$LiteralPath|$len"
  if ($global:S.scenario -eq 'local-write-fails' -and $LiteralPath -like '*node-config.local.cmd.nh-*') { throw 'mock: temp ACL refused' }
  if ($global:S.scenario -eq 'local-acl-after-replace' -and $LiteralPath -like '*node-config.local.cmd') { throw 'mock: ACL refused after the replace' } }
# the simulated node (channel heartbeat + its gate) and privacy agent, one step per Start-Sleep
function global:Sim {
  $s = $global:S; $net = Join-Path $s.root 'network'; $state = Join-Path $net 'state'; $wf = Join-Path $net 'wallet-admission.json'; $ms = SimMs
  $a = Agent
  if ($a -and $s.gens[[int]$a.ProcessId]) {
    $age = ($s.clock - $s.agentAt[[int]$a.ProcessId]).TotalSeconds
    if ($s.policyOn) {       # host-service-gate.mjs: first check at start(), logs onChange / not serving like the measured gate
      $mode = $(foreach ($m in 'gate-never', 'gate-bans', 'gate-flap-once') { if ($s.scenario -match $m) { $m; break } }); if (-not $mode) { $mode = 'admit' }
      if ($age -ge 3 -and -not $s.policyLogged.first) { $s.policyLogged.first = $true
        if ($mode -eq 'gate-never') { NodeLog '[host-policy] this host is not serving: policy unreadable: chain quorum unavailable (mock)' }
        elseif ($mode -eq 'gate-bans') { NodeLog '[host-policy] this host is not serving: banned by the platform host policy'
          [IO.File]::WriteAllText((Join-Path $s.root 'node/platform-host-admission.json'), (@{ hostId = $s.runner; knownRefusal = @{ status = 'current'; reason = 'banned'; at = $ms } } | ConvertTo-Json -Depth 4)) }
        elseif ($mode -eq 'gate-flap-once') { NodeLog '[host-policy] this host is not serving: policy unreadable: one RPC timed out (mock)' }
        else { NodeLog '[host-policy] this host is ADMITTED: serving and taking work'; $s.admitted = $true } }
      if ($mode -eq 'gate-flap-once' -and $age -ge 12 -and -not $s.policyLogged.second) { $s.policyLogged.second = $true; NodeLog '[host-policy] this host is ADMITTED: serving and taking work'; $s.admitted = $true } }
    $s.rev++; $allows = [ordered]@{}
    if ($age -ge 5 -and (-not $s.policyOn -or $s.admitted)) { foreach ($i in $s.ids) { $allows[$i] = @{ appRef = 'catalog://0x' + ('ab' * 32) + '/1'; configCid = ''; validUntil = $ms + 60000 } } }
    if ($age -lt 1 -or ($s.scenario -match 'gate-bans' -and $s.policyOn)) { $allows = [ordered]@{} }
    [IO.File]::WriteAllText($wf, (@{ version = 1; runner = $s.runner; generation = $s.gens[[int]$a.ProcessId]; revision = $s.rev; issuedAt = $ms; expiresAt = $ms + 30000; allows = $allows } | ConvertTo-Json -Depth 5)) }
  if (@($s.procs | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }).Count) {
    $d = $null; try { $d = Get-Content -Raw $wf | ConvertFrom-Json } catch {}
    $fresh = [bool]($d -and [int64]$d.expiresAt -gt $ms)
    $ignore = $s.scenario -eq 'net-ignores-new-gen' -and $d -and $d.generation -ne (Get-Content (Join-Path $s.root 'gen0.txt')).Trim()
    $al = @(if ($fresh -and -not $ignore) { $d.allows.PSObject.Properties.Name }) | Where-Object { $_ }
    $w = [ordered]@{ runner = $s.runner; generation = $(if ($ignore) { (Get-Content (Join-Path $s.root 'gen0.txt')).Trim() } else { $d.generation }); revision = $d.revision; expiresAt = $(if ($d) { $d.expiresAt } else { 0 })
      fresh = ($fresh -and -not $ignore); error = $(if ($d) { $null } else { 'ENOENT' }); applied = (-not $ignore); allows = @($al) }
    $eg = [ordered]@{}; foreach ($i in $al) { $eg[$i] = @{ proxies = @('127.0.0.1:1') } }
    [IO.File]::WriteAllText((Join-Path $state 'status.json'), (@{ version = 2; updatedAt = $ms; apps = @(); walletAdmission = $w } | ConvertTo-Json -Depth 6))
    [IO.File]::WriteAllText((Join-Path $state 'egress-routes.json'), (@{ version = 1; expiresAt = 0; apps = $eg } | ConvertTo-Json -Depth 6)) }
  SaveProcs }
Sim
& $Script -Mode $Mode -ParamsFile $ParamsFile -ParamsSha $ParamsSha
exit $LASTEXITCODE
