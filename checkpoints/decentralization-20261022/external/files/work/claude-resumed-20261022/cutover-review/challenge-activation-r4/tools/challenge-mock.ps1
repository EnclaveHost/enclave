# challenge-mock.ps1 (r3) - run challenge-activate.ps1 UNCHANGED against a simulated post-cutover minipc on Linux pwsh 7 (tests only; NOT
# Windows evidence). Simulated: processes (node cmd/agent, privacy agent + its replica CHILD, which survives a forced kill of the agent
# like an orphan on Windows), loopback listeners, the updater task, ACLs, a clock, the privacy agent's status/egress/log/declaration.
# The script's own file writes (config, backup, journal, temps) and the real node.exe edit helper run for real in a scratch root.
param([string]$Script, [string]$Root, [string]$ParamsFile, [string]$ParamsSha, [string]$Mode = 'apply', [string]$Scenario = 'ok', [string]$Rel)
$global:S = @{ clock = [datetime]::new(2026, 10, 22, 4, 0, 0, [DateTimeKind]::Utc); procs = [Collections.ArrayList]::new(); next = 700; sc = $Scenario; root = $Root
  rel = $Rel; respawnAt = $null; listen = @{}; runner = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'; replicaAt = $null
  ids = @(Get-Content (Join-Path $Root 'expected-ids.json') | ConvertFrom-Json) }
function global:Proc($name, $cmd, $ppid, $procId = 0, $start = $null) { if (-not $procId) { $procId = $global:S.next++ }
  $o = [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $(if ($start) { $start } else { $global:S.clock }); block = $false }
  [void]$global:S.procs.Add($o); return $o }
$st = Get-Content (Join-Path $Root 'procs.json') | ConvertFrom-Json
$global:S.next = 1 + [int](@($st | ForEach-Object { [int]$_.pid }) + 700 | Measure-Object -Maximum).Maximum   # never reuse a live PID
foreach ($p in $st) { $o = Proc $p.name $p.cmd $p.ppid $p.pid $(if ($p.start -is [datetime]) { $p.start.ToUniversalTime() } else { [datetime]::Parse([string]$p.start, $null, 'RoundtripKind').ToUniversalTime() }) }
$cfgPath = Join-Path $Root 'network\privacy-config.json'; $cfgPath = $cfgPath.Replace('\', [IO.Path]::DirectorySeparatorChar)
function global:CfgHasBlock { try { $null -ne ([IO.File]::ReadAllText((Join-Path $global:S.root 'network/privacy-config.json')) | ConvertFrom-Json).enclaveNetwork.challengeReplica } catch { $false } }
function global:PrivacyProc { @($global:S.procs | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }) }
function global:NetLog($line) { Add-Content (Join-Path $global:S.root 'logs/network.log') ("04:00:00 " + $line) }
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds); Sim }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  $all = @($global:S.procs)
  if ($Filter -match "^Name='(.+)' AND ParentProcessId=(\d+)$") { $n = $matches[1]; $pp = [int]$matches[2]; return @($all | Where-Object { $_.Name -eq $n -and $_.ParentProcessId -eq $pp }) }
  if ($Filter -match "^Name='(.+)'$") { $global:S.broadList = 1 + [int]$global:S.broadList; return @($all | Where-Object { $_.Name -eq $matches[1] }) }
  if ($Filter -match '^ProcessId=(\d+)$') { return ($all | Where-Object { $_.ProcessId -eq [int]$matches[1] } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
  if ($global:S.sc -eq 'challenge-query-throws' -and [int]$LocalPort -eq 18292 -and @(PrivacyProc | Where-Object { $_.block }).Count) { throw 'mock: listener query failed late' }
  $o = $global:S.listen[[int]$LocalPort]; if ($null -eq $o) { return @() }; @([pscustomobject]@{ OwningProcess = $o }) }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  [pscustomobject]@{ TaskName = 'Update'; State = $(if ($global:S.sc -eq 'update-queued') { 'Queued' } else { 'Ready' }); Settings = [pscustomobject]@{ Enabled = $true } } }
function global:Get-ScheduledTaskInfo { param($InputObject, $ErrorAction) [pscustomobject]@{ NextRunTime = $global:S.clock.AddMinutes(50) } }
function global:Stop-Process { param($Id, [switch]$Force) $s = $global:S
  $p = $s.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1; if (-not $p) { throw "mock: Cannot find a process with the process identifier $Id." }
  if ($s.sc -eq 'orphan-unkillable' -and $p.CommandLine -like '*dns.mjs*') { throw 'mock: Access is denied' }
  $s.procs.Remove($p)
  foreach ($k in @($s.listen.Keys)) { if ($s.listen[$k] -eq $p.ProcessId) { $s.listen.Remove($k) } }          # a dead process frees its ports
  if ($p.CommandLine -match 'privacy-agent\.mjs') { $s.respawnAt = $s.clock.AddSeconds(10); $s.replicaAt = $null }   # its CHILD is NOT killed
  ($s.listen.Keys | ForEach-Object { "$_=$($s.listen[$_])" }) -join ',' | Set-Content (Join-Path $s.root 'listen-state.txt') }
