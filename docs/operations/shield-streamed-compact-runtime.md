# Incremental source reclamation and streamed compact weights

Implemented 2026-09-30. Full-model qualification is recorded below; these changes
are not an implicit activation on existing hosts. Original-source reclamation
and resident compact weights were already deployed. The earlier NVMe experiment
was only an offline CRT benchmark, not an integrated runtime.

## Runtime changes

`SHIELDED_SOURCE_RECLAIM_INCREMENTAL=1` retires consumed original GGUF pages
after each complete tensor registration. With column splitting, every card
finishes authentication, encoding, and retaining its slice first. A failed
retirement aborts admission. Source prefetch is explicitly incompatible: its
read-ahead callback can mark a future source consumed before authentication.
The existing batch-end behavior remains the default. This reduces startup
overlap; it does not remove an additional 14.67 GiB from steady-state memory.

The compact provider also supports authenticated disk-backed tiles. It selects
and checks the same exact bit packing and integer-GEMM layout, writes only public
encoded weights, and retains the ordered extents and SHA-256 hashes privately.
Every upload, fallback, and refill read authenticates a private buffer before
decoding. Late corruption/truncation clears the entire output; link-level
integrity failures remain latched. Masks, corrections, seeds, KV state, and
activations stay private. Mask strength and GPU result verification are unchanged.

`SHIELDED_COMPACT_STREAM_DIR` selects this provider without changing the WASI-NN
application API. A directory is supported for native qualification and must not
be tmpfs/ramfs. In the measured guest, `fd:197` names a dedicated public scratch
block device. No host filesystem is mounted in the guest. The native runtime
duplicates that descriptor and allocates disjoint bounded extents for matrices
and card slices; destroying a store returns its extents, merging adjacent free
ranges for later model loads. It never trusts old disk content. The descriptor is not a WASI
preopen. The scratch disk contains no application secrets.

The measured `shield-streamed-weights.enabled` marker selects 256-pad refills,
512-slot private pad rings, and the streamed provider. The source-reclamation
marker enables incremental retirement. The launcher supplies a 40 GiB sparse
scratch disk only for images with the stream sidecar. It unlinks the file after
QEMU opens it, so stopping or crashing the guest returns its blocks. Host disk
capacity and I/O remain necessary; this is not a reduction in storage size.
Private pad rings grow with the larger batch and offset some weight savings.

## Build and component verification

Use `isolation/m4/build-shielded-compact.py` with an ABI-matching base runtime,
engine headers/libraries, and the W^X-qualified oneDNN installation. Add
`--incremental-source-reclaim` for the resident candidate or `--streamed-weights`
for both changes. The latter requires the updated `build-app-guest.sh` and
`run-domain.sh` on the host. The builder verifies the complete release closure
and exercises the copied provider with only bundled libraries available.

Checks passed:

- ASan/UBSan compact arithmetic, partial reads, mixed layouts, concurrency,
  W^X, OpenMP restoration, bounds, and failure-output clearing.
- Disk-backed exact arithmetic through batch 256, concurrent reads, corrupted
  and truncated final tiles, output-stride canaries, and RAM-backed spill refusal.
- Backend authentication, fallback, incremental retirement before the next
  tensor, failure closure, incompatible prefetch refusal, and real two-card
  planner ordering before retirement.
- Existing Shield TEE regression suite (13 tests), privilege-drop/seccomp
  hardening, and seccomp-statement mutation tests.

Reproduce the public-matrix comparison with
`shielded/bench/build-compact-stream.py OUTPUT --onednn-root ROOT`, then
`OUTPUT/bench MODEL TENSOR BATCH REPS NVME_DIRECTORY`. It uses the actual
column-split geometry (half the output columns), alternating resident and
streamed order, and compares every product with an independent CRT calculation.
These are component timings, not application tok/s; public test encodings are
not a complete replay of production calibration or multi-session traffic.

On this EPYC 9115/NVMe host, four paired runs measured:

| Matrix | Batch | Resident median | Streamed median | Resident weight store | Streamed metadata |
| --- | ---: | ---: | ---: | ---: | ---: |
| 27B gate, one card's columns | 64 | 24.50 ms | 68.64 ms | 38.65 MiB | 0.003 MiB |
| 27B gate, one card's columns | 256 | 87.85 ms | 118.85 ms | 38.65 MiB | 0.003 MiB |
| 27B down, one card's columns | 256 | 86.10 ms | 120.23 ms | 38.66 MiB | 0.001 MiB |

