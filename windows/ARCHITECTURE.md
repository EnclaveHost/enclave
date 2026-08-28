# Enclave on Windows: the confidential half via Hyper-V

Research conclusion, 2026-08-28. This documents a path that appears viable on
Windows **today**, the evidence for it, and the two things that remain unproven.

## The shape

```
Windows 11 / Server 2025, BARE METAL, on EPYC Milan+ (or TDX Xeon)
  |
  |-- the game                              the user's desktop, untouched
  |-- shielded-worker.exe                   native CUDA, holds the card,
  |                                         shares it with the game via the
  |                                         ordinary NVIDIA driver time-slice
  |-- tray icon + VRAM slider + wallet
  |
  `-- Hyper-V VM, IsolationType = SNP, HclEnabled = false
        `-- the metal Linux guest: supervisor + wasm-manager + agent
              ^
              |  AF_VSOCK (hv_sock transport) <-> AF_HYPERV
```

No dual boot. Windows is never virtualised. The GPU is never passed through.
The card stays on the host **on purpose**: it is outside the trust boundary by
design, so the gamer, the game, and Windows itself are all already the declared
adversary. Only the trusted half needs the hardware root of trust, and that is
what the SNP VM provides.

## Why this is the only door on Windows

Windows cannot launch an SNP guest the way `metal/` does on Linux: QEMU's
Windows accelerator (WHPX) exposes no confidential-guest launch, and a driver
cannot outrank the hypervisor that already owns SVM. Hyper-V's own isolation
type is the only mechanism. Everything below is about whether that mechanism is
reachable and whether it preserves the trust story.

## The HCS document maps onto metal's QEMU argv

Both halves live in the same Host Compute System schema
(`github.com/Microsoft/hcsshim/internal/hcs/schema2`, open source). This is what
hcsshim actually emits for an SNP-isolated Linux utility VM
(`internal/uvm/create_lcow.go`, `makeLCOWSecurityDoc`):

```go
doc.VirtualMachine.SecuritySettings = &hcsschema.SecuritySettings{
    EnableTpm: false,
    Isolation: &hcsschema.IsolationSettings{
        IsolationType: "SecureNestedPaging",
        LaunchData:    hostData,      // base64(digest) -> SNP_LAUNCH_FINISH
        HclEnabled:    opts.HclEnabled,
    },
}
```

Against `metal/enclave-metal.mjs`:

| metal (QEMU + KVM) | Hyper-V (HCS) |
|---|---|
| `-object sev-snp-guest,...` | `IsolationSettings.IsolationType = "SecureNestedPaging"` |
| `host-data=<sha256(volume table)>` | `IsolationSettings.LaunchData` (base64; lands in `SNP_LAUNCH_FINISH`, same 32 bytes, same purpose) |
| direct-boot measured OVMF, `kernel-hashes=on` | `HclEnabled = false` -- fully enlightened, guest at VMPL 0, no paravisor |
| `-kernel vmlinuz -initrd initramfs.cpio.gz -append <cmdline>` | a **VMGS file** carrying kernel + initrd, via `GuestState.GuestStateFilePath` |

**Correction worth recording:** the obvious guess -- reuse
`Chipset.LinuxKernelDirect{KernelFilePath, InitRdPath, KernelCmdLine}`, the
mechanism Linux Containers on Windows already direct-boot with -- is wrong under
isolation. hcsshim gates on `opts.GuestStateFilePath != ""`, and the SNP document
builder sets `GuestState.GuestStateFilePath` and configures **no**
`LinuxKernelDirect` at all. Under SNP the kernel and initrd travel inside the
VMGS. `LinuxKernelDirect` is the non-isolated path only.

That is a packaging difference, not an architectural one, and the packaging
tools are open source.

## The toolchain, end to end

Every step has a public, open-source tool:

