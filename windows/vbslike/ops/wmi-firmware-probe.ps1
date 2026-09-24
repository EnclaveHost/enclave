# wmi-firmware-probe.ps1 - the bounded custom-firmware run on the SUPPORTED WMI path.
#
# WHY A SECOND WRAPPER. ops/isolated-probe.ps1 does this for the HCS lab: its cleanup is
# `vbslike-host reap --prefix`, which terminates COMPUTE SYSTEMS. On the WMI path the things created
# are Hyper-V VMs, and reap would match none of them while Remove-VM is the only thing that removes
# them. Pointing the old wrapper at this path would leave every VM it created behind, so the cleanup
# is rewritten here rather than reused, and this script never calls the launcher at all.
#
# THE SETTING. AllowFirmwareLoadFromFile permits the VM worker to load an UNSIGNED, caller-supplied
# guest firmware image, HOST-WIDE, for every VM created while it is set. Steven authorised it as part
# of bringing this backend into the hosting path, for the length of a bounded run, restored after.
# It is applied here for ONE probe and removed again. This script never leaves it set on a normal
# return, on a thrown error, on a failed precondition or on the probe's own deadline.
#
# WHAT `finally` DOES NOT COVER: this process being killed (Stop-Process, taskkill, a crash) or power
# loss. Then the setting can be left applied; recovery is to remove it by hand. Stated, not covered.
#
# WHAT THIS DOES NOT TOUCH: no Windows feature, no boot configuration, no BitLocker state, no driver,
# no reboot, no change to the live node, and NO VM other than the exact names it created itself, each
# confirmed to carry this backend's ownership marker before removal. It never enumerates VMs by
# prefix alone and never deletes anything it did not create.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Image,
  [Parameter(Mandatory = $true)][string] $ImageSha256,
  [string] $EvidenceDir,
  [int]    $TimeoutSeconds = 240,
  [int]    $MemMiB = 4096,
  [int]    $Vcpus = 2,
  [string] $IsolationType = 'OpenHCL',
  # GuestFeatureSet: 513 (0x201) is what Microsoft's Set-OpenHCL-HyperV-VM.ps1 writes - but that
  # script creates the VM with NO guest-state isolation type, so it clobbers nothing. A VM created
  # with -GuestStateIsolationType OpenHCL already carries GuestFeatureSet 1024, and overwriting it
  # with 513 may be removing the very bit the isolation type set. -1 means LEAVE IT ALONE.
  [int]    $GuestFeatureSet = 513,
  # VTL2, where the paravisor lives. A VM created with -GuestStateIsolationType OpenHCL comes with
  # Vtl2AddressRangeBase/Size/MmioSize and Vtl2AddressSpaceConfigurationMode ALL ZERO - i.e. the
  # paravisor has no address space to be loaded into. -1 leaves each as it is.
  [long]   $Vtl2RangeMiB = -1,
  [long]   $Vtl2MmioMiB  = -1,
  [int]    $Vtl2Mode     = -1,
  [long]   $Vtl2BaseMiB  = -1,
  [int]    $IsolationMode = -1,
  [switch] $Approve
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$RegPath = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$RegName = 'AllowFirmwareLoadFromFile'
$MARKER  = 'enclave-vbslike-app-domain'
$stamp   = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if (-not $EvidenceDir) { $EvidenceDir = "C:\Users\claude\vbs-like\evidence\wmi-firmware-$stamp" }
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$script:notes = @()
function Note($m) { $line = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) $m"; $script:notes += $line; Write-Host $line }

# --- the setting, read exactly: status, value AND type, because restoring a DWORD as a string is a change
function Read-SettingState {
  if (-not (Test-Path $RegPath)) { return @{ Status = 'NoKey'; Value = $null; Kind = $null } }
  try {
    $item = Get-ItemProperty -Path $RegPath -Name $RegName -ErrorAction Stop
    $kind = (Get-Item -Path $RegPath).GetValueKind($RegName)
    return @{ Status = 'Present'; Value = $item.$RegName; Kind = "$kind" }
  } catch { return @{ Status = 'Absent'; Value = $null; Kind = $null } }
}

