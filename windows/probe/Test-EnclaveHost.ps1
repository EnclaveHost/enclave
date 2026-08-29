<#
.SYNOPSIS
  Can THIS Windows machine host an Enclave seller node?

.DESCRIPTION
  Answers one question with evidence rather than opinion: can this box run a
  hardware-attested confidential VM (the trusted half) while Windows keeps the
  GPU on bare metal (the untrusted half, and the game)?

  Nothing here is destructive. The only mutations are (a) a throwaway isolated
  VM that is created and immediately deleted, and only if -Attempt is passed,
  and (b) an empty temp file used as a placeholder firmware image.

  What this probe knows that the first version did not (see ../EDITIONS.md):

    * The SNP/TDX guest loader is in the SAME vmwp.exe / winhvr.sys on Home,
      Pro and Server 2025 (one cumulative update serves every edition). The
      edition difference is which packages are STAGED, not what the platform
      can do. So on Home the probe lists the staged Hyper-V packages instead
      of giving up.
    * The host gate Microsoft's own OpenVMM CI flips before running SNP/TDX
      Hyper-V tests is HKLM\System\CurrentControlSet\Control\Hypervisor
      \EnableHardwareIsolation = 1 (plus AllowFirmwareLoadFromFile = 1 and a
      reboot). After the reboot, Get-VMHost reports SnpStatus / TdxStatus.
      That is a no-side-effect readiness answer, so it is asked first.
    * `Set-OpenHCLFirmware` is NOT a Windows cmdlet. It is a function in
      OpenVMM's petri hyperv.psm1 that writes two WMI properties on
      Msvm_VirtualSystemSettingData: GuestFeatureSet = 0x201 and FirmwareFile.
      The -Attempt path now does exactly that, directly, so the "does a custom
      IGVM compose with SNP isolation?" question is asked the way petri asks it.
    * Windows 10's vmwp.exe (19041) has no IGVM loader at all, so the Windows
      10 verdict is a binary fact, not just a support-lifecycle one.

  Why this architecture and not another (the short version):

    * Windows cannot be the thing that launches an SNP guest via QEMU/KVM the
      way metal/ does on Linux -- the Windows Hypervisor Platform API exposes no
      isolation capability at all, and a driver cannot outrank the hypervisor.
      Hyper-V's own isolation type is the only door.
    * The GPU does NOT go in the enclave. It stays on the Windows host, held by
      the shielded worker, which only ever sees one-time-padded residues over a
      prime field. A hostile GPU host is the declared threat model.
    * Therefore no GPU passthrough is needed, Windows is never virtualised, and
      the card is shared with the game by the ordinary NVIDIA driver.

.PARAMETER Attempt
  Actually create and delete a throwaway isolated VM, and try to attach a
  custom firmware image to it through WMI. This is the decisive test.

.PARAMETER IsolationType
  SNP, TDX or VBS. Defaults to SNP on AMD and TDX on Intel.

  VBS is the DRY RUN. It exercises the identical code path -- New-VM with an
  isolation type, then ModifySystemSettings writing GuestFeatureSet + FirmwareFile
  onto Msvm_VirtualSystemSettingData -- but needs no SEV-SNP or TDX silicon, no
  EnableHardwareIsolation, and no firmware change. vmwp.exe routes VBS isolated
  VMs through the same IGVM loader as SNP ones ("Isolation settings are a
  required parameter for SNP or VBS isolated VMs"; VbsVpContext and
  _IGVM_VHS_VBS_MEASUREMENT sit beside SnpVpContext in the same binary).

  So `-Attempt -IsolationType VBS` on ANY Windows 11 24H2 machine with VBS on
  answers "does a custom IGVM compose with an isolated VM" without touching a
  production box. What it does NOT answer is whether the hypervisor will grant
  SNP specifically -- that is Get-VMHost SnpStatus on real EPYC silicon.

.PARAMETER KeepVm
  Leave the probe VM behind for inspection instead of deleting it.

.EXAMPLE
  .\Test-EnclaveHost.ps1
  .\Test-EnclaveHost.ps1 -Attempt                        # run elevated
  .\Test-EnclaveHost.ps1 -Attempt -IsolationType VBS     # dry run, any Win11 24H2 box
