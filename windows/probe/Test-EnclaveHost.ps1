<#
.SYNOPSIS
  Can THIS Windows machine host an Enclave seller node?

.DESCRIPTION
  Answers one question with evidence rather than opinion: can this box run a
  hardware-attested confidential VM (the trusted half) while Windows keeps the
  GPU on bare metal (the untrusted half, and the game)?

  Nothing here is destructive. The only mutation is an SNP virtual machine that
  is created and immediately deleted, and only if -Attempt is passed. That
  single step is the point of the script: Microsoft DOCUMENTS
  `New-VM -GuestStateIsolationType SNP` in the shipping Windows Server 2025
  Hyper-V module, but a documented parameter value is not a working feature, and
  no public first-hand report of it launching on retail Windows could be found.
  The parameter existing tells you the cmdlet accepts the word. Creating the VM
  tells you the platform means it.

  Why this architecture and not another (the short version):

    * Windows cannot be the thing that launches an SNP guest via QEMU/KVM the
      way metal/ does on Linux -- WHPX exposes no confidential-guest launch, and
      a driver cannot outrank the hypervisor. Hyper-V's own isolation type is
      the only door.
    * The GPU does NOT go in the enclave. It stays on the Windows host, held by
      the shielded worker, which only ever sees one-time-padded residues over a
      prime field. A hostile GPU host is the declared threat model, so the
      gamer, the game, and Windows itself are all already assumed adversarial.
    * Therefore no GPU passthrough is needed, Windows is never virtualised, and
      the card is shared with the game by the ordinary NVIDIA driver, exactly as
      it already is on metal0 (an EPYC 9115 with an RTX 3070).

.PARAMETER Attempt
  Actually create and delete a throwaway SNP VM. This is the decisive test.
  Without it the script reports only what can be learned by inspection.

.PARAMETER KeepVm
  Leave the probe VM behind for inspection instead of deleting it.

.EXAMPLE
  .\Test-EnclaveHost.ps1
  .\Test-EnclaveHost.ps1 -Attempt        # run elevated
#>
[CmdletBinding()]
param(
    [switch]$Attempt,
    [switch]$KeepVm
)

$ErrorActionPreference = 'Continue'
$script:Findings = [System.Collections.Generic.List[object]]::new()

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
    Write-Host ('[{0}] {1,-22} {2}' -f $tag, $Area, $Detail) -ForegroundColor $color
}

function Test-Elevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

