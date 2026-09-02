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

For where the anchor CAN get a hardware boundary, and the two gates that decide it (an
adb-grantable permission, and OEM factory attestation provisioning), see
[SIGNING.md](SIGNING.md) — "What would change the answer". Headline: no Samsung Galaxy is a
candidate, a Pixel is, and **remote attestation, not the VM, is the open risk**.

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
6. ~~**The OP-TEE QEMU rung is still building.**~~ **DONE 2026-08-31: the anchor core builds and
   signs as a GlobalPlatform TA** (`6e3f9c52-...ta`, 138,680 bytes; text 128,413; 24 MiB declared
   heap; 13 `an_*` and 15 `sh_simd_generic_*` symbols linked). Three portability findings came out
   of it, all now fixed behind `SH_NO_LIBM` with x86 disassembly verified byte-identical:
   S-EL0 has **no `<math.h>` and no libm**; `__builtin_lrintf` still lowers to a libcall at `-O3`,
   so the aarch64 path names the instruction (`FCVTNS`, round-to-nearest-ties-even = lrintf's
   default-mode result); and `shielded-field.c` splits cleanly, since its float half is the
   **offline weight encoder** that no anchor ever runs — a TA receives `w_fixed` already encoded
   and links only `sh_balanced`/`sh_crt`/`sh_residue`. What remains unmeasured is the *runtime*
   half: world-switch cost and `TEEC_InvokeCommand` marshalling need the full QEMU image, whose
   build failed separately (missing python `cryptography`, since installed).
7. **The tier's own threat model is unwritten.** Per the handoff, that must precede code for any
   shipping route. For the normal-world path specifically the adversary statement is much weaker
   than `SECURITY.md`'s and has to say so explicitly.

# 8. Pixel 8 Pro: the anchor runs inside a protected VM (2026-09-02)

A second handset changes the answer. **Pixel 8 Pro (`husky`, Tensor G3, Android 16
CP1A.260405.005, verified boot green, bootloader locked)** probes `TIER: AVF-PVM`, and the
anchor — the real `anchor-core.c` + the shipped generic `shielded-simd.c`/`shielded-field.c`,
built with the NDK — **runs inside a pKVM protected VM**, launched from a plain `adb shell`
with the stock `vm` tool. No root, no unlock, no vendor signature, no permission grant.

| | S21+ (normal world) | **Pixel 8 Pro (protected VM)** |
|---|---|---|
| owner can read the anchor's memory | yes (`/proc/PID/mem`) | **no** — pKVM unmaps donated pages from the host kernel |
| hypervisor | none (`/dev/kvm` absent) | `kvm.arm-protected`, both protected and non-protected VMs |
| guest ISA | — | 9 vCPUs, `asimddp` **and `i8mm`** exposed |
| third-party code inside the boundary | impossible | an APK payload (`AVmPayload_main`) |

Measured in-guest, all invariants asserted per shape (`exact`, `verified`, `lie_rejected`,
`pads_distinct`; `verify_fail:1` is the deliberate lie test):

| shape | footprint | pad (refill) | mask | worker (in-guest, scalar) | unmask+verify | PASS |
|---|---|---|---|---|---|---|
| tiny 256×256 | 97 KiB | 682.6 µs | 5.9 µs | 306.9 µs | 5.4 µs | yes |
| attn 896×896 | 899 KiB | 3,747.8 µs | 10.2 µs | 708.7 µs | 7.6 µs | yes |
| gate\|up 896×4864 ×2 | 9,213 KiB | 10,595.6 µs | 3.3 µs | 3,171.7 µs | 11.0 µs | yes |

Generic C, one thread; the refill term is again the only expensive one and is bankable, and
the guest exposes `i8mm`, so the handoff's original "NEON/i8mm" kernel plan is available here
where it was not on SD888. `shielded/anchor/avf/` holds the APK pipeline (`build.sh`), the
attestation probe and the anchor payload; `vm run-app --protected --payload-binary-name
libanchor.so` is the launch.

**What this proves, precisely.** The goal was a root of trust on the operator's phone whose
secrets — pads, Freivalds `s`, plaintext activations, the KV cache — are hidden *from the
phone's owner*. On this device that property holds: the trusted half executes in memory the
host kernel cannot map, and a root shell on the host reads nothing. This run was
`--debug full` so its console could be captured; §9 closes that caveat with the `--debug none`
shape.