#>
[CmdletBinding()]
param(
    [switch]$Attempt,
    [ValidateSet('SNP', 'TDX', 'VBS')][string]$IsolationType,
    [switch]$KeepVm
)

$ErrorActionPreference = 'Continue'
$script:Findings = [System.Collections.Generic.List[object]]::new()
$HvNs = 'root\virtualization\v2'

function Add-Finding {
    param(
        [Parameter(Mandatory)][string]$Area,
        [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'warn', 'info')][string]$Status,
        [Parameter(Mandatory)][string]$Detail
    )
    $script:Findings.Add([pscustomobject]@{ Area = $Area; Status = $Status; Detail = $Detail })
    $color = switch ($Status) {
        'pass' { 'Green' }
        'fail' { 'Red' }
        'warn' { 'Yellow' }
        default { 'Gray' }
    }
    $tag = switch ($Status) {
        'pass' { '  OK  ' }
        'fail' { ' FAIL ' }
        'warn' { ' WARN ' }
        default { ' ---- ' }
    }
    Write-Host ('[{0}] {1,-24} {2}' -f $tag, $Area, $Detail) -ForegroundColor $color
}

function Test-Elevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# Numeric GuestStateIsolationType values as petri and vmms use them.
$IsoNames = @{ 0 = 'TrustedLaunch'; 1 = 'VBS'; 2 = 'SNP'; 3 = 'TDX'; 4 = 'RME'; 16 = 'OpenHCL'; 18 = 'reserved18'; 19 = 'reserved19' }

Write-Host ''
Write-Host 'Enclave host capability probe' -ForegroundColor Cyan
Write-Host '=============================' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------------
# 1. Windows build and edition.
#
# The isolated-VM loader (IGVM, SNP contexts, ID block, CVM policy) is in
# vmwp.exe from 22621 (23H2) onward; custom-IGVM loading (AllowFirmwareLoadFromFile,
# LoadClientHclFirmware) arrived in 26100 (24H2), which is why the OpenVMM guide
# names 26100.1586 as the floor. Windows 10's 19041 vmwp.exe has none of it.
# ---------------------------------------------------------------------------
$isHome = $false
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $build = [int]($os.BuildNumber)
    $ubr = 0
    try { $ubr = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name UBR -ErrorAction Stop).UBR } catch { }
    $caption = $os.Caption
    $detail = "$caption (build $build.$ubr)"

    if ($build -ge 26100 -and ($build -gt 26100 -or $ubr -ge 1586)) {
        Add-Finding 'Windows build' 'pass' "$detail - at or above the 26100.1586 floor (custom IGVM loading present in vmwp.exe)"
    } elseif ($build -ge 26100) {
        Add-Finding 'Windows build' 'warn' "$detail - 26100 but below .1586; install the current cumulative update first"
    } elseif ($build -ge 22621) {
        Add-Finding 'Windows build' 'fail' "$detail - Windows 11 23H2: vmwp.exe has the SNP loader but NOT custom-IGVM loading; the free in-place update to 24H2 fixes this"
    } elseif ($build -ge 22000) {
        Add-Finding 'Windows build' 'fail' "$detail - Windows 11 21H2; a free in-place update to 24H2 fixes this"
    } else {
        Add-Finding 'Windows build' 'fail' ("$detail - Windows 10 or older. Its vmwp.exe (19041) carries no IGVM loader, no SNP " +
            'contexts and no measurement code, and the OS left support on 2025-10-14. Not fixable by updating Windows 10; ' +
            'the equivalent is the free in-place upgrade to Windows 11.')
    }

    $sku = "$caption"
    if ($sku -match 'Home') {
        $isHome = $true
        Add-Finding 'Windows edition' 'warn' ('Home edition - the Hyper-V ROLE is not offered, but the platform files are identical to Pro. ' +
            'See the "Home: staged packages" and "Virtual Machine Platform" lines below for the two routes (EDITIONS.md).')
    } elseif ($sku -match 'Pro|Enterprise|Education|Server') {
        Add-Finding 'Windows edition' 'pass' 'edition offers the Hyper-V role'
    } else {
        Add-Finding 'Windows edition' 'info' "edition not recognised: $sku"
    }
} catch {
    Add-Finding 'Windows build' 'fail' "could not read OS info: $($_.Exception.Message)"
}

