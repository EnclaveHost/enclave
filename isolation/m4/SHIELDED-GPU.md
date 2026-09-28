# Optimized 27B profile (2026-09-27)

The per-app Shield release now admits `qwen3.8-27b-mtp-q4-vl-gguf` as well as
`qwen2.5-0.5b-q8-gguf`. The 27B model requires at least 50% of each 31 GiB V100
worker, a 50 GiB guest, and sixteen vCPUs. The catalog derivation binds this policy,
model and GPU reservation to the app identity; the relay independently reproduces it.
The guest needs CPU headroom for both pools; an eight-vCPU guest starves the
helper chain. On metal0 the total pool is 24 logical CPUs, leaving room for the
five existing CPU apps and host/control processes. CPU-only apps retain their existing release and policy.

`build-shielded-engine.py --engine-git CHECKOUT --runtime GGML_RUNTIME --out OUT`
rebuilds the accepted engine patches from a fixed clean source commit, including
parallel rows and in-place recurrent state. The CPU module and engine are rebuilt
together; the GGML-only Wasmtime binary and existing dependency closure are retained.
The build emits library hashes and source/patch provenance. No experimental regrow
or ntsnap patches are included. `check-shielded-worker-config.py OUT/runtime` checks
both socket and shared-ring routes against the actual compiled backend.

`build-shielded-release.py` additionally needs `--model27` and `--tokenizer27`.
The release pins their SHA-256 digests. Supply `--haltpoll-module` with the
`cpuidle-haltpoll.ko.zst` built for the release kernel. Its measured, bounded
adaptive polling avoids frequent SNP halt/wake transitions on helper handoffs. The large model is not packed into the
initramfs: the measured loader copies the read-only host block device into private
RAM and checks its full digest before starting the app. Mutating the host source
cannot change the authenticated private copy. The tokenizer and Q4 calibration
are in the measured image.

Guestd requires `-shield-model-file /absolute/model.gguf` and
`-shield-shm-dir /absolute/rings`. Each worker must use `--shm DIR/card-N`, with
exactly 64 MiB per file. Create the directory/files with mode 0700/0600 at service
startup; preserve existing file contents when a worker is already using them.
Do not restart workers while GPU apps are running. Workers must outlive control
VM restarts. The guest sees each file through a fixed ivshmem BAR; init checks its
PCI identity/size and exposes only that BAR under the backend's restricted device
paths. Raw vsock access remains denied to the app. The ring contains masked wire
messages, never private model inputs or pads; replies retain bounded copies and
integrity checks. This transport provides no availability guarantee against a host.

The measured 27B settings use column splitting, verification overlap, 64-row pad
pools/refills, four decode threads and sixteen total refill threads (eight per card),
the checked vector CRT refill kernel, a 95% weight budget and one recurrent-state
snapshot for MTP k=1. Apps choose speculative decoding through the existing WASI-NN
API; enabling the snapshot does not force every app to use MTP. Guest context is
512 tokens and batch/ubatch 16, matching the evaluated profile.

Benchmark release IDs and results are recorded in [the production rollout evidence](evidence/shield-27b-production-2026-09-27/README.md). Historical
native-process 24.51 tok/s is not a claim for this per-app SNP runtime.
The September 27 follow-up uses the guest-tested four-thread/vector profile;
the host-specific native affinity shim is not part of the production image.
The small-model profile retains its previous thread counts and refill kernel.

---

# Historical canary stage (superseded by the production rollout above)

The rest of this document records the earlier transport/inference bring-up.
Its GPU-admission-off statements describe that stage, not current production.

## Status at the initial canary stage, 2026-09-27

The two V100-class GPUs on metal0 have dedicated untrusted CUDA workers.
A measured SNP canary executes the production Shield C client inside its guest
against both cards over AF_VSOCK. It checks exact arithmetic against the CPU
reference, Freivalds acceptance and rejection, packed-result equivalence, and
rejection of an unsupported nonlinear operation.

**Hardware transport and fixed-prompt WASI-NN inference are validated; production app GPU admission is not enabled.**
The five existing production apps continue using their original per-app guests.
The production manager still reports `supports.gpu=false` and rejects GPU
allocations. No GPU capacity should be sold or reported as ready merely because
these workers are listening.

## Boundary

```
per-app SNP guest                          untrusted metal0 host
  public test weights -- install -------> CUDA worker -> V100
  fresh mask + input ---- AF_VSOCK ------> masked matrix multiply
  unmask and Freivalds <-- AF_VSOCK ------ masked product
```

The probe is native code inside the measured guest. The guest receives no CUDA
device, and raw inputs, mask seeds, correction values, and nonlinear operations
do not move to a host-side inference service. Public weights are not secret.
This path does not support arbitrary graphics commands or native GPU video
encoding. The production app runtime's restriction on raw AF_VSOCK is unchanged.

## Reproduce the hardware gate

1. Build `shielded/worker-cuda` with `ARCHS=--cuda-gpu-arch=sm_70`.
2. Run one worker per GPU UUID, with `CUDA_VISIBLE_DEVICES` selecting exactly
   that card. Bind TCP only on loopback and expose vsock ports 9501 and 9502.
   Use separate workers and a 31 GiB reservation budget on each 32 GiB card.
