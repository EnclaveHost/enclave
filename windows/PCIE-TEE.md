# Is there a CVM on a PCIe card?

Asked because if one existed, a consumer gaming rig with no SEV-SNP silicon
could still host the trusted half, and the EPYC/TDX board requirement would
disappear.

**Short answer: no, not today. The closest thing -- an NVIDIA BlueField DPU in
zero-trust mode -- solves a different problem than the one we have, and DPU
confidential computing proper is described by NVIDIA's own ecosystem as "under
construction."**

## The structural constraint, first

A PCIe card **cannot make the host's main memory confidential**. Memory
encryption is a memory-controller function, and the card is on the wrong side of
it. SEV-SNP works because the encryption engine sits between the cores and DRAM
with a key the hypervisor never sees; nothing on the PCIe bus can reproduce
that.

So a card cannot give you "a CVM for this host." What it can give you is a
**separate protected computer** that happens to live in a slot. That is a
different thing -- and it only helps if the trusted half is self-contained.

For the shielded tier, it happens to be. The TEE half holds model weights,
activations, the KV cache, the mask pool and the Freivalds secrets, and does the
nonlinear ops. All of that can live on the card; the untrusted GPU stays in the
host and receives one-time-padded residues over PCIe. So the shape fits. It
would not fit a design that needed to protect the host's RAM.

## What actually qualifies

### NVIDIA BlueField DPU -- close, but for a different threat model

A BlueField is genuinely "a server embedded within the server": its own ARM
cores, its own DDR, its own Linux, its own BMC, its own secure boot and eRoT,
and a DICE/SPDM attestation chain (L1-L6, rooted in an NVIDIA certificate, L4
provisioned in production into write-protected memory). PCIe latency is
microseconds, so the transport arithmetic that killed remote offload does not
apply. All of that is real.

**But zero-trust mode does not lock out the machine's owner, and that is the
whole requirement.** NVIDIA's own documentation is precise about what it does:

> Zero Trust, also known as **Restricted Mode**, is a specialized variation of
> DPU Mode that enhances security by preventing the host system administrator
> from accessing BlueField **from the host side**. Once Zero Trust mode is
> enabled, the BlueField must be fully controlled by the **data center
> administrator** via the Arm cores or the BMC connection, rather than through
> the host.

Read the roles. It separates **the tenant on the host** from **the operator on
the DPU**. In a cloud that is exactly right: the tenant rents the host CPU and
must not be able to reach the operator's infrastructure on the card.

In our scenario those two roles are **the same person**. The seller owns the
machine, installs the card, and holds the BMC. Zero-trust mode closes the
host-side door and hands them the key to the front one -- because handing the
legitimate administrator ARM/BMC control is the mode's *intended behaviour*, not
a gap in it.

Two further gaps, both material:

- **No evidence of DPU DRAM encryption against physical attack.** SEV-SNP's
  guarantee rests on a memory encryption engine with a key the host never sees.
  Nothing found indicates BlueField encrypts its own DDR that way, and its DRAM
  is as physically accessible as any other DRAM to someone holding the card.
- **DPU confidential computing is not shipping.** The description in the
  literature is that "confidential computing environments for DPUs are **under
  construction**, based on PCIe **TDISP** features, such as NVIDIA BlueField."
  TDISP is the standard for attaching a device *into* a CVM's trust boundary --
  which presupposes a CVM on the CPU side. So even the future version of this
  does not remove the CPU TEE requirement; it extends one.

Zero-trust mode is a real and useful security control. It is an **administrative
separation between two roles**, not a hardware boundary that resists the party
holding the hardware.

### What does not qualify

- **HSMs** (Thales Luna, Marvell LiquidSecurity, YubiHSM). Real tamper-resistant
  PCIe hardware, but they do key operations. There is no general compute and
  nowhere near enough memory for model weights.
- **A generic SBC** on the end of a cable. Physically separate, but the owner
  owns both machines and can read its memory freely. Physical separation is not
  isolation when the adversary is the person holding both boxes.
- **NVIDIA GPU confidential computing on its own.** H100/Blackwell CC mode does
  not stand alone: "PCIe bus encryption is handled by **integrating the GPU into
  the CPU's trusted execution environment**." The GPU TEE *extends* a CVM
  boundary rather than replacing it, so buying a confidential-capable GPU does
  not remove the CPU TEE requirement.
- **Graphcore IPU with ITX.** Research-stage hardware extensions on a product
  line that is effectively dead.

### RISC-V (specs yes, silicon no)

The obvious place to hope for a cheap answer, since RISC-V is where open
security IP lives. The specs are real and the hardware is not.

**What exists as specification or IP:**

- **CoVE** (Confidential VM Extension, formerly AP-TEE) -- the RISC-V analogue
  of SEV-SNP/TDX, with a companion **CoVE-IO** for device attachment. Active
  spec work under `riscv-non-isa/riscv-ap-tee`, plus implementations from Rivos
  and IBM's formally-verified ACE-RISCV. No confirmation of ratification, and no
  shipping silicon found.
- **Keystone** -- open-source TEE framework built on **PMP** (Physical Memory
  Protection), from UC Berkeley. Runs on HiFive Unleashed and QEMU.
- **SiFive WorldGuard** -- donated to RISC-V International in 2023. Multi-domain
  isolation that tags transactions with World IDs, covering "core, cache,
  interconnect, peripheral, and memory."

**What exists as buyable hardware:** the **Tenstorrent Blackhole** PCIe cards --
p100a at $999, p150a at $1,399 -- carrying **16 SiFive X280 RISC-V cores**,
32 GB GDDR6, and enough Linux support to boot the RISC-V cores directly
(`tenstorrent/tt-bh-linux`). Cheaper than a BlueField, with vector-capable cores
that would suit mask refill, and enough memory for the weights.

