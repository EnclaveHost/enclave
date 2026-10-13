# Sealed-stream offline fixture (pVM browser channel)

`sealed-stream-vectors.json` is copied byte for byte from branch `pvm-cpu/portable-runtime` at 36f040d1,
`shielded/anchor/avf/runtime/pvm-rt/tests/sealed-stream-vectors.json` (sha256 a25658e2664718be8e40f476b6af3d9ac09c2e767c3545b0d143c7a68afe1931). It is the
cross-language vector the VM's Rust (`tests/sealed.rs`) and the page's module (`test/pvm-sealed.test.mjs`) reproduce, and the
offline fixture agreed for this branch: a chunked request `frame`, its `stream` (four DATA chunks and an empty FIN) and an
`aborted` variant (the same data then an ABORT with `abortReason`), the known plaintext `parts`, `enc`, `exported` (the
HPKE-exported "chunked response" secret, 16 bytes), the evidence `nonce`, `responseNonce`, and test seeds `skE`, `skR`, `pkR`,
`appId`, `runtimeId` (published on purpose; not secrets). The stream opens from enc + exported + nonce + responseNonce with
HKDF-SHA256 and AES-128-GCM alone, no HPKE. Caveat: both variants share one response nonce for test convenience, so a FIN and
an ABORT exist at the same index under the same key; a real VM chooses a fresh response nonce per response and never emits two
endings for one, so that splice is a fixture artefact, not an attack. Protocol: `shielded/anchor/avf/SEALED-STREAMING.md` at
the same commit, recorded in `docs/security/pvm-sealed-streaming-review.md`.
