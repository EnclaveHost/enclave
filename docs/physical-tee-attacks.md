# Memory-bus interposition breaks every current TEE, and it matters most to us

**Status: this contradicts a load-bearing claim in `metal/PROTOCOL.md`.** Written
2026-08-28 while searching for an alternative to SEV-SNP/TDX. The search found
something more important than an alternative: the incumbents do not hold against
the adversary our permissionless model explicitly assumes.

## The claim this affects

`metal/PROTOCOL.md`, on why anonymous sellers are safe to accept:

> The seller is **untrusted**. That is the whole point: the security does not
> come from trusting the person who owns the machine, it comes from the CPU.
> [...] A malicious seller cannot read tenant data (SEV-SNP encrypts and
> integrity-protects guest memory; the host, including root, is outside the
> boundary) and cannot run modified code (the launch measurement would not match
> a published release [...]).

Both halves of that sentence are false against a seller with physical access and
about $50-1000 of hardware. A seller has physical access to their own machine by
definition.

## The attacks

Three pieces of 2025 work, all using memory-bus interposers.

### Battering RAM (KU Leuven + Birmingham)

A **$50** DDR4 interposer -- custom PCB ($18.49), DDR4 connector ($16), a
Raspberry Pi Pico ($4), two analog switches. It "remains invisible during system
startup, passing all trust checks", then dynamically aliases addresses at
runtime, defeating boot-time alias detection.

| target | result |
|---|---|
| Intel Scalable SGX | fully compromised -- arbitrary plaintext read/write |
| **AMD SEV-SNP** | **attestation bypass and plaintext access** |
| Intel Client SGX | re-enables previously patched BadRAM |
| Intel TDX | not successfully attacked |
| **Arm CCA** | **theoretically vulnerable, untested** (no hardware) |

DDR4 only -- DDR5's reorganised command/address bus defeats the simple switch
approach -- but the authors state "the underlying issue is not fixed."

### WireTap (Georgia Tech + Purdue)

A **passive** ~$1,000 interposer (mostly the logic analyser). Builds a
ciphertext-to-plaintext dictionary from low-entropy data, exploiting the fact
that scalable TEEs encrypt with **deterministic AES-XTS keyed only by physical
address**. Extracted an **SGX attestation key from a machine in fully trusted
status**.

### TEE.fail -- and this is the one that closes the escape hatches

DDR5, under **$1,000**, off-the-shelf parts, and the authors note **DDR5
interposers are *easier* to build than DDR4** ("only 50% of the soldering work").
It fits in a briefcase.

- **Intel SGX and TDX** -- extracts provisioning certification keys, enabling
  attestation forgery. TDX's survival of Battering RAM does not survive this.
- **AMD SEV-SNP, including with Ciphertext Hiding** -- recovers ECDSA private
  keys.
- **NVIDIA GPU Confidential Computing** -- compromised by leveraging the broken
  CPU TEE keys.

It produces "valid-appearing quotes **verifiable by official libraries**." So the
forgery is not detectable by a verifier doing everything right.

### Vendor position

Intel and AMD acknowledged in February 2025, published advisories by September
2025, and classify physical DRAM attacks as **out of scope**. No firmware
mitigations are planned. Per the Battering RAM authors, a fix "would require a
fundamental redesign of memory encryption itself." Both vendors recommend
physical security as the defence.

## Why this hits us harder than it hits Azure

This is not an Enclave bug; it is the state of the art, and every cloud CVM
shares it. The difference is **who has physical access**.

| deployment | physical access | exposure |
|---|---|---|
| Tinfoil / datacenter fleet | controlled, audited, badge-in | low -- the vendors' recommended mitigation is actually in place |
| **metal, anonymous seller at home** | **the adversary owns the building** | **unmitigated** |

The permissionless protocol is precisely the case the vendors' threat model
excludes. We designed for "the seller is hostile and that is fine because the
CPU protects the tenant", and the CPU does not protect the tenant from someone
holding the motherboard.

## What actually survives

Not everything. Worth being precise, because the protocol is not naked here:

- **Result integrity survives.** Preprocessed Freivalds runs in the TEE over a
  prime unrelated to the field and is checked before any dependent token is
  sampled. A host that tampers with offloaded products is still caught. What
  breaks is confidentiality and the authenticity of attestation, not correctness.
- **The GPU still never sees plaintext.** The shielded construction is unaffected
  -- one-time pads over a prime field do not care what the host does to its own
  DRAM. The exposure is the CVM's memory, not the card's.
- **The economic gates still function.** Bond + slashing (PROTOCOL.md gate 4) and
  proof-of-time do not depend on attestation being unforgeable, though their
  deterrent value drops if a forged quote can pass gate 1.

What breaks: tenant prompt/activation confidentiality against a physically
present seller, and the measurement allowlist as a guarantee that a seller runs
published code.

## Options, none of them free

1. **Tier the trust claim honestly.** First-party and colocated boxes keep the
   strong claim, because physical access is genuinely controlled there. Anonymous
   home sellers get a weaker, explicitly stated one: protected against a remote
   or software-level adversary, **not** against the machine's owner with
   sustained physical access. This is the honest option and it costs us the
   cleanest part of the pitch.
2. **Keep high-value work on first-party boxes.** Route by trust tier rather than
   price alone -- a deployment could declare it will not run on anonymous
   capacity.
3. **Interposer detection (research).** An interposer is in the DRAM path and
   adds propagation delay; memory-timing fingerprinting might detect one.
   Speculative, unproven, and an arms race we would be starting from behind.
4. **Watch DDR5 + on-package memory.** The structural fix is memory that never
   crosses an interposable bus. That points at on-package HBM/SRAM, which is why
   smartcards resist physical attack -- but not at anything that holds a KV cache
   today.

## The bottom line for the alternative search

There is no alternative to find. SGX, TDX, SEV-SNP and NVIDIA GPU CC are all
broken by the same technique, and Arm CCA is untested only because the silicon
was unavailable to the researchers -- it shares the design that makes the attack
work. The root cause is common to all scalable TEEs: **deterministic AES-XTS
keyed by physical address, with no integrity or freshness**, because the Merkle
tree that would provide freshness does not scale (which is exactly why Intel
removed it from SGX after Ice Lake).

Picking different silicon does not solve this. Only changing what we promise, or
who we accept, does.
