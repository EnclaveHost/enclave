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
| 5 | crash recovery | an interrupted turn is reported failed, never as an answer; the engine is serving again within 90 s with no user action | fail-closed yes; auto-restart **yes** since p5 (results/pvm-cpu-p5 rs-01: PASS), but serving again after 123 s (**fails** the 90 s, on the cold start) |
| 6 | parity | every boot's self-test digest equals the model's native reference | **meets** (pc-01: identical to native) |
| 7 | quality | >= 22/24 on the 24-prompt contract set (lane-score.py), default profile | 22/24 (earlier build) |
| 8 | trust | protected build (model pinned), chain verified to Google's roots, capability report admitted by the relay's rules | **meets offline** (pc-01); a live relay attach not yet run |
| 9 | stability | 50 consecutive mixed turns with no engine error | not yet run |

Targets 2, 3 and 5 are where the work is. The levers, in order: keep one engine alive across conversations (3, and the
cold start disappears for every turn after the first); restart a dead VM automatically (5); for sustained throughput, fewer
threads and a lower operating point that the phone can hold, and a smaller quantisation of the same model, each measured for
quality against target 7 (2).

Measured since (2026-09-23, evening):
- **Threads do not move target 2** (results/pvm-cpu-threads1, 8 runs): sustained decode is 7.33-7.65 tok/s with 6 threads,
  with a separate 4- or 5-thread decode pool, and with 4 threads for everything; the phone reaches 86 C on the big cores and
  halves their clocks whatever the setting. What changes is CPU: a 4-thread decode pool holds the rate for ~32 % less CPU
  (537 vs 790 core-ms per token) and keeps 6-thread prefill and TTFT, so it is now the CPU lane's default (Main.java;
  results/pvm-cpu-d4default: 14.08 tok/s at 286 core-ms per token on a short turn, against 419 with one pool). Target 2 needs
  a lower operating point or a smaller quantisation, not a thread count.
- **Where the cold start goes** (results/pvm-cpu-p5 pt-01): the model crosses the encrypted store's decryption twice, stage
  18.3 s and load 59.5 s (36.8 s of it the second read). Staging into private memory and building the tensors from there,
  after the whole-file verdict, removes the second read: the lever for targets 3 and 5.
- **The supervised restart works** (rs-01): a killed VM is run again, attests again, re-verifies the model and serves the
  next turn; the interrupted turn is reported, never answered. Its 123 s is the cold start.

## The app runtime: the same portable component, compiled inside the pVM (direction 2026-09-23)

**The app artifact is the portable WebAssembly component**, the same bundle every Enclave host runs; no host compiles an app
to x86-64 or ARM64 outside a protected domain, and native code is never part of the app contract. The llama.cpp engine
measured above is not the app: it becomes the platform's in-VM **wasi-nn** inference backend (native, in the measured APK),
which the component calls.

**JIT to ARM64 is not possible in a stock Pixel pVM** (measured: results/jit-probe-20260923). The payload's SELinux domain
`microdroid_app` is denied `execmem`, so neither an RWX page nor the W^X route (write RW, then mprotect R+X) is allowed;
it may not write a memfd either, and every writable filesystem it has is `noexec`. The only executable code is what the
measured APK carries. So inside the pVM the runtime **compiles the verified component to wasmtime's portable Pulley
bytecode and interprets it**: compilation still happens inside the protected boundary, the output is data, never native
code, and no executable page is ever created. Where a protected domain permits executable pages (Linux guests), the same
runtime compiles to the local ISA with Cranelift; the Windows VBS enclave, like the pVM, runs Pulley. One runtime
abstraction, the execution strategy chosen per domain by a measured capability probe, and the same component everywhere.

Security contract for the runtime in the pVM (each item fail-closed):

