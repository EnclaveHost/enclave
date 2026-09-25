# uefi-dev-boot.ps1 - a DEV boot of the guest as a UEFI VTL0 in a Gen2 OpenHCL partition.
#
# WHY THIS EXISTS. Measured on this box: Microsoft's standard OpenHCL image starts, and BOTH
# linux-direct images - Microsoft's own release and ours - fail with a bare Worker event 12030
# under the settings tested. So the guest boots as a UEFI stub (a UKI on a read-only medium)
# instead, which is the shape Microsoft ships and tests. The payload is unchanged; only how VTL0 is
# entered changes.
#
# THIS IS A DEV BOOT AND THE LABEL IS NOT DECORATION. Host exclusion is NOT established on this
# path. Nothing here may be reported as verified, attested or host-excluded capacity, and this
# script prints that on every run so a transcript cannot be read as more than it is.
#
# WHAT IT REFUSES TO DO:
#   - it never leaves AllowFirmwareLoadFromFile set: applied for one boot, restored, verified;
#   - it removes only the exact VM it created, and only with this backend's ownership marker;
#   - it adds NO vTPM. The guest's stub measures into PCRs that nothing on this path reads, and a
#     vTPM present but unread LOOKS like attestation to anyone reading the VM's configuration;
#   - it adds no boot-entry LoadOptions and no SMBIOS type 11 strings, and it READS THE BOOT
#     CONFIGURATION BACK before starting and refuses if any appeared. The guest powers off with
#     "MON ERROR refusing to start" if they did, which is a good failure - but a definition that
#     cannot produce it is better than one that relies on the guest to catch it.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Iso,            # the boot medium (deterministic El Torito)
  [Parameter(Mandatory = $true)][string] $IsoSha256,      # pinned; verified on this host
  [string] $Firmware   = 'C:\openhcl-probe\openhcl.bin',  # Microsoft's STANDARD OpenHCL, not linux-direct
  [string] $FirmwareSha256 = '48773995cfa2222ca7bb40020a807dcb8ce155a244b0987ba55334caafe49075',
  [int]    $MemMiB     = 2048,
  [int]    $Vcpus      = 1,
  [int]    $ReadySeconds = 120,
  # THE MODULE THAT DEFINES THE VM, pinned like the medium and the firmware. It was imported from a
  # hand-placed path with no hash check, which is inconsistent: petri's New-CustomVM has more
  # influence on what runs than either file I was verifying (enclave-53).
  [string] $HypervModule = 'C:\Users\claude\hyperv.psm1',
  [string] $HypervModuleSha256 = '17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c',
  [switch] $SkipModulePin,
  [switch] $Approve
)
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$RegPath = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$RegName = 'AllowFirmwareLoadFromFile'
$MARKER  = 'enclave-vbslike-app-domain'
$stamp   = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$name    = "enclave-uefi-$stamp"
$pipe    = "$name-com1"
$notes   = @()
# WRITTEN AS IT GOES, not only at the end. An ssh timeout killed my view of two runs tonight and the
# transcript went with it; a run whose evidence only exists in a dropped console is a run that did
# not happen.
$script:logPath = "C:\Users\claude\uefi-dev-boot-$stamp.log"
function Note($m){
  $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) $m"
  $script:notes += $l; Write-Host $l
  try { Add-Content -Path $script:logPath -Value $l -EA SilentlyContinue } catch { }
}

Note "=== DEV BOOT. Host exclusion is NOT established on this path. Nothing here is verified capacity. ==="
Note "    partition kind: wmi-openhcl-gen2 (the LAUNCHER states it; the guest cannot know it)"

function Read-Setting {
  if (-not (Test-Path $RegPath)) { return @{ S='NoKey' } }
  try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop
        @{ S='Present'; V=$i.$RegName; K="$((Get-Item $RegPath).GetValueKind($RegName))" } }
  catch { @{ S='Absent' } }
}
function App($h){ & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 "https://$h.app.enclave.host/" 2>$null }
$APPS = @('e64f7cba','d9798e4c','a77d0c57','7ae476a3','a69dcbba','c34499ee')