**What it does not yet prove: remote attestation, and the reason is exact.** The attestation
probe (`avf/payload/attest_probe.c`) ran to completion in the pVM and `AVmPayload_requestAttestation`
returned `ATTESTATION_ERROR_UNSUPPORTED (-10003)`; virtualizationservice's message was
*"AVF remotely provisioned component service is not declared"*. The APEX **does** ship the
declaration (`/apex/com.android.virt/etc/vintf/virtualizationservice.xml`, `min-level="202404"`)
and the RKP VM (`service_vm.bin`), `avf.remote_attestation.enabled` is unset (code default true),
rkpd and the RKP hostname are present — but the device's **vendor manifest is
`target-level="8"`** (its Android 14 launch generation, never raised by OTA), and libvintf drops
the `/avf` entry below `min-level`. `vintf` confirms: the assembled framework manifest lists the
`/default`, `/strongbox` and `/widevine` RKP components and no `/avf`. So pVM remote attestation
is a **launch-generation** property: a device that launched with Android 15 (vendor level
202404 — the **Pixel 9a**; the Pixel 9/9 Pro launched on Android 14 and should carry level 8 like
this unit, so they are *not* the fix) admits the component with attestation only "strongly
recommended", and one that launched with Android 16 (202504 — **Pixel 10 family**) is
CTS-required to attest. `probe-device.sh` reports this gate directly; run it inside the return
window of whatever is bought.

Also learned the hard way: `AVmPayload_getDiceAttestationChain` is a *restricted* API —
microdroid_manager refuses it (`EX_SECURITY`) for a `vm`-tool-launched payload and libvm_payload
aborts on the refusal — and a `vm run-app` piped into `head` gets SIGPIPE and stops the VM.

# 9. Phase B: the non-debuggable VM, owned by an app, reporting over vsock (2026-09-02)

§8 left one caveat: the run was `--debug full`. A debuggable pVM keeps the confidentiality
boundary but hands its owner a console, a log and a ramdump on crash, and it can never attest.
The production shape is **`DEBUG_LEVEL_NONE`**, which has none of those — so the payload needs
a mouth of its own, and the host needs a way to listen.

**The shell cannot listen.** `host/vsock-sink.c` (a static listener on `AF_VSOCK`) run from
`adb shell` gets `socket(AF_VSOCK): Permission denied` — the `shell` SELinux domain has no
vsock at all, and the `vm` tool has no connect subcommand. The anchor payload launched with
`vm run-app --debug none` still ran to `payload finished with exit code 0`, but nothing could
come out. What AVF gives the VM's **owner** instead is `VirtualMachine.connectVsock(port)`
through virtualizationservice, so the direction flips: the guest binds a vsock listener after
`notifyPayloadReady`, the owner connects when `onPayloadReady` fires.

**The owner is an ordinary app.** `host/app/Main.java` is a one-activity APK, self-signed with
the spike key, granted `MANAGE_VIRTUAL_MACHINE` with `pm grant` (the permission carries the
`development` flag), driving the `@SystemApi` `android.system.virtualmachine` classes by
reflection since the public `android.jar` does not carry them. It builds
`VirtualMachineConfig{protected=true, debugLevel=NONE, cpuTopology=MATCH_HOST, 1 GiB}`, runs
it, connects on ready and copies the stream to logcat. `build.sh` compiles it with `javac`/`d8`
into the same APK that carries the payload, so the APK's signing key is both the VM's
`authorityHash` and the owner's identity.

Result, on the locked retail Pixel 8 Pro:

```
HOST config protected=true debug=0
VM payload started
VM payload ready -> connectVsock 7777
VSOCK connected
VSOCK ANCHOR start in pVM apk=/mnt/apk vsock=host-connected
VSOCK ANCHOR cpu nproc=9 features= ... asimddp ... i8mm bti
VSOCK {"rung":"avf-pvm","K":256,...,"y_digest":"f1d79d878b6772df",...,"PASS":true}
VSOCK {"rung":"avf-pvm","K":896,"N":896,...,"y_digest":"34d62e67a3282d27",...,"PASS":true}
VSOCK {"rung":"avf-pvm","K":896,"N":4864,"nodes":2,...,"y_digest":"92328cfc4fc1e0a7",...,"PASS":true}
VSOCK ANCHOR end
VSOCK closed after 6 lines
```

| shape | `y_digest` §8 (`--debug full`, vm tool) | `y_digest` §9 (`DEBUG_LEVEL_NONE`, app-owned) | invariants |
|---|---|---|---|
| tiny 256×256 | `f1d79d878b6772df` | `f1d79d878b6772df` | all PASS |
| attn 896×896 | `34d62e67a3282d27` | `34d62e67a3282d27` | all PASS |
| gate\|up 896×4864 ×2 | `92328cfc4fc1e0a7` | `92328cfc4fc1e0a7` | all PASS |

