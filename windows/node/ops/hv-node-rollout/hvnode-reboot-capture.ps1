# hvnode-reboot-capture.ps1 - READ-ONLY evidence for the host-reboot acceptance (REBOOT.md), before and after.
#   before:  powershell -ExecutionPolicy Bypass -File hvnode-reboot-capture.ps1 -Phase pre  -DeploymentId 0x<64> -OutDir <dir>
#   after:   powershell -ExecutionPolicy Bypass -File hvnode-reboot-capture.ps1 -Phase post -DeploymentId 0x<64> -OutDir <dir>
#   -ManagerOnly (post): the manager-only variant (REBOOT.md): the host must NOT have rebooted; the rest is judged the same.
# `pre` writes <dir>\capture-pre.json. `post` writes <dir>\capture-post.json and JUDGES it against capture-pre.json:
# PASS / FAIL / INFO lines, exit 1 on any FAIL. Nothing here starts, stops, or changes anything; no key is read.
# What `post` requires (enclave-87's ruling (B), as amended): the host really rebooted; Secure Boot still ON; the legacy
# task still present and Disabled; both hv tasks Running; exactly ONE manager-tagged VM, Running, a NEW instance (the
# recovered one retired: not listed by the manager, not in Hyper-V); the manager's record for the deployment running on a
# NEW transport key; the node's log showing the restart recovery for it, and NO renewal of it between the boot and that
# recovery (a held lease is not renewed); the node registered, owner-only, isolation advertised.
param(
  [Parameter(Mandatory = $true)][ValidateSet('pre', 'post')][string]$Phase,
  [Parameter(Mandatory = $true)][ValidatePattern('^0x[0-9a-fA-F]{64}$')][string]$DeploymentId,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$ManagerOnly,
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [int]$ManagerPort = 8091, [int]$LocalPort = 9600
)
$ErrorActionPreference = 'Stop'
$id = $DeploymentId.ToLower(); $id10 = $id.Substring(0, 10)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
function GetJson([string]$url) { try { Invoke-RestMethod -Uri $url -TimeoutSec 15 -UseBasicParsing } catch { $null } }
function TaskState([string]$n) { $t = Get-ScheduledTask -TaskName $n -TaskPath '\' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'absent' } }
function LineCount([string]$p) { if (Test-Path -LiteralPath $p) { @(Get-Content -LiteralPath $p).Count } else { 0 } }

$os = Get-CimInstance Win32_OperatingSystem
# the boot, by the box's own monotonic counter (enclave-d1: it increments on every boot, 69 on 2026-09-26; LastBootUpTime
# is NOT updated by a Fast Startup "shutdown then power on", so it only corroborates), and the clock it is read against
$bootId = $null
try { $bootId = [int](Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters' -Name BootId -ErrorAction Stop).BootId } catch { $bootId = $null }
$w32 = $e = $null; $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $w32 = @(& w32tm /query /status 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^(Source|Stratum|Last Successful Sync Time):' }) -join '; ' } finally { $ErrorActionPreference = $e }
$sb = $null; try { $sb = [bool](Confirm-SecureBootUEFI) } catch { $sb = $null }
$vms = @(Get-VM | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' } |
  ForEach-Object { [ordered]@{ name = $_.Name; vmId = [string]$_.VMId; state = [string]$_.State; uptimeSec = [int]$_.Uptime.TotalSeconds } })
$all = @((GetJson "http://127.0.0.1:$ManagerPort/vms").vms)
$mine = @($all | Where-Object { "$($_.name)".ToLower() -eq $id })
$av = GetJson "http://127.0.0.1:$LocalPort/availability"
$cap = [ordered]@{
  phase = $Phase; at = (Get-Date).ToUniversalTime().ToString('o'); deployment = $id
  bootId = $bootId; lastBoot = $os.LastBootUpTime.ToUniversalTime().ToString('o'); timeSource = $w32; secureBoot = $sb
  tasks = [ordered]@{ manager = (TaskState 'EnclaveHvManager'); node = (TaskState 'EnclaveHvNode'); legacy = (TaskState 'EnclaveWindowsNode') }
  vms = $vms
  managerRecords = @($mine | ForEach-Object { [ordered]@{ id = $_.id; status = $_.status; recovered = [bool]$_.recovered; vmState = $_.vmState; transportKeySha256 = $_.transportKeySha256; tier = $_.tier } })
  managerRecordCount = @($all).Count
  node = $(if ($av) { [ordered]@{ role = $av.role; registered = $av.registered; claimScope = $av.claimScope; isolation = $av.isolation; owners = @($av.owners); gasRenewalsLeft = $av.gasRenewalsLeft; tier = $av.tier } } else { $null })
  nodeLogLines = (LineCount (Join-Path $Root 'logs\node.log')); managerLogLines = (LineCount (Join-Path $Root 'logs\manager.log'))
}
$file = Join-Path $OutDir "capture-$Phase.json"
$cap | ConvertTo-Json -Depth 6 | Set-Content -Path $file -Encoding UTF8
Write-Output "wrote $file"
if ($Phase -eq 'pre') {
  if ($null -eq $bootId) { Write-Output 'FAIL pre: the BootId counter is unreadable, so a reboot could not be told from none'; exit 1 }
  Write-Output ("pre: BootId {5}; boot {0}; VMs {1}; record {2}; key {3}; node.log {4} lines" -f $cap.lastBoot, $vms.Count,
    $(if ($mine.Count) { "$($mine[0].id) $($mine[0].status)" } else { 'none' }), $(if ($mine.Count) { "$($mine[0].transportKeySha256)" } else { '-' }), $cap.nodeLogLines, $bootId)
  if ($mine.Count -ne 1 -or "$($mine[0].status)" -ne 'running') { Write-Output 'FAIL pre: the deployment is not running on exactly one partition: fix that before rebooting'; exit 1 }
  exit 0
}

# ---- post: the verdict against the pre capture ----
$pre = Get-Content -Raw (Join-Path $OutDir 'capture-pre.json') | ConvertFrom-Json
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
$preRec = @($pre.managerRecords)[0]
# the reboot, by BootId (exact); LastBootUpTime corroborates; both clocks named
if ($ManagerOnly) { Check ($null -ne $bootId -and $bootId -eq [int]$pre.bootId) "the host did NOT reboot (manager-only variant): BootId $($pre.bootId) -> $bootId" }
else { Check ($null -ne $bootId -and $bootId -eq ([int]$pre.bootId + 1)) "the host rebooted exactly once: BootId $($pre.bootId) -> $bootId" }
Say 'INFO' ("LastBootUpTime {0} -> {1} (corroboration only); time source before: {2}; after: {3}" -f $pre.lastBoot, $cap.lastBoot, $pre.timeSource, $cap.timeSource)
Check ($sb -eq $true) 'Secure Boot is ON'
Check ($cap.tasks.legacy -eq 'Disabled') "the legacy task \EnclaveWindowsNode is present and Disabled ($($cap.tasks.legacy))"
Check ($cap.tasks.manager -eq 'Running' -and $cap.tasks.node -eq 'Running') "both hv tasks Running (manager $($cap.tasks.manager), node $($cap.tasks.node))"
Check ($vms.Count -eq 1 -and $vms[0].state -eq 'Running') ("exactly ONE manager-tagged VM, Running ({0})" -f (($vms | ForEach-Object { "$($_.name) $($_.state)" }) -join ', '))
$oldVmName = @($pre.vms | ForEach-Object { $_.name })
Check (@($vms | Where-Object { $oldVmName -contains $_.name }).Count -eq 0) 'the pre-reboot VM is gone from Hyper-V (retired, not kept)'
Check ($mine.Count -eq 1) "the manager holds ONE record for the deployment ($($mine.Count))"
if ($mine.Count -eq 1) {
  Check ("$($mine[0].status)" -eq 'running' -and -not $mine[0].recovered) "its record is running and not recovered ($($mine[0].status))"
  Check ("$($mine[0].id)" -ne "$($preRec.id)") "a NEW instance ($($preRec.id) -> $($mine[0].id))"
  Check ("$($mine[0].transportKeySha256)" -match '^[0-9a-f]{64}$' -and "$($mine[0].transportKeySha256)" -ne "$($preRec.transportKeySha256)") "a NEW transport key ($("$($preRec.transportKeySha256)".Substring(0, 16))… -> $("$($mine[0].transportKeySha256)".Substring(0, [Math]::Min(16, "$($mine[0].transportKeySha256)".Length)))…); R4 compares the public TLS key with it"
  Say 'INFO' "new transportKeySha256 $($mine[0].transportKeySha256) (hvnode-accept-remote.sh $id <this>)"
}
if ($cap.node) {
  Check ($cap.node.registered -eq $true -and "$($cap.node.claimScope)" -eq 'owner-only' -and "$($cap.node.isolation)" -eq 'hyperv-partition-per-app') "node registered, owner-only, isolation $($cap.node.isolation)"
  Check ("$($cap.node.tier)" -eq 'hv-node') "the relay's verdict on the node's new attach: tier $($cap.node.tier)"
} else { Say 'FAIL' 'the node /availability did not answer' }
# the node's log since the pre capture: the recovery line, and no renewal of this deployment before it
$log = @(Get-Content -LiteralPath (Join-Path $Root 'logs\node.log'))
$since = @($log | Select-Object -Skip ([int]$pre.nodeLogLines))
# after a host reboot the recovered VM was Off (AutomaticStartAction Nothing); after a manager-only restart, Running
$wantState = $(if ($ManagerOnly) { 'Running' } else { 'Off' })
$recIdx = -1; for ($i = 0; $i -lt $since.Count; $i++) { if ($since[$i] -match ([regex]::Escape($id10) + ' restart recovery: the recovered VM \S+ \(' + $wantState + '\) was retired; starting ONE fresh partition')) { $recIdx = $i; break } }
Check ($recIdx -ge 0) "node.log: the restart recovery of $id10 from a $wantState VM ($(if ($recIdx -ge 0) { $since[$recIdx].Substring(0, [Math]::Min(160, $since[$recIdx].Length)) } else { 'absent' }))"
if ($recIdx -ge 0) {
  $early = @($since[0..$recIdx] | Where-Object { $_ -match ('renewed ' + [regex]::Escape($id10)) })
  Check ($early.Count -eq 0) "no renewal of $id10 between the boot and its recovery ($($early.Count))"
}
$holds = @($since | Where-Object { $_ -match ([regex]::Escape($id10) + ' isolation: reboot recovery') })
Check ($holds.Count -eq 0) "no reboot-recovery HOLD for $id10 ($($holds.Count))"
Say 'INFO' ("node.log since pre: {0} lines; renewals of {1}: {2}; NOT renewed: {3}" -f $since.Count, $id10,
  @($since | Where-Object { $_ -match ('renewed ' + [regex]::Escape($id10)) }).Count, @($since | Where-Object { $_ -match ([regex]::Escape($id10) + ' NOT renewed') }).Count)
if ($script:fails -gt 0) { Write-Output "REBOOT ACCEPTANCE (box): $($script:fails) FAIL(s)"; exit 1 }
Write-Output 'REBOOT ACCEPTANCE (box): all PASS'
