# pVM CPU: the phone tier

**pVM CPU** is the platform's inference engine running **entirely on the CPU inside an Android protected VM** (AVF/pKVM) on
the owner's phone. The model, the prompt, the context and the output never leave the VM; the Android host cannot read the
VM's memory. There is no TPU, NPU or GPU in the product path: the masked-TPU lane was closed at 2.4-2.6 tok/s against the
15 tok/s required before TPU acceleration is exposed (TPU.md, Status), and nothing of it is carried by this tier.

Its visual identity is **orange**: the design system's amber (`--amber #FF914D`, site/css/src/tokens.css), always paired with
its name ("pVM CPU" / "pvm cpu"), never colour alone. On the phone the app shows the label from the build's measured
`assets/tier`; on the site the listing badge is rendered from the relay's verified verdict (site handoff, below). Neither
label is evidence: admission is.

## What this tier is not

- **Not the OS-neutral app isolation contract** (isolation/contract, isolation/DESIGN.md T0-T2). That contract hosts tenant
  app bundles in per-app domains on servers; pVM CPU hosts the platform's own inference engine for the phone's owner. It
  claims nothing about that contract, admits nothing for tenant app deployments (relay `computeEligible` keeps `avf` out of
  app compute), and its evidence type is its own.
- **Not a TPU tier.** No TPU/NPU library is in the build (below); the VM refuses the TPU fields.
- **Not "confidential GPU" or "TEE CPU" in the server sense.** The boundary is pKVM's: the Android host is excluded from the
  VM's memory; the hypervisor, Google's DICE/RKP chain and the phone's hardware are trusted.

## The build (what runs, what does not)

`ANCHOR_TIER=pvm-cpu ./build.sh anchor` produces `out/anchor-pvm-cpu.apk`, a separate APK with its own codeHash:

| in the build | not in the build |
|---|---|
| the payload `libanchor.so`, compiled with `ANCHOR_TIER_PVM_CPU` | the split engine (`libengine.so`, `libggml-shielded.so`, `model.calib`) |
| the CPU engine: `liblocalengine.so`, `libllama.so`, `libllama-common.so`, `libggml.so`, `libggml-base.so`, `libggml-cpu-repack.so`, `libc++_shared.so` | the TPU backend `libggml-tpu.so`, the TPU worker `libanchortpu.so`, the Tensor dispatch library, the manifest's `libedgetpu_litert` declaration |
| `assets/tier` = `pvm-cpu`, `assets/anchor.mode`, and in a protected build `assets/model.sha256` | the app-side echo/bridge diagnostics; the pad-ledger, shared-prefix and catalog pins |

Inside the VM the tier is enforced, not just packaged: the payload serves **one** mode, `LOCAL` (the whole model on the VM's
own vCPUs). Any other mode, the LOCAL line's TPU tail or benchmark links, and any pad/prefix/worker/shape control line are
refused before anything runs (`TIER pvm-cpu refused: ...`). The app refuses the same launches first (host/app/Tier.java).
A protected pvm-cpu build needs the **model pin only**; carrying a split-engine pin is an error (anchor_pins.c).

**Masking.** The pads, masks, digit split, kernel verification and repair existed to protect activations sent to an
untrusted accelerator. In this tier no activation leaves the VM, so none of it is in the product path; the payload binary
still contains the (unreachable, refused) split-engine code until the payload is split, noted under Gaps. What stays is what
serves a real boundary: the attestation and its key binding, the model pin and the per-tensor verified loader, the encrypted
store, the fail-closed evidence checks.

## Capability and eligibility contract

A phone is admitted as a pVM CPU host by the relay from **evidence**, never from its model name (relay/pvm-cpu-tier.mjs,
`admitPvmCpu`). All of the following must hold:

1. **Attested VM.** The AVF attestation chain verifies to a pinned Google attestation root (relay/avf-verify.mjs), the
   challenge is this attach's, and `isVmSecure` is true (protected VM, no debuggable or unverified DICE link).