It has **no attestation and no confidential computing features whatsoever**. It
is an AI accelerator whose control processors happen to be RISC-V. Nothing found
suggests Tenstorrent is heading that way.

So: right shape, no security properties. If that card ever grew an attestable
root of trust and memory encryption it would be genuinely interesting, but that
is a wish, not a roadmap.

## The pattern, and the filter it gives you

Four candidates have now failed, and three failed the *same* way:

| candidate | isolation mechanism | encrypts DRAM against the owner? |
|---|---|---|
| Windows VBS / VTL1 | hypervisor privilege levels | **no** |
| BlueField zero-trust | administrative role separation | **no** |
| RISC-V PMP / WorldGuard | physical memory partitioning, transaction tagging | **no** |
| SEV-SNP / TDX | **memory encryption engine, key in the memory controller** | **yes** |

Every one of the first three is *software isolation enforced by hardware
privilege*. That stops software -- another process, the host kernel, a
co-tenant. It does not stop someone holding the machine, because the DRAM still
contains plaintext and they own the DRAM.

SEV-SNP and TDX are categorically different for one reason: the memory
encryption engine sits between the cores and DRAM with a key the host, the
hypervisor, and the owner never see. That is what makes them the only things
that survive an adversary defined as *the person who owns the box*.

**The filter, for any future candidate:** does it encrypt memory with a key its
physical owner cannot extract, and attest a measurement of *our* workload to a
third party? If either answer is no, it does not meet this threat model,
whatever it is called in marketing. Applying that test up front would have
disposed of VBS, BlueField and RISC-V PMP in a sentence each.

## Why it still fails for a gaming rig

Prices, mid-2026:

| card | spec | price |
|---|---|---|
| BlueField-3 (B3220) | 16x Cortex-A78, 32 GB | ~$2,000-3,300 new; $3,332 refurb quoted, up to $4,490 |
| BlueField-2 | 8x Cortex-A72, 16 GB | ~$550-775 used |

Set that against what the card would earn. metal0's shielded worker posts
`priceUsdHr: 0.05` for its RTX 3070. At $0.05/hour a **$550 used BlueField-2
needs ~11,000 hours of continuous, fully-utilised selling** to pay for itself --
about 15 months at 100% occupancy, which will not happen. A BlueField-3 is
several years. The seller spends more on the trust hardware than the compute
hardware they are trying to monetise, before earning a cent.

Two technical problems compound it:

- **The cheap option is the wrong CPU.** Mask refill is the TEE half's dominant
  cost (~48 core-ms/token at 4B, ~100 at 8B+), and the x86 build leans on
  AVX-512 VNNI. BlueField-2's Cortex-A72 is ARMv8.0 and has **no dot-product
  extension**, so the hot loop would fall back to something far slower.
  BlueField-3's A78 is ARMv8.2 with dotprod and would be workable -- but that is
  the $2,000+ card.
- **Memory bounds the model.** The TEE half holds weights in the clear. 16 GB on
  a BF-2 is tight past ~7B once the KV cache is included; 32 GB on a BF-3 is
  comfortable.

## Where it would make sense

Not on a gaming rig, but the idea is not worthless:

- **An operator who already owns BlueField cards.** The marginal cost is zero
  and the DPU is idle capacity. This is a datacenter play, not a consumer one.
- **A purpose-built seller appliance**, where the DPU replaces a whole EPYC
  platform rather than adding to a consumer one. An EPYC board plus CPU is also
  four figures, so a BF-3 plus a cheap host is not obviously worse -- and it
  removes the "must be server silicon" requirement from the host entirely.

That second case is worth keeping in mind, because it inverts the constraint:
today the seller needs an EPYC/TDX **board**. With a DPU they would need a
**card** in any board. That is a strictly easier thing to buy, just not a cheaper
one.

## What it would cost to support

Not free, if it were ever pursued:

- A new RAD format alongside `sev-snp-guest-metal-v1` and `tdx-guest-metal-v1`,
  and verifier support for the DICE/SPDM chain in `metal/verify.mjs` -- which
  today fetches VCEK/ASK/ARK from AMD KDS and would need an NVIDIA equivalent.
- The measurement-reproducibility question all over again. NVIDIA signs CoRIMs
  for its own firmware; our workload image on the DPU needs its own measurement
  path, and "alternative, non-NVIDIA provided attestation certificates are not
  supported."
- An ARM64 build of the guest and the shielded TEE backend, including a
  NEON/SVE dot-product path to replace the AVX-512 VNNI refill kernel.

## Verdict

**There is no commodity "CVM on a PCIe card" today.** I initially read
BlueField's zero-trust mode as one; it is not. It defends the operator's card
from the host's tenant, and our seller is both parties at once.

What would actually be needed is a card that (a) encrypts its own memory against
someone holding it, and (b) attests a measurement of *our* workload to a third
party, with no path for the card's physical owner to extract the keys. BlueField
has (b) for its own firmware and does not demonstrably have (a).

The TDISP direction is worth tracking, but note what it is: a way to pull a
device *inside* an existing CVM boundary. It makes CPU TEEs more useful; it does
not substitute for one. So it does not rescue a consumer box either.

The economics section below is retained because it would have been decisive even
if the security argument had held -- a $550-3,300 card to monetise a $600 GPU
does not work at metal0's posted $0.05/card-hour. Two independent reasons to say
no is worth recording, since only one of them changes if prices fall.
