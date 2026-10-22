# cutover-mock.ps1 - run node-hold-cutover.ps1 UNCHANGED against a simulated minipc on Linux pwsh 7 (tests only).
# Mocks: the Windows cmdlets it calls (CIM processes, scheduled tasks, 8091 listener, Get-VM, REST to manager/node, ACLs), a
# simulated clock (Get-Date / Start-Sleep; status/document times follow it), a privacy agent that enforces (or, by scenario,
# ignores) walletAdmission and writes status.json/egress-routes.json like the real one, and a node that writes its channel
# (or, by scenario, does not). The script's own file writes (configs, backups, journal, temps) and the node.exe config edit are
# REAL, in a scratch root. Scenarios inject: concurrent operator edits (root's reproduction), unkillable nodes, a privacy
# agent that never comes back or never writes a fresh status after a revert, crashes, Hyper-V/manager/other-task changes,
# extra writers on the channel file or the network directory. Every Set-Acl is logged with the target's size at that moment.
param([string]$Script, [string]$Root, [string]$ParamsFile, [string]$ParamsSha, [string]$Mode = 'cutover', [string]$Scenario = 'ok')
$global:S = @{ clock = [datetime]::new(2026, 10, 21, 22, 0, 0, [DateTimeKind]::Utc); next = 50000; procs = [System.Collections.ArrayList]::new()
  respawnAt = $null; nodeGen = $null; nodeStartedAt = $null; scenario = $Scenario; root = $Root; starts = 0; flagSeen = $false; crashed = $false
  runner = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'; ids = @(Get-Content (Join-Path $Root 'expected-ids.txt')) }
function global:SimMs { [DateTimeOffset]::new($global:S.clock).ToUnixTimeMilliseconds() }
function global:Proc($name, $cmd, $ppid, $procId = 0) { if (-not $procId) { $procId = $global:S.next++ }
  $o = [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $global:S.clock.AddMilliseconds($procId % 997); ExecutablePath = 'x' }
  [void]$global:S.procs.Add($o); return $o }
$st = Get-Content (Join-Path $Root 'procs.json') | ConvertFrom-Json        # the pinned identities, created by the driver
$global:S.next = 1 + [int](@($st | ForEach-Object { [int]$_.pid }) + 50000 | Measure-Object -Maximum).Maximum
foreach ($p in $st) { $o = Proc $p.name $p.cmd $p.ppid $p.pid; $o.CreationDate = $(if ($p.start -is [datetime]) { $p.start.ToUniversalTime() } else { [datetime]::Parse($p.start).ToUniversalTime() }) }
function global:Reverted { $s = $global:S; $s.flagSeen -and -not ([IO.File]::ReadAllText((Join-Path $s.root 'node-config.local.cmd'))).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1') }
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds); Sim }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  $all = @($global:S.procs)
  if ($Filter -match "^Name='(.+)'$") { $n = $matches[1]; return @($all | Where-Object { $_.Name -eq $n }) }
  if ($Filter -match '^ProcessId=(\d+)$') { $i = [int]$matches[1]; return ($all | Where-Object { $_.ProcessId -eq $i } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) @([pscustomobject]@{ OwningProcess = 4001 }) }