2. **The pvm-cpu build.** The APK component's `codeHash` is an admitted pvm-cpu build (`PVM_CPU_CODE_HASHES`, from pins.py)
   and its `authorityHash` a pinned signing authority. The research build is a different codeHash and is never this tier.
3. **Bound capability report.** Produced inside the VM after the model loaded, signed by the VM's attested transport key
   (the Ed25519 key the `android-avf-pvm/v2` transcript binds) over `enclave-pvm-cpu-caps-v1\n || report`, and naming this
   attach's nonce. Strict schema: tier, build mode, model digest/size/ctx, VM threads and memory, a fixed self-test's
   prefill and decode rates and output digest, the VM clock at attach and at report, and the device name.
4. **Protected build.** `mode` is `protected`: the model digest is pinned in the measured APK, so the VM refuses any
   other model before READY.
5. **A served model, run correctly.** The model digest is on the tier's list (`PVM_CPU_MODELS`) and the self-test's output
   digest equals that model's reference digest: the parity check, computed natively from the same engine and model.
6. **Measured capability.** The self-test decode rate meets the model's floor and the VM's memory its minimum; the report
   is no older than the window (default 15 minutes) and not older than the attach.

The device name in the report is shown in listings and read by no rule. A phone that passes is admitted as `pvm-cpu`, with
its measured capability attached for routing; a phone that fails is not admitted, with reasons.

## Devices

| device | status |
|---|---|
| **Pixel 10 Pro XL** (mustang, Tensor G5, 16 GB, Android 17 CP2A.260805.005) | measured: the baseline below. Attestation chain verification against the pinned Google roots: **pending** (every capture before sayEvidence kept only a truncated chain; the next pvm-cpu run records it whole) |
| **Pixel 10 / 10 Pro** | same SoC and AVF stack; expected to qualify, **not separately run** |
| **Pixel 11** | **not validated.** Structured for: nothing in the build, the VM or the admission rules names a device; a Pixel 11 is admitted exactly when its evidence passes the contract above. No runtime claim, and no availability claim, until an actual Pixel 11 is run and its results recorded here. |

Eligibility on the phone itself (`Main.gate()`): vendor API level >= 202404, protected-VM capability, remote attestation
supported. These gate whether the app tries; the relay's contract decides admission.

## Model and settings

The Pixel 10 baseline is being measured (results/cpu-baseline-20260923, cpu/bench-baseline.sh); the measured figures and the product acceptance target land here with it.

## Handoff: site and relay (owned by the site-refresh session)

- `relay/tunnel.js` / `relay/api-relay.js`: after an AVF attach whose codeHash is in `PVM_CPU_CODE_HASHES`, accept one
  `{t:"caps", report, sig}` frame and call `admitPvmCpu({ attach, reportBytes, signature, nonce }, pvmCpuPolicyFromEnv(env))`;
  on `eligible`, set the row's relay-owned tier to `pvm-cpu` and add a capability-based branch to `computeEligible` for the
  inference lane (not app deployments), with the verdict's `reasons` as the ineligible reason otherwise.
- `site/js/core/pricing.js` / `fleet-list.js`: the amber "pvm cpu" badge only for rows whose relay-owned tier is `pvm-cpu`;
  Pixel 11 copy stays future tense until this file records a Pixel 11 run.

## Gaps (open, in order)

1. The VM-side capability report (self-test + signed CAPS line) is specified here and verified by the relay module; the
   payload does not emit it yet.
2. Crash recovery: the app neither restarts a dead VM nor keeps one engine across conversations (measured below).
3. The payload binary still contains the split-engine code (unreachable in the pvm-cpu build). Split it.
4. The signing key is the spike key (keys/anchor.jks); a release key and a non-debuggable manifest before any admission.
5. Prompt and answer text pass through the Android app (the owner's own UI); an end-to-end channel to the VM's attested
   key for remote use is not built.
