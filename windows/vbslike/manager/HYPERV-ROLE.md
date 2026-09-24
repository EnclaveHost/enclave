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

- **Recovery is automatic, and takes about 15 minutes for the full set.** Measured today: after the
  operator key was funded the node claimed all five within a minute and four were answering, but the
  RISC Box needed a further 13 minutes to restore its 21.8 GiB guest before its endpoint answered.
  Quoting "about a minute" describes four apps out of five; the interruption to plan around is ~15
  minutes.
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

Then, and only then, the adapter's own preflight, through the code that will use the answers. The
environment is set FIRST, because the launcher refuses to be constructed without the image and its
hash, and the manager is started in the BACKGROUND, because it does not return:

```powershell
cd C:\Users\claude\vbs\manager
$env:ENCLAVE_GUEST_IGVM        = 'C:\Users\claude\vbs-like\openhcl-ownguest.bin'
$env:ENCLAVE_GUEST_IGVM_SHA256 = '2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3'
$env:ENCLAVE_CID_FETCHER       = 'C:\Users\claude\vbs\node\fetch-cid.py'

# 1. what the host has, and what this prefix already owns
node -e "const {WmiHyperVLauncher}=await import('./wmi-launcher.mjs');const {powershellRunner}=await import('./psrun.mjs');const l=new WmiHyperVLauncher({run:powershellRunner(),imagePath:process.env.ENCLAVE_GUEST_IGVM,imageSha256:process.env.ENCLAVE_GUEST_IGVM_SHA256});console.log(JSON.stringify(await l.preflight()));console.log(JSON.stringify(await l.verifyImage()));console.log(JSON.stringify(await l.survey()))" --input-type=module

# 2. the manager, in the background, with its output kept
Start-Process node -ArgumentList 'main.mjs' -RedirectStandardOutput winmgr.out -RedirectStandardError winmgr.err -WindowStyle Hidden
Start-Sleep -Seconds 3
curl.exe -s http://127.0.0.1:8091/health
Get-Content winmgr.out -Tail 5
```

`preflight` must be `"ok":true` with every check passing, `verifyImage` must return the expected
sha256, and `survey` must list no VMs. `/health` must read `"canStart":true`.

**What that proves, and what it does not.** All of it establishes that the host can be ASKED to run
a partition. None of it is a domain running, and none of it is an app serving. The order after that
is: a partition that starts, then a guest that produces console output, then - and this does not
exist yet on this backend - an app-readiness handshake. The manager reports `guest-booted` for the
middle one and will not say `running` without the last.

## Recovery, if the box does not come back cleanly

```powershell
# from another machine, once ZeroTier is up:  ssh minipc-zt
Get-ScheduledTask EnclaveWindowsNode | Select-Object State      # Running?
schtasks /run /tn EnclaveWindowsNode                            # if it is not
Get-Process node,ee-host,shielded-worker | Select-Object Name,Id,StartTime
Get-Content C:\Users\claude\vbs\node\agent.log -Tail 40      # claims and renewals
```

and from here, the fleet's own view:

```bash
curl -s https://api.enclave.host/enclaves | python3 -c "import sys,json;d=json.load(sys.stdin);[print(e.get('serving'),e.get('eligible'),(e.get('availability') or {}).get('claimEnabled'),((e.get('availability') or {}).get('apps') or {}).get('running')) for e in d['enclaves'] if e.get('name')=='nucbox-k11']"
curl -s -o /dev/null -w "%{http_code}\n" https://ipfs.enclave.host/site-root
```

If a lease lapsed while the box was down, `renew` reverts and the node re-claims on its own; the
operator key holds enough gas for that. If ZeroTier does not come back, there is no remote path and
recovery is physical.

## What this does not decide

Whether the crash in `vmchipset.dll` on every isolated-partition start is related. It might be
resolved by the role, or be independent of it. Enabling the role is justified by the launcher
needing `root\virtualization\v2`, not by a prediction about that crash, and I am not making one.
