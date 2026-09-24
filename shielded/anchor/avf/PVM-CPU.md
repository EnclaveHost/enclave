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
| **Pixel 10 Pro XL** (mustang, Tensor G5, 16 GB, Android 17 CP2A.260805.005) | **validated 2026-09-23** (below): the protected pvm-cpu build runs; its AVF chain verifies to a pinned Google root with isVmSecure; its signed capability report is admitted by the relay's rules; self-test parity with native execution; the baseline under Model and settings |
| **Pixel 10 / 10 Pro** | same SoC and AVF stack; expected to qualify, **not separately run** |
| **Pixel 11** | **not validated.** Structured for: nothing in the build, the VM or the admission rules names a device; a Pixel 11 is admitted exactly when its evidence passes the contract above. No runtime claim, and no availability claim, until an actual Pixel 11 is run and its results recorded here. |

Eligibility on the phone itself (`Main.gate()`): vendor API level >= 202404, protected-VM capability, remote attestation
supported. These gate whether the app tries; the relay's contract decides admission.

## Model and settings

**Model: Gemma 4 E2B, Q4_0** (3,360,161,216 bytes, sha256 `5bf274a5…89fc48`), llama.cpp `ddd4ec14` with the repacking CPU
module, 6 threads (the Tensor G5's six big cores), ctx 4096, greedy, no drafter (the MTP drafter measured slower on the CPU:
LOCAL.md). The 27B is not a phone model: its weights alone exceed the VM's 7 GiB. Smaller models and other quantisations are
the first optimisation lever (below), not assumed.

### Measured baseline, Pixel 10 Pro XL, 2026-09-23 (before any optimisation)

results/cpu-baseline-20260923 (cpu/bench-baseline.sh; every run through the fail-closed driver with GRAPHS=none; the live
thermal trace across all of it; SUMMARY.md has every turn). The build measured is the research APK smp2 in mode local, dev
(model hashed, unpinned); the CPU engine is the same code the pvm-cpu build ships.

| | measured |
|---|---|
| cold start, launch -> first token (model cached in the encrypted store) | **88.3-90.5 s** (load 56.4-58.4 s of it; the rest VM boot and the stage re-hash) |
| short turn (28-token prompt, 59 tokens out), 3 cold runs | decode **13.12 / 13.99 / 14.09 tok/s**, time to first token **249-283 ms**, prefill 102-117 tok/s |
| sustained: 4 x 512 tokens back to back in one VM, 3 runs | per turn **12.4-12.6 -> 7.4-10.5 -> 6.6-6.8 -> 5.8-6.6 tok/s**; **7.55 / 7.62 / 8.44 tok/s** over the 2,048 tokens; time to first token 290 -> 990 ms |
| CPU | 5.7-6.0 cores busy (all six threads); 406-488 core-ms per token cool, 771-991 hot |
| thermals | short turns: status 0, BIG peaks 80-96 C, caps unthrottled. Sustained: status 1 after ~1.5 min, big-core caps down to 1.785 / 2.208 GHz (58 % of max), skin 41.2 C; the cool gate then waited 28-29 checks (~5 min) before the next run |
| memory | VM 7,168 MiB effective (8,192 requested; the instance keeps its creation size); phone MemAvailable 1.14-1.55 GiB while it runs |
| crash (crosvm killed mid-turn) | fail-closed: the app saw the stream reset, closed the capture `failed:no-end`, the run was refused, never scored. **No automatic restart.** Manual relaunch -> first token 89.5 s, model reused from the encrypted store (re-hashed). The driver itself waited on the dead run (fixed: lane-run2 now stops on an app-failed capture) |
| parity, quality | self-test parity: measured on the pvm-cpu build (next). Quality on this engine and model: 22/24 automatic, 24/24 with the review rows read (results/qc7, earlier build) |

Reading: one answer of a few hundred tokens on a cool phone runs at 12-14 tok/s; the phone cannot hold that. After about a
minute and a half of continuous decode the big cores are capped at 58 % and the same work costs twice the CPU time.

### Product acceptance target

Measured on a Pixel 10 through the fail-closed driver, protected pvm-cpu build, every figure from COMPLETE windows:

