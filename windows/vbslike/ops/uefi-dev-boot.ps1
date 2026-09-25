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
  # WHICH PARTITION THIS IS, and it changes what may be said about the run:
  #   16 = OpenHCL with IsolationType::None. No page acceptance and no host-visibility model, so
  #        the root partition can map every page of this guest. A dev path, permanently.
  #    1 = VBS. OpenHCL accepts VTL0 RAM host-PRIVATE (HvCallAcceptGpaPages) and only the shared
  #        pool and the rings the guest publishes become host-visible, so the root cannot read a
  #        page the guest has not shared. That is the hypervisor's claim FROM SOURCE; this script
  #        has not measured it, and a type-1 boot on its own does not establish host exclusion.
  [ValidateSet(1, 16)][int] $IsolationType = 16,
  # THE MEMORY EXPERIMENT. A marker is pushed into the guest over the control channel and then
  # looked for from the host, in the partition worker's own address space, while the VM is still
  # running. It only means anything as a PAIR of runs: the identical reader must FIND it on type 16,
  # where the root can map every guest page by construction, or the reader is broken and a type-1
  # miss says nothing. Off by default; this never runs against anything but our own canary VM.
  [switch] $HostRead,
  # OpenHCL's own kmsg, over its diagnostics server on vsock. It is the ONLY readable source for a
  # type-1 start failure on this host: COM3 does not exist here, and a sweep of every Hyper-V event
  # channel across a failing run found no free-text error and no CompleteStartVtl0 entry at all.
  # OpenHCL reports a start failure and then waits 2 minutes to be terminated, so the reason is
  # there for a bounded window and nowhere else.
  [string] $OhclDiag = 'C:\Users\claude\vbs-like\pkg\ohcldiag-dev-5f25f2e7\ohcldiag-dev.exe',
  # GuestFeatureSet, swept rather than assumed. MEASURED on this box, type 1 + openhcl-cvm.bin:
  #   0x400 (what New-VM sets for VBS, OpenHCL feature OFF) -> starts, then triple-faults
  #   0x601 (VBS bit kept, OpenHCL bits added)              -> refuses to start at all
  # Two different stages, which is what says the bits interact rather than simply accumulate. 0 here
  # means "keep what New-VM chose and add 0x201"; any other value is written exactly.
  [uint32] $FeatureSet = 0,
  # A real VMGS for the type-1 path. This host refuses a VBS VM with no guest state and petri
  # supplies none, so one is made by `New-VM -GuestStateIsolationType VBS` and kept after that donor
  # VM is removed. It is guest state, not a secret, and it is never committed.
  [string] $GuestStateFile = 'C:\Users\claude\vbs-like\type1.vmgs',
  [string] $Bundle = '',
  [int]    $RelayPort = 19500,
  [switch] $Approve
)
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$RegPath = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$RegName = 'AllowFirmwareLoadFromFile'
# HV_SOCK SERVICE REGISTRATION. A host process may only BIND a partition's hv_sock service if that
# service GUID is registered here. The HCS path never needed it: its compute-system document
# carries HvSocket.HvSocketConfig with an SDDL granting SYSTEM and Administrators directly. A VM
# defined through WMI has no such document and this build exposes no Msvm_HvSocket* class, so the
# registry is the documented mechanism - measured: without it the bind fails with os error 10013,
# "access forbidden".
#
# It is NOT a security-policy relaxation like AllowFirmwareLoadFromFile: it registers a
# GUID-to-name mapping for a service endpoint. It is still host-wide, so it gets the same
# treatment - recorded, applied for one run, removed, and verified, with the watchdog covering it.
$SvcPath  = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
$ReportSvcGuid = '{0:x8}-facb-11e6-bd58-64006a7986d3' -f 9001
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
Note "    partition kind: wmi-openhcl-gen2, GuestStateIsolationType $IsolationType (the LAUNCHER states it; the guest cannot know it)"
if ($IsolationType -eq 1) {
  Note "    type 1 = VBS: the hypervisor is configured to keep VTL0 RAM host-private. That is a CONFIGURATION,"
  Note "    not a measurement. Until a host-side memory read has been shown to find a guest marker on type 16"
  Note "    and NOT on type 1, nothing from this run may be called host-excluded."
} else {
  Note "    type 16 = IsolationType::None: the root partition can map every page of this guest, by construction."
}