# The platform files. vmwp.exe is the VM worker that parses the isolation
# document and loads the IGVM; winhvr.sys is the hypervisor interface driver
# that carries WinHvImportIsolatedPages / WinHvIssueSnpPspGuestRequest. Both
# ship in every edition's cumulative update.
foreach ($f in @('System32\vmwp.exe', 'System32\vmcompute.dll', 'System32\drivers\winhvr.sys')) {
    try {
        $p = Join-Path $env:SystemRoot $f
        if (Test-Path $p) {
            $v = (Get-Item $p).VersionInfo.FileVersion
            Add-Finding "file $(Split-Path $f -Leaf)" 'pass' "present ($v)"
        } else {
            $why = if ($f -like '*vmwp*' -or $f -like '*vmcompute*') { 'enable Virtual Machine Platform or the Hyper-V role' } else { 'no hypervisor interface driver on this machine' }
            Add-Finding "file $(Split-Path $f -Leaf)" 'warn' "absent - $why"
        }
    } catch { }
}

# ---------------------------------------------------------------------------
# 2. CPU: is there SEV-SNP or TDX silicon underneath at all?
#
# No amount of software fixes this. SEV-SNP is EPYC 7003 (Milan) and newer;
# AMD states SEV is "not available on 4004 and 4005 series AMD EPYC Server CPUs
# or AMD Ryzen CPUs", so the AM5-socket EPYCs do not count. TDX is Xeon
# Scalable 4th gen (Sapphire Rapids) and newer. Consumer Ryzen and Core parts
# implement neither.
# ---------------------------------------------------------------------------
$cpuFamily = 'unknown'
try {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
    $name = ($cpu.Name).Trim()
    Add-Finding 'CPU' 'info' $name

    if ($name -match 'EPYC\s*4\d{3}') {
        $cpuFamily = 'epyc-am5'
        Add-Finding 'CPU: SEV-SNP class' 'fail' 'EPYC 4004/4005 (AM5) - AMD: SEV is not available on these parts. No firmware toggle adds it.'
    } elseif ($name -match 'EPYC') {
        $cpuFamily = 'epyc'
        Add-Finding 'CPU: SEV-SNP class' 'pass' 'AMD EPYC - SEV-SNP capable from 7003 (Milan) onward; see the firmware checklist in EDITIONS.md (RMP coverage OFF for Hyper-V)'
    } elseif ($name -match 'Xeon') {
        $cpuFamily = 'xeon'
        Add-Finding 'CPU: TDX class' 'warn' 'Intel Xeon - TDX exists on Xeon Scalable 4th gen and newer only; Xeon W and Xeon E do not carry it'
    } elseif ($name -match 'Ryzen|Threadripper') {
        Add-Finding 'CPU: SEV-SNP class' 'fail' 'consumer/HEDT Ryzen - SEV-SNP is not implemented in this silicon. No driver or OS update adds it.'
    } elseif ($name -match 'Core|Ultra') {
        Add-Finding 'CPU: TDX class' 'fail' 'consumer Core - TDX is not implemented in this silicon. No driver or OS update adds it.'
    } else {
        Add-Finding 'CPU class' 'warn' 'unrecognised CPU; check the vendor spec for SEV-SNP or TDX support'
    }

    if ($null -ne $cpu.VirtualizationFirmwareEnabled) {
        if ($cpu.VirtualizationFirmwareEnabled) { Add-Finding 'CPU: virtualization' 'pass' 'virtualization enabled in firmware' }
        else { Add-Finding 'CPU: virtualization' 'fail' 'virtualization DISABLED in firmware - enable SVM/VT-x' }
    }
} catch {
    Add-Finding 'CPU' 'warn' "could not read processor info: $($_.Exception.Message)"
}

if (-not $IsolationType) { $IsolationType = if ($cpuFamily -eq 'xeon') { 'TDX' } else { 'SNP' } }
if ($IsolationType -eq 'VBS') {
    Add-Finding 'mode' 'info' ('VBS dry run: same New-VM + ModifySystemSettings path as SNP, but no confidential silicon required. ' +
        'A pass proves the custom-IGVM MECHANISM, not that this host can do SNP.')
}

