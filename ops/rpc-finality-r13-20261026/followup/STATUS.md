# Actual qualification and next integration gates

The exact r13-final candidate f58b0b4f passed its full offline qualification (root0918, exit0). It re-ran changed capture, bootstrap, installer, recovery, wrapper and cold-reader suites, checked complete source/bundle closure, and explicitly reused receipts only for byte-identical unaffected code. Peak own tree232MiB; minimum host available17278MiB, above the16384MiB floor.

The subsequent original-game canary did NOT contact the guest. Its assembler rejected install/MANIFEST.json because the inherited stage label is still base-finality-proof-stage/r10. The candidate needs a metadata-only correction and focused installer/assembler validation; do not bypass this identity check or infer live readiness from offline PASS.

The revised sandbox canary passed17 offline tests. It measures physical host memory separately from guest memory and preserves failing exit status when the host verdict or cleanup fails. It is still PREPARED, with null final pins, and has not run on the real guest.

The derivation harness cache recipe now resolves all1757 dependency packages offline with the pinned toolchain and unchanged lock. That is dependency resolution, not compilation or test success. The first build started four crates but its Claude-owned process disappeared without a terminal receipt after the CLI returned; root verified no cargo/rustc/queue process remained. Persistent build output is retained; root will run the build under its own handle after the immediate guest canaries. No native derivation or SNP authority is claimed.

The schedule audit describes the actual source algorithm and source-pinned ProtocolVersions address, with unresolved deployed-interface and authority checks explicitly listed. A separate reader is in development. Existing unsafe/ASR adapters remain unsuitable as current finalized authority. Administrator controls are preserved; no production service or contract was changed.