Bit-identical. The non-debuggable VM computes what the debuggable one computed, and the only
bytes that reach the host are the ones the payload chose to write.

**What this closes.** The goal's confidentiality half now holds in the exact configuration a
deployment would ship: memory unmapped from the host, no console, no log, no ramdump, an
owner that is a normal installed app rather than a platform-signed one, and a report channel
that carries results and nothing else. SIGNING.md's reading of the AVF security page ("only
apps signed with the platform key can own pVMs") is contradicted by this run and corrected.

**Placement, measured (separate from the boundary).** The first app-owned run was slower on
the heavy shapes than §8's vm-tool run — gate\|up pad 70.5 ms vs 10.6 ms — and a slowdown that
scales with work is placement, not a `debug none` cost. The activity had been started onto a
locked screen, and its process read `cpuset=/background allowed=0-3`: the four A510 little
cores. `virtmgr`/`crosvm` are spawned from the owner's process and inherit it. The device's
groups are `background 0-3`, `foreground 0-7` (adds the four A715), `top-app 0-8` (adds the one
X3); a shell process is allowed 0-8, which is what §8's `vm` tool had. The keyguard could not be
dismissed from adb (PIN), so the fix was made the production-correct way instead:
`host/app/AnchorService.java` hosts the same VM from a **foreground service**
(`am start-foreground-service`), which sits in `/foreground allowed=0-7` whatever the screen is
doing.

| shape | owner in `/background` (0-3) | owner = foreground service (0-7) | §8 vm tool from shell (0-8) |
|---|---|---|---|
| tiny pad / worker | 829.7 / 352.1 µs | 748.3 / 356.4 µs | 682.6 / 306.9 µs |
| attn pad / worker | 7,420.8 / 3,672.9 µs | 2,217.4 / 441.7 µs | 3,747.8 / 708.7 µs |
| gate\|up pad / worker | 70,470.9 / 39,839.6 µs | 20,347.9 / 3,894.1 µs | 10,595.6 / 3,171.7 µs |

Same digests in every column. The remaining gap on the biggest pad (20.3 vs 10.6 ms) is the
X3 that only `top-app` gets; a visible activity would recover it, and multi-threaded pad
banking makes it moot. So an operator app hosts the anchor from a foreground service, and the
number to plan with is the middle column.

**What remains** is unchanged: remote attestation, gated by this unit's launch generation
(§8), needs a Pixel 9a at minimum and a Pixel 10 for a CTS-guaranteed chain.

# 10. Phase 1: the protected VM drives the real GPU worker (2026-09-02)

PLAN.md's first phase, measured. The payload no longer plays its own worker: the VM's owner
app bridges a vsock port to a TCP shielded worker, and the anchor inside the pVM runs
`harness/split-harness.c`'s flow verbatim (same fixture, same order of draws) against the
live `worker-cuda` on the RTX 3070, reached over `adb reverse`:

```
pVM (anchor) --vsock 7778--> owner app --TCP 127.0.0.1:9500--> adbd --USB--> adb server --> worker-cuda / RTX 3070
             --vsock 7777--> owner app (control: challenge in, attestation + results out)
```

Only ciphertext frames cross the bridge, so the app, adbd and the GPU box stay untrusted.
`harness/wire-fd.c` wraps an accepted fd as an `sh_pipe` without touching the shipped
`shielded-wire.c`; `wc_install` is the harness's install over a pipe the caller holds.

**Invariant 6, end to end.** Four shapes, 200 iterations each, the x86 harness and the pVM
against the same worker in the same minute:

| shape | `y_digest` x86 harness | `y_digest` pVM on Pixel 8 Pro | `peak_abs_y` (both) | invariants |
|---|---|---|---|---|
| tiny 256×256 | `0601bec04d97d455` | `0601bec04d97d455` | 3,135,145 | all PASS |
| attn 896×896 | `74789c6c47040613` | `74789c6c47040613` | 3,261,997 | all PASS |
| gate\|up 896×4864 ×2 | `ceff962ccee5c1a0` | `ceff962ccee5c1a0` | 4,334,752 | all PASS |
| down 4864×896 | `1d40d78670218483` | `1d40d78670218483` | 3,403,638 | all PASS |

