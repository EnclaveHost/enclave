# Review and current boundary

This audit distinguishes observed distribution package identity from native source reproducibility. The three Rust binaries have not been independently reproduced. A failed reproduction alone cannot identify which input differed. Matching one rebuild to the pinned bytes would establish a recipe-to-byte link under the recorded environment; it would not constitute a hardware attestation or remove toolchain trust.

Ordered offline reproduction is in progress separately. No image pin, measurement allowlist, production verifier, or consumer was changed by this audit. The per-binary JSON records the audit snapshot rather than later build outcomes. Raw archive capacity metadata is private and is deliberately excluded.