| requirement | how |
|---|---|
| runtime and compiler inside the measured boundary | wasmtime (Cranelift -> Pulley) and the Pulley interpreter are native libraries in the measured APK; the APK's codeHash is attested |
| bundle verified before compilation | the component's SHA-256 (and its publisher signature, when the bundle is signed) is checked inside the VM against the pin or the signed manifest before wasmtime sees a byte; a mismatch refuses |
| W^X | no executable page is created at all (Pulley); the platform's `execmem` denial enforces it, and the runtime also refuses to start if /proc/self/maps shows any writable+executable mapping |
| no host-supplied native code, no unverified compiled cache | deserialising precompiled modules is disabled; every component is compiled inside the VM. A compiled-artifact cache, if added, is keyed by bundle hash + runtime version + target + CPU-feature policy and MACed with a key derived from the VM's instance secret, in the VM's encrypted store; anything else is recompiled |
| identity bound into attestation | runtime name, version, config/policy digest, execution strategy (`pulley64`), the CPU-feature policy (hwcap/hwcap2) and the bundle's SHA-256 go into the capability report the attested transport key signs over the attach nonce (relay/pvm-cpu-tier.mjs) |
| lifecycle and limits | a Store per session with memory limits and epoch/fuel deadlines; deterministic teardown at session end; the VM's supervised restart (target 5) on death |
| cross-platform conformance | the same component and test vectors on the Linux host (Cranelift), Linux Pulley and the Pixel pVM (Pulley): identical outputs |

### Runtime milestones

| # | milestone | status |
|---|---|---|
| 1 | `runtime/pvm-rt` (wasmtime =49.0.0, Cranelift -> Pulley) runs the conformance component inside the pVM: verify before compile, W^X, limits, deadline, the contract's identity | **PASS on the Pixel 10** (results/rt-probe-20260923; host tests `cargo test` 5/5); a 512 MiB VM aborted on memory, open |
| 2 | the component delivered from outside the APK (streamed and verified like the drafter), and the runtime inside the anchor payload beside the engine | **PASS on the Pixel 10** (results/app-m2: every case byte-identical, a wrong digest refused before compiling; `test/anchor-app.test.mjs`) |
| 3 | `wasi:nn` (ggml) backed by the in-VM llama.cpp engine, so an inference app runs unchanged | **PASS on the Pixel 10** (results/app-m3: the component's self-test digest through wasi:nn equals the engine's own, 12/12 refusals; host tests 8/8 in tests/nn.rs) |
| 4 | `wasi:http` served over the vsock bridge | **PASS on the Pixel 10** (results/app-m4: enclave-apps' ggml-probe, unchanged, served over the verified model; host tests 4/4 in tests/httpd.rs); the relay tunnel in place of the app's test hook, and TLS into the VM, not built |
| 5 | Bind2 in the 64-byte attestation challenge and the runtime identity + bundle hash in the capability report; the relay's ABI/2 AVF attach | **evidence verified on the Pixel 10** (results/app-m5: three apps, chain to Google's root, challenge = Bind2 \|\| AppID; `test/pvm-app-attest.test.mjs` 5/5, contract vectors byte-exact); a relay-bound nonce and the relay's attach wiring not yet (handoff) |
| 6 | cross-domain conformance: the same vectors on Linux (Cranelift), Linux (Pulley), Windows, the pVM | host Cranelift + host Pulley + pVM Pulley agree |

The compiled-module cache is **absent by construction**, not switched off: pvm-rt builds wasmtime with default features
off and without the `cache` feature (`cargo tree -e features`; no `wasmtime-cache` in Cargo.lock), and it only ever calls
`Component::from_binary` on the verified bytes, never `deserialize`. So `cache: "none"` in the identity does not depend on a
flag or on HOME. `cpuFeatures: "baseline"` is literal: the engine targets `pulley64` explicitly, so Cranelift reads no host
CPU features and the bytecode is the same on every host.

