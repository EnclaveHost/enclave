# The soak sentinel: a leak-signalling app the hv tier can actually serve

Written by enclave-5d for enclave-87's soak on the NucBox. NOT published. Publishing needs a decision: see "Status".

## Why a new app
The soak (windows/node/ops/hv-soak/soak.mjs) sends `GET /hv-soak/<token>` with the same token in `x-hv-soak`. It looks for
that token on the partition's console and in the node's and manager's logs. Neither existing candidate can trip it on hv:
- **hello-world 1.0.4** never prints a request, so the token check cannot fire;
- **hookbin 0.1.4** (appId 0xf7e65a8f) declares `http:8000`, a wasi:cli app with its own TCP server. It needs bundle/2,
  and the hv plan refuses it before any claim: node-bridge.mjs isolationPlan, "the version serves HTTP on its own port
  (http:8000), and the manager cannot serve bundle/2 yet" (manager/server.mjs SERVES = [bundle/1]).

## What it is
A **wasi:http proxy component** (bundle/1: `wasmtime serve -S cli`, no ports), the only kind the hv tier serves.
- Every request prints `<tag>-STDOUT-REQ <method> <path> <x-hv-soak>` to stdout and `<tag>-STDERR-REQ …` to stderr.
  A guest that gives the app the console (v40's domexec) puts the token there; a fixed guest sends both to /dev/null.
- GET on any path answers 200 text/plain with `<marker> token=<x-hv-soak> path=<path> printed stdout=<n>B stderr=<n>B`.
  The token echo lets the soak count the sample as exercised (enclave-bf's amended G1). The byte counts are what the
  write calls accepted (FAILED if one refused): the app SAYS it printed, so a console showing nothing proves the
  discard rather than a quiet app (enclave-87).
- HEAD tries to send a body `<tag>-HEADBODY <path> <x-hv-soak>`. The runtime drops it (below).

This build:
| | |
|---|---|
| tag | `SOAKf22fbcb7623d` |
| marker | `hvsoakbody289ec97d2c0e` |
| build | `SOAK_TAG=SOAKf22fbcb7623d SOAK_MARKER=hvsoakbody289ec97d2c0e cargo build --release --target wasm32-wasip2` (Cargo.lock from isolation/m2/app, wasi 0.14) |
| component | `soak_sentinel.wasm`, 66707 bytes, sha256 `9a1288fec6496f877e1d37004b3b3b37d09ba195673333d6b1616493107cc7a7` (this workstation's toolchain; rebuild and compare before pinning) |

## Measured under wasmtime 48.0.1 `serve -S cli` (the guest's runtime version), 2026-09-26
- `GET /hv-soak/<token>` with `x-hv-soak: <token>` → 200, chunked, body `hvsoakbody289ec97d2c0e token=<token>
  path=/hv-soak/<token> printed stdout=115B stderr=115B`. stdout had `SOAKf22fbcb7623d-STDOUT-REQ GET /hv-soak/<token>
  <token>` and stderr the STDERR twin. With stdout and stderr sent to /dev/null (a fixed guest), the body still reads
  `printed stdout=71B stderr=71B` for a shorter token.
- `HEAD /hv-soak/tokH` → headers only, no body bytes on the wire, both chunked and with an explicit `content-length: 44`.
- A variant (not this app) that declares `content-length: 2` on a GET and writes more → exactly 2 body bytes on the wire.

So **no app the hv tier serves today can reach the front's unsolicited-response guard**, because the runtime's HTTP server
frames every response. The guard's hv evidence stays the canary's lab bundle/2 load (CANARY-v41.md item 2) and its unit
tests. The vector opens only when the manager serves bundle/2, and then hookbin (HEAD answered with its body, keep-alive)
is a target. A soak that requires a "withheld" line per exercised hv sample would never count a sample.

## Pin and prepare (enclave-87: pin it, prepare the calldata, send nothing)
`pin-and-prepare.mjs` pins the component with the agent wallet's signed upload, as cli/enclave.mjs pinBytes does.
It simulates `publishVersion(slug "hv-soak-sentinel", …, cid, [0,0,128,1], ports "", config "", fee 0)` from the agent
wallet, and prints that calldata and `setApproval(appId, 0, 1)`'s for the Trezor. It sends no transaction.
Timing: the daily pin cleanup on nan (04:17 UTC) unpins a catalog-LISTED CID that is not deployable (Pending counts). So
send 1 and 2 in the same session, before a 04:17. A CID that is pinned but not yet listed is never touched.
First run 2026-09-26 ~02:45Z: the upload token was issued, but `ipfs.enclave.host/add-wasm` answered 502, as did an
unauthenticated POST (a live gateway answers 401). nan-wasm-gateway looks down. NOT pinned yet.

## Status
The catalog owner is 0x0b2d…ee61 (Steven's Trezor). A version the agent wallet publishes stays Pending. The CLI deploys a
Pending version only with `--private`, and the hv tier refuses private deployments. So using this app needs ONE
`setApproval(appId, 0, 1)` from the Trezor. The version must also carry an EMPTY config: `enclave publish` always adds
`{"wasi":"0.2"}`, which the hv plan refuses (config beyond `_media`). So pin it with the agent wallet's upload token, then
call `publishVersion(slug, name, desc, "1.0.0", cid, [0,0,128,1], "", "", 0)` directly. enclave-87 decides whether to
publish.
