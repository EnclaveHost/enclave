# isolation/contract: the app-domain contract, backend-neutral

What every isolation backend agrees on, so that the SAME app bundle and the SAME guest runtime run on
each of them and a verifier applies one rule:

| piece | file | what it fixes |
|---|---|---|
| bundle | `bundle.go` | `ENCLAVE-BUNDLE/1\n` + canonical manifest + artifact; **AppID = sha256(all bytes)**; a non-canonical manifest or a lying artifact hash is refused; the artifact kind is `wasm-component` and nothing else |
| report binding | `report.go` | `report_data[0:32] = sha256(SPKI \|\| nonce)` (in the domain), `[32:64]` = the monitor's app ID; the report request has ONE field (`bind`), other fields are not read |
| lifecycle | `lifecycle.go` | starting -> running -> ending -> ended; a destroy during startup is deferred to startup; reclamation runs exactly once |
| protocol | `protocol.go` | the control lines (`load`, `list`, `state`, `stop`, `destroy`) and how a domain's share is resolved (manifest wins) |
| runtime | `runtime.go` | the runtime identity (name, version, execution mode jit/interpreter, target and host ISA, CPU-feature policy, W^X, cache mode), `RuntimeID`, the ABI/2 binding `Bind2` and the authenticated-cache key; RUNTIME.md is the normative text |
| vectors | `vectors.json`, `vectors_test.go` | the conformance vectors: same bundle -> same ID, a different manifest or bytes -> a different ID, bare bytes, refusals, request parsing, lifecycle scripts |

**The artifact is the portable WebAssembly component, on every host.** A domain compiles it to its own
ISA after verifying the bundle: x86-64 inside a Linux SNP guest or a Hyper-V partition, ARM64 inside a
Pixel pVM. Native code and precompiled cwasm are not distributable artifacts (decided 2026-09-23), so one
app build runs on every tier and a cached compilation is a per-host optimisation behind the same AppID.

Backends: `isolation/m3/monitor` (Linux, inside an SEV-SNP guest; imports this package) and
`windows/vbslike/host` (Windows launcher, Rust; mirrors it in `src/contract.rs` and runs
`vbslike-host vectors vectors.json`). `go test ./...` here, `go test -update` to regenerate the vectors
from this implementation after a deliberate change (bump `ABI` when meaning changes).

`cmd/bundle`: `bundle build -label A -cpu 100 -mem 256 app.wasm out.bundle`, `bundle id FILE`,
`bundle show BUNDLE`.
