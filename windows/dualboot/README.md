# Dual-booting Windows on the EPYC host

Purpose: get a real Windows 11 install on bare metal so `Get-VMHost SnpStatus`
can be read and `Test-EnclaveHost.ps1 -Attempt -IsolationType SNP` can try a
real SEV-SNP launch under Hyper-V.  See `../EDITIONS.md` for what that test is.

This replaces the USB-SSD route.  Windows ships its USB storage drivers as
demand-start, so a system disk behind USB dies at boot with
`INACCESSIBLE_BOOT_DEVICE` -- exactly the "monitors flash, machine reboots"
symptom.  On an internal NVMe that problem does not exist.

## The disks

    nvme0n1   4.0 TB   p1 = LUKS -> /vm            275 GiB used of 3.58 TiB
    nvme1n1   4.0 TB   p1 = ESP /boot, p2 = swap, p3 = LUKS -> /

Windows goes at the end of **nvme0n1**.  Nothing on nvme1n1 is touched, so
`/`, `/boot` and swap are never at risk.

`/vm` holds `warden.qcow2` (63 GiB, metal0's disk -- the one irreplaceable
file) and `enclave-volumes` (210 GiB of GGUF weights, all re-downloadable).

## Order of operations

    # 0. tooling
    sudo pacman -S --needed wimlib dosfstools ntfs-3g os-prober

    # 1. optional but cheap insurance: 63 GiB, a few minutes
    sudo cp -a --reflink=auto /vm/warden.qcow2 /var/tmp/warden.qcow2.bak

    # 2. free 250 GiB at the end of nvme0n1  (dry run first -- it prints
    #    every number it is about to use and changes nothing)
    sudo ./shrink-vm.sh
    sudo ./shrink-vm.sh --apply

    # 3. stage the installer on an internal 12 GiB FAT32 partition
    sudo ./stage-installer.sh
    sudo ./stage-installer.sh --apply

    # 4. reboot, pick "Windows Setup", install into the unallocated space
    # 5. back in Arch:
    sudo ./grub-dualboot.sh

## Why the installer goes on disk instead of a USB stick

`/dev/sda` (the 1 TB USB SSD) currently reports size 0 -- the enclosure has
dropped off the bus.  Staging on internal storage removes that dependency
and is faster.  The 12 GiB partition sits at the very end of the disk so
Windows gets a contiguous block in front of it; delete it afterwards.

## Setup will refuse to install

There is no TPM on this box at all (`/sys/class/tpm/` is empty -- AMD fTPM is
off in firmware) and Secure Boot is disabled.  Windows 11 Setup checks both.
Bypass at the refusal screen:

    Shift+F10  ->  regedit
    HKLM\SYSTEM\Setup\LabConfig      (create the key)
      BypassTPMCheck        DWORD 1
      BypassSecureBootCheck DWORD 1

Do not turn Secure Boot on in firmware to satisfy the check -- GRUB here is
unsigned and would stop booting.

## Getting a local account

Windows 11 25H2 OOBE demands a Microsoft account and a network.  To get a
local account instead, at the OOBE screen press `Shift+F10` and run:

    start ms-cxh:localonly

(`OOBE\BYPASSNRO` was removed in 24H2 and does not work here.)

## Before the SNP test

Re-enable this in the *same* trip to firmware as the install reboot -- it
costs nothing to have on while Windows installs, and it saves a reboot later.

RMP Table Coverage is currently **disabled** in firmware (that is why metal0
is crash-looping with `vm-type SEV-SNP not supported by KVM`).  Re-enable it
before testing Windows -- Hyper-V needs SNP in firmware exactly as KVM does,
and it fixes metal0 at the same time.

Then, in Windows:

    reg add "HKLM\System\CurrentControlSet\Control\Hypervisor" ^
      /v EnableHardwareIsolation /t REG_DWORD /d 1 /f
    shutdown /r /t 0
    Get-VMHost | Select-Object SnpStatus, TdxStatus, GuestIsolationTypes

## If the install boot-loops

Evidence gathered offline, in order:

  sudo ./diagnose-windows.sh    # dumps, Setup logs, did the install finish
  sudo ./diagnose-oobe.sh       # OOBE log + the Setup key from the SYSTEM hive
  sudo ./diagnose-loop.sh       # update-rollback markers vs hard-reset evidence
  sudo ./fix-boot-loop.sh       # dry run; add --apply to act

What the first pass found here: the install completed (ChildCompletion
setup.exe/oobeldr.exe/SetupFinalTasks all 3, GeneralizationState 7), there is
no crash dump anywhere, and OOBE ran to `Detected Reboot Required after ZDP
install`. Setup enabled VBS (`EnableVirtualizationBasedSecurity=1`, HVCI
`Enabled=1`) and the BCD sets neither `hypervisorlaunchtype` nor
`vsmlaunchtype`, so both default to Auto and the Microsoft hypervisor launches
every boot -- while SEV-SNP is active in firmware, the RMP is enforcing, and
`Control\Hypervisor` does not exist so the SNP-host path is off. A triple
fault there resets the machine with no BSOD and no dump, which matches the
missing dumps exactly.

`fix-boot-loop.sh --apply` turns VBS and HVCI off and sets
`CrashControl\AutoReboot=0` so a bugcheck stays on screen. It backs the hive
up first and prints the `--restore` command.

Note the hive may be dirty (Windows was reset before flushing). Replay of
SYSTEM.LOG1/LOG2 cannot corrupt an in-place edit -- it writes back whole pages
of the original -- but it can silently revert one, so a value that reads back
as 1 after a boot attempt just needs the edit repeating.

## Undo

`shrink-vm.sh` only shrinks; to give the space back, delete the Windows
partitions and run the same three resizes in reverse (partition, then
`cryptsetup resize cryptvm` with no `--size`, then `resize2fs` with no size).