Metadata excludes shared plans and worker scratch. Each worker retains bounded
private packed/decode buffers and math workspace. The batch-256 gate cost per
pad is about 21% above resident batch 64 in these measurements, rather than the
180% penalty of streaming batch 64. This is a real performance tradeoff.

## Isolated full-model qualification

Artifacts: `/home/steven/enclave-bench/shield-stream-integrated-20261001`.
Final candidate release:
`31c0bfac70a4fa829c1a72783af72641954f2ba7f299d3a960bb1b1fb22bb541`.
The 32 GiB SNP guest booted, independently attested, loaded the complete 27B
model, and generated 32 tokens. Its usable guest RAM was 31,627 MiB and its
dynamic model/application budget was 28,856 MiB. This establishes a one-session
functional result, not the production minimum for eight sessions.

Cold loading crossed the front's three-minute response deadline twice. Allowing
loading to finish and retrying the warm request succeeded: prefill 2,038 ms,
decode 14,080 ms, **2.20 tok/s**, without MTP. This is a severe speed regression;
the streamed release was **not deployed to Eyesoff-AI**. The production release
remains `d4fab4c8727ce0d07cc850d29236ec2365903789dd8c81fb008210934b22f4c8`.
Evidence: `stream32-models.json`, `stream32-attestation.json`, and the matching
verification log in the artifact directory.

A subsequent native diagnostic using the same streamed provider completed 64
normal decode steps at 12.24 tok/s, with a 411-second first-token time. Profiling
confirmed GPU exchanges on both cards; this was not total CPU fallback. Private
pad refill misses caused 4.27 seconds of synchronous refill work on card 1.
Native and SNP timings are different execution environments and do not establish
a controlled production comparison or sustained throughput after exhausting all
precomputed pads. Evidence: `native.log` and `native-run2.log`.

Cold-start diagnostics also showed per-tile file synchronization waiting on
filesystem journal commits. The current source batches dirty writes at 32 MiB
and synchronizes each completed store before admission; its sanitizer/arithmetic
test passes. That change is **not included** in the measured release above and
has not received a new full-model benchmark.

The incremental-only resident release
`a96f465497e20fe8b81b678137c2f46b27b52f69a30135ae4576a0639b18dc41`
and a 40 GiB isolated probe have been built, but not yet run as a full-model
qualification. Tests were paused to restore Eyesoff-AI and return RISC Box to
queued at the owner's request. Neither candidate has been promoted.

Remaining qualifications include sustained refill-heavy decode, multiple
sessions, and full-model unload/reload. The current source returns raw-disk
extents when stores are destroyed (including failed admission), preventing a
monotonic scratch-space leak across model loads. Sanitizer tests exercise full
capacity, exhaustion, split/merge reuse over 100 cycles, and store destruction.
This lifecycle fix also postdates the full-model candidate release above.

Do not infer an eight-session RAM minimum from a one-session probe. Host QEMU
MemoryCurrent includes the reserved SNP guest pages, not just the model heap.
Existing application share limits, TLS binding, and admission checks remain
required. No LPN or noise-based privacy change is included: those alternatives
do not by themselves remove the correction matrix and remain research.

## Production recovery after qualification

At 2026-10-01 06:28 UTC, Eyesoff-AI was restored on its existing production
release as guest `gd3d682731` (58,956 MiB reserved; CPU share 65%, GPU share 80%).
Its independently verified SNP attestation matched the expected app, runtime,
release, deployment identity, and live TLS key. Public `eyesoff.ai` certificate
verification, `/ping`, and `/models` passed. A GPU-only warm-up returned HTTP 200
and `ok: true` for `qwen3.8-27b-mtp`; both V100s held the model.

RISC Box returned to `queued`, with the supervisor reporting insufficient free
CPU capacity. The four other guests kept their IDs and remained running. The
manager configuration and launcher were byte-for-byte restored from their
pre-test backups; no canary timer, memory hold, or temporary RISC launch guard
remains. This recovery did not change production shares or reduce its reserved
RAM. Evidence is in `9eb4e600-verified-restored.json` and
`eyesoff-restored-warmup.json` in the artifact directory above.
