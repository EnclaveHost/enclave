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

## How the attacks actually work

Worth understanding the mechanism rather than the headline, because it explains
why the vendors say they cannot fix it, and why on-package memory helps.

### The root cause: encryption without integrity or freshness

Every scalable TEE encrypts DRAM with **AES-XTS keyed by the physical address**.
Three properties follow, and all three are load-bearing for the attacks:

1. **Deterministic.** The same plaintext, at the same physical address, always
   produces the same ciphertext. No nonce, no per-write counter.
2. **No integrity.** Nothing authenticates that a cache line is the one the CPU
   wrote (TME-MK's integrity mode is the exception, and is new).
3. **No freshness.** Nothing stops old ciphertext being written back later.

This was a deliberate trade. Client SGX originally had a **Merkle tree** over
enclave memory, giving integrity and anti-replay -- but tree update cost grows
with memory size, so it does not scale to hundreds of gigabytes. Intel removed
it after Ice Lake to make large enclaves possible. SEV-SNP and TDX never had it.
Scalability was bought with exactly the properties that would have stopped this.

### What an interposer is, physically

A small PCB that sits **between the DIMM and its slot**. The memory module plugs
into the interposer, the interposer plugs into the motherboard. Every signal
between CPU and DRAM now passes through attacker-controlled hardware.

Battering RAM's entire bill of materials: a custom PCB ($18.49), a DDR4
connector ($16.00), a Raspberry Pi Pico ($4.00), and two analog switches plus
passives (~$9). Around **$50**.

The critical trick is that it is **passive during boot**. It passes signals
straight through while the platform runs its integrity and alias checks, so
everything passes and the machine reports a fully trusted state. Only afterwards
does it start interfering. That is what defeats boot-time alias detection.

### WireTap: read the bus, build a dictionary (~$1,000)

Purely passive -- it only *watches*. The $1,000 is mostly a logic analyser fast
enough to capture DDR4.

Because encryption is deterministic and keyed by address, a given plaintext at a
given address always yields the same ciphertext. So you build a
**ciphertext-to-plaintext dictionary**: induce known values at observable
addresses, record what the ciphertext looks like, and afterwards you can
recognise that value whenever it reappears. It is the ECB "encrypted penguin"
problem, at cache-line granularity across physical addresses.

Low-entropy, structured data is the ideal target. The authors used it to recover
an **SGX attestation key** from a machine reporting fully trusted status. With
that key you can sign quotes for anything, so remote attestation stops meaning
anything on that platform.

### Battering RAM: alias addresses at runtime ($50)

Cheaper and more direct. The analog switches sit on **address lines**, so at
runtime the interposer can redirect an access intended for one physical address
to different DRAM storage.

That breaks the binding the whole design rests on: the CPU believes a given
physical address is protected memory belonging to an enclave or a guest, while
the actual storage behind it is somewhere the attacker controls. The result is
arbitrary plaintext read/write into SGX-protected memory, and on **SEV-SNP,
attestation bypass plus plaintext access** -- on fully patched systems.

Aliasing is a known threat; platforms check for it at boot. Battering RAM's
contribution is *dynamic* aliasing -- invisible during those checks, enabled
afterwards.

### TEE.fail: the same idea on DDR5 (~$1,000)

Battering RAM only worked on DDR4, because DDR5 reorganised the command/address
bus and simple switches no longer suffice. That was the last remaining excuse.

TEE.fail built a proper DDR5 interposer from off-the-shelf parts for under
$1,000 -- and notes DDR5 interposers are **easier** to build, "only 50% of the
soldering work." It fits in a briefcase. It extracts **provisioning
certification keys** from Intel SGX and TDX, and ECDSA private keys from AMD
SEV-SNP *including with Ciphertext Hiding*. The forged quotes it produces are
"verifiable by official libraries" -- a correct verifier cannot tell. And since
NVIDIA GPU CC roots its attestation in the CPU TEE, compromising the CPU keys
compromises GPU attestation as well.

### Why it will not be fixed

The fix is memory encryption with integrity and freshness -- the Merkle tree
that was removed because it does not scale. Per the Battering RAM authors,
defending against it "would require a fundamental redesign of memory encryption
itself." Intel and AMD both classify physical DRAM attacks as out of scope and
name physical security as the mitigation.

Which is exactly why removing the DIMM socket helps: every one of these attacks
needs a mechanical interface to interpose on. No socket, no interposer.

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

## What actually defends against this, available today

Two things, and the first is Intel's own answer.

### 1. TME-MK cryptographic integrity mode (Intel, shipping)

Intel states it directly:

> Use of cryptographic integrity protection mode of Intel Total Memory
> Encryption - Multi-Key (Intel TME-MK) can provide additional protection
> against alias-based attacks, **such as those outlined in the Battering RAM
> paper**.

Mechanism: once a cache line is initialised with a given keyID it is covered by
a MAC, so any access with an incorrect keyID fails MAC verification. That is
precisely the aliasing Battering RAM relies on.

**Available on 5th Gen Xeon (Emerald Rapids) and Xeon 6 with P-cores.** TDX is
built on TME-MK, so it composes -- enable TME, TME-MT, TDX and the TDX Loader in
firmware.

Scope, honestly: this addresses the **alias** class. It does not obviously
address WireTap's ciphertext-dictionary approach against deterministic
encryption, nor TEE.fail's key extraction. It raises the bar; it does not close
the category.

### 2. Remove the DIMM, remove the attack surface

All three attacks physically interpose **between the CPU and a removable DIMM** --
the interposer is literally an adapter the module plugs into. TEE.fail's authors
built theirs by soldering onto existing risers because that was easier than
fabricating a PCB.

Memory with no socket has no such attachment point:

| memory | interposer difficulty |
|---|---|
| DIMM (every standard server and desktop) | **$50 board, plugs in** |
| soldered LPDDR | BGA trace tapping -- orders of magnitude harder |
| **on-package HBM / co-packaged LPDDR** | requires **decapsulation** |

**Intel Xeon Max** (Sapphire Rapids HBM) is the concrete example: four HBM2e
stacks, **64 GB on package**, and "to obtain the HBM-only mode, **no DIMM must be
installed**" -- in that mode HBM is the only memory the OS sees. It is Sapphire
Rapids silicon, so TDX-capable. NVIDIA Grace is the same shape (co-packaged
LPDDR5X, up to 480 GB, no serviceable modules).

Cost is the catch: Xeon Max 9468 is ~$9,900 and the 9480 ~$12,980. Datacenter
pricing, not a seller-box budget.

**Caveat, stated plainly:** this is an inference from the attack mechanism, not
an explicit recommendation by the authors or vendors -- searching found no such
statement from either. The residual physical attack is decapsulation to probe
on-package interconnect, which NVIDIA's own confidential-computing threat model
calls "out of scope... technically challenging and risky" given multi-layer
packaging.

### The procurement conclusion, which is the actionable part

**AMD currently has no stated mitigation.** SEV-SNP *with Ciphertext Hiding* was
still broken by TEE.fail, and Ciphertext Hiding "neither addresses issues with
deterministic encryption nor prevents physical bus interposition."

So for **new first-party hardware**, the better-defended choice today is
**Intel Xeon 6 (P-core) or 5th Gen Emerald Rapids, running TDX with TME-MK
cryptographic integrity enabled** -- rather than another EPYC/SEV-SNP box like
metal0. Add on-package memory if the budget ever justifies it and the
interposition point disappears entirely.

That is a real answer to "what should we buy", even though it is not a drop-in
replacement for SEV-SNP and does not make an anonymous home seller trustworthy.

## The alternative: IBM Secure Execution on LinuxONE / IBM Z

Searching for a replacement architecture rather than a mitigation turned up
exactly one candidate that meets the bar, and it is the only one found that
**explicitly claims resistance to physical attacks** rather than declaring them
out of scope.

### It meets every requirement

| requirement | IBM Secure Execution |
|---|---|
| encrypts memory | **two independent layers** (below) |
| protects from the hypervisor | Ultravisor; "will only allow the hypervisor to see the SVM memory encrypted" |
| secure root of trust | IBM-signed **host key document**, per machine |
| third-party verifiable attestation | `pvattest`, open source in `s390-tools` |
| runs our guest | Linux SVMs -- needs an s390x port |
| **resists physical attack** | **claimed explicitly** |

**The two layers matter.** Since **IBM z16 and LinuxONE 4, all memory is
encrypted**, and IBM states this is "transparent to all firmware and software"
and "**intended to protect the IBM Z and IBM LinuxONE memory against physical
attacks**." That is *independent of* Secure Execution's own per-SVM encryption.
So there is a whole-memory layer aimed at the physical adversary and a per-guest
layer aimed at the hypervisor -- against Intel's and AMD's single layer that
addresses only the second and disclaims the first.

**The trust chain is the same shape as AMD's.** A per-machine host key document,
verified against the IBM Z host-key-signing-key certificate, an intermediate CA,
and a root CA, with a CRL of revoked host keys -- structurally VCEK -> ASK ->
ARK. The tooling (`genprotimg` to build the image, `pvattest` to attest,
`pvsecret` to inject secrets) is open source in `s390-tools`.

### The GPU objection dissolves, which is the whole point

IBM Z has no GPU support -- CUDA has never targeted s390x. That looks fatal for
a "shielded GPU" product until you remember the tier's defining property:
**the GPU is untrusted by design and belongs outside the boundary.** It does not
need to be in the confidential machine, or even attached to it. It needs a fast
link.

```
LinuxONE / IBM Z                          commodity GPU host
  SVM: the trusted half                     shielded-worker + the card
  weights, activations, KV cache,           sees only one-time-padded
  mask pool, Freivalds secrets              residues over a prime field
        |                                          |
        `------------- RDMA, ~2-5 us RTT ----------'
```

That transport is not a compromise -- it is **faster than the tier already runs
at**. metal0's numbers are 46 us per exchange on host loopback and ~152 us over
vhost-vsock in the CVM, yielding ~100-154 tok/s. RDMA over 100GbE lands around
2-5 us round trip, so at ~49 exchanges per token the transport term would be
~0.25 ms -- a rounding error against a 4.6 ms token, and better than the
in-CVM path metal0 uses today.

### What it costs

- **An s390x port of the trusted half.** `wasm/ggml-shielded` and especially the
  mask-refill kernel, which leans on AVX-512 VNNI today and would need s390x
  vector (VXE) equivalents. That is the same class of work as the ARM64 port,
  and refill is the TEE half's dominant cost so it has to be done properly.
- **Enterprise pricing.** LinuxONE now ships single-frame and rack-mount options
  rather than only full frames, but this is not consumer hardware and never will
  be.
- **A new RAD format and verifier path** alongside `sev-snp-guest-metal-v1`:
  host key document chain verification instead of VCEK from AMD KDS.

### Where it fits

Not the gaming-rig product -- nothing is. This is the answer to a different and
sharper question: **what should carry work whose confidentiality actually has to
survive an adversary with physical access?**

Given that a $50 board defeats SEV-SNP and a ~$1,000 one defeats TDX and SGX,
and that both vendors have declined to fix it, a tier backed by hardware whose
vendor *does* claim physical-attack resistance is worth having -- for
first-party capacity, for the deployments that need the strong claim, and as the
honest top of a trust ladder whose lower rungs we now know the limits of.

## The bottom line for the alternative search

There is no alternative to find. SGX, TDX, SEV-SNP and NVIDIA GPU CC are all
broken by the same technique, and Arm CCA is untested only because the silicon
was unavailable to the researchers -- it shares the design that makes the attack
work. The root cause is common to all scalable TEEs: **deterministic AES-XTS
keyed by physical address, with no integrity or freshness**, because the Merkle
tree that would provide freshness does not scale (which is exactly why Intel
removed it from SGX after Ice Lake).

Picking different silicon does not *solve* this -- but it is not nothing either.
Intel TDX with TME-MK cryptographic integrity is the best-defended standard
configuration available today and has a vendor-stated mitigation for the
Battering RAM class; AMD has none. And any machine without DIMM sockets removes
the attachment point the whole attack family depends on.

There IS one alternative architecture that clears the bar -- IBM Secure
Execution on z16/LinuxONE 4, whose transparent full-memory encryption is stated
by IBM to protect "against physical attacks", with an IBM-signed host key
document as the root of trust and open-source attestation tooling. Its lack of
GPU support is not the obstacle it appears, because the shielded tier puts the
GPU outside the boundary on purpose and RDMA closes the gap faster than the
loopback the tier runs on today. See the section above.

For the anonymous home-seller model specifically, hardware choice only narrows
the gap. Closing that still requires changing what we promise, or who we accept.