Bit for bit, and `ywidth=3`: the pVM negotiated FIELD_GEMM24 with the 1.3 worker like any
other client. (These digests differ from section 3's because that table was 30 iterations;
the digest folds every iteration's products.)

**The gate reads the deciding property directly.** On this unit:
`vendor_api_level=34 board_api_level=202504 capabilities=3 protected_vm=true` →
`UNSUPPORTED (launch generation 34 < 202404)`, and the attestation request in the same run
answered `-10003` as section 8 predicted. Note the split: the *board* level is current, the
*vendor* level is pinned to the product's launch (Android 14 = 34). That is the property a
Pixel 9 shares with this phone and a Pixel 9a does not, and it is why the customer list reads
"Pixel 9a, and Pixel 10 or newer".

**Cost of the bridge, separate from the boundary.** Median exchange round trip from inside
the pVM: 5.3 ms tiny, 5.7 ms attn, 9.8 ms gate\|up, 7.1 ms down, against 1.27 ms for the
S21+'s normal-world process over the same `adb reverse` (section 5) and 18-132 µs on x86. The
extra ~4 ms is two vsock hops and a Java copy loop per direction, not USB. A native bridge in
the app, or `--network-supported` so the guest dials the worker itself, removes it; it is an
engineering item, not a trust one. Pad times are the `/foreground` cpuset's A715s (section 9).

What the Pixel 10 Pro XL adds when it arrives is one line in this same log: `ATTEST status=OK`
followed by the certificate chain, which is phase 2's first test vector.

# 11. Phase 3, first two steps: the complete trusted half on the phone, with SDOT (2026-09-02)

PLAN.md's engine port starts with two things the scoping pass put first: give the refill loop
to SDOT, and get the *complete* trusted half (`shielded-tee.c`, not the anchor subset) building
and passing on the phone. Both are done, and neither moved a byte of the x86 build.

**The kernel.** `shielded-simd.c` gains a third variant, `-DSH_SIMD_NEON` (suffix `_neon`): the
same C body as generic everywhere except `refill_rows4`, which becomes one SDOT per 16 bytes
via the exact identity `Σ x·w = SDOT(x−128, w) + 128·Σw` (section 4), with the public row sum
computed once per weight row for the twelve dots. `shielded-tee.c` grows a `simd_neon` table
and an `__aarch64__` branch of `sh_simd_get` that gates on `HWCAP_ASIMDDP` and runs the same
`simd_agree` cross-check AVX-512 gets. Every addition sits under `__aarch64__` / `SH_SIMD_NEON`
guards, and the proof that the shipped image is untouched is mechanical: the five x86 objects
(`shielded-tee.o`, both `shielded-simd` builds, `field`, `wire`) rebuilt from the edited tree have
the same sha256 as before the edit.

**On the phone, normal world first.** `build.sh probe` builds `shielded-tee.c` + field + wire +
both SIMD objects + `shielded-probe` with the NDK (bionic, static). `sh_simd_get()` on the
Pixel 8 Pro chooses `neon-sdot`, meaning the agreement check passed on this silicon;
`SHIELDED_NO_SIMD=1` chooses `generic`. `shielded-probe` against the live worker over
`adb reverse` passes everything in both modes with identical output:

```
{"exact":true,"verified":true,"lie_rejected":true,"denylist_refused":true,"local_identical":true,
 "reply_width":3,"packed_identical":true,"peak_abs_y":1981042,"field_headroom":3.65,"K":896,"N":896}
```

**Inside the protected VM.** The anchor core's one refill call site is now a build-time name
(`AN_REFILL`, default generic); the pVM payload links the SDOT object and, because the same
`/foreground` vCPU lands on an A510 or an A715 from one run to the next, measures both kernels
back to back on the same thread rather than trusting run-to-run pad medians:

| shape | generic refill | SDOT refill | speedup | outputs |
|---|---|---|---|---|
| 896×896 | 6,519 µs (1.5 GMAC/s) | 1,614 µs (6.0 GMAC/s) | **4.0×** | identical |
| 896×4864 | 10,149 µs (5.2 GMAC/s) | 2,602 µs (20.0 GMAC/s) | **3.9×** | identical |

The four-shape run's digests are unchanged (`0601bec0…`, `74789c6c…`, `ceff962c…`, `1d40d786…`),
which is the end-to-end statement that the kernel is exact. Two notes for the sizing work
ahead: with a pad batch of one, three quarters of the twelve dots are clamped duplicates that
banking at b=4 would turn into real pads for free; and the refill is now a minority of pad
generation, so the ChaCha20 + residue split + CRT path is next (section 4 measured it at
55-60% before this change).

**What this leaves for phase 3.** Steps 3-5 of the scoping: rebuild the pinned llama.cpp for
arm64 without CUDA, build `libggml-shielded.so` against it and run `ggml-test` / `shielded-run`
on the phone, and give `sh_link_open` an fd-adopting form so the whole trusted half can run
inside the VM the way the anchor subset already does.
