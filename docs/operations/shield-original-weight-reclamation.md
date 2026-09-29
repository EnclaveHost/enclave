# Original model-weight reclamation

The opt-in measured Shield runtime (`--original-source-reclaim` in
`isolation/m4/build-shielded-engine.py`) retires the original quantized GGUF
pages after copying their tensor into private memory for authenticated encoding.
It does **not** remove the encoded int8 rows used for local mask generation,
change the pad dealer, relax GPU result verification, or reduce the KV/MTP caches.

## Trust and ownership

`shieldmodel` still copies the full pinned public model into the isolated guest
and checks the existing whole-file SHA-256. With the runtime marker enabled, it
uses an explicit private tmpfs under the model directory: initramfs may use
ramfs, which does not support hole punching. The model remains read-only by path.
Init passes the native runtime two narrow inherited descriptors before dropping
privileges: a writable handle to that private copy and a read-only handle to the
public-model block device. Neither descriptor is a WASI application handle.
The existing uid/capability drop, protected-path checks and seccomp filter remain.

The native loader parses only metadata using llama's no-allocation mode. It
binds tensor name, type, dimensions, length and SHA-256 to the already verified
private bytes. CPU tensors (including token embeddings) are copied into private
resident buffers. Only calibrated quantized matrices accepted by the backend's
source-placement rules get non-host source buffers, whose guarded pointers
cannot be accessed as ordinary CPU memory.

On the first source read, a private destination receives the original bytes;
only complete pages strictly within that tensor's extent are punched out of the
private file. Adjacent tensor boundary pages remain intact. The backend verifies
the destination before encoding it. A subsequent source read uses the public
backing device and authenticates the entire tensor against the private table.
No host-backed mmap or one-time verification of mutable host bytes is used.
An unexpected fallback still passes through this authenticated read interface.
A failed read, authentication or reclamation refuses the load rather than
silently using missing or unauthenticated data. Source and backing files must
not alias. CPU embedding lookups never become secret-dependent storage reads.

This mode is single-model per native process, matching the existing Shield
process-lifetime weight registry. A second model load is refused; restarting the
isolated app rebuilds the verified private source. Do not enable it on a runtime
that expects multiple independently unloaded/reloaded models in one process.

## Validation and measured capacity

The 27B static calibration inventory suggested 15.667 GiB. Actual placement is
stricter: 408 tensors qualify, totalling 15,754,321,920 bytes (14.673 GiB).
A full-model loader test actually released 15,752,646,656 bytes of file blocks
(14.671 GiB); 1,675,264 boundary bytes remained. Other original tensors remain
necessary for CPU execution. Do not advertise 15.7 GiB as confirmed savings.

Checks run for the implementation:

- ASan/UBSan source tests: real block release, intact neighbouring bytes,
  authenticated rereads, tampered/truncated backing, descriptor mismatches and
  explicit hole-punch failure.
- Existing backend authentication tests, including local mask minting and exact
  narrow/wide fallback after original source mappings are absent.
- Real 0.5B and 27B no-allocation loader integration; full 27B test constrained
  to a 4 GiB cgroup, with a 3 GiB peak and no swap.
- Inherited-descriptor integration against the unchanged production engine,
  with the model file read-only by path.
- Measured model copy/hash tests and guest seccomp statement/mutation tests.

The engine recipe can retain the existing ABI-matching pinned llama/GGML/CPU
binaries with `--reuse-engine-runtime`. Use the matching existing engine flags
and pinned revision; this is not permission to combine unrelated engine ABIs.
The new shim links the measured libcrypto closure for accelerated SHA-256.
`runtime-closure.py` includes its transitive dependencies while preserving the
existing pinned runtime libraries. It checks all ELF dependencies and runs the
loader with only the bundled filesystem visible. A host `ldd` check alone can
silently resolve omitted libraries from the build machine and is insufficient.

Changing the runtime changes the domain release measurement. Independently
predict/admit that release before restarting the app. Keep the prior release
admitted for rollback. Guest reservation floors and the host's app-RAM budget
must not be lowered merely from the static tensor estimate: qualify actual
inference peak memory, cache occupancy and throughput first.