3. Run `sh isolation/m4/build-shielded-canary.sh BASE_TEMPLATE APP_BUNDLE OUT`.
   It copies a pinned template, builds the current production Shield probe,
   checks the probe's libc/libm against the template, and adds a measured gate
   before the domain front starts. It does not modify the base template.
4. Launch `OUT/canary.cpio.gz` with `isolation/m2/run-domain.sh`, SNP mode,
   one vCPU and at least 1 GiB RAM. Connect an ordinary ciphertext forwarder
   to the guest's vsock port 443.
5. Verify with `isolation/m2/client.mjs`, using `OUT/measurement.txt`, the
   independently derived bundle AppID, the pinned runtime identity, AMD root,
   VCEK and TCB floor. Require fresh and second-nonce attestation, replay
   rejection, and an app response on the attested TLS key. Serial output is
   diagnostic only: it is not the attestation evidence.
6. Negative control: stop one otherwise unused worker, boot the identical
   image, and verify that it fails before exposing the front. Restore the
   worker afterwards. Do not stop workers with real workloads attached.

## Remaining application integration

- A measured inference runtime and its exact engine/backend libraries in the
  per-app release. The current release is a CPU application runtime without
  the linked GGML inference engine; a CLI `-S nn` option alone is not evidence
  that this backend exists.
- A narrow guest-side transport for the Shield backend that preserves the app
  runtime's existing vsock restriction and the front's key isolation.
- Authenticated public model delivery and calibration tied to the selected
  model; the current per-app supervisor refuses model-volume requests.
- Per-app GPU memory/share reservations and teardown, with control-plane
  inventory distinct from successful in-guest inference capability.
- A new independently reproducible and admitted release, real-model canary,
  faulty-worker tests, and then scheduler admission. Retain the existing
  `gpu=false` gates until these pieces work together.

Do not remove the launcher's rejection of legacy `shieldedWorkers` under
`ISOLATION_BACKEND` to force this through. That setting wires the old shared
control-VM tenant runtime; it does not implement the per-app runtime above.

## In-guest WASI-NN inference, 2026-09-27

A **public fixed-prompt canary** now runs Qwen2.5-0.5B-Instruct Q8_0
through the Wasmtime WASI-NN GGML backend inside a 4-vCPU, 8-GiB SNP guest.
The two V100 workers receive masked matrix operations through fixed vsock
routes. A measured root broker exposes private Unix sockets to the runtime's
UID, leaving the app runtime's raw-vsock seccomp prohibition intact. The broker
has a five-second connect deadline, bounded connection count and lifetime, and
closes connections on guest shutdown. It handles no masks or plaintext prompts.

Hardware observations (diagnostic image, not a production release):

- Fresh AMD/TCB/measurement/AppID/runtime/TLS attestation, a second nonce and
  replay rejection passed before sending the inference request.
- Initial eight-token sample: 15.84 decode tokens/s, including cold effects.
- Two subsequent 64-token samples: 64.88 and 58.55 decode tokens/s; identical
  token IDs. This is **0.5B**, not the 27B model, and not a CPU-vs-GPU speedup
  claim. These are short samples, not a sustained-load benchmark.
- Runtime counters recorded 2,094 and 2,002 successful masked socket GEMM
  exchanges on the two cards at the first periodic counter snapshot.
- A lab proxy flipped one byte of a real packed GPU reply. The guest detected
  a wrong product and returned HTTP 500 without generated-token output.
  Replacing the faulty worker with the honest worker did not clear the failure:
  the same trusted engine continued refusing inference. A fresh engine is
  required after an integrity failure.
- The original full NN runtime was rejected by W^X attestation because ONNX
  requested an executable stack. The canary uses a GGML-only Wasmtime build;
  no W^X or attestation checks were weakened.

### Reproduce the inference canary

Use `build-shielded-inference-canary.py --help`. Inputs are a pinned CPU app
image template, a prepared GGML-only runtime directory, the public model and a
WASI-NN fixed-token probe bundle. The builder pins the model SHA-256 to
`f81d63cf49568f78154f6ddc8b114f603579360c7c878831a7f95a51dc284d24`, uses
this tree's matching calibration and broker, rejects executable-stack shared
libraries, and records input hashes. The runtime directory must include the
matching CPU and Shielded backend libraries under `backends/` and the
transitive shared-library closure. Use the vendored GGML 0.18 headers to build
Shielded against the same GGML engine.

The tested Wasmtime source is the existing Enclave-patched v49.0.0 tree
(upstream base `ac0772970`) with these Cargo features and no defaults:

```
run,serve,compile,wat,parallel-compilation,cache,cranelift,component-model,
component-model-async,threads,wasi-http,wasi-nn,wasmtime-wasi-nn/ggml,pooling-allocator
```

`ELL_LIB_LOCATION` must name the matching engine libraries when building.
Do not copy unrelated ONNX/Stable-Diffusion/CUDA runtime libraries into this
profile. No GPU device is attached to the guest. Run the image with four vCPUs
and 8192 MiB, predict the measurement for those same launch inputs, then use
`client.mjs --path '/?steps=64'` with all the normal trust pins.

**The builder intentionally enables diagnostic logging of a public fixture.**
It is not suitable for user prompts or production admission. Normal hosted
apps still have `supports.gpu=false`. Remaining production requirements above
still apply: measured model selection, share-bound reservations, a quiet
production image, independent release admission, and scheduler integration.
