# The portable runtime: one app build, compiled inside every domain

Decided 2026-09-23. The app artifact distributed to every host is the **WebAssembly component** in
the contract bundle (`bundle.go`, kind `wasm-component`, refused otherwise). A domain verifies the
bundle, then **JIT-compiles the component to its own ISA inside the protected boundary**: x86-64 in a
Linux SNP guest (isolation/m3, m4) or a Hyper-V partition (windows/vbslike), ARM64 in a Pixel pVM.
Native x86-64 or ARM64 compilation is never part of the app contract. Native or ahead-of-time output may
exist as an internal optimisation inside a domain only if it preserves the same bundle identity and
trust contract; it is not a public app format and is never distributed.

Scope of the pVM CPU tier: Pixel 10 and Pixel 11, CPU only. There is no TPU tier.

## Requirements (normative; `runtime.go` encodes the ones a verifier can check)

1. **Boundary.** The JIT and the runtime execute inside the protected, measured boundary of the domain
   (the SNP guest, the pVM, the partition). Nothing outside it compiles for it.
2. **Verify before compile.** The bundle's hash (its AppID) and, where a publisher signature exists,
   its signature are checked before a byte of it is compiled. A bundle that fails is not compiled.
3. **W^X.** No page is ever both writable and executable. A runtime that cannot state this
   (`RuntimeIdentity.WX != "enforced"`) is not admissible; `RuntimeID` refuses it.
4. **No host-supplied native code.** A domain never accepts compiled code from the host, and never
   uses a compiled cache it has not authenticated.
5. **Caches.** If a domain keeps compiled artifacts, each is keyed by `CacheKey(appID, runtimeID)`,
   which covers the bundle hash, the runtime version, the target ISA and the CPU-feature policy, and is
   authenticated under a key the domain holds (`Cache: "authenticated"`); otherwise it compiles every
   time (`Cache: "none"`). Any other mode is refused.
6. **Attestation binds the runtime.** ABI/2 (`Bind2`) folds the runtime identity, the runtime and JIT
   version, the target ISA and the CPU-feature policy, into `report_data[0:32]` together with the domain
   key and the verifier nonce; `report_data[32:64]` stays the app ID, which already covers the manifest
   and its policy. A verifier recomputes the binding from the identity the domain states in its
   attestation document, so a document naming another runtime, version, ISA or feature policy does not
   verify.
7. **Lifecycle, limits, failure.** Deterministic cleanup exactly once (`lifecycle.go`), resource limits
   from the manifest policy, and fail-closed verification everywhere: an unverifiable bundle, identity or
   cache entry is refused, never worked around.
8. **Conformance.** `vectors.json` carries the runtime vectors (valid identities and refused ones, their
   IDs, ABI/2 bindings and cache keys); every backend passes them (`go test ./...` here,
   `vbslike-host vectors` on Windows).

## Wiring, by backend (the next step for each owner)

| backend | runtime identity source | binding | status |
|---|---|---|---|
| Linux domains (isolation/m2 front, m3 monitor, m4) | a `runtime.json` written by `build-domain.sh` beside the runtime in `/plat/rt` (name, version from `wasmtime --version`, ISA, the `-C` feature policy the launcher passes, `wx: enforced`, `cache: none`) | the front computes `Bind2` when the file is present and states the identity in its document under `runtime`; `judge.mjs` recomputes it | contract done; front/judge wiring not started |
| Windows partitions (windows/vbslike) | the same file inside the same guest image; the launcher's signed document repeats it | the same, plus the launcher's own `partition.guestImageSha256` | contract mirrored and vectors passing; launcher wiring follows the front |
| Pixel pVM CPU tier (Pixel 10/11) | the runtime inside the pVM states `targetIsa: aarch64` and its feature policy | the same document and binding; the pVM's report replaces the SNP report | to be implemented by the pVM lane on this contract |

Until a backend emits ABI/2, it keeps ABI/1 (`Bind`), and its documents say so; a verifier accepts only
the ABI it was told to expect.
