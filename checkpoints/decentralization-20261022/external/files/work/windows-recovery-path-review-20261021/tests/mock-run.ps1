# Runs each probe step (the exact text, minus root's transport HEAD) on Linux pwsh against STUBS of the Windows cmdlets it
# calls, fed by a fixture. Proves the steps' control flow and JSON shape and the gate logic's inputs - NOT Windows semantics.
param([string]$Fixture, [string]$StepsJson)
$ErrorActionPreference = 'Stop'                     # as the transport HEAD sets it
$global:F = Get-Content -Raw -LiteralPath $Fixture | ConvertFrom-Json
function D($s) { [datetime]::Parse([string]$s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal) }
function global:FileSha($f) { $v = $global:F.sha.$f; if ($v) { $v } else { 'absent' } }
function global:Test-Path { param([Parameter(Position = 0)]$Path, $LiteralPath) $x = $(if ($LiteralPath) { $LiteralPath } else { $Path }); @($global:F.exists) -contains [string]$x }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
  if ($global:F.fail -contains 'tcp') { throw 'mock: tcp unavailable' }
  @($global:F.tcp | Where-Object { $_.LocalPort -eq $LocalPort -and $_.State -eq $State } | ForEach-Object { [pscustomobject]@{ LocalAddress = $_.LocalAddress; LocalPort = $_.LocalPort; RemoteAddress = $_.RemoteAddress; RemotePort = $_.RemotePort; OwningProcess = $_.OwningProcess } }) }
function global:Get-NetIPAddress { param($IPAddress, $AddressFamily, $ErrorAction)
  $r = @($global:F.ips | Where-Object { -not $IPAddress -or $_.IPAddress -eq $IPAddress } | ForEach-Object { [pscustomobject]@{ IPAddress = $_.IPAddress; InterfaceIndex = $_.InterfaceIndex; InterfaceAlias = $_.InterfaceAlias
    PrefixLength = $_.PrefixLength; PrefixOrigin = $_.PrefixOrigin; SuffixOrigin = $_.SuffixOrigin; ValidLifetime = [timespan]::FromSeconds($_.ValidSec); AddressState = $_.AddressState } })
  if ($IPAddress -and -not $r.Count) { throw "mock: no address $IPAddress" }; $r }
function global:Find-NetRoute { param($RemoteIPAddress, $ErrorAction)
  @([pscustomobject]@{ IPAddress = 'x'; DestinationPrefix = $null }) + @($global:F.routeToClient | ForEach-Object { [pscustomobject]@{ DestinationPrefix = $_.prefix; InterfaceIndex = $_.ifIndex; NextHop = $_.nextHop; RouteMetric = 256 } }) }
function global:Get-NetAdapter { param($ErrorAction) @($global:F.adapters) }
function global:Get-NetRoute { param($DestinationPrefix, $ErrorAction) @($global:F.defaultRoutes | Where-Object { @($DestinationPrefix) -contains $_.DestinationPrefix }) }
function global:Get-NetConnectionProfile { param($ErrorAction) @($global:F.profiles) }
function global:Get-VMSwitch { param($ErrorAction) @($global:F.vmSwitches) }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  if ($ClassName -eq 'Win32_Service') { $n = [regex]::Match([string]$Filter, "Name='([^']+)'").Groups[1].Value; $s = $global:F.services.$n; if (-not $s) { throw "mock: no service $n" }; return $s }
  if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ LastBootUpTime = (D $global:F.lastBoot) } }
  if ($ClassName -eq 'Win32_Process') {
    if ($global:F.fail -contains 'processes') { throw 'mock: WMI timeout' }
    $p = @($global:F.procs | ForEach-Object { [pscustomobject]@{ Name = $_.Name; ProcessId = $_.pid; ParentProcessId = $_.ppid; SessionId = 0; CommandLine = $_.cmd; CreationDate = (D $_.start) } })
    if ($Filter -match "Name like 'sshd%'") { return @($p | Where-Object { $_.Name -like 'sshd*' }) }; return $p }
  throw "mock: class $ClassName" }
function global:Get-Item { param($LiteralPath, $ErrorAction)
  if ($LiteralPath -like '*sshd.exe') { return [pscustomobject]@{ VersionInfo = [pscustomobject]@{ ProductVersion = $global:F.sshdVersion } } }
  if ($LiteralPath -like '*update.log') { return [pscustomobject]@{ Length = 1234; LastWriteTimeUtc = (D $global:F.updateLogWritten) } }
  throw "mock: no item $LiteralPath" }
function global:Get-Content { param($LiteralPath, $Tail, [switch]$Raw) @($global:F.updateLog) }
function global:Get-NetFirewallRule { param($Name, $ErrorAction) if (-not $global:F.fwRule) { throw 'mock: no rule' }; $global:F.fwRule }
function global:Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline)]$InputObject) [pscustomobject]@{ LocalPort = $global:F.fwRule.port } }
function global:Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline)]$InputObject) [pscustomobject]@{ RemoteAddress = 'Any' } }
function global:Get-NetFirewallProfile { param($ErrorAction) @($global:F.fwProfiles) }
function global:Get-ItemProperty { param($LiteralPath, $Name, $ErrorAction) $v = $global:F.reg.$Name; if ($null -eq $v) { if ($ErrorAction -eq 'SilentlyContinue') { return $null }; throw "mock: no $Name" }; [pscustomobject]@{ $Name = $v } }
function global:Get-LocalUser { param($Name, $ErrorAction) if (@($global:F.users) -contains $Name) { [pscustomobject]@{ Name = $Name } } }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  @($global:F.tasks | Where-Object { (-not $TaskPath -or $_.path -eq $TaskPath) -and (-not $TaskName -or $_.name -eq $TaskName) } | ForEach-Object { $t = $_
    [pscustomobject]@{ TaskName = $t.name; State = $t.state; Settings = [pscustomobject]@{ Enabled = $t.enabled }; Principal = [pscustomobject]@{ UserId = 'SYSTEM' }
      Actions = @([pscustomobject]@{ Execute = $t.exe; Arguments = $t.args }); _next = $t.next; _last = $t.last
      Triggers = @($t.triggers | ForEach-Object { [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_Task' + $_.kind + 'Trigger' }; Enabled = $_.enabled; Delay = $_.delay; Repetition = [pscustomobject]@{ Interval = $_.every } } }) } }) }
function global:Get-ScheduledTaskInfo { param($InputObject, $ErrorAction)
  [pscustomobject]@{ LastRunTime = $(if ($InputObject._last) { D $InputObject._last }); LastTaskResult = 0; NextRunTime = $(if ($InputObject._next) { D $InputObject._next }) } }
function global:Get-ChildItem { param($LiteralPath, [switch]$Directory, $Filter, $ErrorAction) $d = $global:F.dirs.$LiteralPath; if ($null -eq $d) { return @() }; @($d | ForEach-Object { [pscustomobject]@{ Name = $_ } }) }
function global:Join-Path { param($Path, $ChildPath) "$Path\$ChildPath" }
$env:SSH_CONNECTION = [string]$global:F.sshConnection
$S = [IO.File]::ReadAllText($StepsJson) | ConvertFrom-Json   # (Get-Content is stubbed above: read the steps file directly)
$out = [ordered]@{}
foreach ($p in $S.PSObject.Properties) {
  try { $r = @(& ([scriptblock]::Create([string]$p.Value))); $out[$p.Name] = [string]$r[-1] } catch { $out[$p.Name] = '{"error":' + (ConvertTo-Json -InputObject ("step threw: " + $_.Exception.Message)) + '}' } }
$out | ConvertTo-Json -Compress
