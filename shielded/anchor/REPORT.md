# Phone-hosted trust anchor — feasibility, measured on a Galaxy S21+

Status: **SPIKE, measured on the target device 2026-08-30.** The anchor split runs and
is bit-exact against the x86 reference; the three routes that would give it a *TrustZone-class*
trust story are all closed on this specific handset, and that is the finding.

Companion: [`docs/shielded-inference.md`](../../docs/shielded-inference.md) (the tier's design),
[`shielded/SECURITY.md`](../SECURITY.md) (the threat model this anchor would have to restate),
[`shielded/REPORT.md`](../REPORT.md) (the CVM-anchored numbers everything below is compared against).

## 0. The device, and why it decides the question

The constraint is a specific handset, so every capability below is read off it rather than
from a datasheet.

| property | value | how |
|---|---|---|
| model | **SM-G996U1** (Galaxy S21+ 5G, US unlocked) | `ro.product.model` |
| SoC | **SM8350 / Snapdragon 888**, platform `lahaina` | `ro.soc.model`, `ro.board.platform` |
| TEE | **Qualcomm QTEE** (not Samsung TEEGRIS — that is the Exynos variant) | follows from the SoC |
| OS | Android 15, SDK 35, patch 2026-01-01 | `ro.build.version.*` |
| bootloader | **locked, `green`, `oem_unlock_allowed=0`** | `ro.boot.verifiedbootstate`, `ro.boot.flash.locked`, `sys.oem_unlock_allowed` |
| hypervisor | **absent**: no `/dev/kvm`, `ro.boot.hypervisor.*` all empty | direct probe |
| cores | 1x Cortex-X1 (0xd44), 3x A78 (0xd41), 4x A55 (0xd05) | `/proc/cpuinfo` |
| SIMD | `aes pmull sha1 sha2 asimddp` — **`i8mm` NO, `sve` NO, `bf16` NO** | `/proc/cpuinfo` Features |
| RAM | 7.5 GiB | `/proc/meminfo` |

Two of those rows overturn assumptions the handoff carried:

- **`i8mm` is not present.** The handoff's engineering delta says "port refill/unmask kernels
  from AVX-512 VNNI to NEON/i8mm". On this SoC (ARMv8.2 cores) the available instruction is
  **SDOT/UDOT (`asimddp`)**, not the ARMv8.6 i8mm. That changes the port, and section 4
  measures what it costs.
- **There is no hypervisor.** The handoff's interim milestone ("nonlinears in a pKVM protected
  VM") has no substrate here: AVF arrived with the Android 15 *chipset* mandate, which a 2021
  Snapdragon 888 predates. `/dev/kvm` does not exist.

## 1. The three trust routes, against this handset

| route | verdict on SM-G996U1 | the blocking fact |
|---|---|---|
| vendor-signed TrustZone TA (QTEE) | **CLOSED** | QTEE trustlets are verified against a root-cert hash in SoC eFuses; on a retail handset that key is the **OEM's** (Samsung's). Qualcomm's 2024-25 open-sourcing (the upstream QTEE Linux driver, `quic-teec`, `minkipc`) is all **normal-world client** code; the TA-authoring SDK stays licensed. A solo LLC cannot get a trustlet signed for a retail Galaxy. |
| OP-TEE / own secure world | **CLOSED** | `sys.oem_unlock_allowed=0` and `oem_unlock_supported=null`. US "U1" Samsung handsets ship with the unlock toggle absent, permanently. No custom bootloader, so no replacing the secure world. |
| pKVM / AVF protected VM | **CLOSED** | No `/dev/kvm`, no `ro.boot.hypervisor.*`. Not a configuration gap — the silicon generation predates the mandate. |
| **normal-world aarch64 process** | **OPEN, and measured below** | Runs today via `adb`/an APK. Gives *no* isolation from a root-level adversary on the phone. |

The consequence is stated plainly because it changes the tier, not just the schedule: **on this
handset there is no path to the TrustZone-class anchor the handoff scoped.** What runs is the
anchor's arithmetic in normal world, whose trust story is "the phone's owner and its OS are
honest", not "isolated from a root-level software adversary". Per `SECURITY.md`'s own rule —
plaintext outside the trusted half collapses the tier to trust-the-host — that is a **different
and weaker tier**, and it must not inherit the word "attested".

Which of the two S21+ variants is in hand mattered and was checked rather than assumed: the
Exynos 2100 variant would have been TEEGRIS (strategic-partners-only, one contact address);
this is the Snapdragon variant, so the gate is Samsung's QTEE signing key either way.

