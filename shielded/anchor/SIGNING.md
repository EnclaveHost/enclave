# TA signing programs, against the phone anchor

Answers open question 1 of the phone-anchor handoff ("which TA signing program"), and then
the constraint that supersedes it: **the anchor has to work on a Samsung Galaxy S21+.**

Sources are public record and linked. Where the public record is silent, that is marked and
is itself a finding — it means the answer only exists under NDA. Device facts come from the
handset itself ([REPORT.md](REPORT.md) section 0), not from a datasheet.

## The decisive question, first: on-chip SRAM + pager control for a third-party TA

The route the handoff chose rests on TA code, keys and working tiles living in **secure
on-chip SRAM**, with everything else AES-GCM-paged to a TZASC DRAM carveout under
SRAM-resident freshness state. So the gating question is whether any program exposes that
to a third party.

**Publicly unanswered-to-negative on all three, with no known precedent.** Every third-party
TA whose memory layout is publicly documented — Widevine included — executes in a
**TZASC-protected DDR carveout**, not on-chip memory
([Wideshears, Black Hat Asia 2021](https://i.blackhat.com/asia-21/Thursday-Handouts/as-21-Zhao-Wideshears-Investigating-And-Breaking-Widevine-On-QTEE-wp.pdf);
[bits-please on the QSEE carveout](http://bits-please.blogspot.com/2016/04/exploring-qualcomms-secure-execution.html)).
Snapdragon on-chip IMEM is small and reserved for boot/debug/hardware blocks rather than
general TA use (mainline `sm8550.dtsi` / `sm8650.dtsi` describe it as a `syscon` of a few
hundred KB), and the older multi-MB OCMEM is a GPU/camera/video resource. The GlobalPlatform
Internal Core API has no primitive for pinning residency or driving a pager at all.

The structural reason is worth stating once: **pager-style encrypted paging out of on-chip
SRAM is a trusted-OS-core capability, not a TA capability.** OP-TEE demonstrates the exact
pattern — its pager does AES-GCM encrypted paging, and on STM32MP1 the core runs in on-chip
SYSRAM paging out to DRAM ([OP-TEE docs](https://optee.readthedocs.io/en/latest/building/devices/stm32mp1.html))
— but it does so *as the secure OS*. On QTEE, Kinibi and TEEGRIS that machinery belongs to
the vendor, and a TA is a userland process above it.

The one public lever: Trustonic **secure drivers (`drApi`) can map physical memory and handle
interrupts** ([Quarkslab](https://blog.quarkslab.com/a-deep-dive-into-samsungs-trustzone-part-3.html)).
If any program can host this design, it is Kinibi, as a **driver-level** arrangement rather
than a TA.

> **Consequence: SRAM-anchored software memory encryption is not available off the shelf from
> any of the three. It is a bespoke partnership ask everywhere.**

## The three programs

| | QTEE (Qualcomm) | Kinibi (Trustonic) | TEEGRIS (Samsung) |
|---|---|---|---|
| **Who signs a retail TA** | the **device OEM's** fused root of trust — so an OEM relationship, not merely a Qualcomm one ([Check Point](https://research.checkpoint.com/2019/the-road-to-qualcomm-trustzone-apps-fuzzing/)) | Trustonic test key for dev, **OEM key** for production ([Kinibi-600a](https://www.trustonic.com/news/kinibi-600a-commercial-release/)) | Samsung only: the trustlet's pubkey hash is compared against a hash baked into the TZOS binary ([Quarkslab pt.1](https://blog.quarkslab.com/a-deep-dive-into-samsungs-trustzone-part-1.html)) |
| **Solo-LLC entry** | Not realistic. SDK is "available to licensed users"; the 2024-25 open-sourcing (upstream QTEE Linux driver, `quic-teec`, `minkipc`) is **normal-world client code only** | Most realistic of the three. Historic ‹t-dev program, emulator, remote test servers; current third-party-via-SoC precedent in Solana Mobile on MediaTek | Effectively closed. SDK is "only available to strategic partners"; the entire public on-ramp is one email address |
| **Cost / NDA** | **public record silent** | **public record silent** (historically per-device/per-TA under NDA) | **public record silent** |
| **GP conformance** | compatibility shim, not native | GP-certified lineage; Kinibi-610a aligns crypto to **Internal Core API v1.4** | GP-**certified** (TEEgris v4/v4.1) |
| **TA threading** | not documented for third parties | **yes** — pthreads/SMP since Kinibi-610a | **yes** — multicore + PThread |
| **Heap ceiling** | not documented | no public figure; CA↔TA buffer capped at 1 MiB | not documented |
| **On-chip SRAM / pager** | **no**, and no precedent | **no** as a TA; `drApi` driver is the only lever | **no**, not documented |
| **Remote attestation** | Android Key Attestation | Android Key Attestation | **Knox Attestation** — TrustZone-signed verdict over REST, the best third-party story of the three |
| **Fleet** | ~22% of SoCs, ~35% of premium | MediaTek volume leader (~30%) but thin at premium; legacy Exynos S6–S9 | Exynos Galaxy only, and **eroding** — S25 was Snapdragon-only, S26 is region-split |

### Ranking, in the abstract

1. **Kinibi** — most realistic to engage, and the only one with a public lever toward the
   paging design (`drApi`). Production still needs an OEM key.
2. **QTEE** — best fleet and the Widevine precedent, hardest entry: needs an OEM co-sponsor.
3. **TEEGRIS** — strongest attestation, but closed to a solo LLC and on a shrinking fleet.

## Against the S21+, all of it is moot

The handset is **SM-G996U1 / SM8350 (Snapdragon 888)**, so its TEE is **QTEE** — the Exynos
2100 variant would have been TEEGRIS, and that was checked rather than assumed. Which one it
is barely matters, because on this device every route is closed by the device itself:

| route | why it is closed here |
|---|---|
| QTEE TA | signing requires **Samsung's** key. Item 1 in the ranking is Kinibi, which this SoC does not run; item 2 is QTEE, whose gate is an OEM relationship a solo LLC does not have. |
| OP-TEE / own secure world | `sys.oem_unlock_allowed=0`, `oem_unlock_supported=null` — the US "U1" handset has no unlock toggle, permanently. No custom bootloader, so no replacing the secure world. |
| pKVM / AVF protected VM | no `/dev/kvm`, all `ro.boot.hypervisor.*` empty. AVF arrived with the Android 15 chipset mandate; a 2021 Snapdragon 888 predates it. |

So the handoff's open question 1 — *which* signing program — is not the live question for this
device. **No signing program is reachable on it.** What remains is a normal-world process,
which runs and is bit-exact ([REPORT.md](REPORT.md) section 3) but carries a materially weaker
trust story that must not be described as attested.

## What would change the answer: AVF, and exactly where it stands

Researched 2026-08-31 against AOSP source. AVF (protected VMs) is the only route a solo
LLC can walk without a vendor relationship, so its details matter more than the TA table.

**No Samsung Galaxy is a candidate.** Google's Play Console device catalog listed 361
AVF-supporting models with **not one Samsung device on it**, and a published Galaxy S23 Ultra
shell dump has no `/dev/kvm`, no `ro.boot.hypervisor.*` at all, only a root-only
`/dev/gunyah`. Architecturally consistent: two independent reverse-engineering writeups put
**Samsung's RKP/H-Arx hypervisor at EL2** (the "uH" micro-hypervisor on Exynos; embedded in
Qualcomm's QHEE on Snapdragon), and only one thing can own EL2. Exynos 2500/2600 (Z Flip 7,
S26, S26+) do expose AVF, but **only non-protected VMs are confirmed** — protected-VM
capability has never been published by anyone.

**The VM itself is more reachable than the docs imply.** AOSP's "not available to third party
apps" means "not in the public SDK and not grantable without adb", not "impossible":

- `MANAGE_VIRTUAL_MACHINE` is `signature|preinstalled|development`. The **`development`** flag
  makes it grantable by `adb shell pm grant` on a **stock, locked, production** build — the
  same mechanism `WRITE_SECURE_SETTINGS` uses. No root, no unlock, no Shizuku.
- **Our exact workload needs only that one permission.** `setProtectedVm`, `setMemoryBytes`
  and `setCpuTopology` are all top-level config; `USE_CUSTOM_VIRTUAL_MACHINE` is only needed
  for a non-Microdroid VM, a custom kernel, or extra APKs.
- The **pvmfw wall cuts in our favour**: protected VMs require a pvmfw-signed payload, so a
  custom kernel can only run NON-protected (this is what blocks Podroid, the shipping
  third-party AVF app). A native `.so` inside **stock Microdroid** is exactly the protectable
  case.
- CTS proves it works on retail: `MicrodroidTestApp` is a **non-platform-signed** CTS module
  that grants both permissions via shell identity and runs parameterised over
  `protectedVm={false,true}` — and CTS must pass on final shipping software.

**Attestation is the actual blocker, and it is unresolved.** A pVM we cannot *prove* is a pVM
is worth little more than a normal Android process, and:

- Production `requestAttestation` needs no partner allowlist — same permission — but it fails
  `ATTESTATION_ERROR_UNSUPPORTED` unless the OEM registered the device's UDS-rooted DICE key
  at the **RKP factory** and threaded RKP VM markers through the vendor boot chain. That
  cannot be added later.
- CTS **requires** it only where `ro.vendor.api_level >= 202504` (launched with Android 16).
  Pixel 8/9 and every upgraded device sit in the silent-skip branch.
- **No pinnable public trust anchor is documented.** AOSP's reference verifier trusts whatever
  self-signed root the chain carries — a consistency check, not attestation. **If Google
  publishes no pinnable AVF RKP root, this route has no verifiable remote attestation**, and
  that single question decides build-vs-buy.
- `enableTestAttestation()` is a dead end: `@TestApi`, and it returns a hardcoded certificate
  that **expired 2024-02-14**.
- `isVmSecure` is false for any debuggable VM, so production must ship `DEBUG_LEVEL_NONE`.
- The CDD mandates only that `getCapabilities()` return *one of* protected/non-protected —
  **protected support is not required**, so it is a per-SoC gamble to be probed, never assumed.

**Compute envelope inside a pVM:** CPU only (no GPU/NPU — so the on-device-GPU-worker topology
is out), full NEON incl. dotprod, several GB of RAM fine, but the default is **one vCPU** so
`CPU_TOPOLOGY_MATCH_HOST` must be set explicitly. I/O over vsock. Changing the payload rotates
the VM's DICE secrets, so every app update changes its attested identity.

**Buy, if this route is taken:** a Pixel, not a Samsung. **Pixel 10-class or newer** if
attestation must be guaranteed (vendor API >= 202504); a used **Pixel 8a (~$205-250)** is
enough to prototype the VM mechanics, with attestation to be probed rather than assumed.
Run `probe-device.sh` on the unit before committing to a fleet.

## The concrete next step, if a TrustZone route is still wanted

Ask Trustonic, in one message, the two questions the public record cannot answer: whether a
**secure driver** can access on-chip memory and implement pager-style encrypted paging, and
what the **TA working-set/heap budget** is in writing. That is the most answerable channel and
it is the only lever with public evidence behind it. In parallel, build the AVF prototype on a
device that has it — it is the artifact any OEM conversation will want to see, and it is
buildable today without anyone's permission.
