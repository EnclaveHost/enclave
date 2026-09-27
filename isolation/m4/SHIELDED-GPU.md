# Per-app SNP guests and Enclave Shield GPU workers

## Status, 2026-09-27

The two V100-class GPUs on metal0 have dedicated untrusted CUDA workers.
A measured SNP canary executes the production Shield C client inside its guest
against both cards over AF_VSOCK. It checks exact arithmetic against the CPU
reference, Freivalds acceptance and rejection, packed-result equivalence, and
rejection of an unsupported nonlinear operation.

**This is hardware transport validation, not production app GPU admission.**
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
