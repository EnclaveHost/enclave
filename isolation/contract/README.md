# isolation/contract: the app-domain contract, backend-neutral

What every isolation backend agrees on, so that the SAME app bundle and the SAME guest runtime run on
each of them and a verifier applies one rule:

| piece | file | what it fixes |
|---|---|---|
| bundle | `bundle.go` | `ENCLAVE-BUNDLE/1\n` + canonical manifest + artifact; **AppID = sha256(all bytes)**; a non-canonical manifest or a lying artifact hash is refused |
| report binding | `report.go` | `report_data[0:32] = sha256(SPKI \|\| nonce)` (in the domain), `[32:64]` = the monitor's app ID; the report request has ONE field (`bind`), other fields are not read |
| lifecycle | `lifecycle.go` | starting -> running -> ending -> ended; a destroy during startup is deferred to startup; reclamation runs exactly once |
| protocol | `protocol.go` | the control lines (`load`, `list`, `state`, `stop`, `destroy`) and how a domain's share is resolved (manifest wins) |
| vectors | `vectors.json`, `vectors_test.go` | the conformance vectors: same bundle -> same ID, a different manifest or bytes -> a different ID, bare bytes, refusals, request parsing, lifecycle scripts |

Backends: `isolation/m3/monitor` (Linux, inside an SEV-SNP guest; imports this package) and
`windows/vbslike/host` (Windows launcher, Rust; mirrors it in `src/contract.rs` and runs
`vbslike-host vectors vectors.json`). `go test ./...` here, `go test -update` to regenerate the vectors
from this implementation after a deliberate change (bump `ABI` when meaning changes).

`cmd/bundle`: `bundle build -label A -cpu 100 -mem 256 app.wasm out.bundle`, `bundle id FILE`,
`bundle show BUNDLE`.
