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

## Production qualification

The rollout compares the unchanged release `f8a5940b` with the deferred-release
candidate `83b38d61`. Both use the same pinned model, runtime settings, MTP,
GPU workers and 128-token public prompt. Cached requests have 0–1 ms prefill.
The browser automation helper is paused during timing because its CPU usage
otherwise materially changes the result. Model and prompt warmup are excluded
from the cached measurements.

| Measurement | Cached decode (tok/s) | First token (ms) | MTP accepted/drafted |
| --- | --- | --- | --- |
| Baseline before candidate | 16.0, 16.6, 16.5, 16.5 | 679–722 | 50/78 |
| Deferred candidate, first batch | 15.9, 16.2, 16.1, 16.0 | 671–718 | 49/79 |
| Deferred candidate, repeat | 15.2, 15.9, 15.7, 15.9 | 672–773 | 49/79 |
| Unchanged baseline after rollback | 15.0, 14.9, 14.9, 15.2 | 705–742 | 49/79 |
| Final deployed candidate instance | 14.4, 14.4, 14.4, 14.3 | 713–738 | 46/82 |

The unchanged baseline itself varies substantially between instances. The
first candidate instance overlapped the baseline range and exceeded the adjacent
control run. The final instance used three more MTP rounds, with lower raw
throughput. Mean wall decode time per round was 108.46 ms versus 108.09 ms
in that control (about 0.35% difference). This supports comparable steady-state
processing cost; it does not prove identical end-to-end tok/s or zero performance
difference under every workload. Do not summarize these results as an
unconditional performance guarantee. Public response hashes also vary
between unchanged baseline instances, so production text is not claimed to be
bit-identical across restarts. The fixed native small-model probe produced the
same 16 token IDs before and after the change.

In the first deferred candidate instance, host-accounted guest RAM after cached
chat was 58,449,432,576 bytes (54.44 GiB), versus 67,014,017,024 bytes (62.41 GiB)
in the preceding baseline: a 7.98 GiB reduction. Releasing 14.67 GiB of private
model pages does not imply a 14.67 GiB drop in the host's SNP VM footprint;
already-touched guest pages and their reuse affect that accounting. Keep the
existing reservation until peak usage under the full supported concurrency is
separately qualified.

Earlier immediate-retirement variants saved about 13.6 GiB of host-accounted
RAM but measured 14.4–15.1 tok/s. The deferred variant deliberately preserves
the original private pages while long-lived encoded buffers are allocated.
Temporary source buffers use direct anonymous mappings that are unmapped after
encoding; this avoids changing glibc's allocation policy for encoded weights.
Tests cover move ownership, allocation failure and actual unmapping. The latest
full-model loader fixture checks unchanged allocated blocks before the batch
flush, then the release of 14.67 GiB while every CPU tensor hash remains intact.

Both releases retain the existing GPU reconnect cleanup race: a connection can
briefly be refused while its predecessor still holds a reservation. Qualification
waits for successful warmup and a priming request before comparing cached
throughput. This work does not change the GPU reservation protocol.

The release is deployed on metal0 as `gdfd55468e`, with warmup complete and
fresh nonce/SNP/TLS verification passing on both `eyesoff.ai` and its canonical
app address. All five other app instances remained running and unchanged.
Final host-accounted guest RAM is 58,430,832,640 bytes (54.42 GiB), versus
67,279,228,928 bytes (62.66 GiB) in the adjacent control: **8.24 GiB less**.
The 24.3 GiB encoded masking data and the existing RAM reservation are unchanged.

Evidence lives in
`/home/steven/enclave-bench/shield-original-reclaim-20260929/`, including the
independently predicted release, source/backend sanitizer logs, native loader
results and the before/candidate/after benchmark JSON files.
