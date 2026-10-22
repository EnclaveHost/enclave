# cutover-mock.ps1 - run node-hold-cutover.ps1 UNCHANGED against a simulated minipc on Linux pwsh 7 (tests only).
# Mocks: the Windows cmdlets it calls (CIM processes, scheduled tasks, 8091 listener, REST to manager/node, ACLs), a
# simulated clock (Get-Date / Start-Sleep), a privacy agent that enforces (or, by scenario, ignores) walletAdmission and
# writes status.json/egress-routes.json like the real one, and a node that writes its channel (or, by scenario, does not).
# The script's own file writes (configs, backups, journal) and node.exe config edit are REAL, in a scratch root.
param([string]$Script, [string]$Root, [string]$ParamsFile, [string]$ParamsSha, [string]$Mode = 'cutover', [string]$Scenario = 'ok')
$global:S = @{ clock = [datetime]::new(2026, 10, 21, 22, 0, 0, [DateTimeKind]::Utc); next = 50000; procs = [System.Collections.ArrayList]::new()
  respawnAt = $null; nodeGen = $null; nodeStartedAt = $null; scenario = $Scenario; root = $Root
  runner = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'; ids = @(Get-Content (Join-Path $Root 'expected-ids.txt')) }
function global:Proc($name, $cmd, $ppid, $procId = 0) { if (-not $procId) { $procId = $global:S.next++ }
  $o = [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $global:S.clock.AddMilliseconds($procId % 997); ExecutablePath = 'x' }
  [void]$global:S.procs.Add($o); return $o }
$st = Get-Content (Join-Path $Root 'procs.json') | ConvertFrom-Json        # the pinned identities, created by the driver
foreach ($p in $st) { $o = Proc $p.name $p.cmd $p.ppid $p.pid; $o.CreationDate = $(if ($p.start -is [datetime]) { $p.start.ToUniversalTime() } else { [datetime]::Parse($p.start).ToUniversalTime() }) }
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds); Sim }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  $all = @($global:S.procs)
  if ($Filter -match "^Name='(.+)'$") { $n = $matches[1]; return @($all | Where-Object { $_.Name -eq $n }) }
  if ($Filter -match '^ProcessId=(\d+)$') { $i = [int]$matches[1]; return ($all | Where-Object { $_.ProcessId -eq $i } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) @([pscustomobject]@{ OwningProcess = 4001 }) }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $t = foreach ($n in 'Card', 'Network', 'Node', 'Relay', 'Shield') { [pscustomobject]@{ TaskName = $n; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = "/c `"C:\ProgramData\Enclave\run-$($n.ToLower()).cmd`"" }) } }
  if ($TaskName) { $t | Where-Object { $_.TaskName -eq $TaskName } } else { $t } }
function global:Stop-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be stopped, not $TaskName" }
  $cmd = @($global:S.procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-node.cmd*' })
  foreach ($c in $cmd) { $global:S.procs.Remove($c)
    if ($global:S.scenario -notin 'agent-survives', 'agent-unkillable') { foreach ($a in @($global:S.procs | Where-Object { $_.ParentProcessId -eq $c.ProcessId })) { $global:S.procs.Remove($a) } } }
  $global:S.nodeStartedAt = $null }
function global:Start-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be started" }
  $c = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"' 1
  $null = Proc 'node.exe' '"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"' $c.ProcessId
  $global:S.nodeStartedAt = $global:S.clock; $global:S.nodeGen = $null; $global:S.starts++; SaveProcs
  Add-Content (Join-Path $global:S.root 'node-starts.txt') 'start' }
function global:SaveProcs { @($global:S.procs | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) |
  ConvertTo-Json -Depth 3 | Set-Content (Join-Path $global:S.root 'procs-state.json') }
function global:Stop-Process { param($Id, [switch]$Force)
  $p = $global:S.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1
  if ($global:S.scenario -eq 'crash-enforcing' -and $p.CommandLine -match 'privacy-agent\.mjs') { throw 'mock: a terminating error while restarting the privacy agent' }
  if (-not $p) { return }
  if ($global:S.scenario -eq 'agent-unkillable' -and $p.CommandLine -like '*agent.mjs*') { return }
  $global:S.procs.Remove($p)
  if ($p.CommandLine -match 'privacy-agent\.mjs') { $global:S.respawnAt = $global:S.clock.AddSeconds(10) } }
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -like '*8091/vms') { return [pscustomobject]@{ vms = @(Get-Content (Join-Path $global:S.root 'vms.json') | ConvertFrom-Json) } }
  throw "mock: no $Uri" }
function global:Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if (@($global:S.procs | Where-Object { $_.CommandLine -like '*agent.mjs*' }).Count -and $Uri -like '*9600*') { return [pscustomobject]@{ StatusCode = 200 } }; throw 'mock: refused' }
function global:Get-Acl { param($LiteralPath)
  $a = [pscustomobject]@{ Sddl = 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)'; AreAccessRulesProtected = $true }
  $a | Add-Member ScriptMethod GetAccessRules { param($x, $y, $z) @([pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' } },
                                                                   [pscustomobject]@{ AccessControlType = 'Allow'; FileSystemRights = 2032127; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-544' } }) }
  $a | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-18' } }
  return $a }
function global:Set-Acl { param($LiteralPath, $AclObject) if ($global:S.scenario -eq 'flag-write-fails' -and $LiteralPath -like '*node-config.local.cmd*') { throw 'mock: flag write refused' } }
# the simulated privacy agent + node, one step per Start-Sleep
function global:Sim {
  $s = $global:S; $net = Join-Path $s.root 'network'; $state = Join-Path $net 'state'; $wf = Join-Path $net 'wallet-admission.json'
  # ROOT NEGATIVE FIXTURE: a concurrent administrator edit changes the local-config CAS after both config writes.
  $lf = Join-Path $s.root 'node-config.local.cmd'
  if (-not $s.conflictInjected -and $s.scenario -eq 'net-ignores-wallet' -and ([IO.File]::ReadAllText($lf)).Contains('ENCLAVE_NETWORK_WALLET_HOLD=1')) {
    [IO.File]::AppendAllText($lf, "`r`nrem concurrent operator change`r`n"); $s.conflictInjected = $true
  }

  if ($s.respawnAt -and $s.clock -ge $s.respawnAt) { $s.respawnAt = $null; $null = Proc 'node.exe' '"node.exe" "C:\Program Files\Enclave\network\privacy-agent.mjs" --config x' 3001 }
  $node = @($s.procs | Where-Object { $_.CommandLine -like '*agent.mjs*' }).Count
  if ($node -and $s.nodeStartedAt -and $s.scenario -ne 'node-no-channel') {
    if (-not $s.nodeGen) { $s.nodeGen = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }); $s.rev = 0 }
    $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $s.rev++
    $allows = [ordered]@{}; if (($s.clock - $s.nodeStartedAt).TotalSeconds -ge 5) { foreach ($i in $s.ids) { $allows[$i] = @{ appRef = 'catalog://0x' + ('ab' * 32) + '/1'; configCid = ''; validUntil = $ms + 60000 } } }
    [IO.File]::WriteAllText($wf, (@{ version = 1; runner = $s.runner; generation = $s.nodeGen; revision = $s.rev; issuedAt = $ms; expiresAt = $ms + 30000; allows = $allows } | ConvertTo-Json -Depth 5)) }
  $pa = @($s.procs | Where-Object { $_.CommandLine -match 'privacy-agent\.mjs' }).Count
  if ($pa) {
    $cfg = Get-Content -Raw (Join-Path $net 'privacy-config.json') | ConvertFrom-Json
    $enf = [bool]$cfg.enclaveNetwork.walletAdmission -and $s.scenario -ne 'net-ignores-wallet'
    $st = [ordered]@{ version = 2; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); apps = @() }; $eg = [ordered]@{}
    if ($enf) { $d = $null; try { $d = Get-Content -Raw $wf | ConvertFrom-Json } catch {}
      $al = @(if ($d) { $d.allows.PSObject.Properties.Name })
      $st.walletAdmission = [ordered]@{ runner = $s.runner; generation = $d.generation; revision = $d.revision; expiresAt = $(if ($d) { $d.expiresAt } else { 0 }); fresh = [bool]$d; error = $(if ($d) { $null } else { 'ENOENT' }); applied = $true; allows = $al }
      foreach ($i in $al) { $eg[$i] = @{ proxies = @('127.0.0.1:1') } } }
    else { foreach ($i in $s.ids) { $eg[$i] = @{ proxies = @('127.0.0.1:1') } } }
    [IO.File]::WriteAllText((Join-Path $state 'status.json'), ($st | ConvertTo-Json -Depth 6))
    [IO.File]::WriteAllText((Join-Path $state 'egress-routes.json'), (@{ version = 1; expiresAt = 0; apps = $eg } | ConvertTo-Json -Depth 6)) }
  SaveProcs }
Sim
& $Script -Mode $Mode -ParamsFile $ParamsFile -ParamsSha $ParamsSha
exit $LASTEXITCODE