# --- the live node and the apps, before and after: this run must not disturb service
function Get-NodeHealth {
  $p = @(Get-Process node -ErrorAction SilentlyContinue | Sort-Object Id | ForEach-Object { "$($_.Id)@$($_.StartTime.ToUniversalTime().ToString('s'))" })
  $t = (Get-ScheduledTask -TaskName EnclaveWindowsNode -ErrorAction SilentlyContinue).State
  @{ NodePids = $p; Task = "$t" }
}
function Get-AppHealth {
  $ids = @()
  try { $ids = (Get-Content 'C:\Users\claude\vbs\node\host-state.json' -Raw | ConvertFrom-Json).tracked } catch { }
  $out = @()
  foreach ($id in $ids) {
    # curl.exe, not Invoke-WebRequest: Windows PowerShell 5.1 has no -SkipCertificateCheck or
    # -SkipHttpErrorCheck, so the cmdlet threw on EVERY app and this reported -1 for all six - a
    # health check that cannot distinguish a healthy app from a dead one, which is worse than none,
    # because the before/after comparison then silently passes whatever happens. curl.exe ships with
    # Windows, returns the status code as text, and treats a 401 as the answer it is.
    $code = -1
    try {
      $raw = & curl.exe -s -o NUL -w "%{http_code}" --max-time 20 "https://api.enclave.host/x/$id/" 2>$null
      if ("$raw" -match '^\d+$') { $code = [int]$raw }
    } catch { $code = -1 }
    $out += @{ id = "$id".Substring(0,10); code = $code }
  }
  $out
}

# --- cleanup: EXACT names this run created, ownership confirmed. Never a prefix sweep.
function Remove-OwnedVm([string]$name) {
  $v = Get-VM -Name $name -ErrorAction SilentlyContinue
  if (-not $v) { return "absent" }
  if ($v.Notes -ne $MARKER) { return "REFUSED: $name is not ours (Notes='$($v.Notes)')" }
  Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue
  Remove-VM -VM $v -Force
  return "removed"
}

$before      = Read-SettingState
$nodeBefore  = Get-NodeHealth
$appsBefore  = Get-AppHealth
$created     = New-Object System.Collections.Generic.List[string]
$mutated     = $false
$script:runFailure = $null

Note "image      : $Image"
Note "image sha  : $ImageSha256"
Note "setting    : $($before.Status)$(if ($before.Status -eq 'Present') { " $($before.Kind)=$($before.Value)" })"
Note "node       : pids=$($nodeBefore.NodePids -join ',') task=$($nodeBefore.Task)"
Note "apps before: $(($appsBefore | ForEach-Object { "$($_.id)=$($_.code)" }) -join ' ')"
$before     | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-before.json')
$nodeBefore | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-before.json')
$appsBefore | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'apps-before.json')

# --- preconditions, read-only
$actual = (Get-FileHash $Image -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $ImageSha256.ToLower()) { throw "the image on disk hashes $actual, not $ImageSha256" }
Note "image hash verified on the host"
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw "Get-VM is absent: no Hyper-V role, so nothing here could be created or cleaned up" }
if (-not (Get-Service vmms -ErrorAction SilentlyContinue)) { throw "vmms is not installed" }
Note "preconditions ok (role present, vmms installed)"

if (-not $Approve) {
  Write-Host "=== preflight complete. NOTHING was changed and nothing will be written by this run."
  Write-Host "    With -Approve it would:"
  Write-Host "      1. set $RegName = 1 (REG_DWORD) under $RegPath  [HOST-WIDE, permits UNSIGNED guest firmware]"
  Write-Host "      2. create ONE VM with -GuestStateIsolationType $IsolationType, pin $Image as its firmware, start it, read its console"
  Write-Host "      3. remove that exact VM by name with the ownership marker confirmed"
  Write-Host "      4. restore the setting to '$(if ($before.Status -eq 'Present') { "$($before.Kind)=$($before.Value)" } else { 'ABSENT' })' and verify status, value AND type"
  Write-Host "    Evidence: $EvidenceDir"
  return
}