Write-Host ''
Write-Host 'Enclave host capability probe' -ForegroundColor Cyan
Write-Host '=============================' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------------
# 1. Windows build.
#
# Confidential VM support landed in the 26100 branch (Windows Server 2025 /
# Windows 11 24H2), which is also the OS build Azure Local 2607 carries when it
# ships confidential VMs in public preview. Older branches do not have the
# isolation type at all, so there is no point continuing on one.
# ---------------------------------------------------------------------------
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $build = [int]($os.BuildNumber)
    $caption = $os.Caption
    $detail = "$caption (build $build)"
    if ($build -ge 26100) { Add-Finding 'Windows build' 'pass' $detail }
    elseif ($build -ge 22000) { Add-Finding 'Windows build' 'warn' "$detail - pre-26100; the SNP isolation type is not expected here" }
    else { Add-Finding 'Windows build' 'fail' "$detail - far too old for confidential VMs" }
} catch {
    Add-Finding 'Windows build' 'fail' "could not read OS info: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 2. CPU: is there SEV-SNP or TDX silicon underneath at all?
#
# This is the check that no amount of software fixes. SEV-SNP is EPYC 7003
# (Milan) and newer; TDX is Xeon Scalable (4th gen / Sapphire Rapids and newer).
# Consumer Ryzen and Core parts implement NEITHER -- not a firmware toggle, the
# silicon is absent. We match on the brand string because CPUID is not reachable
# from PowerShell without native code; a machine that passes this check should
# still confirm in firmware (SMEE / SEV Control / SNP Memory (RMP)).
# ---------------------------------------------------------------------------
$cpuFamily = 'unknown'
try {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
    $name = ($cpu.Name).Trim()
    Add-Finding 'CPU' 'info' $name

    if ($name -match 'EPYC') {
        $cpuFamily = 'epyc'
        Add-Finding 'CPU: SEV-SNP class' 'pass' 'AMD EPYC - SEV-SNP capable from 7003 (Milan) onward; verify SMEE + SEV Control + SNP Memory (RMP) are enabled in firmware'
    } elseif ($name -match 'Xeon') {
        $cpuFamily = 'xeon'
        Add-Finding 'CPU: TDX class' 'warn' 'Intel Xeon - TDX exists on Xeon Scalable 4th gen and newer only; Xeon W and E do not carry it'
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

# ---------------------------------------------------------------------------
# 3. Hyper-V present?
#
# Hyper-V is the only path to an SNP guest on Windows, so it has to be on. Note
# the client and server feature names differ.
# ---------------------------------------------------------------------------
$hyperVOn = $false
try {
    if (Get-Command Get-WindowsOptionalFeature -ErrorAction SilentlyContinue) {
        $f = Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Hyper-V-All' -ErrorAction SilentlyContinue
        if ($null -ne $f) {
            $hyperVOn = ($f.State -eq 'Enabled')
            if ($hyperVOn) { Add-Finding 'Hyper-V' 'pass' 'Microsoft-Hyper-V-All enabled' }
            else { Add-Finding 'Hyper-V' 'fail' "Microsoft-Hyper-V-All is $($f.State) - enable it and reboot" }
        }
    }
    if (-not $hyperVOn -and (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue)) {
        $f = Get-WindowsFeature -Name 'Hyper-V' -ErrorAction SilentlyContinue
        if ($null -ne $f) {
            $hyperVOn = $f.Installed
            if ($hyperVOn) { Add-Finding 'Hyper-V' 'pass' 'Hyper-V role installed' }
            else { Add-Finding 'Hyper-V' 'fail' 'Hyper-V role not installed' }
        }
    }
    if (-not (Get-Command Get-VMHost -ErrorAction SilentlyContinue)) {
        Add-Finding 'Hyper-V module' 'fail' 'the Hyper-V PowerShell module is absent - install the management tools'
    } else {
        Add-Finding 'Hyper-V module' 'pass' 'Hyper-V PowerShell module present'
    }
} catch {
    Add-Finding 'Hyper-V' 'warn' "feature query failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 4. THE parameter.
#
# Does this host's New-VM actually carry -GuestStateIsolationType, and does its
# type admit SNP / TDX? Microsoft's Windows Server 2025 reference lists
# TrustedLaunch, VBS, SNP, TDX, Disabled. Reading it off the live cmdlet proves
# what THIS machine's module offers rather than what the docs say.
# ---------------------------------------------------------------------------
$isoValues = @()
try {
    $cmd = Get-Command New-VM -ErrorAction Stop
    if ($cmd.Parameters.ContainsKey('GuestStateIsolationType')) {
        $p = $cmd.Parameters['GuestStateIsolationType']
        Add-Finding 'Isolation parameter' 'pass' "New-VM exposes -GuestStateIsolationType ($($p.ParameterType.Name))"

        if ($p.ParameterType.IsEnum) {
            $isoValues = [Enum]::GetNames($p.ParameterType)
        } else {
            $vs = $p.Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] } | Select-Object -First 1
            if ($vs) { $isoValues = $vs.ValidValues }
        }

        if ($isoValues.Count -gt 0) {
            Add-Finding 'Isolation values' 'info' ($isoValues -join ', ')
            if ($isoValues -contains 'SNP') { Add-Finding 'Isolation: SNP' 'pass' 'SNP is an accepted value on this host' }
            else { Add-Finding 'Isolation: SNP' 'fail' 'SNP is NOT among the accepted values on this host' }
            if ($isoValues -contains 'TDX') { Add-Finding 'Isolation: TDX' 'pass' 'TDX is an accepted value on this host' }
        } else {
            Add-Finding 'Isolation values' 'warn' 'could not enumerate the accepted values'
        }
    } else {
        Add-Finding 'Isolation parameter' 'fail' 'New-VM has no -GuestStateIsolationType on this host - the build is too old or the module is downlevel'
    }
} catch {
    Add-Finding 'Isolation parameter' 'fail' "could not inspect New-VM: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 4b. Custom firmware: can this host be handed OUR IGVM?
#
# This is what makes a reproducible measurement possible. Microsoft's OpenVMM
# guide documents Set-OpenHCLFirmware -IgvmFile for pointing a VM at a custom
# IGVM, gated on the AllowFirmwareLoadFromFile registry value, which permits
# UNSIGNED firmware images. Without it we would be stuck with a Microsoft-built
# UVM whose measurement nobody outside Microsoft can reproduce.
#
# Note that `OpenHCL` is itself a valid -GuestStateIsolationType even though the
# published New-VM reference does not list it, so an absent value above is not
# proof of absence here.
# ---------------------------------------------------------------------------
try {
    if (Get-Command Set-OpenHCLFirmware -ErrorAction SilentlyContinue) {
        Add-Finding 'Custom IGVM' 'pass' 'Set-OpenHCLFirmware present - this host can be pointed at a custom IGVM'
    } else {
        Add-Finding 'Custom IGVM' 'fail' 'Set-OpenHCLFirmware not found - needs Windows 11 24H2 (26100.1586+) or Server 2025 with OpenHCL support'
    }

    $virtKey = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
    $allow = $null
    try { $allow = (Get-ItemProperty -Path $virtKey -Name 'AllowFirmwareLoadFromFile' -ErrorAction Stop).AllowFirmwareLoadFromFile } catch { }
    if ($allow -eq 1) {
        Add-Finding 'Unsigned firmware' 'pass' 'AllowFirmwareLoadFromFile=1 - custom IGVM images may be loaded'
    } else {
        Add-Finding 'Unsigned firmware' 'warn' ('AllowFirmwareLoadFromFile is not set. Enable it elevated with: ' +
            'Set-ItemProperty "HKLM:/Software/Microsoft/Windows NT/CurrentVersion/Virtualization" -Name AllowFirmwareLoadFromFile -Value 1 -Type DWORD')
    }

    if ($isoValues -contains 'OpenHCL') {
        Add-Finding 'Isolation: OpenHCL' 'pass' 'OpenHCL isolation available'
    }
} catch {
    Add-Finding 'Custom IGVM' 'warn' "custom-firmware probe failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 5. GPU: the card that gets sold.
#
# The card is NOT passed through and NOT put in the enclave. It stays here on
# the host with the game. What matters is only that CUDA is present and how much
# VRAM there is, because the seller's slider sets a VRAM BUDGET the fleet is
# told about -- the worker takes no device memory at start-up, tenants reserve
# their share when they connect, and what they reserved goes back when they
# disconnect.
# ---------------------------------------------------------------------------
try {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
        $q = & nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader 2>$null
        if ($LASTEXITCODE -eq 0 -and $q) {
            foreach ($line in @($q)) { Add-Finding 'GPU' 'pass' $line.Trim() }
        } else {
            Add-Finding 'GPU' 'warn' 'nvidia-smi present but returned nothing'
        }
    } else {
        $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
        foreach ($g in $gpus) { Add-Finding 'GPU' 'info' "$($g.Name) (no nvidia-smi; CUDA required for the shielded worker)" }
        Add-Finding 'GPU: CUDA' 'fail' 'nvidia-smi not found - the shielded worker needs an NVIDIA CUDA card'
    }
} catch {
    Add-Finding 'GPU' 'warn' "GPU query failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 6. GPU partitioning (informational).
#
# Recorded because it is genuinely available on Windows and is the reason the
# card never has to be passed through: a Hyper-V guest can SHARE a physical GPU
# with the host, with no generation restriction. This architecture does not
# depend on it -- the worker runs on the host -- but it is the escape hatch if
# a future design wants GPU inside a guest.
# ---------------------------------------------------------------------------
try {
    $pgpu = $null
    if (Get-Command Get-VMHostPartitionableGpu -ErrorAction SilentlyContinue) {
        $pgpu = Get-VMHostPartitionableGpu -ErrorAction SilentlyContinue
    } elseif (Get-Command Get-VMPartitionableGpu -ErrorAction SilentlyContinue) {
        $pgpu = Get-VMPartitionableGpu -ErrorAction SilentlyContinue
    }
    if ($pgpu) { Add-Finding 'GPU-PV' 'info' "$(@($pgpu).Count) partitionable GPU(s) reported by Hyper-V" }
    else { Add-Finding 'GPU-PV' 'info' 'no partitionable GPUs reported (not required by this design)' }
} catch {
    Add-Finding 'GPU-PV' 'info' 'partitionable GPU query unavailable'
}

# ---------------------------------------------------------------------------
# 7. The decisive test.
#
# Create an SNP-isolated VM. No disk, minimum memory, deleted immediately. The
# error text on failure is the most valuable output this script produces: it is
# the difference between "the platform refuses this feature outside Azure Local"
# and "firmware is not configured", and those lead to completely different
# decisions.
# ---------------------------------------------------------------------------
if ($Attempt) {
    if (-not (Test-Elevated)) {
        Add-Finding 'SNP launch test' 'warn' 'skipped - run this script elevated to attempt VM creation'
    } else {
        $vmName = "enclave-snp-probe-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        $created = $false
        try {
            Write-Host ''
            Write-Host "  creating $vmName with -GuestStateIsolationType SNP ..." -ForegroundColor Cyan
            $vm = New-VM -Name $vmName -MemoryStartupBytes 1GB -Generation 2 -NoVHD `
                         -GuestStateIsolationType SNP -ErrorAction Stop
            $created = $true
            Add-Finding 'SNP launch test' 'pass' 'Hyper-V ACCEPTED an SNP-isolated VM on this host'

            try {
                $v = Get-VM -Name $vmName -ErrorAction Stop
                Add-Finding 'SNP VM state' 'info' "version $($v.Version), state $($v.State)"
            } catch { }

            # THE question this probe exists to answer.
            #
            # Loading a custom IGVM is documented, but ONLY for -GuestStateIsolationType
            # OpenHCL and TrustedLaunch. Whether Set-OpenHCLFirmware will accept a VM
            # created with SNP isolation is undocumented, and it decides everything:
            #
            #   accepts -> we ship our own IGVM as a confidential guest, compute its
            #              launch measurement offline, and PROTOCOL.md's allowlist stays
            #              auditable (anyone rebuilds and recomputes).
            #   refuses -> the only remaining route is a Microsoft-built UVM, whose
            #              measurement "cannot be independently reproduced by third
            #              parties" -- a real downgrade to the tenant-facing claim.
            #
            # A dummy path is used deliberately: we are testing whether the cmdlet
            # REJECTS THE VM, not whether it likes the file. "file not found" is a
            # PASS for our purposes; "not supported on an isolated VM" is the failure.
            if (Get-Command Set-OpenHCLFirmware -ErrorAction SilentlyContinue) {
                $probeIgvm = Join-Path $env:TEMP 'enclave-probe-nonexistent.bin'
                try {
                    Set-OpenHCLFirmware -Vm $vm -IgvmFile $probeIgvm -ErrorAction Stop
                    Add-Finding 'Custom IGVM + SNP' 'pass' 'Set-OpenHCLFirmware accepted an SNP-isolated VM'
                } catch {
                    $m = $_.Exception.Message
                    if ($m -match 'not found|does not exist|cannot find|No such') {
                        Add-Finding 'Custom IGVM + SNP' 'pass' ("cmdlet reached file handling on an SNP-isolated VM " +
                            "(rejected the dummy path, not the VM) - custom IGVM appears to compose with SNP")
                    } elseif ($m -match 'isolation|isolated|not supported|unsupported|invalid') {
                        Add-Finding 'Custom IGVM + SNP' 'fail' ("REFUSED for an isolated VM: $m")
                        Add-Finding 'Custom IGVM + SNP' 'info' 'this is the Path A blocker - reproducible measurement may not be reachable; see ARCHITECTURE.md'
                    } else {
                        Add-Finding 'Custom IGVM + SNP' 'warn' "inconclusive: $m"
                    }
                }
            } else {
                Add-Finding 'Custom IGVM + SNP' 'warn' 'Set-OpenHCLFirmware absent; cannot test the combination'
            }

            # Actually STARTING it would need a real bootable IGVM/VMGS pair, which
            # this probe does not ship.
        } catch {
            $msg = $_.Exception.Message
            Add-Finding 'SNP launch test' 'fail' $msg
            if ($msg -match 'not supported|unsupported|invalid|cannot') {
                Add-Finding 'SNP launch test' 'info' 'read the message above carefully: platform refusal, firmware not configured, and unsupported-CPU all look different'
            }
        } finally {
            if ($created -and -not $KeepVm) {
                try { Remove-VM -Name $vmName -Force -ErrorAction Stop; Write-Host "  removed $vmName" -ForegroundColor DarkGray }
                catch { Add-Finding 'cleanup' 'warn' "could not remove $vmName - delete it by hand" }
            }
        }
    }
} else {
    Add-Finding 'SNP launch test' 'info' 'not attempted - re-run elevated with -Attempt for the decisive answer'
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Verdict' -ForegroundColor Cyan
Write-Host '-------' -ForegroundColor Cyan

$fails = @($script:Findings | Where-Object { $_.Status -eq 'fail' })
$snpAccepted = @($script:Findings | Where-Object { $_.Area -eq 'SNP launch test' -and $_.Status -eq 'pass' }).Count -gt 0
$snpValue = $isoValues -contains 'SNP'

if ($snpAccepted) {
    Write-Host 'This host CREATED an SNP-isolated VM. The confidential half is viable here.' -ForegroundColor Green
    Write-Host 'Next: build a bootable IGVM + VMGS pair for the metal guest and start it.' -ForegroundColor Green
} elseif ($snpValue -and -not $Attempt) {
    Write-Host 'SNP is an accepted isolation value here. Re-run elevated with -Attempt to find out' -ForegroundColor Yellow
    Write-Host 'whether the platform actually honours it - that is the open question.' -ForegroundColor Yellow
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