function global:Get-VM { param($ErrorAction)
  if ($global:S.scenario -eq 'hyperv-unavailable') { throw 'mock: Hyper-V module unavailable' }
  $v = @(Get-Content (Join-Path $global:S.root 'hyperv.json') | ConvertFrom-Json)
  # a VM replaced behind the same name (new GUID) once the new node has run for 5 s
  if ($global:S.scenario -eq 'vm-replaced' -and $global:S.nodeStartedAt -and ($global:S.clock - $global:S.nodeStartedAt).TotalSeconds -ge 5) { $v[0].Id = 'ffffffff-0000-0000-0000-000000000000' }
  return $v }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $t = foreach ($n in 'Card', 'Network', 'Node', 'Relay', 'Shield') { [pscustomobject]@{ TaskName = $n; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = "/c `"C:\ProgramData\Enclave\run-$($n.ToLower()).cmd`"" }) } }
  # G4 final: the live \Enclave\Update (update-host.ps1, SYSTEM, hourly; root review G-UPD)
  $t = @($t) + [pscustomobject]@{ TaskName = 'Update'; State = $(if ($global:S.scenario -eq 'update-running') { 'Running' } else { 'Ready' })
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\Enclave\update-host.ps1"' }) }
  if ($TaskName) { $t | Where-Object { $_.TaskName -eq $TaskName } } else { $t } }
function global:Get-ScheduledTaskInfo { param($InputObject)   # update-due: the next hourly run falls inside the bound
  [pscustomobject]@{ NextRunTime = $global:S.clock.AddMinutes($(if ($global:S.scenario -eq 'update-due') { 5 } else { 50 })) } }
function global:Stop-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be stopped, not $TaskName" }
  $s = $global:S; $survive = ($s.scenario -eq 'agent-unkillable') -or ($s.scenario -eq 'node-no-channel-unkillable' -and $s.starts -ge 1)
  foreach ($c in @($s.procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-node.cmd*' })) { $s.procs.Remove($c)
    if (-not $survive) { foreach ($a in @($s.procs | Where-Object { $_.ParentProcessId -eq $c.ProcessId })) { $s.procs.Remove($a) } } }
  if (-not $survive) { $s.nodeStartedAt = $null }; SaveProcs }
function global:Start-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be started" }
  $c = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"' 1
  $null = Proc 'node.exe' '"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"' $c.ProcessId
  $global:S.nodeStartedAt = $global:S.clock; $global:S.nodeGen = $null; $global:S.starts++
  # another \Enclave\ task's process is replaced while this run is going on
  if ($global:S.scenario -eq 'other-task-changed') { $null = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-relay.cmd"' 1 }
  SaveProcs; Add-Content (Join-Path $global:S.root 'node-starts.txt') 'start' }
function global:SaveProcs { @($global:S.procs | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) |
  ConvertTo-Json -Depth 3 | Set-Content (Join-Path $global:S.root 'procs-state.json') }
function global:Stop-Process { param($Id, [switch]$Force)
  $s = $global:S; $p = $s.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1
  if ($p.CommandLine -match 'privacy-agent\.mjs' -and ($s.scenario -eq 'crash-enforcing' -or ($s.scenario -eq 'crash-once' -and -not $s.crashed))) { $s.crashed = $true; throw 'mock: a terminating error while restarting the privacy agent' }
  if (-not $p) { return }
  if ($p.CommandLine -like '*node\agent.mjs*' -and ($s.scenario -eq 'agent-unkillable' -or ($s.scenario -eq 'node-no-channel-unkillable' -and $s.starts -ge 1))) { return }
  $s.procs.Remove($p)
  if ($p.CommandLine -match 'privacy-agent\.mjs' -and -not ($s.scenario -eq 'revert-no-privacy' -and (Reverted))) { $s.respawnAt = $s.clock.AddSeconds(10) }
  SaveProcs }
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -like '*8091/vms') { return [pscustomobject]@{ vms = @(Get-Content (Join-Path $global:S.root 'vms.json') | ConvertFrom-Json) } }
  throw "mock: no $Uri" }
function global:Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if (@($global:S.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }).Count -and $Uri -like '*9600*') { return [pscustomobject]@{ StatusCode = 200 } }; throw 'mock: refused' }
function global:Get-Acl { param($LiteralPath)
  $extra = ($global:S.scenario -eq 'wallet-acl-bad' -and $LiteralPath -like '*wallet-admission.json') -or ($global:S.scenario -eq 'netdir-acl-bad' -and $LiteralPath -eq (Join-Path $global:S.root 'network'))
  # N3 (G4 final): the live data dir carries a NON-inheritable BU read (root's evidence); the scenarios add an inheritable one
  $isRoot = $LiteralPath.TrimEnd('\', '/') -eq $global:S.root.TrimEnd('\', '/'); $isNet = $LiteralPath -eq (Join-Path $global:S.root 'network')
  $bu = $(if ($isRoot -and $global:S.scenario -eq 'pd-inherit-read-bad') { 'ContainerInherit, ObjectInherit' } elseif ($isRoot) { 'None' } elseif ($isNet -and $global:S.scenario -eq 'netdir-read-bad') { 'ContainerInherit, ObjectInherit' } else { $null })
  # AI precondition (node-hold-acl-normalization): a config file whose DACL is NOT auto-inherited (the native fixture's failing 'inherited' form)
  $noai = ($global:S.scenario -eq 'cfg-acl-no-ai' -and $LiteralPath -like '*privacy-config.json') -or ($global:S.scenario -eq 'local-acl-no-ai' -and $LiteralPath -like '*node-config.local.cmd')
  $a = [pscustomobject]@{ Sddl = $(if ($noai) { 'O:BAG:S-1-5-21-1-2-3-513D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)' } else { 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)' }); AreAccessRulesProtected = $true; Extra = $extra; Bu = $bu }
  $a | Add-Member ScriptMethod GetAccessRules { param($x, $y, $z)
    $r = @([pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' },
           [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-544' }; InheritanceFlags = 'ContainerInherit, ObjectInherit'; PropagationFlags = 'None' })
    if ($this.Bu) { $r += [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 1179817; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-545' }; InheritanceFlags = $this.Bu; PropagationFlags = 'None' } }
    if ($this.Extra) { $r += [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 278; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-11' } } }
    return $r }
  $a | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-18' } }
  return $a }
function global:Set-Acl { param($LiteralPath, $AclObject)
  $len = $(if (Test-Path -LiteralPath $LiteralPath) { (Get-Item -LiteralPath $LiteralPath).Length } else { -1 })
  Add-Content (Join-Path $global:S.root 'acl-log.txt') "$LiteralPath|$len"
  if ($global:S.scenario -eq 'flag-write-fails' -and $LiteralPath -like '*node-config.local.cmd*') { throw 'mock: flag write refused' } }
# the simulated privacy agent + node, one step per Start-Sleep
function global:Sim {
  $s = $global:S; $net = Join-Path $s.root 'network'; $state = Join-Path $net 'state'; $wf = Join-Path $net 'wallet-admission.json'
  $lf = Join-Path $s.root 'node-config.local.cmd'; $cf = Join-Path $net 'privacy-config.json'
  if (([IO.File]::ReadAllText($lf)).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1')) { $s.flagSeen = $true }
  # ROOT'S REPRODUCTION (root-review/rollback-conflict/cutover-mock.ps1, verbatim logic): a concurrent administrator edit
  # changes the local-config CAS after both config writes
  if (-not $s.conflictInjected -and $s.scenario -eq 'root-concurrent-local-edit' -and ([IO.File]::ReadAllText($lf)).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1')) {
    [IO.File]::AppendAllText($lf, "`r`nrem concurrent operator change`r`n"); $s.conflictInjected = $true }
  if (-not $s.conflictInjected -and $s.scenario -eq 'concurrent-cfg-edit' -and ([IO.File]::ReadAllText($lf)).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1')) {
    $c = Get-Content -Raw $cf | ConvertFrom-Json; $c | Add-Member -NotePropertyName operatorEdit -NotePropertyValue $true; [IO.File]::WriteAllText($cf, ($c | ConvertTo-Json -Depth 8)); $s.conflictInjected = $true }
  if ($s.respawnAt -and $s.clock -ge $s.respawnAt) { $s.respawnAt = $null; $null = Proc 'node.exe' '"node.exe" "C:\Program Files\Enclave\network\privacy-agent.mjs" --config x' 3001 }
  $node = @($s.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }).Count
  if ($node -and $s.nodeStartedAt -and $s.scenario -notin 'node-no-channel', 'node-no-channel-unkillable' -and ([IO.File]::ReadAllText($lf)).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1')) {
    if (-not $s.nodeGen) { $s.nodeGen = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }); $s.rev = 0 }
    $ms = SimMs; $s.rev++
    $allows = [ordered]@{}; if (($s.clock - $s.nodeStartedAt).TotalSeconds -ge 5) { foreach ($i in $s.ids) { $allows[$i] = @{ appRef = 'catalog://0x' + ('ab' * 32) + '/1'; configCid = ''; validUntil = $ms + 60000 } } }
    [IO.File]::WriteAllText($wf, (@{ version = 1; runner = $s.runner; generation = $s.nodeGen; revision = $s.rev; issuedAt = $ms; expiresAt = $ms + 30000; allows = $allows } | ConvertTo-Json -Depth 5)) }
  $pa = @($s.procs | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }).Count
  $silent = $s.scenario -eq 'revert-status-stale' -and (Reverted)          # the agent after the revert never writes a status
  if ($pa -and -not $silent) {
    $cfg = Get-Content -Raw $cf | ConvertFrom-Json
    $ignore = $s.scenario -in 'net-ignores-wallet', 'root-concurrent-local-edit', 'concurrent-cfg-edit', 'revert-status-stale', 'revert-no-privacy'
    $enf = [bool]$cfg.enclaveNetwork.walletAdmission -and -not $ignore
    $st = [ordered]@{ version = 2; updatedAt = (SimMs); apps = @() }; $eg = [ordered]@{}
    if ($enf) { $d = $null; try { $d = Get-Content -Raw $wf | ConvertFrom-Json } catch {}
      $al = @($(if ($d) { $d.allows.PSObject.Properties.Name }) | Where-Object { $_ })
      $st.walletAdmission = [ordered]@{ runner = $s.runner; generation = $d.generation; revision = $d.revision; expiresAt = $(if ($d) { $d.expiresAt } else { 0 }); fresh = [bool]$d; error = $(if ($d) { $null } else { 'ENOENT' }); applied = $true; allows = $al }
      foreach ($i in $al) { $eg[$i] = @{ proxies = @('127.0.0.1:1') } } }
    else { foreach ($i in $s.ids) { $eg[$i] = @{ proxies = @('127.0.0.1:1') } } }
    [IO.File]::WriteAllText((Join-Path $state 'status.json'), ($st | ConvertTo-Json -Depth 6))
    [IO.File]::WriteAllText((Join-Path $state 'egress-routes.json'), (@{ version = 1; expiresAt = 0; apps = $eg } | ConvertTo-Json -Depth 6)) }
  SaveProcs }
Sim
& $Script -Mode $Mode -ParamsFile $ParamsFile -ParamsSha $ParamsSha
exit $LASTEXITCODE