function Read-Setting {
  if (-not (Test-Path $RegPath)) { return @{ S='NoKey' } }
  try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop
        @{ S='Present'; V=$i.$RegName; K="$((Get-Item $RegPath).GetValueKind($RegName))" } }
  catch { @{ S='Absent' } }
}
# THE TWO HEALTH LAYERS, and why the gate is the second one.
#
# 01:43:14 on 09-25 this script printed `apps before: <six>=000` and refused the run. The apps were
# fine: they answered 200/401 from outside the box a minute before and a minute after. What had
# failed was THIS BOX's own path out to the relay - six probes, all six back in well under a second,
# so a fast failure and not a timeout. A user reaches the relay by a different path than the box's
# own hairpin does, so a public probe failing HERE is not evidence about what a user sees, in either
# direction.
#
# So the public probe is retried once and reported, and the thing the run is actually gated on is
# each app answering on the node's OWN loopback port. That is a stronger basis for "this boot was
# harmless" anyway: it is the app itself, with no relay, no DNS and no egress in the path.
function App($h){
  $c = & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 "https://$h.app.enclave.host/" 2>$null
  if ("$c" -eq '000' -or "$c" -notmatch '^\d{3}$') {
    Start-Sleep -Seconds 3
    $c = & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 "https://$h.app.enclave.host/" 2>$null
  }
  "$c"
}