For milestone 5's runtime self-test tuple (the shared judge rejects an ABI/2 document without one): wasmtime is a library
in the payload process, so a scan of that one process is complete coverage and the tuple is `exec_pages=refused:EACCES
wx=clean maps=1 scope=self` (jit_probe measured the EACCES). `scope=self` stops being honest if the runtime ever moves into
a process of its own. Measured on the Pixel 10 exactly so (results/app-m5).

### wasi:http in the pVM (milestone 4)

An Enclave HTTP app is a `wasi:http/proxy` component; the pVM serves it unchanged. `APP ... serve=http` (payload/anchor_app.h)
makes the payload verify, compile and pre-instantiate it once (runtime/pvm-rt `httpd.rs`: `pvmrt_http_open`), then accept
connections on vsock 7786 one at a time and hand each to `pvmrt_http_serve_fd`, which speaks HTTP/1.1 on it (hyper) until the
peer closes. Every request gets a fresh instance in a fresh Store (256 MiB, its own epoch deadline: 60 s, 600 s over a
model) that is dropped when the request ends; with `graph=`, every request's wasi:nn is the same one graph, so the engine's
single sequence is never shared between requests. The component cannot make an outgoing request (the build has no TLS
client and `send_request` refuses; the VM has no network anyway). The server stops on the owner's `STOP`, when the control
channel closes, or after an hour with neither a connection nor a word.