function global:Get-FileHash { param($Algorithm, $LiteralPath)
  if ($global:S.sc -eq 'foreign-at-write' -and -not $global:S.foreign -and $LiteralPath -like '*before-challenge*') { $global:S.foreign = $true
    [IO.File]::AppendAllText((Join-Path $global:S.root 'network/privacy-config.json'), ' ') }      # an operator/enroll write between backup and CAS
  Microsoft.PowerShell.Utility\Get-FileHash -Algorithm $Algorithm -LiteralPath $LiteralPath }
# R2: the node's host state (expected ids running unless a scenario drops one)
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -notlike '*9600/v1/host/state') { throw "mock: no $Uri" }
  $ids = @($global:S.ids | Where-Object { -not ($global:S.sc -eq 'id-not-running' -and $_ -eq $global:S.ids[0]) })
  $ns = [DateTimeOffset]::new($global:S.clock).ToUnixTimeSeconds()
  [pscustomobject]@{ deployments = @($ids | ForEach-Object { [pscustomobject]@{ id = $_; status = 'running'; walletHeld = $false; leaseUntil = $ns + 3600 } }) } }
function global:Get-Acl { param($LiteralPath)
  $a = [pscustomobject]@{ Sddl = 'O:SYG:SYD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)' }
  $a | Add-Member ScriptMethod GetAccessRules { param($x, $y, $z)
    @([pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' },
      [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-544' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' }) }
  $a | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-18' } }
  return $a }
function global:Set-Acl { param($LiteralPath, $AclObject)
  if ($global:S.sc -eq 'write-fails' -and $LiteralPath -like '*privacy-config.json.nh-*') { throw 'mock: config write refused' } }
# the privacy agent: (re)spawned by its task 10 s after a kill; it loads the config at start; status/egress every step; with the block
# it starts the replica CHILD 5 s later (unless the scenario keeps it from starting) and declares it serving
function global:Sim {
  $s = $global:S
  if ($s.respawnAt -and $s.clock -ge $s.respawnAt) { $s.respawnAt = $null
    $n = Proc 'node.exe' '"node.exe" "C:\Program Files\Enclave\network\privacy-agent.mjs" --config x' 3001; $n.block = (CfgHasBlock)
    if ($n.block) { $s.replicaAt = $s.clock.AddSeconds(5) } }
  $pa = @(PrivacyProc); if (-not $pa.Count) { return }; $agent = $pa[0]
  if ($agent.block -and $s.replicaAt -and $s.clock -ge $s.replicaAt) { $s.replicaAt = $null
    if ($s.sc -eq 'challenge-never') { NetLog 'challenge replica not started (attempt 1; this host''s network and every app''s routes are unaffected): gate; next attempt in 30 s' }
    else { $c = Proc 'node.exe' ('"node.exe" "' + $s.rel + [IO.Path]::DirectorySeparatorChar + 'dns.mjs"') $agent.ProcessId
      $s.listen[18353] = $c.ProcessId; $s.listen[18354] = $c.ProcessId; $s.listen[18292] = $agent.ProcessId
      NetLog 'challenge replica serving: app-zone-replica, release 3e1560f94542, Shield evidence'; $s.served = $true
      [IO.File]::WriteAllText((Join-Path $s.root 'challenge-replica/challenge-front.json'), (@{ version = 1; state = 'serving'; pid = $agent.ProcessId; proofKey = 'SECRET-PROOF-KEY'; release = @{ dnsSha256 = '3e1560f9' }; expiresAt = 1 } | ConvertTo-Json)) } }
  $gen = $(try { ([IO.File]::ReadAllText((Join-Path $s.root 'network/wallet-admission.json')) | ConvertFrom-Json).generation } catch { $null })
  $bad = $s.sc -eq 'core-fails' -and $agent.block
  $ms = [DateTimeOffset]::new($s.clock).ToUnixTimeMilliseconds()
  # r3: the node's channel document (wallet-admission.json: version 1, runner, generation, heartbeat expiry, per-id binding + validUntil)
  # and the privacy status (version 2, the applied channel, per-app wallet/lease/proof deadlines); scenarios corrupt ONE fact each
  $al = [ordered]@{}; foreach ($i in $s.ids) { $al[$i] = [ordered]@{ appRef = 'app-' + $i.Substring(2, 1); configCid = 'bafy-' + $i.Substring(2, 1); validUntil = $ms + 60000 } }
  if ($s.sc -eq 'wrong-binding') { $al[$s.ids[0]].appRef = 'app-OTHER' }
  if ($s.sc -eq 'expired-grant') { $al[$s.ids[1]].validUntil = $ms - 1000 }
  $doc = [ordered]@{ version = 1; runner = $s.runner; generation = $gen; revision = [int64]($ms / 1000); expiresAt = $ms + 30000; allows = $al }
  [IO.File]::WriteAllText((Join-Path $s.root 'network/wallet-admission.json'), ($doc | ConvertTo-Json -Depth 6))
  $late = $s.served -and $s.sc -like 'late-*'
  $wa = [ordered]@{ runner = $s.runner; generation = $(if ($late -and $s.sc -eq 'late-generation') { 'g-other' } else { $gen }); revision = [int64]($ms / 1000)
    fresh = -not ($late -and $s.sc -eq 'late-fresh'); applied = -not ($late -and $s.sc -eq 'late-applied'); error = $(if ($late -and $s.sc -eq 'late-error') { 'mock: channel unreadable' } else { $null })
    expiresAt = $ms + 30000; allows = @($s.ids) }
  $apps = @($s.ids | ForEach-Object { [ordered]@{ deploymentId = $_; walletUntil = $ms + 600000; leaseUntil = $ms + 600000; proofUntil = $ms + 600000 } })
  $stj = [ordered]@{ version = 2; updatedAt = $(if ($s.sc -eq 'future-status') { $ms + 60000 } else { $ms }); walletAdmission = $(if ($bad) { $null } else { $wa }); apps = $apps }
  [IO.File]::WriteAllText((Join-Path $s.root 'network/state/status.json'), ($stj | ConvertTo-Json -Depth 6))
  $eg = [ordered]@{}; if (-not $bad) { $ids = @($s.ids); if ($s.sc -eq 'egress-wrong-ids' -and $agent.block) { $ids = @($ids | Select-Object -Skip 1) + @('0x' + ('ee' * 32)) }
    foreach ($i in $ids) { $eg[$i] = @{ proxies = @('127.0.0.1:1'); dns = @('1.1.1.1') } } }
  [IO.File]::WriteAllText((Join-Path $s.root 'network/state/egress-routes.json'), (@{ version = 1; expiresAt = $ms + 30000; apps = $eg } | ConvertTo-Json -Depth 5))
  @($s.procs | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine } }) | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $s.root 'procs-state.json')
  ($s.listen.Keys | ForEach-Object { "$_=$($s.listen[$_])" }) -join ',' | Set-Content (Join-Path $s.root 'listen-state.txt') }