| step | tool | notes |
|---|---|---|
| bundle kernel + initrd + cmdline into an IGVM | `buildigvm`, `microsoft/igvm-tooling`, or OpenVMM's tooling | IGVM is an open Microsoft format; one file can declare SEV-SNP, TDX and non-confidential platforms |
| write that IGVM into a VMGS | **`VmgsTool`** (in `microsoft/openvmm`) | writes FileId 8 (`GUEST_FIRMWARE`); resource codes include `NONCONFIDENTIAL`, `SNP`, `TDX`, **`SNP_NO_HCL`**, `TDX_NO_HCL` |
| launch it | hcsshim, or P/Invoke to `vmcompute.dll` | `SecureNestedPaging` + `HclEnabled: false` + `GuestStateFilePath` |
| compute the expected measurement independently | **`sev-snp-measure`** (virtee) or `igvmmeasure` | `sev-snp-measure` is the same tool `metal/PROTOCOL.md` already names, and takes ovmf + kernel + initrd + append |
| read the quote in-guest | configfs-tsm / `/dev/sev-guest` | what `metal/guest/agent.mjs` already does |

`SNP_NO_HCL` is the detail that matters most. It is an explicitly named resource
code in Microsoft's own tooling, which means paravisor-free SNP is a supported
configuration rather than an inference from a kernel doc.

## Why `HclEnabled = false` is the load-bearing field

Hyper-V runs SNP guests two ways, per the Linux kernel's own documentation
(`Documentation/virt/hyperv/coco.rst`):

> Hyper-V provides two modes for running SEV-SNP VMs: 1) In vTOM mode with a
> paravisor, and 2) In "fully enlightened" mode with normal "C" bit control over
> page encryption, and no paravisor.

> With AMD SEV-SNP processors, in fully-enlightened mode the guest OS runs in
> VMPL 0 and has full control of the guest context.

This matters enormously for **this** platform, because `metal/PROTOCOL.md`'s
measurement allowlist is only worth something if anyone can independently
recompute a release's launch digest. In **vTOM/paravisor mode** the measurement
covers Microsoft's Hardware Compatibility Layer and guest firmware; the SoK on
CVM trust relationships (arXiv 2503.08256) puts it plainly: *"The measurement
cannot be attested, as the HCL and guest firmware are closed source and
therefore not reproducible."* That would reduce the allowlist to "trust
Microsoft's binaries" and break the auditability property.

In **fully enlightened mode** there is no paravisor in the picture, the guest
owns VMPL 0, and Hyper-V direct-boots the kernel — the kernel documentation
notes it "uses Linux direct boot mode to boot up Linux kernel and so it needs to
pvalidate system memory by itself." That is the same measurement shape metal
already relies on.

Cost of fully-enlightened mode: the guest must implement SEV-SNP **Restricted
Interrupt Injection**, and the Hyper-V-specific enlightenments must be built
into the kernel. That is a `metal/build-image.mjs` kernel-config change, not a
design change.

## IGVM: the packaging format that makes the measurement reproducible