# self-heal: a run killed with its SSH can leave a VM and the setting applied
# THE ORPHAN WINDOW. The marker is applied AFTER New-CustomVM returns, so a kill in between leaves a
# VM with EMPTY Notes - which a marker-only rule then refuses to remove, stranding the very VM the
# cleanup exists for (enclave-53; wmi-launcher.mjs documents the same trap and I reintroduced it
# here). `enclave-uefi-*` is this script's own namespace, so an empty-Notes VM under that name is
# ours by construction. A VM under that name carrying SOMEBODY ELSE'S marker is still refused.
foreach ($v in (Get-VM -EA SilentlyContinue | Where-Object { $_.Name -like 'enclave-uefi-*' })) {
  if ($v.Notes -eq $MARKER -or [string]::IsNullOrWhiteSpace($v.Notes)) {
    Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Remove-VM -VM $v -Force -EA SilentlyContinue
    Note "self-heal: removed stale $($v.Name) (notes: $(if($v.Notes){'ours'}else{'EMPTY - killed before the marker was applied'}))"
  } else { Note "self-heal: REFUSING $($v.Name), Notes='$($v.Notes)' is not ours" }
}

$before   = Read-Setting
$nodeBefore = @(Get-Process node -EA SilentlyContinue | ForEach-Object { $_.Id }) -join ','
$appsBefore = $APPS | ForEach-Object { "$_=$(App $_)" }
Note "setting before: $($before.S)"
Note "node pids     : $nodeBefore"
Note "apps before   : $($appsBefore -join ' ')"
if (@($appsBefore | Where-Object { $_ -match '=(200|401)$' }).Count -eq 0) {
  throw "no app answered before this run: the health check cannot show this boot was harmless, so it is refused"
}

foreach ($f in @(@{p=$Iso;h=$IsoSha256;n='medium'}, @{p=$Firmware;h=$FirmwareSha256;n='firmware'})) {
  if (-not (Test-Path $f.p)) { throw "$($f.n) not found: $($f.p)" }
  $got = (Get-FileHash $f.p -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $f.h.ToLower()) { throw "$($f.n) hashes $got, not the pinned $($f.h)" }
  Note "$($f.n) verified: $($f.p) ($((Get-Item $f.p).Length) bytes)"
}

if (-not $Approve) {
  Write-Host "=== preflight only. Nothing changed. With -Approve it would:"
  Write-Host "      1. set $RegName = 1 (REG_DWORD)  [HOST-WIDE, permits UNSIGNED guest firmware]"
  Write-Host "      2. create ONE Gen2 VM, isolation OpenHCL, Secure Boot OFF, NO vTPM,"
  Write-Host "         firmware $Firmware, DVD $Iso as the only boot device, COM1 -> \\.\pipe\$pipe"
  Write-Host "      3. read the boot configuration BACK and refuse if any LoadOptions appeared"
  Write-Host "      4. start it and watch COM1 for 'MON ready control_port=9000' for $ReadySeconds s"
  Write-Host "      5. remove that exact VM and restore the setting, verified"
  return
}

$mutated = $false
$created = $false