try {
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
  $mutated = $true
  Note "SETTING APPLIED (DWORD=1). It is removed again in this run's cleanup."
  (Read-SettingState) | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-applied.json')

  $name = "enclave-fw-$stamp"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  $vm = New-VM -Name $name -Generation 2 -MemoryStartupBytes ($MemMiB * 1MB) -NoVHD -Version '12.0' -GuestStateIsolationType $IsolationType
  $created.Add($name) | Out-Null
  Set-VM -VM $vm -Notes $MARKER
  Set-VMProcessor -VM $vm -Count $Vcpus
  Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
  try { Set-VMFirmware -VM $vm -EnableSecureBoot Off } catch { Note "secure boot: $($_.Exception.Message)" }
  Note "created $name (isolation $IsolationType, ${MemMiB}MiB, $Vcpus vCPU, marker applied)"

  # pin the firmware through the supported WMI path
  $ns   = 'root\virtualization\v2'
  $cs   = Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where ElementName = '" + $name + "'")
  $vssd = $cs | Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState
  if ($GuestFeatureSet -ge 0) { $vssd.GuestFeatureSet = $GuestFeatureSet; Note "setting GuestFeatureSet=$GuestFeatureSet (was $($vssd.GuestFeatureSet))" }
  else { Note "leaving GuestFeatureSet as the isolation type set it: $($vssd.GuestFeatureSet)" }
  if ($Vtl2Mode -ge 0)     { $vssd.Vtl2AddressSpaceConfigurationMode = [uint16]$Vtl2Mode; Note "Vtl2AddressSpaceConfigurationMode=$Vtl2Mode" }
  # MEGABYTES, not bytes. Hyper-V said so itself: "The invalid value '268435456' was specified for
  # the VTL2 size ... Please enter a value between 128 and 1048576". 268435456 was 256 MiB expressed
  # in bytes, and the field wants 256.
  if ($Vtl2RangeMiB -ge 0) { $vssd.Vtl2AddressRangeSize = [uint64]$Vtl2RangeMiB; Note "Vtl2AddressRangeSize=$Vtl2RangeMiB (MiB)" }
  if ($Vtl2MmioMiB -ge 0)  { $vssd.Vtl2MmioAddressRangeSize = [uint64]$Vtl2MmioMiB; Note "Vtl2MmioAddressRangeSize=$Vtl2MmioMiB (MiB)" }
  if ($Vtl2BaseMiB -ge 0)  { $vssd.Vtl2AddressRangeBase = [uint64]$Vtl2BaseMiB; Note "Vtl2AddressRangeBase=$Vtl2BaseMiB (MiB)" }
  if ($IsolationMode -ge 0){ $vssd.GuestStateIsolationMode = [uint16]$IsolationMode; Note "GuestStateIsolationMode=$IsolationMode" }
  $vssd.FirmwareFile    = $Image
  $ser  = [Microsoft.Management.Infrastructure.Serialization.CimSerializer]::Create()
  $emb  = [System.Text.Encoding]::Unicode.GetString($ser.Serialize($vssd, [Microsoft.Management.Infrastructure.Serialization.InstanceSerializationOptions]::None))
  $svc  = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService
  $res  = Invoke-CimMethod -InputObject $svc -Name ModifySystemSettings -Arguments @{ SystemSettings = $emb }
  $prv = [int]$res.ReturnValue
  Note "pin returnValue=$prv"
  # 4096 means a JOB, not success. Without waiting for it the settings may never be applied and the
  # next line reads them back as they were - which is exactly what happened on the first VTL2 run:
  # FirmwareFile read back EMPTY, the VM started with no image, and the failure looked like a
  # finding about VTL2 when it was this script not waiting.
  if ($prv -eq 4096) {
    if (-not $res.Job) { throw "ModifySystemSettings returned 4096 with no Job" }
    $pj = $res.Job | Get-CimInstance
    $pdl = (Get-Date).AddSeconds(60)
    while ($pj.JobState -eq 4 -and (Get-Date) -lt $pdl) { Start-Sleep -Milliseconds 300; $pj = $pj | Get-CimInstance }
    Note "pin job state=$($pj.JobState) errorCode=$($pj.ErrorCode) desc=$(($pj.ErrorDescription -replace "`r?`n",' '))"
    if ($pj.JobState -ne 7) { throw "the firmware pin FAILED: job state $($pj.JobState), $($pj.ErrorDescription)" }
  } elseif ($prv -ne 0) { throw "ModifySystemSettings returned $prv" }
  $back = (Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where ElementName = '" + $name + "'")) |
          Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState
  Note "FirmwareFile reads back: $($back.FirmwareFile)"
  if ("$($back.FirmwareFile)" -ne "$Image") { throw "the pin did not land: FirmwareFile reads back '$($back.FirmwareFile)', not '$Image'" }
  Note "GuestFeatureSet reads back: $($back.GuestFeatureSet)"
  Note "Vtl2 reads back: mode=$($back.Vtl2AddressSpaceConfigurationMode) base=$($back.Vtl2AddressRangeBase) size=$($back.Vtl2AddressRangeSize) mmio=$($back.Vtl2MmioAddressRangeSize)"

  # serial console, so a booting paravisor can be heard
  $pipe = "\\.\pipe\$name-com1"
  try { Set-VMComPort -VM $vm -Number 1 -Path $pipe; Note "console on $pipe" } catch { Note "com port: $($_.Exception.Message)" }

  $t0 = Get-Date
  $startErr = $null
  # START VIA WMI, not Start-VM. Start-VM's message is often just "failed to start", and by the time
  # it has failed the VM is in a state where a second RequestStateChange answers 32775 (invalid
  # state for this operation) with NO job - so the reason is gone. Asking Msvm_ComputerSystem first
  # gives a Msvm_ConcreteJob whose ErrorDescription names the element that refused.
  $startErr = $null
  try {
    $cs2 = Get-CimInstance -Namespace $ns -Query ("select * from Msvm_ComputerSystem where ElementName = '" + $name + "'")
    $rsc = Invoke-CimMethod -InputObject $cs2 -MethodName RequestStateChange -Arguments @{ RequestedState = [uint16]2 }
    $rv = [int]$rsc.ReturnValue
    Note "RequestStateChange returnValue=$rv"
    if ($rv -eq 4096 -and $rsc.Job) {
      $job = $rsc.Job | Get-CimInstance
      $dl = (Get-Date).AddSeconds(90)
      while ($job.JobState -eq 4 -and (Get-Date) -lt $dl) { Start-Sleep -Milliseconds 500; $job = $job | Get-CimInstance }
      Note "job state=$($job.JobState) errorCode=$($job.ErrorCode) desc=$(($job.ErrorDescription -replace "`r?`n",' '))"
      if ($job.JobState -ne 7) {
        $startErr = "job state $($job.JobState), errorCode $($job.ErrorCode): $($job.ErrorDescription)"
        try { $ge = Invoke-CimMethod -InputObject $job -MethodName GetErrorEx
              foreach ($x in @($ge.Errors)) { Note ("job error: " + ($x -replace "`r?`n", ' ')) } }
        catch { Note "GetErrorEx: $(($_.Exception.Message -replace "`r?`n",' '))" }
      }
    } elseif ($rv -ne 0) { $startErr = "RequestStateChange returned $rv" }
    if (-not $startErr) { Note "START OK after $([int]((Get-Date)-$t0).TotalMilliseconds) ms, state=$((Get-VM -Name $name).State)" }
    else { Note "START FAILED: $startErr" }
  } catch { $startErr = ($_.Exception.Message -replace "`r?`n", ' '); Note "START FAILED (exception): $startErr" }

  $loadLines = @()
  if (-not $startErr) {
    # give the guest until the deadline to say something
    $bytes = 0; $head = ''
    while ((Get-Date) -lt $deadline -and $bytes -eq 0) {
      Start-Sleep -Seconds 3
      try {
        $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', "$name-com1", [System.IO.Pipes.PipeDirection]::In)
        $c.Connect(1000)
        $buf = New-Object byte[] 4096
        $n = $c.Read($buf, 0, $buf.Length)
        if ($n -gt 0) { $bytes = $n; $head = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n) }
        $c.Dispose()
      } catch { }
    }
    Note "console: $bytes bytes$(if ($bytes -gt 0) { " head=$($head.Substring(0,[Math]::Min(120,$head.Length)))" })"
    $loadLines = @(Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Worker-Operational' -MaxEvents 40 -ErrorAction SilentlyContinue |
                   Where-Object { $_.TimeCreated -ge $t0 } | ForEach-Object { ($_.Message -replace "`r?`n", ' ') })
    foreach ($l in $loadLines) { Note "OP: $l" }
  }
  $adm = @(Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Worker-Admin' -MaxEvents 30 -ErrorAction SilentlyContinue |
           Where-Object { $_.TimeCreated -ge $t0 } | Sort-Object TimeCreated |
           ForEach-Object { "[$($_.Id)] " + ($_.Message -replace "`r?`n", ' ') })
  foreach ($l in $adm) { Note "ADMIN: $l" }
  @{ start = $startErr; operational = $loadLines; admin = $adm } | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $EvidenceDir 'probe.json')
}
catch {
  $script:runFailure = $_.Exception.Message
  Note "RUN FAILED: $($script:runFailure)"
}
finally {
  # Nothing in here may terminate this block, and RESTORATION sits in its own nested finally so a
  # failure removing a VM cannot skip it. Each step is attempted regardless of the others.
  $ErrorActionPreference = 'Continue'
  Note "=== cleanup"
  $failures = @()

  try {
    try {
      foreach ($n in $created) {
        $r = Remove-OwnedVm $n
        Note "cleanup ${n}: $r"
        if ($r -like 'REFUSED*') { $failures += $r }
      }
      $stray = @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'enclave-fw-*' })
      if ($stray) { $failures += "VMs this run created are still present: $($stray.Name -join ', ')" }
    } catch { $failures += "cleanup: $($_.Exception.Message)" }
  }
  finally {
    # RESTORE, always, to the exact prior status, value and type.
    try {
      if ($mutated) {
        if ($before.Status -eq 'Present') { Set-ItemProperty -Path $RegPath -Name $RegName -Value $before.Value -Type $before.Kind }
        else { Remove-ItemProperty -Path $RegPath -Name $RegName -ErrorAction SilentlyContinue }
      }
      $after = Read-SettingState
      $after | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-after.json')
      $same = ($after.Status -eq $before.Status) -and ("$($after.Value)" -eq "$($before.Value)") -and ($after.Kind -eq $before.Kind)
      if ($same) { Note "SETTING RESTORED to $(if ($before.Status -eq 'Present') { "$($before.Kind)=$($before.Value)" } else { 'ABSENT' }) (status, value and type verified)" }
      else { $failures += "SETTING NOT RESTORED: now $($after.Status) $($after.Kind)=$($after.Value), was $($before.Status) $($before.Kind)=$($before.Value)" }
    } catch { $failures += "RESTORE FAILED: $($_.Exception.Message)" }
  }

  try {
    $nodeAfter = Get-NodeHealth
    $nodeAfter | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-after.json')
    if (($nodeAfter.NodePids -join ',') -ne ($nodeBefore.NodePids -join ',') -or $nodeAfter.Task -ne $nodeBefore.Task) {
      $failures += "the live node changed: before pids=$($nodeBefore.NodePids -join ',') task=$($nodeBefore.Task); after pids=$($nodeAfter.NodePids -join ',') task=$($nodeAfter.Task)"
    } else { Note "live node unchanged (pids=$($nodeAfter.NodePids -join ',') task=$($nodeAfter.Task))" }
    $appsAfter = Get-AppHealth
    $appsAfter | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'apps-after.json')
    Note "apps after : $(($appsAfter | ForEach-Object { "$($_.id)=$($_.code)" }) -join ' ')"
    # A baseline where NOTHING answered means the check is broken, not that the apps are down: it
    # would make every after-comparison pass no matter what this run did.
    $liveBefore = @($appsBefore | Where-Object { $_.code -gt 0 }).Count
    if ($appsBefore.Count -gt 0 -and $liveBefore -eq 0) {
      $failures += "the app health check saw NO app answering before the run: it cannot show this run was harmless, so it is reported rather than passed over"
    }
    foreach ($b in $appsBefore) {
      $a = $appsAfter | Where-Object { $_.id -eq $b.id }
      if ($b.code -gt 0 -and $a -and $a.code -le 0) { $failures += "app $($b.id) answered $($b.code) before and $($a.code) after" }
    }
  } catch { $failures += "health check: $($_.Exception.Message)" }

  if ($script:runFailure) { $failures += $script:runFailure }
  $script:notes | Set-Content (Join-Path $EvidenceDir 'transcript.txt')
  @{ failures = $failures; evidence = $EvidenceDir } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $EvidenceDir 'result.json')
  Note "evidence: $EvidenceDir"
  if ($failures.Count -gt 0) { foreach ($f in $failures) { Write-Host "FAILURE: $f" }; Write-Host "RUN FAILED: $($failures.Count) failure(s)" }
  else { Write-Host "RUN OK" }
}
