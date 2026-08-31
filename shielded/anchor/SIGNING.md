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

## What would change the answer

- **A different handset.** A device with an unlockable bootloader (Pixel, or an
  international/dev-unlockable Samsung) reopens custom firmware; a 2024+ flagship reopens
  **AVF protected VMs**, which give real isolation, an RKP-backed attestation chain, and no
  vendor signing relationship at all. AVF is the only route on this list a solo LLC can walk
  unaccompanied — though shipping a pVM to *retail* is still gated behind
  `MANAGE_VIRTUAL_MACHINE` (privileged/preinstalled apps), so it is a prototype and
  OEM-pitch vehicle rather than a distribution channel today.
- **An OEM or SoC partnership**, which is what every TrustZone row above ultimately requires.
- **Dropping the on-chip-SRAM requirement.** If the design can accept a TZASC DRAM carveout
  with keys in DRAM-resident TA memory — a weaker but still TrustZone-class boundary — the
  decisive question softens from "unprecedented" to "ordinary TA work", and the ranking above
  becomes actionable. That is a security decision for the tier's threat model, not an
  engineering one, and it should be made explicitly.

## The concrete next step, if a TrustZone route is still wanted

Ask Trustonic, in one message, the two questions the public record cannot answer: whether a
**secure driver** can access on-chip memory and implement pager-style encrypted paging, and
what the **TA working-set/heap budget** is in writing. That is the most answerable channel and
it is the only lever with public evidence behind it. In parallel, build the AVF prototype on a
device that has it — it is the artifact any OEM conversation will want to see, and it is
buildable today without anyone's permission.
