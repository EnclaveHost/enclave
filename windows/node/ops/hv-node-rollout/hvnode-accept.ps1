# hvnode-accept.ps1 - READ-ONLY acceptance of the running hv node + manager on the NucBox (ROLLOUT.md step 7, the box
# half; the relay/public half is hvnode-accept-remote.sh). Prints PASS / FAIL / INFO; exits 1 on any FAIL.
#   powershell -ExecutionPolicy Bypass -File hvnode-accept.ps1 -Commit <node commit, 8+ hex> [-DeploymentId 0x…]
param(
  [Parameter(Mandatory = $true)][string]$Commit,
  [string]$DeploymentId = '',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [int]$ManagerPort = 8091, [int]$LocalPort = 9600,
  [string]$Operator = '0x389C3f030a209D04D026228D2D053fEB75DbadcA',
  [string]$RuntimeId = 'ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8'
)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function GetJson([string]$url) { Invoke-RestMethod -Uri $url -TimeoutSec 15 -UseBasicParsing }
$c8 = $Commit.Substring(0, 8).ToLower()

# A1: the platform is as it was: Secure Boot on, the legacy task still Disabled (and still there)
try { Check ((Confirm-SecureBootUEFI) -eq $true) 'A1 Secure Boot is ON' } catch { Say 'FAIL' "A1 Secure Boot unreadable" }
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
Check ($legacy -and $legacy.State -eq 'Disabled') 'A1 legacy task \EnclaveWindowsNode exists and is Disabled'

# A2: the two tasks run, from the installed files
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  $x = Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue
  Check ($x -and $x.State -eq 'Running') "A2 task \$t is Running ($(if ($x) { $x.State } else { 'absent' }))"
}
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
$nodeProc = @($procs | Where-Object { $_.CommandLine -like '*agent.mjs*' })
$mgrProc = @($procs | Where-Object { $_.CommandLine -like '*main.mjs*' })
Check ($nodeProc.Count -eq 1) "A2 exactly one node agent process ($($nodeProc.Count))"
Check ($mgrProc.Count -eq 1) "A2 exactly one manager process ($($mgrProc.Count))"
$runNode = Get-Content -Raw (Join-Path $Root 'run-node.cmd')
Check ($runNode -like "*\hvnode\$c8\windows\node*") "A2 run-node.cmd runs the tree $c8"

# A3: the manager: preflight passed, the backend, the runtime the node names
try {
  $h = GetJson "http://127.0.0.1:$ManagerPort/health"
  Check ($h.canStart -eq $true) "A3 manager /health canStart=true"
  Check ("$($h.backend)" -eq 'hyperv-partition-per-app') "A3 manager backend $($h.backend)"
  Check ("$($h.catalog.runtimeId)" -eq $RuntimeId) "A3 manager catalog.runtimeId = the node's ENCLAVE_ISOLATION_RUNTIME_ID ($("$($h.catalog.runtimeId)".Substring(0, [Math]::Min(8, "$($h.catalog.runtimeId)".Length))))"
  Check ($h.boundary.hostExcluded -ne $true) ("A3 manager boundary.hostExcluded={0} (never claimed: T0-hv, monitor-signed)" -f $h.boundary.hostExcluded)
} catch { Say 'FAIL' "A3 manager /health: $($_.Exception.Message)" }

# A4: the node (loopback surface): the hv role, engine retired, owner-only, registered, gas
try {
  $a = GetJson "http://127.0.0.1:$LocalPort/availability"
  Check ("$($a.role)" -eq 'windows-hv-node') "A4 node role $($a.role)"
  Check ($null -eq $a.teeCpu) 'A4 node teeCpu is null (no TEE claim)'
  Check ("$($a.claimScope)" -eq 'owner-only') "A4 claimScope $($a.claimScope)"
  Check ("$($a.operator)".ToLower() -eq $Operator.ToLower()) "A4 operator $($a.operator)"
  Check ($a.registered -eq $true) 'A4 registered on chain'
  $owners = @($a.owners | ForEach-Object { "$_".ToLower() })
  Check ($owners -contains $Operator.ToLower()) ("A4 owners served: {0} (the operator, plus each valid delegation)" -f ($owners -join ', '))
  Check ([int]$a.gasRenewalsLeft -gt 200) "A4 gasRenewalsLeft $($a.gasRenewalsLeft) (> 200; GAS.md)"
  Check ("$($a.tier)" -eq 'hv-node') "A4 relay verdict tier $($a.tier) (the attach was accepted)"
  if ($null -ne $a.isolation) { Check ("$($a.isolation)" -eq 'hyperv-partition-per-app') "A4 advertises isolation $($a.isolation)" }
  else { Say 'INFO' 'A4 the node does not advertise availability.isolation yet (b4 adds it; test 1 needs it for `deploy --isolation`)' }
  $v = GetJson "http://127.0.0.1:$LocalPort/v1/health"
  Check ("$($v.engine)" -eq 'retired') "A4 engine $($v.engine)"
} catch { Say 'FAIL' "A4 node loopback: $($_.Exception.Message)" }

# A5: the logs: the attach, and no legacy engine
$log = Join-Path $Root 'logs\node.log'
if (Test-Path $log) {
  $tail = Get-Content $log -Tail 400
  Check (@($tail | Select-String -SimpleMatch 'ee-host').Count -eq 0) 'A5 node.log never starts ee-host'
  Say 'INFO' ("A5 node.log attach lines: " + (@($tail | Select-String -Pattern 'attest|attach|hv-node' | Select-Object -Last 3 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(140, $_.Line.Length)) }) -join ' | '))
} else { Say 'FAIL' "A5 no $log" }

# A6: M3 is applied (permanent), as recorded
$virt = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'
Check (((Get-ItemProperty -Path $virt -Name AllowFirmwareLoadFromFile -ErrorAction SilentlyContinue).AllowFirmwareLoadFromFile) -eq 1) 'A6 AllowFirmwareLoadFromFile = 1'
Check (Test-Path (Join-Path $virt 'GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3')) 'A6 hv_sock 9001 GUID registered'
Check (Test-Path (Join-Path $Root 'm3-prior-state.json')) 'A6 the M3 prior state is recorded (for -Revert)'

# A7 (with -DeploymentId): the test deployment runs as a partition, and the manager's view is T0-hv, host not excluded
if ($DeploymentId) {
  try {
    $vms = (GetJson "http://127.0.0.1:$ManagerPort/vms").vms
    $mine = @($vms | Where-Object { "$($_.name)".ToLower() -eq $DeploymentId.ToLower() })
    Check ($mine.Count -eq 1) "A7 the manager holds one VM for $($DeploymentId.Substring(0,10))"
    if ($mine.Count -eq 1) {
      Check ("$($mine[0].status)" -eq 'running') "A7 its status $($mine[0].status)"
      Check ("$($mine[0].tier)" -match '^(?i)t0-hv$') "A7 its tier $($mine[0].tier)"
      Check ($mine[0].hostExcluded -ne $true) 'A7 hostExcluded is not claimed'
      Say 'INFO' ("A7 transportKeySha256 {0} (hvnode-accept-remote.sh compares the public TLS key with it)" -f $mine[0].transportKeySha256)
    }
  } catch { Say 'FAIL' "A7 manager /vms: $($_.Exception.Message)" }
}
if ($script:fails -gt 0) { Write-Output "ACCEPT (box): $($script:fails) FAIL(s)"; exit 1 }
Write-Output 'ACCEPT (box): all PASS'
