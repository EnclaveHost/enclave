# Original model-weight reclamation

The opt-in measured Shield runtime (`--original-source-reclaim` in
`isolation/m4/build-shielded-engine.py`) retires the original quantized GGUF
pages after a registration batch finishes authenticated encoding and allocation.
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
private bytes. CPU tensors (including token embeddings) remain in their original
private pages under one read-only mapping and CPU buffer. Only calibrated quantized matrices accepted by the backend's
source-placement rules get non-host source buffers, whose guarded pointers
cannot be accessed as ordinary CPU memory.

Each source read first fills a private destination, which the backend verifies
before encoding. The original private pages remain throughout the registration
batch, including both cards' reads, so their early retirement cannot change the
allocation of long-lived encoded weights. At the successful end of the batch, a
registered callback punches only complete interior pages of consumed tensors.
CPU tensors and unread sources remain intact. A release failure latches the
backend closed before inference. Later reads of retired sources use the public
backing device and authenticate the entire tensor against the private table.
The CPU mapping is of the authenticated private tmpfs, never the public block
device. No host-backed mmap or one-time verification of mutable host bytes is used.
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
  narrow/wide fallback after original source mappings are absent, including
  reconstruction of both column slices when a two-card link is unavailable.
  The fallback must never treat one card’s half-width product as a full tensor
  or read the retired original mapping after a shape refusal.
- Real 0.5B and 27B no-allocation loader integration; full 27B test constrained
  to a 4 GiB cgroup and no swap. The revised mapping test additionally hashes
  every retained CPU tensor before and after reclaiming all 408 GPU sources,
  and verifies that CPU tensors share one buffer. The first implementation
  peaked at 3 GiB; the revised file-backed test reached its 4 GiB cgroup limit
  while reclaiming page cache, without an OOM or swap.
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

The first production qualification saved 13.35 GiB of total guest RAM after
prefix warmup (57.88 to 44.53 GiB), while preserving output and MTP acceptance.
It was withdrawn because cached throughput measured about 15.0 tok/s versus a
back-to-back baseline near 15.7. The second candidate preserved the original CPU mapping/buffer layout, but
also measured about 15.0 tok/s and was withdrawn. The next candidate puts only
temporary source copies in direct anonymous mappings and unmaps them after
encoding. The SHA streaming scratch uses a bounded 64 KiB stack buffer. These
changes avoid large scratch allocations changing glibc's dynamic mmap threshold
and the allocation of long-lived encoded weights. This is an allocator
hypothesis until qualified by a production A/B test; encoded int8 allocation,
masking and verification remain unchanged.

Scratch-buffer tests verify move ownership, allocation failure and that released
mappings are absent (`mincore` returns `ENOMEM`). Prefetch and authenticated
source tests pass, and the revised runtime completes 16 native decode steps on
the small model with 720 MiB peak RAM. A full 27B loader run releases
15,752,638,464 bytes (14.671 GiB), retains all CPU tensor hashes and uses a 3 GiB
peak without swap. Allocated-block accounting differs by a few pages between fixture runs. Performance qualification must pass before retaining this
release in production; loader correctness alone is not throughput evidence.

A fresh baseline measurement before the third candidate produced 14.8, 15.1,
15.1 and 14.8 tok/s (median 14.95), with 709–738 ms first-token latency and
0–1 ms cached prefill. It overlaps the withdrawn candidates, so the earlier
15.7-versus-15.0 difference cannot yet be attributed solely to reclamation.
Compare the third candidate with this fresh baseline using the same prompt,
MTP acceptance, cache state and inactive browser automation helper.

The scratch candidate was also withdrawn after 14.4–14.9 tok/s samples versus
the latest 14.8–15.1 baseline. It reduced total guest RAM from 62.46 to 48.85 GiB
after cached chat, but the small speed difference remains unresolved. Two host
CPU-placement trials were reverted. The next candidate defers retirement until
all registrations in the current planner batch have completed, preserving the
private original pages while encoded allocations are created. Its callback is
installed only with the verifier before registration; failures latch all cards
closed. Unit coverage checks callback ordering, rejection before verifier
admission, duplicate/late installation, and failure before graph execution.