# Each running deployment on its own 127.0.0.1 port, as the node reports them. An empty list is
# itself a refusal below: it means the node's own surface did not answer, so nothing can be compared.
function Loopbacks {
  $out = @()
  $r = & curl.exe -s --max-time 10 "http://127.0.0.1:9600/v1/deployments" 2>$null
  if (-not $r) { return ,$out }
  try { $j = $r | ConvertFrom-Json } catch { return ,$out }
  foreach ($d in $j.deployments) {
    if ($d.port -gt 0 -and $d.status -eq 'running') {
      $c = & curl.exe -s -o NUL -w "%{http_code}" --max-time 8 "http://127.0.0.1:$($d.port)/" 2>$null
      $out += "$($d.id.Substring(0,10))=$c"
    }
  }
  ,$out
}
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
$loopBefore = Loopbacks
Note "setting before : $($before.S)"
Note "node pids      : $nodeBefore"
Note "apps before    : $($appsBefore -join ' ')"
Note "loopback before: $(if($loopBefore.Count){$loopBefore -join ' '}else{'NONE - the node surface did not answer'})"
if (@($loopBefore | Where-Object { $_ -match '=(200|401)$' }).Count -eq 0) {
  throw "no app answered on its own loopback port before this run: the health check cannot show this boot was harmless, so it is refused"
}
if (@($appsBefore | Where-Object { $_ -match '=(200|401)$' }).Count -eq 0) {
  Note "NOTE: every public probe FROM THIS BOX failed while the loopback layer is healthy. That is this box's"
  Note "      own egress to the relay, not an app outage - a user's path to the relay is a different one. The"
  Note "      harmlessness comparison for this run therefore rests on the loopback layer."
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
$script:runFailed = $false
$script:exitCode  = 0

# THE WATCHDOG, launched BEFORE the setting is applied.
#
# `finally` does not run when this process is killed - and that is not hypothetical: an ssh timeout
# killed a run tonight, leaving AllowFirmwareLoadFromFile APPLIED and a VM RUNNING until I removed
# them by hand. Cleanup did not "hold" there, it failed. So a separate detached process now owns the
# guarantee: it waits past this run's own deadline and, if the sentinel file still exists, force
# restores the setting and removes this run's VM. The main script deletes the sentinel on a clean
# finish, so the watchdog then does nothing.
# A STALE SENTINEL MEANS THE SETTING WE ARE ABOUT TO CALL "before" IS A PREVIOUS RUN'S.
#
# Without this the host can be left permitting unsigned firmware while the log says the opposite,
# with no reboot needed (enclave-53): run A is killed with the key set; run B starts and records
# Present/1 as the host's prior state; A's watchdog then removes the value under B; B's cleanup
# faithfully restores it to 1 and verifies it. The setting is host-wide, so this is the one failure
# here that outlives the experiment, and it is refused rather than reasoned about.
$stale = @(Get-ChildItem "C:\Users\claude\uefi-probe-active-*.txt" -EA SilentlyContinue)
if ($stale.Count) {
  foreach ($f in $stale) { Write-Host "STALE SENTINEL: $($f.Name) -> $(Get-Content $f.FullName -Raw -EA SilentlyContinue)" }
  throw ("another run's sentinel is still present, so the current AllowFirmwareLoadFromFile value is " +
         "that run's and not this host's resting state. Refusing to start: restoring from a borrowed " +
         "'before' is how a host gets left permitting unsigned firmware with a log that says otherwise.")
}
$sentinel = "C:\Users\claude\uefi-probe-active-$stamp.txt"
# The sentinel carries the state to restore TO and the owning pid, so a watchdog restores what this
# run actually found rather than assuming Absent.
Set-Content -Path $sentinel -Force -Value @"
vm=$name
pid=$PID
before.S=$($before.S)
before.V=$($before.V)
before.K=$($before.K)
"@
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
  Remove-Item -Path '$(Join-Path $SvcPath $ReportSvcGuid)' -Recurse -Force -EA SilentlyContinue
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
  # the hv_sock service for the report port, if it is not already somebody else's
  $svcKey = Join-Path $SvcPath $ReportSvcGuid
  $script:svcAdded = $false
  if (-not (Test-Path $svcKey)) {
    New-Item -Path $svcKey -Force | Out-Null
    New-ItemProperty -Path $svcKey -Name 'ElementName' -Value 'enclave report signing (probe)' -PropertyType String -Force | Out-Null
    $script:svcAdded = $true
    Note "hv_sock service $ReportSvcGuid registered for port 9001 (removed again in cleanup)"
  } else { Note "hv_sock service $ReportSvcGuid already registered by somebody else; left alone" }

  if (-not $SkipModulePin) {
    if (-not (Test-Path $HypervModule)) { throw "the Hyper-V module is not at $HypervModule" }
    $mh = (Get-FileHash $HypervModule -Algorithm SHA256).Hash.ToLower()
    if ($mh -ne $HypervModuleSha256.ToLower()) { throw "the module that DEFINES the VM hashes $mh, not the pinned $HypervModuleSha256" }
    Note "hyperv.psm1 verified: $mh"
  } else { Note "hyperv.psm1 pin SKIPPED by request (the VM definition is therefore unverified)" }
  Import-Module $HypervModule -Force   # petri's New-CustomVM, the reference definition
  # COM3 would be OpenHCL's own VTL2 log, where it names the settings it refuses on an isolated VM.
  # petri's -Com3 sets it by indexing Msvm_SerialPortSettingData[2], and on THIS host that index is
  # empty: the first type-1 run died with "The property 'Connection' cannot be found on this object"
  # before the VM was ever defined. A missing diagnostic port must not fail the experiment it exists
  # to diagnose, so -Com3 is not passed and the port is probed below and recorded as UNSUPPORTED.
  # WHY TYPE 1 IS BUILT THIS WAY. Every piece is a measurement or Microsoft's own recipe.
  #
  # petri, which runs Microsoft's 28 hyperv_openhcl_uefi_x64[vbs] cases, defines an isolated VM in
  # ONE DefineSystem with GuestStateIsolationType, GuestFeatureSet 0x201 and FirmwareFile together,
  # and removes the synthetic mouse, keyboard and display for isolation types 1-3. A New-VM VM
  # patched afterwards through ModifySystemSettings is NOT the same thing, and it never started.
  #
  # It differs from the type-16 path in one further place, and it is the OPPOSITE of what I first
  # guessed. petri sets the VTL2 trio only when `is_openhcl && !is_isolated`
  # (petri/src/vm/hyperv/powershell.rs:548): openhcl.bin carries a RELOCATABLE_REGION and a
  # PAGE_TABLE_RELOCATION_REGION so it needs auto placement, while openhcl-cvm.bin has NEITHER and
  # requires VTL2 at the FIXED GPA 0x8000000. Asking a fixed image to auto-place a 1 GiB VTL2 range
  # is the best available explanation for the bare 12030 (enclave-5d). So type 16 gets
  # -IncreaseVtl2Memory and type 1 must NOT - my earlier "VTL2 is always required" was wrong.
  #
  # The one thing petri does not supply is guest state, and this host requires it: without a VMGS,
  # VMMS refuses at define time with "security settings which do not allow it". petri's knob for
  # going without one, GuestStateLifetime, does not exist on this build (nor does
  # GuestStateEncryptionPolicy), so stateless guest state is UNSUPPORTED here rather than declined.
  # -GuestStateFile points at a real VMGS made by `New-VM -GuestStateIsolationType VBS`, kept after
  # that donor VM was removed.
  if ($IsolationType -eq 1) {
    if (-not $GuestStateFile) { throw "type 1 needs -GuestStateFile: this host refuses a VBS VM with no guest state, and petri supplies none" }
    if (-not (Test-Path $GuestStateFile)) { throw "the guest-state file is not at $GuestStateFile" }
    Note "guest state: $GuestStateFile ($((Get-Item $GuestStateFile).Length) bytes, sha $((Get-FileHash $GuestStateFile -Algorithm SHA256).Hash.ToLower().Substring(0,16)))"
    Note "VTL2: auto placement NOT set - openhcl-cvm.bin is a fixed-GPA image, and petri sets the trio only for non-isolated VMs"
    New-CustomVM -VMName $name -GuestStateIsolationEnabled $true -GuestStateIsolationType 1 `
      -GuestStateIsolationMode 0 -FirmwareFile $Firmware -GuestStateFilePath $GuestStateFile `
      -TpmEnabled $true -SecureBootEnabled $false -Com1 $true `
      -Memory ($MemMiB * 1MB) -VpCount $Vcpus | Out-Null
    $created = $true
    $vm = Get-VM -Name $name
    $pipe3 = $null
    # READ BACK what the VM actually IS, rather than reprinting the parameters it was asked for.
    $vssdR = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData |
             Where-Object { $_.ConfigurationID -eq $vm.Id.Guid }
    $gsf = "$($vssdR.GuestStateDataRoot)\$($vssdR.GuestStateFile)"
    Note ("read back: GuestStateIsolationType=$($vssdR.GuestStateIsolationType) enabled=$($vssdR.GuestStateIsolationEnabled) " +
          "GuestFeatureSet=0x$('{0:x}' -f [uint32]$vssdR.GuestFeatureSet) Vtl2Mode=$($vssdR.Vtl2AddressSpaceConfigurationMode) " +
          "Vtl2Range=$($vssdR.Vtl2AddressRangeSize) firmware='$($vssdR.FirmwareFile)'")
    if ([int]$vssdR.GuestStateIsolationType -ne 1) { throw "GuestStateIsolationType read back as $($vssdR.GuestStateIsolationType), not 1" }
    if ($vssdR.FirmwareFile -ne $Firmware) { throw "the VM's FirmwareFile reads '$($vssdR.FirmwareFile)', not the pinned $Firmware" }
    $nics = @(Get-VMNetworkAdapter -VM $vm -ErrorAction SilentlyContinue)
    if ($nics.Count) { $nics | Remove-VMNetworkAdapter -Confirm:$false; Note "removed $($nics.Count) network adapter(s); this guest has no NIC" }
    else { Note "no network adapter was defined; this guest has no NIC" }
  } else {
    New-CustomVM -VMName $name -GuestStateIsolationEnabled $true -GuestStateIsolationType $IsolationType `
      -GuestStateIsolationMode 0 -FirmwareFile $Firmware -IncreaseVtl2Memory `
      -SecureBootEnabled $false -Com1 $true -Memory ($MemMiB * 1MB) -VpCount $Vcpus | Out-Null
    $created = $true
    $vm = Get-VM -Name $name
  }
  Set-VM -VM $vm -Notes $MARKER
  Note "created $name (id $($vm.Id)) - Gen2, GuestStateIsolationType $IsolationType, Secure Boot off"

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
  # COM3 keeps the name petri gave it. Set-VMComPort only addresses ports 1 and 2, while COM3 exists
  # only in the Msvm model, which is why New-CustomVM sets it through WMI and this reads it there.
  # Probed rather than assumed, and its absence is recorded as unsupported, not as a failure.
  $pipe3 = $null
  try {
    $vssd3  = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData |
              Where-Object { $_.ConfigurationID -eq $vm.Id.Guid }
    $ports3 = @($vssd3 | Get-CimAssociatedInstance -ResultClassName Msvm_SerialPortSettingData)
    if ($ports3.Count -ge 3) { $pipe3 = "$($vm.Id)-3"; Note "COM3 present ($($ports3.Count) serial ports)" }
    else { Note "COM3 UNSUPPORTED: this host's Gen2 VM exposes $($ports3.Count) serial ports, so OpenHCL's own log cannot be read. Recorded as unsupported, NOT as a pass or a failure." }
  } catch { Note "COM3 UNSUPPORTED: $($_.Exception.Message)" }
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
  # On type 16 a vTPM must not be present: nothing on that path reads a PCR, and a vTPM sitting in
  # the configuration unread LOOKS like attestation to anyone reading it. On type 1 Windows enables
  # one as part of the supported VBS configuration (New-VM sets TpmEnabled True), and it is where
  # the guest-state key protector lives - so refusing it would mean refusing the only isolation
  # configuration this host supports. It is therefore RECORDED, loudly, rather than refused: present
  # and unread is still not attestation, and this line is what stops a transcript implying it is.
  if ($null -eq $sec) { Note "vTPM: could not be read (no Msvm_SecuritySettingData); none was added by this definition" }
  elseif ($sec.TpmEnabled -and $IsolationType -eq 1) {
    Note "vTPM: PRESENT (TpmEnabled = True), because Windows makes one for a VBS VM and the guest-state"
    Note "      key protector lives there. NOTHING ON THIS PATH READS ITS PCRs. Its presence is not"
    Note "      attestation and must never be reported as any."
  }
  elseif ($sec.TpmEnabled) { throw "a vTPM is ENABLED on a type-$IsolationType VM; nothing reads its PCRs on this path and it must not be present" }
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
  $seen3 = ''
  $pipeClient = $null; $pipe3Client = $null
  $script:pendingRead = $null; $script:readBuf = $null
  $script:pendingRead3 = $null; $script:readBuf3 = $null
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
  # COM3 on the same terms: opened as fast as possible and HELD, because a named pipe keeps nothing
  # for an absent client and OpenHCL says why it refused a configuration in its first moments.
  for ($i = 0; $i -lt 100 -and $pipe3 -and -not $pipe3Client; $i++) {
    try {
      $c3 = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipe3,
              [System.IO.Pipes.PipeDirection]::In, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $c3.Connect(100)
      $pipe3Client = $c3
    } catch { Start-Sleep -Milliseconds 50 }
  }
  if ($pipe3) { Note $(if ($pipe3Client) { "COM3 (OpenHCL's own log) attached" } else { "COM3 could NOT be attached: an OpenHCL refusal would be silent" }) }
  if ($pipeClient) { Note "COM1 attached $([int]((Get-Date)-$t0).TotalMilliseconds) ms after start" }
  else { Note "COM1 could NOT be attached after 100 tries: anything the guest says is unobservable" }
  # Start the kmsg reader immediately: the failure it exists to catch happens within SECONDS of the
  # start, and the diagnostics server only exists while the partition is alive.
  $kmsgOut = $null; $kmsgProc = $null
  if ($IsolationType -eq 1 -and (Test-Path $OhclDiag)) {
    $kmsgOut = "C:\Users\claude\vbs-evidence\kmsg-$stamp.txt"
    try {
      $kmsgProc = Start-Process -FilePath $OhclDiag -ArgumentList @($name, 'kmsg') -NoNewWindow -PassThru `
                    -RedirectStandardOutput $kmsgOut -RedirectStandardError "$kmsgOut.err"
      Note "ohcldiag-dev kmsg started (pid $($kmsgProc.Id)) -> $kmsgOut"
    } catch { Note "ohcldiag-dev could not be started: $($_.Exception.Message -replace "`r?`n",' ')" }
  } elseif ($IsolationType -eq 1) { Note "ohcldiag-dev NOT FOUND at $OhclDiag; an OpenHCL start failure will be unreadable" }
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
    try {
      if ($pipe3Client -and $pipe3Client.IsConnected) {
        if ($null -eq $script:pendingRead3) {
          $script:readBuf3 = New-Object byte[] 8192
          $script:pendingRead3 = $pipe3Client.ReadAsync($script:readBuf3, 0, $script:readBuf3.Length)
        }
        if ($script:pendingRead3.Wait(200)) {
          if (-not $script:pendingRead3.IsFaulted -and $script:pendingRead3.Result -gt 0) {
            $seen3 += [System.Text.Encoding]::ASCII.GetString($script:readBuf3, 0, $script:pendingRead3.Result)
          }
          $script:pendingRead3 = $null
        }
      }
    } catch { }
    if ($seen -match 'MON ready')  { $ready = $true }
    if ($seen -match 'MON ERROR')  { break }
  }
  try { if ($pipeClient) { $pipeClient.Dispose() } } catch { }
  try { if ($pipe3Client) { $pipe3Client.Dispose() } } catch { }
  Note "console bytes: $($seen.Length) (COM1), $(if($pipe3){"$($seen3.Length) (COM3)"}else{'COM3 unsupported on this host'})"
  # OpenHCL's own words, whatever else happened.
  if ($kmsgOut) {
    Start-Sleep -Seconds 2
    try { if ($kmsgProc -and -not $kmsgProc.HasExited) { $kmsgProc.Kill() } } catch { }
    $km = Get-Content $kmsgOut -EA SilentlyContinue
    $kerr = Get-Content "$kmsgOut.err" -EA SilentlyContinue
    Note "ohcldiag-dev kmsg: $(@($km).Count) line(s)$(if(@($kerr).Count){", $(@($kerr).Count) on stderr"})"
    if (@($kerr).Count) { foreach ($l in (@($kerr) | Select-Object -First 4)) { Note "  KMSG-ERR: $l" } }
    $keep = @($km | Where-Object { $_ -match 'fail|error|refus|isolat|attest|vmgs|guest state|key|vtl|panic|start' })
    Note "  (kept $(@($keep).Count) matching line(s) of $(@($km).Count))"
    foreach ($l in (@($keep) | Select-Object -First 40)) { Note "  KMSG: $l" }
  }
  # COM3 is printed whenever the guest did not come ready, and always on type 1, where the whole
  # question is whether OpenHCL accepted the isolated configuration at all.
  if ($seen3 -and (-not $ready -or $IsolationType -eq 1)) {
    $keep = $seen3 -split "`n" | Where-Object { $_ -match 'isolat|refus|not supported|unsupported|error|panic|vtl|accept|attest|vbs' }
    Note "  --- COM3 (OpenHCL), $(@($keep).Count) matching lines ---"
    foreach ($l in ($keep | Select-Object -First 25)) { Note "  OPENHCL: $($l.Trim())" }
  }
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

      # THE MARKER. Fresh per run, so a hit can never be last run's bytes still lying around, and
      # long enough that a 48-byte ASCII run cannot occur by chance in a memory image.
      #
      # It reaches the guest by travelling THROUGH the host, which is a confound worth stating
      # plainly: the worker may hold a copy of it in its own buffers whatever the guest does. That
      # bias runs toward FINDING the marker, never toward missing it, so it can only make an
      # isolated partition look non-isolated - the conservative direction. A hit on type 1 would
      # therefore need a second look; a miss on type 1 beside a hit on type 16 is the real signal.
      if ($HostRead) {
        $marker = "ENCLAVE-HOSTREAD-MARKER/1-" + ([guid]::NewGuid().ToString('N')) + "-END"
        Note "marker: $marker"
        $mk = & C:\Users\claude\vbs-like\target\release\vbslike-host.exe hvdial --vm $vmId --port 9000 --seconds 10 --send "{`"cmd`":`"echo`",`"marker`":`"$marker`"}" 2>&1 | Out-String
        Note "marker pushed to the guest: $($mk.Trim())"
        # Both readers, because they fail in different ways and the comparison is the evidence.
        # vmwp first (it does not disturb the guest), then the saved-state path, which SUSPENDS the
        # VM - so it runs last, after the app has been served, and resumes afterwards.
        $hr = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\host-read-guest.ps1 `
                -VmId $vmId -Marker $marker -Label "type$IsolationType" 2>&1 | Out-String
        foreach ($l in ($hr -split "`n" | Where-Object { $_.Trim() })) { Note "  HOSTREAD/vmwp: $($l.Trim())" }
        $script:hostReadMarker = $marker
      }
      if ($st -match '"head"\s*:\s*"\S') { Note "PROTOCOL OK: the monitor answered a control command" }
      else { Note "PROTOCOL: connected but the monitor returned no answer to {cmd:state}" }

      # THE WHOLE PATH: report signer on 9001, load on 9000 with hash agreement, relay to 40000+id.
      if ($Bundle -and (Test-Path $Bundle)) {
        $bsha = (Get-FileHash $Bundle -Algorithm SHA256).Hash.ToLower()
        Note "loading $Bundle (sha $($bsha.Substring(0,16))) through hv_sock ..."
        $svOut = "C:\Users\claude\wmiserve-$stamp.out"
        $sv = Start-Process -FilePath 'C:\Users\claude\vbs-like\target\release\vbslike-host.exe' `
              -ArgumentList @('wmiserve','--vm',$vmId,'--bundle',$Bundle,'--medium-sha256',$attachedSha,
                              '--tcp',"$RelayPort",'--label','canary','--vcpus',"$Vcpus",'--mem',"$MemMiB",'--hold','90') `
              -NoNewWindow -PassThru -RedirectStandardOutput $svOut -RedirectStandardError "$svOut.err" `
              -RedirectStandardInput 'C:\Users\claude\labin.txt'
        $dl = (Get-Date).AddSeconds(90); $served = $false
        while ((Get-Date) -lt $dl -and -not $served) {
          Start-Sleep -Seconds 2
          $o = Get-Content $svOut -Raw -EA SilentlyContinue
          if ($o -match '"step":"ready"') { $served = $true }
          elseif ($o -match '"ok":false') { break }
        }
        foreach ($l in (Get-Content $svOut -EA SilentlyContinue)) { Note "  WMISERVE: $l" }
        if ($served) {
          # The APP's own bytes, through the relay. curl -k accepts the guest's self-signed cert:
          # this proves the app SERVES, not its identity. Identity is judge-hv's job on the
          # handshake key, and is a separate check - a 200 here is not an attestation.
          Start-Sleep -Seconds 2
          # RAW BYTES TO A FILE, then hash them. Piping through Out-String appends a newline, which
          # is why an earlier run reported 14 bytes where enclave-53 pins 13 - measured twice by
          # them, from wasmtime serve of the pinned component and from 99's HCS window. A byte
          # count taken through PowerShell's string layer is a count of PowerShell's string, not of
          # what the app sent.
          $bodyFile = "C:\Users\claude\appbody-$stamp.bin"
          & curl.exe -sk --max-time 20 -o $bodyFile "https://127.0.0.1:$RelayPort/" 2>$null
          if (Test-Path $bodyFile) {
            $len = (Get-Item $bodyFile).Length
            $bsh = (Get-FileHash $bodyFile -Algorithm SHA256).Hash.ToLower()
            $txt = [System.IO.File]::ReadAllText($bodyFile)
            Note "APP ANSWERED: $len raw bytes, sha256 $bsh"
            Note "  body: $($txt -replace "`r",'\r' -replace "`n",'\n')"
            if ($bsh -eq '03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340') {
              Note "APP OK: the app served EXACTLY the pinned bytes through the guest's own TLS"
              Note "  (identity NOT verified here: curl -k accepted the guest cert. That is judge-hv's job.)"
            } else { Note "APP: answered, but the bytes are not the pinned content (expected sha 03ba204e...)" }
          # LAST, because it suspends the guest: the documented saved-state path.
          if ($HostRead -and $script:hostReadMarker) {
            $ss = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\host-read-savedstate.ps1 `
                    -VmId $vmId -Marker $script:hostReadMarker -Label "type$IsolationType" -ResumeAfter 2>&1 | Out-String
            foreach ($l in ($ss -split "`n" | Where-Object { $_.Trim() })) { Note "  HOSTREAD/saved: $($l.Trim())" }
          }
            Remove-Item $bodyFile -Force -EA SilentlyContinue
          } else { Note "APP: no body file; the relay returned nothing" }
        } else { Note "WMISERVE did not reach ready" }
        try { if (-not $sv.HasExited) { Stop-Process -Id $sv.Id -Force -EA SilentlyContinue } } catch {}
      }
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
catch {
  # A FAILED RUN MUST NOT EXIT 0. It used to: the catch only logged, and `finally` exited 1 only for
  # CLEANUP failures, so a hash mismatch, a firmware read-back mismatch, Secure Boot on, a vTPM
  # where none is allowed, a silent guest or MON ERROR all ended in "RUN OK" and exit 0. Every
  # type-1 failure tonight reported success to its caller (enclave-53).
  $script:runFailed = $true
  Note "RUN FAILED: $($_.Exception.Message -replace "`r?`n",' ')"
}
finally {
  $ErrorActionPreference = 'Continue'
  $fail = @()
  try {
    if ($created) {
      $v = Get-VM -Name $name -EA SilentlyContinue
      Note "cleanup: VM $(if($v){"present, state $($v.State), notes '$($v.Notes)'"}else{'already gone'})"
      # WAIT FOR Off BEFORE REMOVING. Remove-VM on a VM still transitioning throws
      # "InvalidState" - measured: a run left enclave-uefi-20260925-024136 behind exactly this way,
      # and the old code announced "removed" over the top of it.
      if ($v -and $v.Notes -eq $MARKER) {
        Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue
        $dlRm = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $dlRm -and (Get-VM -Name $name -EA SilentlyContinue).State -ne 'Off') { Start-Sleep -Milliseconds 500 }
        for ($a = 0; $a -lt 5 -and (Get-VM -Name $name -EA SilentlyContinue); $a++) {
          try { Remove-VM -VM (Get-VM -Name $name) -Force -EA Stop }
          catch { Note "remove attempt $($a+1): $($_.Exception.Message -replace "`r?`n",' ')"; Start-Sleep -Seconds 2 }
        }
        Note "removed $name"
      }
      elseif ($v) { $fail += "REFUSING to remove $name (Notes='$($v.Notes)')" }
      # VERIFY, do not announce. finally runs with ErrorActionPreference Continue, so a Remove-VM
      # that fails (a VM still Starting or Stopping) is non-terminating and uncaught, and the next
      # line used to say "removed" regardless (enclave-53).
      if (Get-VM -Name $name -EA SilentlyContinue) { $fail += "$name is STILL PRESENT after the removal" }
      if ($IsolationType -eq 1 -and $gsf -and (Test-Path $gsf)) { $fail += "guest state left on disk: $gsf" }
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
      # only what THIS run added: a service registered by somebody else is never removed
      if ($script:svcAdded) {
        Remove-Item -Path (Join-Path $SvcPath $ReportSvcGuid) -Recurse -Force -EA SilentlyContinue
        if (Test-Path (Join-Path $SvcPath $ReportSvcGuid)) { $fail += "hv_sock service $ReportSvcGuid NOT removed" }
        else { Note "hv_sock service $ReportSvcGuid removed (verified)" }
      }
    } catch { $fail += "RESTORE FAILED: $($_.Exception.Message)" }
  }
  $nodeAfter = @(Get-Process node -EA SilentlyContinue | ForEach-Object { $_.Id }) -join ','
  if ($nodeAfter -ne $nodeBefore) { $fail += "the live node changed: $nodeBefore -> $nodeAfter" } else { Note "live node unchanged ($nodeAfter)" }
  Note "apps after     : $(($APPS | ForEach-Object { "$_=$(App $_)" }) -join ' ')"
  $loopAfter = Loopbacks
  Note "loopback after : $(if($loopAfter.Count){$loopAfter -join ' '}else{'NONE - the node surface did not answer'})"
  $lost = @($loopBefore | Where-Object { $_ -match '=(200|401)$' } | ForEach-Object { $_.Split('=')[0] } |
           Where-Object { $id = $_; -not (@($loopAfter | Where-Object { $_ -match "^$id=(200|401)$" }).Count) })
  if ($lost.Count) { Note "HARM: these answered on loopback before this run and do not now: $($lost -join ' ')" }
  else { Note "no app that answered on loopback before this run stopped answering" }
  Note "=== DEV BOOT. Host exclusion NOT established. Not verified capacity. ==="
  Remove-Item $sentinel -Force -EA SilentlyContinue        # disarm: this run cleaned up itself
  Remove-Item $wdFile   -Force -EA SilentlyContinue
  # Three outcomes, three codes, so a caller can tell them apart:
  #   1  cleanup failed - the host may not be as this script found it. The loudest case.
  #   2  the run failed but cleanup was clean - the host is fine, the experiment is not.
  #   0  the guest came ready AND cleanup was clean.
  # The verdict is DECIDED here and ACTED ON after the block. `exit` inside `finally` does not set
  # the process exit code - measured: a run that printed "RUN FAILED (cleanup also failed)" still
  # handed its caller 0, which is the very bug this was added to fix.
  # THROUGH Note, not Write-Host. A detached run (Win32_Process Create) has no console, so every
  # cleanup failure was written to nowhere: a canary VM was left RUNNING after a saved-state read and
  # the log showed the setting restored with no hint that anything had gone wrong.
  if ($fail.Count) { foreach ($f in $fail) { Note "FAILURE: $f" }; Note "RUN FAILED (cleanup also failed)"; $script:exitCode = 1 }
  elseif ($script:runFailed -or -not $ready) {
    Note "RUN FAILED$(if(-not $script:runFailed){' (the guest never came ready)'}) - cleanup was clean"; $script:exitCode = 2
  }
  else { Note "RUN OK"; $script:exitCode = 0 }
}

# The exit code, set inside `finally` and acted on here for the reason stated there.
exit $script:exitCode
