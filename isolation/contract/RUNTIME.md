# The portable runtime: one app build, compiled inside every domain

Decided 2026-09-23. The app artifact distributed to every host is the **WebAssembly component** in
the contract bundle (`bundle.go`, kind `wasm-component`, refused otherwise). A domain verifies the
bundle, then **compiles the component inside the protected boundary**: JIT to the domain's own ISA
where the domain may hold executable pages (x86-64 in a Linux SNP guest, isolation/m3 and m4, or a
Hyper-V partition, windows/vbslike; ARM64 where such a domain is ARM64), and to wasmtime's Pulley
bytecode, interpreted, where it may not. **A stock Pixel protected VM may not** (measured 2026-09-23 on a
Pixel 10 Pro XL, Android 17: `execmem` denied to the payload domain, anonymous RWX and RW-then-RX both
refused, no writable memfd, the data store `noexec`; evidence in the pVM lane's
`shielded/anchor/avf/results/jit-probe-20260923`), so the Pixel 10/11 pVM CPU tier compiles the verified
component to Pulley inside the pVM and interprets it, with no executable page anywhere. The identity
says which mode a domain uses (`execution: jit | interpreter`), and a verifier sees it in the binding.
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
   version, the execution mode, the target and host ISAs and the CPU-feature policy, into
   `report_data[0:32]` together with the domain key and the verifier nonce; `report_data[32:64]` stays the app ID, which already covers the manifest
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
| Linux domains (isolation/m2 front, m3 monitor, m4) | `runtime.json`, written into the image beside the runtime by `runtime-identity.sh` from `build-domain.sh` / `build-app-guest.sh`, and CHECKED against the domain by `m2/front/runtime.go` before it is stated | the front computes `Bind2` when the file is present and states the identity and its self-test in the document; `judge.mjs` `checkRuntime` recomputes the binding and pins the identity when the caller supplies `want.runtime` (`client.mjs --runtime`) | **WIRED and verified on hardware 2026-09-23**: M2 24/24 (2h/2i/2j), M3a 31/31, M4a 14/14, and N9g-N9k against the genuine signed report |
| Windows VBS enclave (VTL1, `windows/vbs`) | the same file inside the enclave image | the same binding; the enclave's report replaces the SNP report | `execution: interpreter`, `targetIsa: pulley64`, `hostIsa: x86_64`: VTL1 refuses **every** executable page (`ERROR_DYNAMIC_CODE_BLOCKED` 1655 at `VirtualAlloc` AND at `VirtualProtect`, while RW->R is allowed - so it is the EXECUTE bit alone; measured, `windows/PARITY.md`), so no JIT can ever run there. Not wired |
| Windows partitions (windows/vbslike) | the same file inside the same guest image (`plat/rt/runtime.json`), so a partition states what the Linux domains state; the front checks it inside the partition (exec_pages=allowed there) | the same `Bind2`; `windows/vbslike/verify/judge-hv.mjs` recomputes it through `runtime.mjs`; the launcher's signed document carries `report_data` unchanged | **WIRED** 2026-09-23: image `44abb52b…`, lab 34/34 on the NucBox (`windows/vbslike/evidence/lab-abi2-2026-09-23.json`), including the restated-version, unauthenticated-cache and ABI/1-downgrade refusals |
| Pixel pVM CPU tier (Pixel 10/11, CPU only, no TPU tier) | `{wasmtime, <version>, execution interpreter, targetIsa pulley64, hostIsa aarch64, cpuFeatures baseline, wx enforced, cache none}`; the component is compiled to Pulley by Cranelift inside the pVM | the same 64 bytes: the AVF `attestationChallenge` (`AVmPayload_requestAttestation`, up to 64 bytes) carries `Bind2` in `[0:32]` and the app ID in `[32:64]`; the relay's AVF attach today verifies a 32-byte sha256 of the v2 transcript, so an ABI/2 pVM attach is its own format on the relay side | pVM lane implementing on this contract; relay format not started |

Until a backend emits ABI/2, it keeps ABI/1 (`Bind`), and its documents say so; a verifier accepts only
the ABI it was told to expect.

## Status: what holds today, and what this direction still needs

Holds, on hardware (warden-host, planes kernel, 2026-09-23):

* the app artifact is the portable component in every backend, and `bundle.go` refuses anything else;
* the Linux domains state their runtime identity, bind it into `report_data[0:32]`, and **check it against
  the domain before stating it** - an executable page must be obtainable for `execution: jit`, and no page
  in the domain may be writable and executable - exiting rather than serving on a fault;
* a verifier recomputes that binding and refuses a report restated under any other runtime: name, version,
  execution mode, feature policy or cache mode, each rejected on the binding itself rather than on a field
  comparison (`negative.mjs` N9h, against the genuine PSP-signed report);
* the Go implementation, the Rust launcher and the JavaScript verifier agree on every vector.

Does NOT hold yet, and is not to be implied:

* **`cpuFeatures` is `host-detected`, not a pinned list.** The launcher passes no target or feature flags,
  so Cranelift enables what CPUID reports on the chip it runs on. The policy is bound faithfully and the
  report's VCEK does name that chip, but a pinned feature list would be strictly stronger and is the next
  piece of work on requirement 6.
* **No compiled cache exists anywhere.** Both Linux launchers pass `-C cache=n`, because wasmtime's module
  cache is on by default (measured, with a control) and m3's domains run with `HOME=/tmp`, so without that
  flag each domain would have kept an unauthenticated compiled cache. `CacheKey` is therefore a rule for
  when a cache is added, not a description of one.
* **Cross-platform conformance is partial.** The vectors are shared and pass on all three implementations,
  but no test yet runs one bundle on a Linux SNP domain and a Windows domain and compares behaviour.
* **On the IGVM path the guest image is outside the launch measurement** (`isolation/m3/PLAN.md` section
  16), so a `runtime.json` inside that image is not measured there. This is the same gap that moved app
  naming into the SVSM for M4b, and it applies to the runtime identity for the same reason: under IGVM the
  SVSM has to carry it, or the claim narrows to "the domain says so".