| # | criterion | target | baseline |
|---|---|---|---|
| 1 | interactive turn (<= 512-token prompt, <= 256 tokens out, thermal status <= 1) | decode median >= 12 tok/s, p10 >= 10; time to first token p90 <= 1.0 s (warm engine) | 13.1-14.1; 249-305 ms (**meets**, cool phone) |
| 2 | sustained 2,048 tokens back to back | >= 10 tok/s over the run and >= 8 in every 512-token window, thermal status <= 1 | 7.6-8.4, worst window 5.8, status 1 (**fails**) |
| 3 | cold start, launch -> first token, model cached | <= 60 s; a kept-alive engine answers at target 1 | 88-91 s (**fails**) |
| 4 | memory | VM <= 7 GiB, phone MemAvailable >= 1 GiB throughout | 7 GiB, 1.14 GiB (**meets**, no margin) |
| 5 | crash recovery | an interrupted turn is reported failed, never as an answer; the engine is serving again within 90 s with no user action | fail-closed yes, auto-restart **no** (**fails**) |
| 6 | parity | every boot's self-test digest equals the model's native reference | **meets** (pc-01: identical to native) |
| 7 | quality | >= 22/24 on the 24-prompt contract set (lane-score.py), default profile | 22/24 (earlier build) |
| 8 | trust | protected build (model pinned), chain verified to Google's roots, capability report admitted by the relay's rules | **meets offline** (pc-01); a live relay attach not yet run |
| 9 | stability | 50 consecutive mixed turns with no engine error | not yet run |

Targets 2, 3 and 5 are where the work is. The levers, in order: keep one engine alive across conversations (3, and the
cold start disappears for every turn after the first); restart a dead VM automatically (5); for sustained throughput, fewer
threads and a lower operating point that the phone can hold, and a smaller quantisation of the same model, each measured for
quality against target 7 (2).

## On-device validation, Pixel 10 Pro XL, 2026-09-23

results/pvm-cpu-p2: the protected pvm-cpu build **p2** (`out/anchor-pvm-cpu.apk` sha256 `2bca7b35…`, codeHash
`3b709922…`, spike signing key, model pin E2B Q4_0) through the fail-closed driver, twice (pc-01, pc-02; the second found
the identical build installed and did not reinstall).

| check | result |
|---|---|
| build in the VM | `PINS mode=protected model=pinned tier=pvm-cpu`; `MODEL ok 5bf274a5… (matches the pin)`; 7,168 MiB VM |
| decode | 13.10 and 12.98 tok/s (short turn), first token ~250 ms: the baseline, unchanged by the tier build |
| attestation | the capture now holds the whole chain (5 certificates). `relay/avf-verify.mjs` **refused every real Pixel 10 chain** ("too many DER children": Android 17 adds an empty fourth field to the AVF extension); fixed to accept that field only when it is an empty SEQUENCE. The chain then verifies: pinned Google root, isVmSecure true, APK component = p2's codeHash, pinned authority. Kept as a real-device test (test/avf-real-pixel10.test.mjs) |
| capability report | self-test `pvm-cpu-selftest-v1`: 32-token prompt at 128.6 tok/s, 64 tokens at 12.76 tok/s; the report is signed by the VM's attested transport key and `admitPvmCpu` admits it (cpu/verify-capture.mjs on the capture, and the test) |
| parity | the same engine, model table and self-test run natively on the same phone (cpu/selftest-ref.c, as the app user) give output digest `9c4c7f76…ce2f`: **identical** to the pVM's. The VM costs ~22 % of decode (native 16.38 tok/s, pVM 12.76) |
| tier enforcement | launching the pvm-cpu build in mode engine, or in mode local with the TPU graphs and bundle, is refused by the app (`HOST FAIL: tier pvm-cpu: …`) and no VM starts |

Not yet exercised on the device: a relay-bound attach (the report's nonce here is the owner's challenge; the relay path is
built on both sides and tested, not yet run against a live hub), and the payload's own refusal of a non-LOCAL run (the app
refuses first).

## Handoff: site and relay (owned by the site-refresh session)

- `relay/tunnel.js` / `relay/api-relay.js`: after an AVF attach whose codeHash is in `PVM_CPU_CODE_HASHES`, accept one
  `{t:"caps", report, sig}` frame and call `admitPvmCpu({ attach, reportBytes, signature, nonce }, pvmCpuPolicyFromEnv(env))`;
  on `eligible`, set the row's relay-owned tier to `pvm-cpu` and add a capability-based branch to `computeEligible` for the
  inference lane (not app deployments), with the verdict's `reasons` as the ineligible reason otherwise.
- `site/js/core/pricing.js` / `fleet-list.js`: the amber "pvm cpu" badge only for rows whose relay-owned tier is `pvm-cpu`;
  Pixel 11 copy stays future tense until this file records a Pixel 11 run.

## Gaps (open, in order)

1. A live relay attach from the phone (both sides built and tested; not yet run against a hub).
2. Crash recovery: the app neither restarts a dead VM nor keeps one engine across conversations (measured below).
3. The payload binary still contains the split-engine code (unreachable in the pvm-cpu build). Split it.
4. The signing key is the spike key (keys/anchor.jks); a release key and a non-debuggable manifest before any admission.
5. Prompt and answer text pass through the Android app (the owner's own UI); an end-to-end channel to the VM's attested
   key for remote use is not built.