# THE WATCHDOG, launched BEFORE the setting is applied.
#
# `finally` does not run when this process is killed - and that is not hypothetical: an ssh timeout
# killed a run tonight, leaving AllowFirmwareLoadFromFile APPLIED and a VM RUNNING until I removed
# them by hand. Cleanup did not "hold" there, it failed. So a separate detached process now owns the
# guarantee: it waits past this run's own deadline and, if the sentinel file still exists, force
# restores the setting and removes this run's VM. The main script deletes the sentinel on a clean
# finish, so the watchdog then does nothing.
$sentinel = "C:\Users\claude\uefi-probe-active-$stamp.txt"
Set-Content -Path $sentinel -Value "$name" -Force
$wdSeconds = $ReadySeconds + 120
$wd = @"
Start-Sleep -Seconds $wdSeconds
if (Test-Path '$sentinel') {
  `$m = '$MARKER'
  foreach (`$v in (Get-VM -EA SilentlyContinue | Where-Object { `$_.Name -eq '$name' -and (`$_.Notes -eq `$m -or [string]::IsNullOrWhiteSpace(`$_.Notes)) })) {
    Stop-VM -VM `$v -TurnOff -Force -EA SilentlyContinue; Remove-VM -VM `$v -Force -EA SilentlyContinue
  }
  # RESTORE TO WHAT WAS THERE, not unconditionally to absent. It is absent on this box today, which
  # is why always-removing looked correct; it would be wrong the day the key is legitimately set.
  if ('$($before.S)' -eq 'Present') { Set-ItemProperty '$RegPath' -Name '$RegName' -Value $($before.V) -Type '$($before.K)' }
  else { Remove-ItemProperty '$RegPath' -Name '$RegName' -EA SilentlyContinue }
  Add-Content -Path '$script:logPath' -Value "`$((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) WATCHDOG fired: the run did not clean up; setting restored and `$('$name') removed" -EA SilentlyContinue
  Remove-Item '$sentinel' -Force -EA SilentlyContinue
}
"@
$wdFile = "C:\Users\claude\uefi-watchdog-$stamp.ps1"
Set-Content -Path $wdFile -Value $wd -Force
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wdFile" } | Out-Null
Note "watchdog armed for ${wdSeconds}s (it force-restores the setting if this run is killed)"

