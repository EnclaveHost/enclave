# Enabling the Hyper-V role on nucbox-k11 — a procedure to review, not to run

The supported way to give a VM a custom IGVM is WMI on the Hyper-V role: `wmi-launcher.mjs`
implements it, against Microsoft's own `openhcl/Set-OpenHCL-HyperV-VM.ps1`. The adapter is written
and tested. What it cannot do on this box is run, because the role is absent.

This is the exact change that would let it run. **Nothing here has been executed.** It needs
Steven's approval and one planned reboot.

## First: is this edition and build even eligible?

Checked, because a procedure that assumes the SKU is a wasted reboot.

| | |
|---|---|
| edition | `Professional` — **Windows 11 Pro**, which supports Hyper-V (Home does not) |
| build | 26200.9457, 25H2 |
| hypervisor | `HypervisorPresent: True` **already** — VBS runs on it today |

No edition or build blocker. The hypervisor is already loaded, so this adds the role's services and
management on top of a hypervisor that is running, rather than turning virtualization on from cold.

## The three features, and what they are now

| feature | now | why it is needed |
|---|---|---|
| `Microsoft-Hyper-V-Hypervisor` | `Disabled` | the role's hypervisor component |
| `Microsoft-Hyper-V-Services` | `Disabled` | installs **`vmms`**, which owns `root\virtualization\v2` — the namespace the firmware pin is written through |
| `Microsoft-Hyper-V-Management-PowerShell` | `Disabled` | `Get-VM` / `New-VM`, which create and own the VM |

Services now: `vmms` **NOT INSTALLED**, `vmcompute` Running, `hvhost` Running.
`VirtualMachinePlatform` is `Enabled` and **must stay enabled** — the existing enclave node depends
on it. Nothing in this procedure disables it.

## Enabling, without letting Windows restart on its own

```powershell
Enable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Hypervisor
Enable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Services
Enable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Management-PowerShell
```

`-NoRestart` on every one: the reboot is a separate, deliberate step, not something the last command
decides. Expect each to report `RestartNeeded: True`.

## Before touching anything

1. **The node's state and logs.** `C:\Users\claude\vbs\node\host-state.json` and `agent.log` — copy
   both. The incident log `agent-incident-20260923-24.log` is already preserved on the box and must
   not be deleted; note that the repository's `*.log` ignore rule would silently drop it if anyone
   tried to archive it by committing it.
2. **App data is not on this box.** The five deployments keep their durable state in their own S3
   and R2 buckets, so a reboot does not risk it. Nothing here deletes anything.
3. **No VMs to back up.** `Get-VM` does not exist and no Hyper-V VMs exist; the lab partitions are
   transient HCS compute systems, created and destroyed per probe. There is nothing to export.
4. **Record the before state**: the feature table above, `vmms` absent, and the current five
   running deployments with their lease end times.

## What breaks, and for how long

**The five apps stop.** A reboot stops the node, the enclave, the shielded worker and every app:
`0xe64f7cba` (RISC Box), `0x7ae476a3` (the IPFS gateway behind `ipfs.enclave.host`), `0xd9798e4c`,
`0xa77d0c57` (jot) and `0xa69dcbba` (the MCP adapter).

- **Recovery is automatic and was measured today.** After the operator key was funded, the node
  claimed all five and had them serving inside a minute, and the RISC Box took a further 13 minutes
  to restore its 21.8 GiB guest.
- **The lease is the risk.** Leases run in 30-minute quanta. If the box is down past a lease's end,
  `renew` reverts and only a fresh `claim` recovers it — which costs gas. The operator holds
  ~0.0019 ETH, enough for many claims, so this is a delay rather than a wall. **Do it just after a
  renewal**, not just before one.
- **`ipfs.enclave.host` goes with it**, which is the site's publishing path. A site deploy during
  the window would publish but the in-enclave IPNS publisher could not see the new root.

## The access risk, stated plainly

Remote access to this box is `ssh minipc-zt` over ZeroTier. The LAN name did not answer today
(`No route to host`). **If ZeroTier does not come back after the reboot, this session loses the box
entirely** and recovery is physical. That is the single largest risk in this procedure and it is
why the reboot must be planned rather than incidental. Steven should be at the machine, or content
to be.

## After the reboot: verify in this order

```powershell
Get-Service vmms, vmcompute, hvhost | Select-Object Name, Status          # vmms must now exist and run
Get-CimClass -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
(Get-CimClass -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData).CimClassProperties.Name -contains 'FirmwareFile'
Get-Command Get-VM
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform    # must still be Enabled
```

Then, and only then, the adapter's own preflight, which asks the same questions and reports them:

```
node -e "import('./windows/vbslike/manager/wmi-launcher.mjs').then(async m => { ... })"
```

And the node itself: the scheduled task Running, the enclave answering, the five deployments
re-claimed, `ipfs.enclave.host/site-root` serving, and the shielded worker's card still present —
the GPU path is the thing most likely to behave differently under the full role, and it is worth
checking rather than assuming.

## Rolling back

```powershell
Disable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Management-PowerShell
Disable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Services
Disable-WindowsOptionalFeature -Online -NoRestart -FeatureName Microsoft-Hyper-V-Hypervisor
```

then a second reboot. Two implications worth saying out loud:

1. **Rollback costs another reboot and another outage.** It is not free and not instant, so the
   decision to enable should be taken as though it were one-way for the day.
2. **Enabling the role changes the host partition's relationship to the hypervisor.** VBS already
   runs here, so the hypervisor is not new, but the root partition under the full role is not
   identical to the root partition under Virtualization Machine Platform alone. The enclave, the
   shielded Vulkan worker and the existing HCS lab path are all things to re-verify rather than
   assume, and any of them regressing is a reason to roll back.

## What this does not decide

Whether the crash in `vmchipset.dll` on every isolated-partition start is related. It might be
resolved by the role, or be independent of it. Enabling the role is justified by the launcher
needing `root\virtualization\v2`, not by a prediction about that crash, and I am not making one.