## 2. What was built

An OS-free core carrying the part of `shielded-tee.c` that must live inside the anchor —
pad bank, mask, unmask, integer Freivalds, int64 local reference — with no threads, sockets,
stdio or `getenv`, so one object links into a GlobalPlatform TA, a native harness and a
cross-built aarch64 binary:

```
shielded/anchor/core/anchor-core.{h,c}     the anchor's trusted half (OS-free)
shielded/anchor/harness/                   split-harness, rtt-probe, refill-neon-bench
shielded/anchor/optee/ta/                  the same core as a GP TA (UUID 6e3f9c52-...)
shielded/anchor/optee/host/                the normal-world CA: sockets only, ciphertext only
```

The arithmetic is **not reimplemented**: masking, unmasking, Freivalds and refill are the
*generic build of* `wasm/ggml-shielded/shielded-simd.c` — the same functions the CVM stack
self-checks its AVX-512 twins against. There is exactly one copy of the field code, which is
what keeps a phone anchor from silently disagreeing with the enclave by one ulp.

The split is real, not cosmetic: `an_mask()` emits ciphertext planes and `an_finish()` consumes
a ciphertext reply and returns only verdicts. The pad `r`, `u = r.W`, the Freivalds secrets and
every unmasked `y` stay inside the core and have no API that exports them. The normal-world
half (`worker-client.c`) speaks the worker's real protocol 1.3 — HELLO, ALLOC, chunked
`SET_TENSOR` of the public weights, `GRAPH_INSTALL`, then `FIELD_GEMM24` exchanges — so the
socket carries exactly what the handoff's rule allows it to carry.

## 3. Invariant #6: phone-anchored ≡ reference, bit for bit

Same four shapes, run on the S21+ and on this x86 box, against the same live `worker-cuda`
binary on an RTX 3070. `y_digest` is FNV-1a over every unmasked product of every iteration.

| shape | K | N | nodes | y_digest (x86) | y_digest (S21+) | peak \|y\| | headroom |
|---|---|---|---|---|---|---|---|
| tiny | 256 | 256 | 1 | `e73f677de5757c2e` | `e73f677de5757c2e` | 3,135,145 | 2.31x |
| attn | 896 | 896 | 1 | `e559e6683f1e8623` | `e559e6683f1e8623` | 3,230,713 | 2.24x |
| gate\|up | 896 | 4864 | 2 | `b69e75d75f23ae1f` | `b69e75d75f23ae1f` | 3,674,757 | 1.97x |
| down | 4864 | 896 | 1 | `ea363fadd8b8fd5b` | `ea363fadd8b8fd5b` | 3,403,638 | 2.12x |