try {
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD; $mutated = $true
  Note "SETTING APPLIED (removed again in this run's cleanup)"

  if (-not $SkipModulePin) {
    if (-not (Test-Path $HypervModule)) { throw "the Hyper-V module is not at $HypervModule" }
    $mh = (Get-FileHash $HypervModule -Algorithm SHA256).Hash.ToLower()
    if ($mh -ne $HypervModuleSha256.ToLower()) { throw "the module that DEFINES the VM hashes $mh, not the pinned $HypervModuleSha256" }
    Note "hyperv.psm1 verified: $mh"
  } else { Note "hyperv.psm1 pin SKIPPED by request (the VM definition is therefore unverified)" }
  Import-Module $HypervModule -Force   # petri's New-CustomVM, the reference definition
  New-CustomVM -VMName $name -GuestStateIsolationEnabled $true -GuestStateIsolationType 16 `
    -GuestStateIsolationMode 0 -FirmwareFile $Firmware -IncreaseVtl2Memory `
    -SecureBootEnabled $false -Com1 $true -Memory ($MemMiB * 1MB) -VpCount $Vcpus | Out-Null
  $created = $true
  $vm = Get-VM -Name $name
  Set-VM -VM $vm -Notes $MARKER
  Note "created $name (id $($vm.Id)) - Gen2, isolation OpenHCL, Secure Boot off, NO vTPM"

  & icacls $Iso      /grant "NT VIRTUAL MACHINE\$($vm.Id):R" | Out-Null
  & icacls $Firmware /grant "NT VIRTUAL MACHINE\$($vm.Id):R" | Out-Null

  # petri's New-CustomVM defines the VM through a single DefineSystem call and adds NO storage
  # controller, so there is nowhere to attach a boot medium: Add-VMDvdDrive fails with "no available
  # locations were found on the disk controller". Measured on the first run. Add one first.
  if (-not (Get-VMScsiController -VM $vm -ErrorAction SilentlyContinue)) {
    Add-VMScsiController -VM $vm
    Note "added a SCSI controller (New-CustomVM creates none)"
  }
  Add-VMDvdDrive -VM $vm -Path $Iso
  # HASHED AT ATTACH TIME, not from the pin argument. The pin says what we MEANT to attach; this
  # says what the VM is actually pointed at, and they are only the same if nothing changed the file
  # between the check above and this line. partition.guestImageSha256 is this value - the MEDIUM's,
  # not the UKI's, because with Secure Boot off the stub reads addons and credentials from the ESP,
  # so two media with the same UKI can boot different command lines (enclave-99's review).
  $dvd = Get-VMDvdDrive -VM $vm
  $attached = $dvd.Path
  $attachedSha = (Get-FileHash $attached -Algorithm SHA256).Hash.ToLower()
  Note "attached medium: $attached"
  Note "guestImageSha256 (medium, hashed at attach): $attachedSha"
  if ($attachedSha -ne $IsoSha256.ToLower()) { throw "the attached medium hashes $attachedSha, not the pinned $IsoSha256" }
  Set-VMFirmware -VM $vm -FirstBootDevice $dvd
  Set-VMComPort  -VM $vm -Number 1 -Path "\\.\pipe\$pipe"
  Note "DVD attached and set as the ONLY boot device; COM1 -> \\.\pipe\$pipe"

  # THE READ-BACK. The guest refuses to start if the command line is not exactly its pinned one, or
  # if the stub unpacked anything besides os-release. Load options and SMBIOS strings are how that
  # would happen, so they are checked HERE rather than left for the guest to catch.
  $fw = Get-VMFirmware -VM $vm
  Note "boot order: $((@($fw.BootOrder | ForEach-Object { $_.BootType })) -join ', ')"
  Note "secure boot: $($fw.SecureBoot)"
  if ($fw.SecureBoot -ne 'Off') { throw "Secure Boot is $($fw.SecureBoot); the UKI is unsigned and this must be Off" }
  if (@($fw.BootOrder).Count -ne 1) { throw "the VM has $(@($fw.BootOrder).Count) boot entries; exactly one (the DVD) is expected" }
  # The vTPM, asserted through WMI rather than Get-VMTpm: that cmdlet does not exist in this build's
  # Hyper-V module, and my first version threw on it - a check meant to enforce the absence of a
  # vTPM instead stopped the boot. Msvm_SecuritySettingData.TpmEnabled is present here and is the
  # property Hyper-V itself uses. If neither can be read we say so rather than assuming absence.
  $sec = (Get-CimInstance -Namespace 'root\virtualization\v2' -Query ("select * from Msvm_ComputerSystem where ElementName = '" + $name + "'")) |
         Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState |
         Get-CimAssociatedInstance -ResultClass Msvm_SecuritySettingData -ErrorAction SilentlyContinue
  if ($null -eq $sec) { Note "vTPM: could not be read (no Msvm_SecuritySettingData); none was added by this definition" }
  elseif ($sec.TpmEnabled) { throw "a vTPM is ENABLED; nothing reads its PCRs on this path and it must not be present" }
  else { Note "vTPM: absent (Msvm_SecuritySettingData.TpmEnabled = False)" }
  foreach ($e in $fw.BootOrder) {
    $lo = $e.Device.PSObject.Properties['LoadOptions']
    if ($lo -and $lo.Value) { throw "a boot entry carries LoadOptions ('$($lo.Value)'); the guest would refuse to start" }
  }
  Note "read-back OK: one boot entry, no LoadOptions, Secure Boot off, vTPM as reported above"

  # OPEN THE CONSOLE BEFORE STARTING, AND KEEP IT OPEN.
  #
  # The previous run booted (Worker-Admin 18601 "successfully booted an operating system") and
  # captured ZERO bytes, because this connected AFTER Start-VM and reconnected every few seconds.
  # A named pipe does not buffer for an absent client, so everything the guest said before the
  # first connect - which is all of it, on a fast boot - was discarded. The reader was the reason
  # the console looked silent, not the guest.
  # Hyper-V creates the COM1 pipe SERVER when the VM starts, not when Set-VMComPort is called - so
  # attaching beforehand is impossible (measured: Connect times out). Start first, then attach as
  # fast as possible and HOLD the connection: a named pipe does not buffer for an absent client, so
  # every millisecond before the first connect is output that can never be recovered.
  $seen = ''; $ready = $false
  $pipeClient = $null
  $script:pendingRead = $null; $script:readBuf = $null
  $t0 = Get-Date
  Start-VM -Name $name
  for ($i = 0; $i -lt 100 -and -not $pipeClient; $i++) {
    try {
      # Asynchronous, or .NET Framework turns ReadAsync into a blocking read on a thread and
      # IGNORES the cancellation token - so a timed-out Wait leaves the read PENDING and the next
      # iteration overlaps it on the same stream (enclave-53). It only worked because the guest
      # spoke within one iteration, which is luck that would evaporate on the silent-guest case
      # this reader exists for.
      $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipe,
             [System.IO.Pipes.PipeDirection]::In, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $c.Connect(100)
      $pipeClient = $c
    } catch { Start-Sleep -Milliseconds 50 }
  }
  if ($pipeClient) { Note "COM1 attached $([int]((Get-Date)-$t0).TotalMilliseconds) ms after start" }
  else { Note "COM1 could NOT be attached after 100 tries: anything the guest says is unobservable" }
  Note "started; watching COM1 for 'MON ready' for $ReadySeconds s"
  while (((Get-Date) - $t0).TotalSeconds -lt $ReadySeconds -and -not $ready) {
    Start-Sleep -Seconds 3
    # Read from the ONE connection opened before the start, with a deadline so a silent guest can
    # never hang this the way Read() once did.
    try {
      # ONE outstanding read at a time: a new one is issued only when the previous has completed.
      if ($pipeClient -and $pipeClient.IsConnected) {
        if ($null -eq $script:pendingRead) {
          $script:readBuf = New-Object byte[] 8192
          $script:pendingRead = $pipeClient.ReadAsync($script:readBuf, 0, $script:readBuf.Length)
        }
        if ($script:pendingRead.Wait(2500)) {
          if (-not $script:pendingRead.IsFaulted -and $script:pendingRead.Result -gt 0) {
            $seen += [System.Text.Encoding]::ASCII.GetString($script:readBuf, 0, $script:pendingRead.Result)
          }
          $script:pendingRead = $null        # completed: the next iteration may issue another
        }
      }
    } catch { }
    if ($seen -match 'MON ready')  { $ready = $true }
    if ($seen -match 'MON ERROR')  { break }
  }
  try { if ($pipeClient) { $pipeClient.Dispose() } } catch { }
  Note "console bytes: $($seen.Length)"
  if ($seen) { foreach ($l in ($seen -split "`n" | Where-Object { $_ -match 'MON|error|panic|refus' } | Select-Object -First 12)) { Note "  CONSOLE: $($l.Trim())" } }
  if ($ready) {
    Note "RESULT: MON ready - the guest booted as a UEFI VTL0 (DEV BOOT; host exclusion NOT established)"
    # THE CONTROL CHANNEL. `MON ready` does NOT prove it: AF_VSOCK accepts a listen with no
    # transport registered, so the monitor can say ready while nothing could ever reach it. The
    # guest's virtio vsock modules fail to insert here (they are QEMU's); enclave-5d reports the
    # pinned kernel has CONFIG_HYPERV_VSOCKETS=y built in, which would make those failures noise.
    # This dial is what decides between the two readings.
    $vmId = (Get-VM -Name $name).Id.Guid
    Note "dialling hv_sock $vmId port 9000 ..."
    $dial = & C:\Users\claude\vbs-like\target\release\vbslike-host.exe hvdial --vm $vmId --port 9000 --seconds 10 2>&1 | Out-String
    Note "hvdial: $($dial.Trim())"
    if ($dial -match '"connected"\s*:\s*true') {
      Note "CONTROL CHANNEL OK: the guest has a working vsock transport and is listening on 9000"
      # A connect proves a listener. An EXCHANGE proves the monitor is speaking its protocol, which
      # is what `load` will need. {"cmd":"state"} is the cheapest command that carries no payload.
      $st = & C:\Users\claude\vbs-like\target\release\vbslike-host.exe hvdial --vm $vmId --port 9000 --seconds 10 --send '{"cmd":"state"}' 2>&1 | Out-String
      Note "state exchange: $($st.Trim())"
      if ($st -match '"head"\s*:\s*"\S') { Note "PROTOCOL OK: the monitor answered a control command" }
      else { Note "PROTOCOL: connected but the monitor returned no answer to {cmd:state}" }
      Note "  (a connect proves the transport and the listener. It says NOTHING about identity, boundary or host exclusion.)"
    } else {
      Note "CONTROL CHANNEL FAILED: MON ready was printed but nothing answered on 9000"
    }
  }
  elseif ($seen -match 'MON ERROR'){ Note "RESULT: the guest REFUSED to start; the line above names the guard that fired" }
  elseif ($seen.Length -gt 0)      { Note "RESULT: the guest spoke but never said MON ready" }
  else                             { Note "RESULT: silent - no console bytes; a silent partition is not a booted one" }

  Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Worker-Admin' -MaxEvents 15 -EA SilentlyContinue |
    Where-Object { $_.TimeCreated -ge $t0 } | Sort-Object TimeCreated |
    ForEach-Object { Note ("  ADMIN [$($_.Id)] " + (($_.Message -replace "`r?`n",' ').Substring(0,[Math]::Min(150,($_.Message -replace "`r?`n",' ').Length)))) }
}
catch { Note "RUN FAILED: $($_.Exception.Message -replace "`r?`n",' ')" }
finally {
  $ErrorActionPreference = 'Continue'
  $fail = @()
  try {
    if ($created) {
      $v = Get-VM -Name $name -EA SilentlyContinue
      if ($v -and $v.Notes -eq $MARKER) { Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Remove-VM -VM $v -Force; Note "removed $name" }
      elseif ($v) { $fail += "REFUSING to remove $name (Notes='$($v.Notes)')" }
    }
  } catch { $fail += "cleanup: $($_.Exception.Message)" }
  finally {
    try {
      if ($mutated) {
        if ($before.S -eq 'Present') { Set-ItemProperty $RegPath -Name $RegName -Value $before.V -Type $before.K }
        else { Remove-ItemProperty $RegPath -Name $RegName -EA SilentlyContinue }
      }
      $after = Read-Setting
      if ($after.S -eq $before.S -and "$($after.V)" -eq "$($before.V)") { Note "SETTING RESTORED to $($before.S) (verified)" }
      else { $fail += "SETTING NOT RESTORED: now $($after.S), was $($before.S)" }
    } catch { $fail += "RESTORE FAILED: $($_.Exception.Message)" }
  }
  $nodeAfter = @(Get-Process node -EA SilentlyContinue | ForEach-Object { $_.Id }) -join ','
  if ($nodeAfter -ne $nodeBefore) { $fail += "the live node changed: $nodeBefore -> $nodeAfter" } else { Note "live node unchanged ($nodeAfter)" }
  Note "apps after    : $(($APPS | ForEach-Object { "$_=$(App $_)" }) -join ' ')"
  Note "=== DEV BOOT. Host exclusion NOT established. Not verified capacity. ==="
  Remove-Item $sentinel -Force -EA SilentlyContinue        # disarm: this run cleaned up itself
  Remove-Item $wdFile   -Force -EA SilentlyContinue
  if ($fail.Count) { foreach ($f in $fail) { Write-Host "FAILURE: $f" }; Write-Host "RUN FAILED"; exit 1 }
  else { Write-Host "RUN OK"; exit 0 }
}
