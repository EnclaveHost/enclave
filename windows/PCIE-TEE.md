# Is there a CVM on a PCIe card?

Asked because if one existed, a consumer gaming rig with no SEV-SNP silicon
could still host the trusted half, and the EPYC/TDX board requirement would
disappear.

**Short answer: yes, one exists -- the NVIDIA BlueField DPU in zero-trust mode.
It would technically work. It costs 1-6x the GPU it would monetize, which
inverts the product's economics.**

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

### NVIDIA BlueField DPU (the real candidate)

NVIDIA describes it as "a server embedded within the server itself... It runs its
own Linux kernel, its own management plane, and its own attestation root of
trust -- completely isolated from the host." **Zero-trust mode** is the relevant
configuration: it "implements an additional layer of security where the host
system administrator is prevented from accessing BlueField from the host."

That is the property we need. The declared adversary is the machine's owner, and
zero-trust mode is explicitly designed to exclude them.

The attestation is genuine and structurally analogous to AMD's:

| AMD SEV-SNP | BlueField-3 |
|---|---|
| VCEK -> ASK -> ARK, rooted at AMD | DICE cert chain L1-L6, rooted in an **NVIDIA root certificate** |
| VCEK provisioned per-part | L4 provisioned in production, in write-protected memory |
| report signed by the PSP | SPDM measurements signed by the L6 leaf key |
| launch measurement | DICE measurements + CoRIM reference values |

Latency is a non-issue: PCIe round trips are microseconds, comparable to the
loopback figures the tier already runs at, so none of the WAN arithmetic that
killed remote offload applies here.

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

The question was worth asking and the answer is genuinely "yes, that exists."
It fails on price rather than on architecture, which is a better failure than
the ones before it -- those were physics. If DPU prices fall, or if the target
shifts from "monetise a gaming rig" to "a purpose-built seller box that does not
need server silicon," this comes back.