[IGVM](https://github.com/microsoft/igvm) (Independent Guest Virtual Machine) is
a Microsoft-originated **open** format bundling firmware, kernel and initrd into
one file whose launch measurement is computable **when the file is built**. The
`igvmmeasure` tool computes SEV-SNP measurements from an IGVM file — the direct
analogue of the `sev-snp-measure` that metal's allowlist depends on. QEMU
consumes IGVM for SEV/SEV-ES/SEV-SNP; Cloud Hypervisor consumes it via MSHV;
edk2 gained IGVM output in January 2026. One IGVM file can declare support for
SEV-SNP, TDX **and** non-confidential hosts.

That is the packaging answer: build the metal guest once as an IGVM, compute its
measurement at build time, run it on QEMU/KVM on Linux *and* Hyper-V on Windows,
and keep one auditable allowlist across both.

## Transport

The metal guest already speaks `AF_VSOCK`
(`wasm/ggml-shielded/shielded-wire.c`), and Linux carries an `hv_sock`
transport that backs `AF_VSOCK` over Hyper-V's VMBus. The Windows host side is
`AF_HYPERV`. So the guest half of the shielded link may need close to no change;
the worker's socket layer is what gets ported.

## Two paths, and the trade between them

Research surfaced two distinct ways to get an SNP boundary on a Windows host.
They differ in exactly one property -- and it is the property this platform
sells.

### Path A -- our own VMGS, fully enlightened (`SNP_NO_HCL`)

Package metal's kernel + initrd into an IGVM, write it to a VMGS with
`VmgsTool` using resource code `SNP_NO_HCL`, launch through HCS with
`SecureNestedPaging` + `HclEnabled: false`. No paravisor, guest at VMPL 0,
measurement computable up front with `sev-snp-measure` -- the same tool
`PROTOCOL.md` already names.

**Keeps the whole trust story.** The allowlist stays auditable: anyone rebuilds
the release, recomputes the digest, and compares. No unmeasured byte we did not
build.

**RESOLVED -- Hyper-V will load a custom, unsigned firmware image.** Microsoft's
own OpenVMM guide documents the procedure, on Windows 11 **client**:

```powershell
# once per system, elevated -- permits unsigned firmware images
Set-ItemProperty "HKLM:/Software/Microsoft/Windows NT/CurrentVersion/Virtualization" `
  -Name "AllowFirmwareLoadFromFile" -Value 1 -Type DWORD

$vm = New-VM $VmName -generation 2 -GuestStateIsolationType OpenHCL -VHDPath $vmOsDisk -BootDevice VHD
Set-VM -VM $vm -AutomaticCheckpointsEnabled $false
Set-VMFirmware -VM $vm -EnableSecureBoot Off

# point the VM at OUR IGVM
Set-OpenHCLFirmware -Vm $vm -IgvmFile $firmwareFile
```

Three things this establishes:

- **`Set-OpenHCLFirmware -IgvmFile`** is the cmdlet that hands Hyper-V a custom
  IGVM. `Set-VMFirmware` has no such parameter, which is why the earlier search
  came up empty -- it is a separate cmdlet.
- **`OpenHCL` is a sixth `-GuestStateIsolationType` value**, absent from the
  `New-VM` reference page, which lists only TrustedLaunch/VBS/SNP/TDX/Disabled.
  The documented values are not the complete set.
- **Windows 11 24H2 (build 26100.1586) or later, client SKU** is the floor. A
  gaming rig on Windows 11 qualifies; Server is not required.

**The caveat, stated by Microsoft and worth taking seriously:** "Windows Client
and Server offer only **development support -- not production support** -- for
OpenHCL workloads." It works and it is documented, but it is not a supported
production configuration, so it can change across Windows updates. For a seller
node that ships to other people's machines, that is a real operational risk to
plan for (pin the build, detect breakage, fail closed), not a reason the
architecture is wrong.

### Path B -- Confidential-ACI style: Microsoft's UVM, our workload

The shipping alternative. Microsoft's signed UVM provides the SNP boundary; our
code runs inside it; a **security policy** (Rego) pins exactly what may run, and
`SHA256(policy)` goes into `LaunchData` -> `HOST_DATA` in every attestation
report. A verifier checks the SNP report against AMD's certificates, matches the
launch measurement against Microsoft's COSE_Sign1 UVM endorsement
(`feed: "ContainerPlat-AMD-UVM"`), and checks HOST_DATA against the expected
policy hash.

**This demonstrably works on a standalone on-premises Windows host.** The
Confidential Container Groups paper (ACM Queue / CACM, by the team that built
Confidential ACI) describes a lab environment of a **Dell PowerEdge R7515 with an
AMD EPYC 7543P, running Windows Server 2022 Datacenter (22H2)** and an *offline*
copy of the ACI platform (containerd, cri, hcsshim), with the UVM running a
patched 5.15 Linux carrying the AMD and Microsoft SEV-SNP enlightenment patches.
Not Azure. Not Azure Local. A server in a lab.

**What it costs us**, stated plainly by Microsoft's own scheme documentation:
the UVM measurement *cannot be independently reproduced by third parties* -- it
must match Microsoft's signed reference-info, making that link **trust-based
rather than reproducible**.

### The trade

Both paths give a genuine hardware root of trust: AMD SNP memory encryption, so
the Windows host cannot read guest RAM. That is the seller-facing requirement and
both satisfy it.

They differ on the **tenant-facing** claim. metal's pitch, and this repo's
README, is that the chain verifies "from the CPU's attestation quote down to the
exact commit of this repo that built the running image." Path A preserves that.
Path B replaces one link with "and Microsoft says this UVM measurement is
theirs" -- still hardware-rooted, still far better than nothing, but no longer
end-to-end reproducible. Whether that is acceptable is a positioning decision,
not an engineering one, and it should be made deliberately rather than
discovered later by a verifier.

## What is proven, and what is not

**Proven from primary sources:**

- `New-VM -GuestStateIsolationType` accepts `SNP` and `TDX` in the shipping
  Windows Server 2025 Hyper-V module (Microsoft Learn, `New-VM` reference).
- Azure Local 2607 (July 2026, build 12.2607.1003.73) ships Confidential VMs in
  public preview "powered by AMD SEV-SNP technology" on OS build 26100 — the
  same branch as Windows Server 2025 and Windows 11 24H2.
- Fully-enlightened, paravisor-free SNP guests on Hyper-V are documented in the
  mainline Linux kernel, with direct kernel boot.
- hcsshim ALREADY builds SNP-isolated Linux utility VMs: `IsolationType:
  "SecureNestedPaging"` with `LaunchData` and `HclEnabled` is shipping,
  open-source, exercised code -- it is the mechanism behind Azure Confidential
  Containers on ACI.
- `VmgsTool` in `microsoft/openvmm` writes an IGVM into a VMGS with resource
  code **`SNP_NO_HCL`**, so paravisor-free SNP is a named, supported
  configuration in Microsoft's own tooling, not an inference.
- `sev-snp-measure` -- the exact tool `metal/PROTOCOL.md` relies on -- computes
  the measurement from ovmf + kernel + initrd + append, so the independent
  verification step carries over unchanged.
- GPU partitioning (GPU-PV) shares a physical GPU between host and guests with
  **no GPU generation restriction** — so a consumer GeForce qualifies. This
  design does not require it, but it removes the "passthrough is exclusive"
  objection permanently.
- SNP attestation from Hyper-V guests is an established path (Google's
  `go-sev-guest` carries a platform flag for it).

**NOT proven, and decisive:**

1. **Does retail Windows actually honour it?** No public first-hand report of
   `IsolationType: SNP` launching on a non-Azure-Local Hyper-V host was found.
   Microsoft has historically gated this. `probe/Test-EnclaveHost.ps1 -Attempt`
   is written to answer exactly this on real hardware.
2. **Is `HclEnabled = false` reachable from a retail host?** The field is in the
   schema; whether the platform permits a fully-enlightened SNP guest outside
   Azure is unknown. If only vTOM mode is available, confidentiality still holds
   (the Windows host genuinely cannot read guest RAM) but reproducible
   measurement does not, and the allowlist model needs rethinking.
3. **Will a retail host accept OUR VMGS?** hcsshim's SNP path takes a VMGS via
   `GuestStateFilePath`, and `VmgsTool` builds one, but every shipped example
   carries a Microsoft-built UVM. Whether the platform validates the guest
   firmware against a Microsoft signature (ACI ships a COSE_Sign1
   `reference-info` signed by Microsoft carrying the expected UVM measurement)
   or will launch an arbitrary VMGS is the question that decides whether this is
   a product or a dead end. `Set-VMFirmware` exposes no IGVM path, so the
   launcher drives HCS directly (hcsshim, or P/Invoke to `vmcompute.dll`)
   regardless.

## The build pipeline, concretely

Every step is a public tool. Nothing here needs a Microsoft signature or an
Azure subscription.

```sh
# 1. Build the guest image exactly as metal does today (unchanged).
node metal/build-image.mjs --supervisor ghcr.io/...@sha256:... --wasm ghcr.io/...@sha256:...
#    -> metal/dist/{vmlinuz, initramfs.cpio.gz, cmdline, manifest.json}

# 2. Package it as an IGVM. OpenVMM ships a confidential recipe (x64-cvm) and a
#    Linux-direct recipe; --custom-kernel and --override-manifest carry our
#    kernel and our cmdline / VTL0 boot configuration.
cargo xflowey build-igvm x64-cvm \
    --custom-kernel metal/dist/vmlinuz \
    --override-manifest enclave-vtl0.json
#    -> flowey-out/artifacts/build-igvm/release/x64-cvm/openhcl-x64-cvm.bin

# 3. Compute the launch measurement OFFLINE, so the allowlist stays auditable.
igvmmeasure openhcl-x64-cvm.bin          # or sev-snp-measure, as PROTOCOL.md already uses
```

Then on the Windows host, once per system:

```powershell
Set-ItemProperty "HKLM:/Software/Microsoft/Windows NT/CurrentVersion/Virtualization" `
  -Name "AllowFirmwareLoadFromFile" -Value 1 -Type DWORD
```

and per launch:

```powershell
$vm = New-VM $Name -Generation 2 -GuestStateIsolationType OpenHCL -NoVHD
Set-VM -VM $vm -AutomaticCheckpointsEnabled $false
Set-VMFirmware -VM $vm -EnableSecureBoot Off
Set-OpenHCLFirmware -Vm $vm -IgvmFile openhcl-x64-cvm.bin
Start-VM $vm
```

Notes that matter:

- **metal's existing `vmlinuz` is fine.** x86_64 Linux Direct accepts both an
  uncompressed ELF `vmlinux` and a compressed `bzImage`/`vmlinuz`; the loader
  places the protected-mode code and lets the kernel's own decompressor run.
- **`x64-cvm` is the confidential recipe.** `cargo xflowey build-igvm --help`
  enumerates the full recipe list, including the Linux-direct variants.
- **OpenHCL is open source**, so if the paravisor ends up inside the
  measurement, that measurement is still reproducible -- which is precisely the
  gap the CVM trust SoK complained about when the HCL was closed. Being able to
  rebuild OpenHCL is what makes the paravisor-mode option acceptable at all, and
  it is why `SNP_NO_HCL` is a preference rather than a hard requirement.

## Windows-specific risks on the GPU half

Two things behave differently on Windows than on the Linux box the tier was
measured on, and both hit the headline feature ("sell part of the card while I
play").

### 1. Coarse-grained preemption means the GAME may stutter

On Linux the known failure was the worker being starved: a game on metal0's 3070
took most of the time slices and the masked path went 152 -> 1240 us per
exchange, dropping the tenant from ~95 to 15 tok/s. `host-setup.sh` addresses it
with `nvidia-smi compute-policy --set-timeslice=1` (SHORT).

Windows adds the *reverse* risk. Under WDDM, preemption is coarse: executing
blocks are preempted at a granularity where the whole GPU yields to the
preempting task. Background compute competing with a fullscreen game can
therefore show up as **frame hitching in the game**, which the seller
experiences directly and will not tolerate. And `nvidia-smi compute-policy` is
a compute-mode control whose availability under WDDM is unconfirmed -- the
Linux mitigation may simply not exist here.

Implications for the product, not just the port:

- The slider needs a companion control, something like **"pause selling while a
  game is running."** The daemon can detect fullscreen-exclusive presentation
  and stop accepting new tenant reservations, letting existing links drain.
  Without that, the first stutter makes the seller uninstall.
- Lower-priority CUDA streams (`cudaStreamCreateWithPriority`) are worth
  measuring but are not a substitute: priority influences scheduling, it does
  not bound the preemption granularity.
- The fleet-facing half already copes. The worker re-measures
  `field_gmac_per_s` on every HELLO, and `gsup` marks the card `contended` when
  it answers under half its best figure, at which point tenants fall back to the
  enclave's CPU. So the network already degrades honestly while someone games;
  what is missing is the *seller-facing* half of the same fact.

### 2. VRAM accounting is not the driver's to report under WDDM

In WDDM mode the **Windows kernel-mode display driver manages GPU memory, not
the NVIDIA driver**, and some `nvidia-smi` memory statistics are unavailable as
a result.

That matters because `vram_free_gb` -- the figure the fleet uses to decide what
this card can still be sold for -- is computed as
`min(budget - reserved, driver free)` (`shieldedCardGb`, protocol 1.3). The
`reserved` half is the worker's own bookkeeping and is unaffected. The
`driver free` half comes from `cudaMemGetInfo`, and under WDDM that number
reflects Windows' allocator rather than the card's true free memory.

Before trusting the slider on Windows, confirm what `cudaMemGetInfo` actually
returns there with a game running, and decide whether the Windows build should
advertise `budget - reserved` alone rather than taking a `min` with a figure
that may be systematically wrong in either direction. Advertising more than the
card can give causes a refused HELLO, which the guest handles (it computes in
the enclave and retries) but which wastes a placement; advertising less silently
costs the seller money.

## The daemon cannot be a plain Windows service (session 0 kills CUDA)

The obvious design -- worker supervised by a Windows Service so it runs without
anyone logged in -- **does not work on a consumer card**, and this is a hard
platform rule rather than a tuning problem:

> Session 0 isolation prevents GPU applications via CUDA, OpenCL or other
> compute frameworks from running as a Windows service. CUDA applications
> cannot run as a service in session 0 if CUDA devices use WDDM.

Services live in session 0, which has no access to display devices, and a
GeForce is WDDM. TCC mode (which would allow it) is not available on GeForce.

### The shape that does work

Split it, which is the documented workaround -- "a service can run in session 0
and launch a provider process in session 1 with access to CUDA devices":

```
Windows Service (session 0)          lifecycle, autostart, updates, config,
  |                                  on-chain identity, the local HTTP API
  |                                  -- NO CUDA in this process
  `-- CreateProcessAsUser(...) -->   shielded-worker.exe in the ACTIVE session
                                     -- holds the card, CUDA works here
```

The service resolves the active console session
(`WTSGetActiveConsoleSessionId` -> `WTSQueryUserToken` -> `DuplicateTokenEx`)
and launches the worker into it. The tray app is per-user and lives in that
session too, so this is consistent rather than contorted.

### What that costs, and it is a real product constraint

**The worker only runs while a user session exists.**

| state | session? | sells? |
|---|---|---|
| logged in, using the PC | yes | yes |
| **screen locked** | yes -- a locked session is still a session | **yes** |
| logged out / no user signed in | no | **no** |
| asleep | no | no |

"Sell compute while I sleep" therefore means *screen locked, machine awake*, not
*signed out*. That is the normal state for a desktop left running overnight, so
the product is fine -- but the onboarding copy must not promise earnings from a
machine the owner signs out of, because it will not deliver them and the seller
will conclude the software is broken.

### Sleep has to be held off deliberately

A sleeping machine sells nothing, so the daemon must call
`SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)` while it is
actively serving, and **clear it with `SetThreadExecutionState(ES_CONTINUOUS)`
the moment it stops**. Holding it indefinitely is the documented anti-pattern:
on a Modern Standby machine it drains the battery flat with the lid closed.

So: assert it only while tenants are actually connected, release it when idle,
and make it a visible setting rather than a silent one -- a seller who finds
their PC never sleeps again, and never learns why, uninstalls.

## What the guest kernel needs (a `build-image.mjs` change)

Fully-enlightened mode is not free on the guest side. Per the kernel
documentation and the Hyper-V SNP enlightenment series (Tianyu Lan, Microsoft,
merged 2023), the guest must:

- **Implement SEV-SNP Restricted Interrupt Injection.** Hyper-V requires it, and
  the reason is the threat model, not tidiness: *"in fully enlightened mode, a
  malicious hypervisor could inject interrupts into the guest OS at times that
  violate x86/x64 architectural rules"* -- e.g. injecting while the guest has
  interrupts disabled. Without it the guest is attackable by the host it is
  supposed to be protected from.
- **Do its own early-boot memory setup.** The kernel docs note that under a
  paravisor "Linux does not perform the early boot memory setup steps that are
  particularly tricky with AMD SEV-SNP" -- which is precisely the work
  fully-enlightened mode hands back to the guest. It pvalidates system memory
  itself.
- **Use `vmmcall` for Hyper-V hypercalls** in SNP-enlightened mode, rather than
  the usual hypercall page.

Concretely that means `CONFIG_AMD_MEM_ENCRYPT` plus the Hyper-V guest
enlightenments, on a kernel new enough to carry the SNP-on-Hyper-V series.

`metal/build-image.mjs` currently builds from a pinned Arch kernel package.
Stock distro kernels generally enable `CONFIG_HYPERV` and
`CONFIG_AMD_MEM_ENCRYPT`, so this may need no more than a version floor -- but
it must be **verified rather than assumed**, because the failure mode is a guest
that boots and looks fine while missing the interrupt-injection hardening that
makes the isolation meaningful. That is exactly the class of silent failure this
whole tier is built to avoid.

Check before building: the pinned kernel's version against the SNP-on-Hyper-V
series, and that `CONFIG_AMD_MEM_ENCRYPT` and the Hyper-V enlightenments are
actually set in the config the reproducible build pins.

## The guest's QEMU dependencies, and what replaces each

`build-image.mjs` bakes a specific module set and a specific config channel,
both of which are QEMU-shaped. Enumerated here because each needs a named
replacement and one of them is a small design decision rather than a swap.

| metal today (QEMU) | on Hyper-V |
|---|---|
| `qemu_fw_cfg.ko` -- out-of-band config | **no equivalent; see below** |
| `virtio_net.ko` + `net_failover.ko` | `hv_netvsc.ko` (VMBus networking) |
| `vmw_vsock_virtio_transport.ko` | `hv_sock.ko` -- backs the same `AF_VSOCK` API over VMBus |
| `tsm_report.ko`, `sev-guest.ko` | unchanged -- this is why attestation carries over |
| `dm-verity` + `dm-mod` (model volumes) | unchanged, but the disk arrives as VMBus storage rather than virtio-blk |
| (VMBus core) | `hv_vmbus.ko` must be added |

The attestation modules being unchanged is the load-bearing row: the guest reads
its SNP report through configfs-tsm either way, so
[`metal/guest/agent.mjs`](../metal/guest/agent.mjs) needs no change to produce
the RAD.

### Replacing fw_cfg is the one real decision

Today the launcher hands the guest its deployment config -- `name`, `relayUrl`,
`tunnelToken`, `registryKey`, `payoutAddress`, the shielded worker's address --
over QEMU **fw_cfg**, deliberately *outside* the measurement. That is what lets
one image have one stable launch measurement no matter which relay or token it
uses, and it is why the measurement allowlist works at all.

Hyper-V has no fw_cfg. Three candidates, and the third is the right one:

1. **`LaunchData`/HOST_DATA** -- wrong tool. It is measured into every report
   and it is 32 bytes. It is the correct home for the model-volume digest (which
   is exactly what metal uses `host-data=` for) and nothing else.
2. **Hyper-V KVP exchange** (`hv_utils`) -- workable, but it is a
   general-purpose host/guest key-value channel with its own daemon, and it
   would mean carrying another service in a deliberately minimal measured image.
3. **Ask the host daemon over `hv_sock` at boot.** The guest already needs
   `hv_sock` for the shielded link. PID 1 opens a second connection to the
   daemon on the host and requests its config.

Option 3 preserves the trust properties **exactly**, which is the point: fw_cfg
is host-controlled and unmeasured, and so is this. The host could lie about the
relay URL or withhold the token in either design, and neither can reach the
launch measurement. Nothing is weakened by the substitution; the channel changes
and the trust boundary does not move.

It also collapses two host-guest channels into one transport, so the Windows
daemon has a single `AF_HYPERV` listener serving both the config request at boot
and the masked exchanges afterwards.

## Implementation plan

Staged so each step produces a decision, not just code.

1. **Probe.** `probe/Test-EnclaveHost.ps1 -Attempt`, elevated, on the EPYC 9115
   + RTX 3070. Confirms build, isolation values, `Set-OpenHCLFirmware`, the
   registry gate, and whether an isolated VM actually creates. Cheap, and it
   grounds everything else.
2. **Boot the existing guest.** Package `metal/dist` into an IGVM, load it with
   `Set-OpenHCLFirmware`, and get a serial console. Success criterion: PID 1
   reaches the point where `metal/guest/init` starts the three services.
3. **Attestation.** Confirm the guest can pull an SNP report through
   configfs-tsm the way `metal/guest/agent.mjs` already does, that
   `report_data` still binds the in-guest TLS key, and that the launch
   measurement matches the one computed offline in step 2. **This is the go/no-go
   for the whole trust story** -- if the measurement is not reproducible here,
   fall back to Path B knowingly, or stop.
4. **Transport.** Host `AF_HYPERV` <-> guest `AF_VSOCK` over `hv_sock`.
   Benchmark at the shielded exchange sizes and compare against the 152 us
   vhost-vsock figure that yields ~100 tok/s on metal0. This sets the tok/s
   ceiling and is worth knowing before the worker port.
5. **Worker port.** `shielded/worker-cuda` to Windows: Winsock2, `WSAPoll` for
   `poll`, `CreateFileMapping` for the `--shm` ring, vsock dropped (the host
   side is `AF_HYPERV`). **The op allowlist and denylist refusals port
   unchanged**, with a test asserting the Windows binary refuses a denylisted op
   on the wire -- that is one of the four boot-probe assertions and the reason
   the tier is safe to run on a machine nobody attested.
6. **Live VRAM budget.** Make `g_vram_budget` adjustable at runtime so the
   slider acts without restarting the worker, clamping a decrease at current
   reservations rather than evicting a paying tenant.
7. **The product.** Daemon, tray, popup with the slider, first-run setup for
   RAM/CPU, wallet (WalletConnect or generated, with the hardware-wallet
   warnings), installer.

Steps 1-3 are research that happens to produce code. Only after step 3 is it
worth building step 7.

## Test order

1. `probe/Test-EnclaveHost.ps1 -Attempt` on the EPYC 9115 + RTX 3070 box.
   Creation succeeding or failing, and the exact error text, decides everything.
2. If creation succeeds: package metal's existing `dist/vmlinuz` +
   `dist/initramfs.cpio.gz` into an IGVM, write it to a VMGS with `VmgsTool`
   (`SNP_NO_HCL`), and drive HCS with `SecureNestedPaging` + `HclEnabled: false`
   + `GuestStateFilePath`. A signature refusal here is the end of the road; an
   ordinary boot failure is just work.
3. If it boots: check whether the guest can read an SNP report through
   configfs-tsm the way `metal/guest/agent.mjs` already does, and compare the
   launch measurement against an independently computed one.
4. Only then: the worker port, the tray, the slider, the wallet.

Note one pre-existing caveat that carries over unchanged: metal0's workstation
EPYC "reports a masked/unprovisioned chip id, so AMD KDS has no VCEK for it and
`verify.mjs` reports the signature chain **inconclusive** (measurement + key
binding still verify)" (`metal/HANDOFF.md`). A datacenter EPYC provisions its
VCEK; a workstation part may not, on Windows or Linux alike.