# initial state: the agent that the cutover left (WITHOUT the block); scenario listeners
foreach ($p in @(PrivacyProc)) { $p.block = (CfgHasBlock) }
if ($Scenario -in 'tunnel-sshd', 'tunnel-impostor') { $t = Proc 'sshd.exe' '"C:\Windows\System32\OpenSSH\sshd.exe" -R' 1 $(if ($Scenario -eq 'tunnel-sshd') { 4100 } else { 4200 }) ([datetime]::new(2026, 10, 22, 3, 0, 0, [DateTimeKind]::Utc)); $global:S.listen[31053] = $t.ProcessId }
if ($Scenario -eq 'tunnel-squatter') { $t = Proc 'python.exe' 'python.exe -m dnsfake' 1; $global:S.listen[31053] = $t.ProcessId }
if ($Scenario -eq 'port-busy') { $t = Proc 'node.exe' 'node.exe other.mjs' 1; $global:S.listen[18353] = $t.ProcessId }
if ($Scenario -in 'prior-orphan', 'orphan-unkillable') { # a replica child left from a previous agent run: rollback must stop exactly it
  $pa = @(PrivacyProc)[0]; $pa.block = $true; $c = Proc 'node.exe' ('"node.exe" "' + $Rel + [IO.Path]::DirectorySeparatorChar + 'dns.mjs"') $pa.ProcessId
  $global:S.listen[18353] = $c.ProcessId; $global:S.listen[18354] = $c.ProcessId; $global:S.listen[18292] = $pa.ProcessId }
Sim
& $Script -Mode $Mode -ParamsFile $ParamsFile -ParamsSha $ParamsSha
exit $LASTEXITCODE