# ---------------------------------------------------------------------------
# 3. Hyper-V present, and on Home: is it stageable?
#
# Microsoft's OpenVMM CI enables exactly three features before its SNP/TDX
# Hyper-V tests: Microsoft-Hyper-V, Microsoft-Hyper-V-Management-PowerShell,
# Microsoft-Hyper-V-Management-Clients. On Home those packages are on disk in
# %SystemRoot%\servicing\Packages but not owned by the edition manifest, so the
# feature is "unknown" to DISM until they are staged with /add-package.
# ---------------------------------------------------------------------------
$hyperVOn = $false
try {
    if (Get-Command Get-WindowsOptionalFeature -ErrorAction SilentlyContinue) {
        foreach ($feat in @('Microsoft-Hyper-V', 'Microsoft-Hyper-V-Management-PowerShell', 'Microsoft-Hyper-V-Management-Clients')) {
            $f = Get-WindowsOptionalFeature -Online -FeatureName $feat -ErrorAction SilentlyContinue
            if ($null -eq $f) {
                Add-Finding "feature $feat" 'warn' 'unknown to DISM on this edition'
            } elseif ($f.State -eq 'Enabled') {
                if ($feat -eq 'Microsoft-Hyper-V') { $hyperVOn = $true }
                Add-Finding "feature $feat" 'pass' 'enabled'
            } else {
                Add-Finding "feature $feat" 'fail' "$($f.State) - enable it: DISM /Online /Enable-Feature /All /FeatureName:$feat"
            }
        }
    }
    if (-not $hyperVOn -and (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue)) {
        $f = Get-WindowsFeature -Name 'Hyper-V' -ErrorAction SilentlyContinue
        if ($null -ne $f -and $f.Installed) { $hyperVOn = $true; Add-Finding 'Hyper-V' 'pass' 'Hyper-V role installed' }
    }

    if ($isHome) {
        # Route A: stage the in-box packages. Use the wide *Hyper*.mum glob; the
        # narrow *Hyper-V*.mum pattern produced a partial stack on 24H2.
        try {
            $pk = Join-Path $env:SystemRoot 'servicing\Packages'
            $mums = @(Get-ChildItem -Path $pk -Filter '*Hyper*.mum' -ErrorAction SilentlyContinue)
            if ($mums.Count -gt 0) {
                Add-Finding 'Home: staged packages' 'pass' ("$($mums.Count) *Hyper*.mum packages present - Route A (DISM /add-package each, then " +
                    '/enable-feature Microsoft-Hyper-V -All) gives this machine the same vmms.exe and PowerShell module as Pro')
            } else {
                Add-Finding 'Home: staged packages' 'warn' 'no *Hyper*.mum packages found in servicing\Packages - Route A unavailable; Route B (HCS via Virtual Machine Platform) only'
            }
        } catch {
            Add-Finding 'Home: staged packages' 'warn' "could not list servicing packages: $($_.Exception.Message)"
        }
    }

    if (-not (Get-Command Get-VMHost -ErrorAction SilentlyContinue)) {
        Add-Finding 'Hyper-V module' 'warn' 'Hyper-V PowerShell module absent - the Get-VMHost / New-VM checks below are skipped'
    } else {
        Add-Finding 'Hyper-V module' 'pass' 'Hyper-V PowerShell module present'
    }

    # Virtual Machine Platform exposes HCS (vmcompute + vmwp) WITHOUT the role;
    # it is how WSL2 runs on Home and how shipping products create full VMs
    # there. Route B for Home.
    try {
        $vmp = Get-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform' -ErrorAction SilentlyContinue
        if ($null -ne $vmp) {
            if ($vmp.State -eq 'Enabled') {
                Add-Finding 'Virtual Machine Platform' 'pass' 'enabled - HCS is exposed even without the Hyper-V role (Route B on Home)'
            } else {
                Add-Finding 'Virtual Machine Platform' 'warn' ("$($vmp.State) - enable with: " +
                    'Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All')
            }
        }
    } catch { }

    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        if ($cs.HypervisorPresent) { Add-Finding 'Hypervisor running' 'pass' 'a hypervisor is present and running' }
        else { Add-Finding 'Hypervisor running' 'fail' 'no hypervisor detected - enable virtualization in firmware and a virtualization feature, then reboot' }
    } catch { }
} catch {
    Add-Finding 'Hyper-V' 'warn' "feature query failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 4. The two registry values Microsoft's CI sets, and what the hypervisor
#    says after the reboot.
#
#   HKLM\System\CurrentControlSet\Control\Hypervisor\EnableHardwareIsolation = 1
#     "Enable hardware-isolation CPU features (Intel TDX / AMD SEV-SNP)";
#     read by the hypervisor loader at boot -> reboot required.
#   HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization\AllowFirmwareLoadFromFile = 1
#     permits an UNSIGNED IGVM to be loaded (ours).
# ---------------------------------------------------------------------------
$hwIso = $null
try {
    $hvKey = 'HKLM:\System\CurrentControlSet\Control\Hypervisor'
    try { $hwIso = (Get-ItemProperty -Path $hvKey -Name 'EnableHardwareIsolation' -ErrorAction Stop).EnableHardwareIsolation } catch { }
    if ($hwIso -ge 1) {
        Add-Finding 'EnableHardwareIsolation' 'pass' "= $hwIso (1 = enable, 2 = force)"
    } else {
        Add-Finding 'EnableHardwareIsolation' $(if ($IsolationType -eq 'VBS') { 'info' } else { 'fail' }) ('not set. Elevated: reg add "HKLM\System\CurrentControlSet\Control\Hypervisor" /v EnableHardwareIsolation /t REG_DWORD /d 1 /f ; then REBOOT. ' +
            'This is the host gate Microsoft flips before its own SNP/TDX Hyper-V tests.')
    }
    $sevSnp = $null
    try { $sevSnp = (Get-ItemProperty -Path $hvKey -Name 'EnableSevSnp' -ErrorAction Stop).EnableSevSnp } catch { }
    if ($null -ne $sevSnp) { Add-Finding 'EnableSevSnp' 'info' "= $sevSnp (optional; AMD only)" }

    $virtKey = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
    $allow = $null
    try { $allow = (Get-ItemProperty -Path $virtKey -Name 'AllowFirmwareLoadFromFile' -ErrorAction Stop).AllowFirmwareLoadFromFile } catch { }
    if ($allow -eq 1) {
        Add-Finding 'AllowFirmwareLoadFromFile' 'pass' '= 1 - custom (unsigned) IGVM images may be loaded'
    } else {
        Add-Finding 'AllowFirmwareLoadFromFile' 'warn' ('not set. Elevated: reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization" ' +
            '/v AllowFirmwareLoadFromFile /t REG_DWORD /d 1 /f')
    }
} catch {
    Add-Finding 'registry' 'warn' "registry probe failed: $($_.Exception.Message)"
}

# Get-VMHost: SnpStatus / TdxStatus / GuestIsolationTypes. petri's comment:
# "there are other factors that determine SNP/TDX support than just hardware
# compatibility, hence we rely on SnpStatus and TdxStatus". 1 means yes.
$snpStatus = $null; $tdxStatus = $null
if (Get-Command Get-VMHost -ErrorAction SilentlyContinue) {
    try {
        $h = Get-VMHost -ErrorAction Stop
        $props = $h.PSObject.Properties
        if ($props['SnpStatus']) {
            $snpStatus = $h.SnpStatus
            if ($snpStatus -eq 1) { Add-Finding 'Get-VMHost SnpStatus' 'pass' '1 - the hypervisor reports SEV-SNP guests are possible on this host' }
            else { Add-Finding 'Get-VMHost SnpStatus' 'fail' "$snpStatus - SNP not available (firmware settings, EnableHardwareIsolation without a reboot, or the platform refusing)" }
        } else {
            Add-Finding 'Get-VMHost SnpStatus' 'warn' 'property absent - Hyper-V module older than the 26100 branch'
        }
        if ($props['TdxStatus']) {
            $tdxStatus = $h.TdxStatus
            if ($tdxStatus -eq 1) { Add-Finding 'Get-VMHost TdxStatus' 'pass' '1 - the hypervisor reports TDX guests are possible on this host' }
            else { Add-Finding 'Get-VMHost TdxStatus' 'info' "$tdxStatus" }
        }
        if ($props['GuestIsolationTypes']) {
            Add-Finding 'Get-VMHost isolation types' 'info' (@($h.GuestIsolationTypes) -join ', ')
        }
    } catch {
        Add-Finding 'Get-VMHost' 'warn' "failed: $($_.Exception.Message)"
    }
}

# The host's advertised isolation types straight from WMI, independent of the
# PowerShell module's enum: Msvm_VirtualSystemSettingData definitions under
# Microsoft:Definition\VirtualSystem\GuestStateIsolationType\<n>. This is what
# ExHyperV and petri read; it works wherever vmms runs.
$wmiIsoTypes = @()
try {
    $caps = Get-CimInstance -Namespace $HvNs -ClassName Msvm_VirtualSystemManagementCapabilities -ErrorAction Stop | Select-Object -First 1
    if ($caps) {
        $defs = Get-CimAssociatedInstance -InputObject $caps -ResultClassName Msvm_VirtualSystemSettingData -ErrorAction Stop
        foreach ($d in $defs) {
            if ($d.InstanceID -like 'Microsoft:Definition\VirtualSystem\GuestStateIsolationType\*' -and $d.GuestStateIsolationEnabled) {
                $n = [int]$d.GuestStateIsolationType
                $wmiIsoTypes += $(if ($IsoNames.ContainsKey($n)) { $IsoNames[$n] } else { "type$n" })
            }
        }
        if ($wmiIsoTypes.Count -gt 0) {
            Add-Finding 'WMI isolation definitions' 'info' ($wmiIsoTypes -join ', ')
            foreach ($t in @('SNP', 'TDX')) {
                if ($wmiIsoTypes -contains $t) { Add-Finding "WMI advertises $t" 'pass' "$t is an advertised guest-state isolation type on this host" }
            }
        } else {
            Add-Finding 'WMI isolation definitions' 'warn' 'no GuestStateIsolationType definitions advertised - vmms predates isolation, or the role is not enabled'
        }
    }
} catch {
    Add-Finding 'WMI isolation definitions' 'info' "unavailable: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 5. THE parameter on the live New-VM.
# ---------------------------------------------------------------------------
$isoValues = @()
if (Get-Command New-VM -ErrorAction SilentlyContinue) {
    try {
        $cmd = Get-Command New-VM -ErrorAction Stop
        if ($cmd.Parameters.ContainsKey('GuestStateIsolationType')) {
            $p = $cmd.Parameters['GuestStateIsolationType']
            if ($p.ParameterType.IsEnum) { $isoValues = [Enum]::GetNames($p.ParameterType) }
            else {
                $vs = $p.Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] } | Select-Object -First 1
                if ($vs) { $isoValues = $vs.ValidValues }
            }
            Add-Finding 'New-VM isolation param' 'pass' "present; values: $($isoValues -join ', ')"
            if ($isoValues -contains $IsolationType) { Add-Finding "New-VM accepts $IsolationType" 'pass' "$IsolationType is an accepted value" }
            else { Add-Finding "New-VM accepts $IsolationType" 'fail' "$IsolationType is NOT among the accepted values on this module" }
        } else {
            Add-Finding 'New-VM isolation param' 'fail' 'New-VM has no -GuestStateIsolationType - the module is older than the 26100 branch'
        }
    } catch {
        Add-Finding 'New-VM isolation param' 'fail' "could not inspect New-VM: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 6. GPU: the card that gets sold. Stays on the host with the game.
# ---------------------------------------------------------------------------
try {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
        $q = & nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader 2>$null
        if ($LASTEXITCODE -eq 0 -and $q) { foreach ($line in @($q)) { Add-Finding 'GPU' 'pass' $line.Trim() } }
        else { Add-Finding 'GPU' 'warn' 'nvidia-smi present but returned nothing' }
    } else {
        $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
        foreach ($g in $gpus) { Add-Finding 'GPU' 'info' "$($g.Name) (no nvidia-smi; CUDA required for the shielded worker)" }
        Add-Finding 'GPU: CUDA' 'fail' 'nvidia-smi not found - the shielded worker needs an NVIDIA CUDA card'
    }
} catch {
    Add-Finding 'GPU' 'warn' "GPU query failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 7. The decisive test: create an isolated VM, then hand it a firmware file
#    through WMI exactly as petri's Set-OpenHCLFirmware does.
#
# A zero-byte placeholder file is used. Content validation of the IGVM happens
# at Start-VM, not at ModifySystemSettings, so what is being tested here is
# whether the management service ACCEPTS FirmwareFile + GuestFeatureSet on an
# SNP/TDX-isolated VM. Acceptance -> custom IGVM composes with hardware
# isolation on this host. Refusal text is the most valuable output.
# ---------------------------------------------------------------------------
function Set-ProbeFirmware {
    param([Parameter(Mandatory)]$Vm, [Parameter(Mandatory)][string]$FirmwarePath)
    $vmms = Get-CimInstance -Namespace $HvNs -ClassName Msvm_VirtualSystemManagementService -ErrorAction Stop | Select-Object -First 1
    $id = $Vm.Id.ToString()
    $vssd = Get-CimInstance -Namespace $HvNs -Query "SELECT * FROM Msvm_VirtualSystemSettingData WHERE ConfigurationID='$id' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'" -ErrorAction Stop | Select-Object -First 1
    if (-not $vssd) { throw 'realized Msvm_VirtualSystemSettingData not found for the probe VM' }
    if (-not $vssd.PSObject.Properties['FirmwareFile']) { throw 'Msvm_VirtualSystemSettingData has no FirmwareFile property on this host (vmms predates custom IGVM)' }
    $vssd.GuestFeatureSet = [uint32]0x201
    $vssd.FirmwareFile = $FirmwarePath
    $ser = [Microsoft.Management.Infrastructure.Serialization.CimSerializer]::Create()
    $bytes = $ser.Serialize($vssd, [Microsoft.Management.Infrastructure.Serialization.InstanceSerializationOptions]::None)
    $xml = [System.Text.Encoding]::Unicode.GetString($bytes)
    $r = Invoke-CimMethod -InputObject $vmms -MethodName ModifySystemSettings -Arguments @{ SystemSettings = $xml } -ErrorAction Stop
    if ($r.ReturnValue -eq 4096 -and $r.Job) {
        $job = $r.Job
        $deadline = (Get-Date).AddSeconds(60)
        while ($job.JobState -in 2, 3, 4 -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
            $job = Get-CimInstance -InputObject $job
        }
        if ($job.JobState -ne 7) { throw "ModifySystemSettings job ended in state $($job.JobState): $($job.ErrorDescription)" }
    } elseif ($r.ReturnValue -ne 0) {
        throw "ModifySystemSettings returned $($r.ReturnValue)"
    }
}

if ($Attempt) {
    if (-not (Test-Elevated)) {
        Add-Finding 'isolated VM test' 'warn' 'skipped - run this script elevated to attempt VM creation'
    } elseif (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
        Add-Finding 'isolated VM test' 'warn' 'skipped - no Hyper-V PowerShell module (on Home: stage the packages first, Route A)'
    } else {
        $vmName = "enclave-$($IsolationType.ToLower())-probe-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        $created = $false
        $vm = $null
        try {
            Write-Host ''
            Write-Host "  creating $vmName with -GuestStateIsolationType $IsolationType ..." -ForegroundColor Cyan
            $vm = New-VM -Name $vmName -MemoryStartupBytes 1GB -Generation 2 -NoVHD `
                         -GuestStateIsolationType $IsolationType -ErrorAction Stop
            $created = $true
            Add-Finding 'isolated VM test' 'pass' "Hyper-V ACCEPTED a $IsolationType-isolated VM on this host"

            try {
                $v = Get-VM -Name $vmName -ErrorAction Stop
                Add-Finding 'isolated VM state' 'info' "version $($v.Version), state $($v.State), GuestStateIsolationType $($v.GuestStateIsolationType)"
            } catch { }

            $probeIgvm = Join-Path $env:TEMP 'enclave-probe-placeholder.igvm'
            try { Set-Content -Path $probeIgvm -Value '' -NoNewline -ErrorAction Stop } catch { }
            try {
                Set-ProbeFirmware -Vm $vm -FirmwarePath $probeIgvm
                Add-Finding "custom IGVM + $IsolationType" 'pass' ('ModifySystemSettings accepted GuestFeatureSet=0x201 + FirmwareFile on the isolated VM - ' +
                    'custom IGVM composes with hardware isolation here; next step is a real IGVM and Start-VM')
            } catch {
                $m = $_.Exception.Message
                if ($m -match 'isolation|isolated|not supported|unsupported|invalid|denied') {
                    Add-Finding "custom IGVM + $IsolationType" 'fail' "REFUSED: $m"
                    Add-Finding "custom IGVM + $IsolationType" 'info' 'this is the Path A blocker - see ARCHITECTURE.md / EDITIONS.md'
                } else {
                    Add-Finding "custom IGVM + $IsolationType" 'warn' "inconclusive: $m"
                }
            } finally {
                try { Remove-Item -Path $probeIgvm -Force -ErrorAction SilentlyContinue } catch { }
            }
        } catch {
            $msg = $_.Exception.Message
            Add-Finding 'isolated VM test' 'fail' $msg
            Add-Finding 'isolated VM test' 'info' ('read the message carefully: "not supported on this host" after EnableHardwareIsolation + reboot with SnpStatus=1 ' +
                'is a platform refusal; before the reboot or with SnpStatus<>1 it is just the gate')
        } finally {
            if ($created -and -not $KeepVm) {
                try { Remove-VM -Name $vmName -Force -ErrorAction Stop; Write-Host "  removed $vmName" -ForegroundColor DarkGray }
                catch { Add-Finding 'cleanup' 'warn' "could not remove $vmName - delete it by hand" }
            }
        }
    }
} else {
    Add-Finding 'isolated VM test' 'info' 'not attempted - re-run elevated with -Attempt for the decisive answer'
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Verdict' -ForegroundColor Cyan
Write-Host '-------' -ForegroundColor Cyan

$fails = @($script:Findings | Where-Object { $_.Status -eq 'fail' })
$vmAccepted = @($script:Findings | Where-Object { $_.Area -eq 'isolated VM test' -and $_.Status -eq 'pass' }).Count -gt 0
$fwAccepted = @($script:Findings | Where-Object { $_.Area -like 'custom IGVM*' -and $_.Status -eq 'pass' }).Count -gt 0
$hostSaysYes = ($IsolationType -eq 'SNP' -and $snpStatus -eq 1) -or ($IsolationType -eq 'TDX' -and $tdxStatus -eq 1)

if ($vmAccepted -and $fwAccepted -and $IsolationType -eq 'VBS') {
    Write-Host 'DRY RUN PASSED: this host created a VBS-isolated VM and accepted a custom firmware file on it.' -ForegroundColor Green
    Write-Host 'The custom-IGVM mechanism works. Still unproven: whether the hypervisor grants SNP on' -ForegroundColor Green
    Write-Host 'confidential silicon - that is EnableHardwareIsolation + a reboot + SnpStatus on an EPYC box.' -ForegroundColor Green
} elseif ($vmAccepted -and $fwAccepted) {
    Write-Host "This host CREATED a $IsolationType-isolated VM and accepted a custom firmware file on it." -ForegroundColor Green
    Write-Host 'Next: build the metal guest as an IGVM (x64-cvm), point FirmwareFile at it, Start-VM, pull a report.' -ForegroundColor Green
} elseif ($vmAccepted) {
    Write-Host "This host CREATED a $IsolationType-isolated VM but the custom-firmware write was refused or inconclusive - see above." -ForegroundColor Yellow
} elseif ($hostSaysYes -and -not $Attempt) {
    Write-Host "Get-VMHost says $IsolationType is available here. Re-run elevated with -Attempt for the decisive answer." -ForegroundColor Green
} elseif (($null -eq $hwIso -or $hwIso -lt 1) -and $IsolationType -ne 'VBS') {
    Write-Host 'EnableHardwareIsolation is not set. Set it (see above), reboot, and re-run - nothing else is meaningful until then.' -ForegroundColor Yellow
    Write-Host 'Or dry-run the mechanism on any machine now:  -Attempt -IsolationType VBS' -ForegroundColor Yellow
} elseif ($fails.Count -gt 0) {
    Write-Host "$($fails.Count) blocking finding(s):" -ForegroundColor Red
    foreach ($f in $fails) { Write-Host "  - $($f.Area): $($f.Detail)" -ForegroundColor Red }
} else {
    Write-Host 'Inconclusive - see the findings above.' -ForegroundColor Yellow
}
Write-Host ''

$script:Findings | Export-Csv -NoTypeInformation -Path (Join-Path $PWD 'enclave-host-probe.csv') -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $PWD 'enclave-host-probe.csv')) {
    Write-Host "findings written to enclave-host-probe.csv" -ForegroundColor DarkGray
}