**All four match, and so do `peak_abs_y` and the headroom, to the digit.** Every run also
asserts `exact` (unmasked product equals the core's own int64 reference), `verified`
(Freivalds accepts the honest result), `lie_rejected` (a single flipped reply byte is refused)
and `pads_distinct` (the same activation masked twice gives different planes).

### The wrap that proved the guard works on ARM

The first `down` run (K=4864) failed verification after 29 iterations. The decisive test was
running the identical shape natively: **x86 failed at iteration 29 too, with the identical
counts.** So it is not an ARM port bug — the fixture at K=4864 sits only 2.9σ from `M/2`, the
field wrapped, and the integer Freivalds caught it. That is rule 3 of `README.md` firing
correctly, on both architectures, at the same input.

The fixture now scales its activation range as `1/sqrt(K)` to stand in for the per-site
calibrated exponent a real model carries (`--xmax` overrides). This is a property of the
*fixture*, not the anchor: a real deployment gets its exponents from `shielded-calib`, and the
handoff's rule that the exponent is a public model constant is untouched.

## 4. Refill on the phone, and the kernel port the handoff got half right

Refill (`u = r.W`) is the anchor's one unoffloadable term and costs three residue planes per
offloaded MAC. The CVM does it with `vpdpbusd`, whose point is a **mixed u8 x s8** dot product:
pad residues are unsigned [0,250], encoded weights signed [-119,119].

AArch64 has no mixed-sign dot product, and this SoC has no `i8mm` either. The available
instruction is SDOT. The identity that recovers the product exactly:

```
xs = x - 128                    (fits int8: [-128,122])
sum_k x[k]*w[k] = SDOT(xs, w) + 128 * sum_k w[k]
```

`sum_k w[k]` is a per-output-row constant of the **public** weights, precomputed once at
registration, so it costs nothing per pad. `refill-neon-bench` asserts bit-equality against the
scalar kernel before it reports any timing, and the identity holds exactly
(`exact_match: true`, no mismatching element).

Measured on the S21+ (big cores, `taskset f0`), same source at three build levels:

| refill kernel, K=896 N=896 | µs (b=4) | G-MAC/s | vs default |
|---|---|---|---|
| scalar, toolchain default `-march` | 1,881.6 | 5.12 | 1.00x |
| scalar, `-march=armv8.2-a+dotprod` | 1,200.5 | 8.02 | 1.57x |
| **hand SDOT + offset identity** | **313.6** | **30.72** | **6.00x** |

`exact_match: true` at every shape tested (896x4864, 896x896, 4864x896, 256x256), speedups
2.9-3.8x over the same-source scalar. **The identity is exact and the kernel is worth building.**

Two consequences beyond the kernel itself:

**A compiler flag is worth 1.74x of the pad phase, for free.** The shipped generic build carries
no `-march`, so it targets baseline ARMv8-A and leaves the auto-vectoriser idle. Rebuilding the
whole harness at `armv8.2-a+dotprod`, with **a byte-identical `y_digest`** (`a925beb64bbace73`
both ways, so the arithmetic is untouched):

| harness build | pad | mask | wire | unmask+verify |
|---|---|---|---|---|
| toolchain default | 4,818.9 µs | 14.0 | 1,587.2 | 6.5 |
| `armv8.2-a+dotprod` | **2,766.6 µs** | 12.3 | 1,310.6 | 5.5 |

**Refill is only ~40-45% of pad generation, so SDOT alone does not finish the job.** The bench
puts the 12 dot products at 1,881 µs (default build) inside a 4,819 µs pad phase; the remainder is
ChaCha20 keystream, the residue split and CRT recombination, and all of it scales with the same
build flags. A phone port that stops at the refill kernel would leave more than half the term
standing. ARMv8 `aes`/`pmull` are present on this device and are the obvious next lever for the
keystream.

Per-shape cost of the *shipped generic* kernel as it stands today, against the same code path on
this box's EPYC 9115 with AVX-512 VNNI:

| shape | S21+ pad (µs) | x86 pad (µs) | ratio | S21+ mask (µs) | S21+ unmask+verify (µs) |
|---|---|---|---|---|---|
| tiny (256x256) | 480.6 | 36.4 | 13.2x | 5.5 | 2.7 |
| attn (896x896) | 6,289.7 | 405.3 | 15.5x | 19.1 | 8.9 |
| gate|up (896x4864, 2 nodes) | 16,604.0 | 4,310.4 | 3.9x | 4.1 | 12.6 |
| down (4864x896) | 11,560.2 | 2,230.9 | 5.2x | 16.4 | 6.9 |

Mask and unmask+verify are **cheap on the phone** -- tens of microseconds, nowhere near the
budget. Refill is not: one `gate|up` pad costs 16.6 ms unoptimised, and a 0.5B token needs 49 pads.
That confirms the handoff's own conclusion in the strongest terms: **pad banking is mandatory, not
an optimisation.** Banked, refill leaves the critical path entirely and the per-exchange anchor cost
is `mask + unmask + verify` ~ 18-28 µs.

A sizing check for banking, using the 0.5B's ~1.36 G-MAC of offloaded work per token: refill is
3x that, ~4.08 G-MAC/token, which at the SDOT rate is ~133 ms of one big core per token against a
~63 ms token. Sustained real-time refill would therefore need **~2 of the 4 big cores continuously**,
which is exactly the thermal argument the handoff makes for banking rather than a live refill pool.

## 5. Transport: the measured distribution, which is what the routing rule wants

The handoff's routing rule is "a measured RTT distribution, not a transport name", because
decode is a serial chain of unpipelineable exchanges and one tail event costs as much as
thirty median ones. `rtt-probe` speaks the worker's real protocol at real payload sizes.

600 exchanges each, S21+ to the RTX 3070 worker, over the USB cable via `adb reverse`:

| path | shape | min | p50 | p90 | p99 | max | p99/p50 | implied 0.5B tok/s |
|---|---|---|---|---|---|---|---|---|
| x86 loopback (reference) | attn | 16.6 | **17.2** | 18.2 | 21.4 | 29.4 | 1.24 | 1184 |
| USB `adb reverse` | tiny | 494.8 | 1163.4 | 1404.9 | 2073.5 | 18947.8 | 1.78 | 17.5 |
| USB `adb reverse` | attn | 937.6 | **1268.4** | 1481.4 | 1850.1 | 3532.8 | 1.46 | 16.1 |
| USB `adb reverse` | gate\|up | 1236.7 | 1852.4 | 2093.9 | 3075.5 | 5419.4 | 1.66 | 11.0 |

(µs; `implied tok/s` = 1e6 / (49 x p50), the handoff's 0.5B exchange count.)

**The transport is 98% of the token budget** — 1268 µs of wire against 28 µs of anchor
arithmetic. Two honest caveats on that number:

- `adb reverse` relays through `adbd` in userspace plus the host's adb server, so it is an
  **upper bound** on USB, not the NCM/RNDIS figure the handoff wants. Raw tethering should be
  materially better; measuring it is section 7's first item.
- The tail is well behaved (p99/p50 = 1.46-1.78), which is the property that decides interactive
  eligibility. The one 18.9 ms outlier in 600 `tiny` exchanges is the kind of event the routing
  rule exists to catch.

So the anchor-side arithmetic is **not** the phone's problem; the link is. At ~16 tok/s for a
0.5B model this lands in the band the handoff predicted for WiFi rather than the one it
predicted for USB — consistent with the relay overhead above.

## 6. TA heap: a number the vendor conversation would have to start from

`an_footprint()` reports what the core allocates for a geometry, because a GP TA must declare
`TA_DATA_SIZE` up front:

| shape | footprint |
|---|---|
| tiny (256x256) | 97 KiB |
| attn (896x896) | 0.88 MiB |
| down (4864x896) | 4.4 MiB |
| gate\|up (896x4864, 2 nodes) | **9.0 MiB** |

One `gate|up` group of a **0.5B** model already needs 9 MiB, before the KV cache, before a
pad bank, and before anything a 4B model would ask for. The handoff's open question 2 — GP heap
limits, "traditionally single-digit MB" — is therefore not a formality: the smallest interesting
geometry is already at the edge. The spike's TA declares 24 MiB and would have to negotiate it.

## 7. What is open

1. **Measure the real RNDIS transport.** Enabling RNDIS (`svc usb setFunctions rndis`) worked — a
   `usb0` interface appeared on the host — but it switches the USB function away from adb and
   resets the debugging authorization (since restored). Enabling **USB tethering from Settings**
   instead keeps adb alive, because that uses a composite USB config; that is the way to get this
   measurement. It is the number that decides whether USB clears the interactive bar with margin,
   since everything in section 5 is an `adb reverse` upper bound.
2. **The RNDIS path needs an address.** `usb0` came up but self-assigned link-local
   (169.254.3.1); the phone ran no DHCP server, and configuring the interface needs root on this
   box.
3. **The on-path/batched refill gap is not fully explained.** The same kernel costs 1,881 µs in a
   batched loop but sits inside a 4,819 µs pad phase on the request path. The obvious suspect was
   the `schedutil` governor dropping clocks across each 1.3 ms network wait; that was tested and
   **ruled out** — `cpu4` held 2,419,200 kHz throughout an interleaved run. The non-refill terms
   (ChaCha20, residue split, CRT) account for the remainder in aggregate, but it has not been
   attributed line by line.
4. **Sustained and thermal behaviour is unmeasured.** All figures are short bursts on a cool
   device (battery 32.4 °C, cores at full clock). The handoff is explicit that a shared thermal
   envelope must be budgeted on sustained decode, not burst — and section 4's sizing check says
   banking would want ~2 of 4 big cores continuously.
5. **The SDOT kernel is a bench, not the shipped path.** `refill-neon-bench` proves the identity
   and the speedup; landing it means an `sh_simd_neon` build of `shielded-simd.c` alongside the
   AVX-512 and generic ones, selected the same way and self-checked against generic exactly as
   `sh_simd_get()` already does for AVX-512.
6. **The OP-TEE QEMU rung is still building.** It proves the TA *shape* (heap, GP API,
   world-switch cost, `TEEC_InvokeCommand` marshalling) and is worth finishing for any device
   where a signing path exists — but it cannot run on this handset, so it informs the design
   rather than this decision.
7. **The tier's own threat model is unwritten.** Per the handoff, that must precede code for any
   shipping route. For the normal-world path specifically the adversary statement is much weaker
   than `SECURITY.md`'s and has to say so explicitly.
