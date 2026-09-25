# Can the OpenHCL UEFI path on nucbox-k11 exclude the Windows host? — **NO**

**Verdict: NO-GO for host exclusion on this hardware. The UEFI path is an integration prototype.**
It is a real and useful one — it boots, it has a live control channel, and it exercises the whole
manager/node/relay stack — but it cannot deny the ordinary Windows host kernel or the VM worker
access to app memory or keys, and no software change to our stack can make it.

Dated 2026-09-25. Sources are the pinned openvmm checkout at `a7b0bd4` and measurements on the box.

## The primitive that would be required

Host exclusion means the root partition (Windows, `vmwp.exe`, the kernel) **cannot read guest
memory**. The only mechanism that provides this is **hardware memory encryption with integrity**:
AMD SEV-SNP, Intel TDX, or ARM CCA. Everything else is access control administered by software the
host itself controls.

## What the pinned source says

`openhcl/hcl/src/ioctl.rs:1411` and `vmm_core/virt/src/generic.rs:149`, identically:

```rust
/// Returns whether the isolation type is hardware-backed.
pub fn is_hardware_isolated(&self) -> bool {
    matches!(self, Self::Snp | Self::Tdx | Self::Cca)
}
```

The isolation enum is `None, Vbs, Snp, Tdx, Cca`. **`Vbs` is deliberately excluded from
`is_hardware_isolated`.** Page-visibility control — the thing that decides what the host may map —
lives in `openhcl/openhcl_boot/src/arch/x86_64/snp.rs:493`, `change_page_visibility(host_visible)`:
it is SNP-specific, not a general facility.

`vmm_core/virt_whp/src/lib.rs:885` accepts `IsolationType::None | IsolationType::Vbs` for the
**host-side** VMM (Windows Hypervisor Platform). A host-side VMM driving the partition is a host-side
VMM that can reach it.

## What VTLs actually separate, which is the easy thing to get wrong

`Guide/src/reference/architecture/openhcl.md:20-30`:

> OpenHCL relies on Virtual Trust Levels (VTLs) to establish a security boundary **between itself and
> the guest OS**.
> - **VTL2:** OpenHCL runs here. It has higher privileges and is isolated from VTL0.
> - **VTL0:** The Guest OS runs here. **It cannot access VTL2 memory or resources.**

That is the **guest-to-paravisor** boundary, inside one partition. It says nothing about the root
partition, which is a *different partition*. VSM ranks privilege **within** a partition; it is not a
mechanism for hiding a child partition from its host.

The same document puts host exclusion only under Confidential Computing:

> In Confidential VMs (CVMs), **the host is not trusted**. OpenHCL runs inside the **encrypted** VM
> context (VTL2)...

The word doing the work is *encrypted*.

## What this box can actually do — measured, not inferred

CPU: **AMD Ryzen 9 8945HS** (Family 19h, client APU). SEV-SNP is an EPYC server feature.

A bounded capability probe, one VM created and removed per type, no firmware setting:

| `-GuestStateIsolationType` | create | start |
|---|---|---|
| **SNP** | **REFUSED: "The operation failed."** | — |
| **TDX** | **REFUSED: "The operation failed."** | — |
| `VBS` (type 1) | created, `GuestStateIsolationEnabled=True` | starts |
| `OpenHCL` (type 16) | created | starts with our IGVM |
| `TrustedLaunch` (type 0) | created | starts |

**The hardware primitive is absent, and the host refuses even to define a VM that would need it.**

Our own guest agrees, unprompted, on every boot:

```
MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no
MON ready control_port=9000 snp=false
```

## The three boundaries, kept apart

| boundary | status on this configuration | enforced by |
|---|---|---|
| **app ↔ app** | **real.** Each app is a separate VM with its own address space. | the hypervisor's partition separation |
| **guest VTL0 ↔ paravisor VTL2** | **real**, per the architecture doc. | VSM/VTL ranking within the partition |
| **physical host ↔ guest** | **ABSENT.** | would need SNP/TDX/CCA; neither exists here |

The first two are genuine and worth having. Neither is the promise "the host cannot read your app".

## Identity, and why it is weaker than it looks

Our own `UEFI-BOOT.md` already states it: all identity on this path is **launcher-signed**. The
launcher runs in the root partition. So a client verifying an attestation from this path is trusting
the host that could also read the memory — the signature attests what the launcher observed, not
something the host was unable to forge. There is no hardware root of trust in the chain: no vTPM (we
deliberately add none, because nothing reads its PCRs), and no SNP report.

Secure Boot is irrelevant to this question and must not be offered as an answer: it constrains what
the guest *boots*, not what the host may *read*. We run with it OFF, since the UKI is unsigned.

## Go / no-go

- **NO-GO** for advertising host exclusion, verified capacity or confidential computing on this
  configuration, on this machine, by any software change.
- **GO** for the UEFI path as an **integration prototype**: it is the only shape that boots here
  (linux-direct does not, for Microsoft's own image as much as ours), and it exercises the real
  manager, node, bridge, relay and guest-held TLS end to end. That work is not wasted — it is the
  same stack any future hardware-isolated backend would need.

## What would change the answer

1. **SEV-SNP hardware** (EPYC) or **TDX hardware**. Then `GuestStateIsolationType SNP`/`TDX` become
   creatable, memory is encrypted, and an SNP report gives a client-verifiable identity rooted in AMD
   rather than in our launcher. This is the Linux SNP tier's existing architecture.
2. Nothing else. There is no documented transition from VBS-backed VTL separation to root-partition
   exclusion, because that is not what VSM is for.

## Exact unknowns, stated rather than smoothed

- Whether any **future** Windows build exposes a root-exclusion mode for non-hardware-isolated
  partitions. Nothing in the pinned source or the guide suggests one, and `is_hardware_isolated` is
  a deliberate, load-bearing distinction — but "not in this source" is not "never".
- Whether this **specific** Ryzen supports SEV (not SNP) in some form the host does not surface. It
  would not help: SEV without SNP lacks the integrity/RMP guarantees, and Hyper-V refuses the type.
- We have **not** empirically demonstrated the host reading guest memory. It is not needed for the
  verdict and was not run: the source is explicit and the capability probe is conclusive. If an
  empirical demonstration is wanted, the bounded form is reading our OWN probe VM's memory through a
  documented API — never a bypass, and never against a customer app.