The conformance app is enclave-apps' ggml-probe (runtime/conformance/bundles/ggml-probe.wasm, sha256 `1ad17b45…`, the
bytes built from enclave-apps, not rebuilt here): `/ping`, then a greedy generation through wasi:nn. On the host it decodes
exactly what a mock model predicts, over keep-alive, a fresh instance per request; a request past its deadline gets no answer
and the next connection is served. On the phone the app's `--es app_http` hook sends five GETs and then STOP
(cpu/app-http-run.sh, check-app-http.py); the product path puts the relay tunnel where that hook is, and TLS for the app
terminates in the VM (not built: today the owner's app sees the plaintext requests, as it sees the chat).

### ABI/2 for the app (milestone 5)

Once the component has arrived, and before it runs, the payload (`app_attest_abi2`) measures its own code-page rights and
asks the VM for a second AVF certificate:

- the runtime self-test tuple, measured in this process: map a page RW and ask for R+X (`exec_pages=refused:EACCES` in a
  stock Microdroid), then scan /proc/self/maps for a writable+executable mapping; any at all refuses the run.
  `maps=1 scope=self` because the runtime is a library in this process;
- the 64-byte challenge `Bind2 || AppID`, with Bind2 = SHA-256(`enclave-bind-v2\n` || transport SPKI || attach nonce ||
  RuntimeID) and RuntimeID = SHA-256 of the identity exactly as printed (pvm-rt prints the contract's canonical JSON);
- the chain as `ABI2_LINK<i>[k]` lines, apart from the attach chain, beside `ABI2 runtime`, `ABI2 selftest` and
  `ABI2 binding`.

Who states the identity matters: here it is measured code. libpvm_rt.so (whose constants `pvmrt_identity` returns) and
the payload that computes the binding are both in the APK, and the APK's codeHash is a vmComponent of the same AVF
certificate that carries the challenge, so an identity stated by any other runtime build comes with a different codeHash.
(Under IGVM on the Linux lane the guest image is outside the launch measurement, and the identity there is asserted by
unmeasured code.)

`relay/pvm-app-attest.mjs` `verifyPvmAppAbi2` is the verifier. It checks the identity against the contract's rules, then
that the identity is canonical and a pinned runtime ID, then the tuple under the shared judge's rules. It then asks
`verifyAvfEvidence` for the challenge it recomputes from its own nonce, the transport key it holds and the app it expects:
a restated identity, another nonce, key or app is a different challenge. The contract's `runtime.mjs` is not on main yet,
so RuntimeID/Bind2/Validate are restated there and pinned to the contract's vectors (fb5e466c) in the test; import the
contract once it lands. The relay's attach does not call it yet (handoff below).

### wasi:nn in the pVM (milestone 3)

The app reaches the model only through `wasi:nn@0.2.0-rc-2024-10-28`, the WIT the server's ggml backend
(wasm/wasmtime-nn-ggml.patch) and ggml-probe use, with the server's verbs cut to what a portable app needs:
`load-by-name(<graph>)`, `{"tokenize": U8}` -> `"ids"`, `{"tokens": I32 [1,n]}` -> `"logits"` (the last position),
`{"vocab_pieces"}` -> `"bytes"` + `"offsets"`. The chain, each link fail-closed:

1. The owner's launch names the graph (`--es app_graph`); the host sends the engine's LOCAL line and `APP ... graph=<name>`.
   The payload receives the component first, then stages the model exactly as mode local does (whole-file digest against
   the pin, then every tensor hashed before use) and loads it in the CPU engine.
2. The engine runs the tier's capability self-test on its own path and emits the signed CAPS report, then hands the loaded
   model to the payload as an ops table (payload/pvmrt_nn.h, the C mirror of nn.rs `NnOps`; the layout is asserted on
   both sides) instead of opening the chat port.
3. pvm-rt links wasi:nn only for such a run and registers exactly one graph under the APP line's name. `load` from bytes
   is refused (a component cannot bring weights into the attested VM); an unknown name is not found; one execution context
   at a time (`[sessions_busy]`, as the server's default); every token id range-checked; any input beside `"tokens"` other
   than `"more"` refused rather than ignored (the server's `"all"`, `"topk"`, `"mtp"` change the answer's shape); a
   failed decode ends its context; the sequence is cleared when a context is dropped and when the Store is dropped.
4. The conformance component `runtime/conformance/nn-cli` (bundles/nn-v1.wasm) runs the engine's own self-test through
   this path. Its digest must equal the CAPS report's `output_sha256` from the same VM and the same model load: parity of
   the app path with the engine, checked by runtime/conformance/check-app-nn.py.

Not in this cut: the server's speculative and prefix-cache verbs (`caps`, `all`, `topk`, `mtp_*`, `prompt`/`marks`,
`copy_from`, `rewind`), vision, and more than one concurrent sequence. An app that needs them is refused, not misserved.

Measured (results/app-m3): parity exact; the app path decodes at 10.7 tok/s against the engine's 14.0 in the same VM, the
difference being the 262,144 logits crossing into the guest and a Pulley argmax over them each token; the server's `topk`
verb (host-side top-k) is the remedy, not built here yet.

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
- ABI/2 for apps on the phone: after the attach, when a pvm-cpu phone runs an app, read its `ABI2_*` lines (or a frame
  carrying the same fields) and call `verifyPvmAppAbi2` (relay/pvm-app-attest.mjs) with the session's nonce, the attached
  transport SPKI, the app's expected SHA-256, the pinned runtime IDs and the tier's code/authority pins; an app without
  verified ABI/2 evidence is not served as a protected app.
- `site/js/core/pricing.js` / `fleet-list.js`: the amber "pvm cpu" badge only for rows whose relay-owned tier is `pvm-cpu`;
  Pixel 11 copy stays future tense until this file records a Pixel 11 run.

## Gaps (open, in order)

1. A live relay attach from the phone (both sides built and tested; not yet run against a hub).
2. Cold start and recovery: 88-91 s cold, 123 s after a crash; one read of the model instead of two is the next change,
   then one engine kept across conversations.
3. The payload binary still contains the split-engine code (unreachable in the pvm-cpu build). Split it.
4. The signing key is the spike key (keys/anchor.jks); a release key and a non-debuggable manifest before any admission.
5. Prompt and answer text pass through the Android app (the owner's own UI); an end-to-end channel to the VM's attested
   key for remote use is not built.
