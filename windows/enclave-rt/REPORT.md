# A tenant's app inside a VBS enclave

**Status: WORKING on the NucBox K11 (nucbox-k11), 2026-09-21.** A component published to the
on-chain catalog, claimed as an ordinary deployment, runs inside VTL1 and answers at
`https://api.enclave.host/x/<id>/…`. Its code and memory are inside the enclave; so is the model
it can call.

**Two worlds, and the second one is the platform's own.** `enclave:app@0.1.0` (wit/app.wit) is
written for this box. `wasi:http` is what every `wasmtime serve` app in the catalog already is, and
`src/wasihost.rs` implements its host side - wasi:io, wasi:http/types, wasi:cli, wasi:clocks,
wasi:random - inside the enclave, so such an app runs UNCHANGED. Proven with the platform's own
`hello-world:1.0.4`: its approved artifact, its existing deployment, its existing URL, now served
from inside a VBS enclave.

**What still cannot run here, exactly.** Most of this catalog is not wasi:http at all: dead-drop,
ballot, pixelboard, hookbin, handoff, tipline and the s3-ipfs-adapter are `wasi:cli/run` commands
that bind their own TCP port through `wasi:sockets`. An enclave has no socket to bind and no
reactor to poll, so that shape needs three things that are not built: brokered sockets (the host
carrying opaque bytes, with the guest's own TLS inside the enclave), a guest thread for a run loop
that never returns, and secrets delivered into VTL1. Until then those deployments are refused by
name. That is why publishing is still down: `ipfs.enclave.host` is served by the s3-ipfs-adapter,
which is exactly that shape, and the fleet has no confidential VM online to run it.

## The problem this solves

`wasmtime serve` cannot run in a VBS enclave. It needs a JIT (VTL1 has no page it may execute,
which is the property VBS exists to enforce), mmap, and Rust std over an OS that is not there. So
the first version of app hosting on this box ran the app in VTL0, beside the enclave, where the
machine's owner can read it. That is not what this platform sells, and a notice on the fleet row
saying so is not a substitute for the property.

## The shape of the answer

Wasmtime, minus code generation, split across the boundary:

| where | what | why |
| --- | --- | --- |
| VTL0, `precompile/` | wasmtime + cranelift, target `pulley64` | compiles the component to **bytecode**, which is data |
| VTL1, `src/lib.rs` | wasmtime `no_std`, `runtime + component-model + pulley` | interprets it: no executable pages, no OS |
| VTL1, `../enclave-engine/ee-app.cpp` | the gate and the four host functions | one request in, one response out |
| VTL0, `../node/appframe.mjs` | the frame codec and the world sniffer | the agent's half, one definition of the wire |

Pulley is wasmtime's portable interpreter. Because it bounds-checks in software, the runtime needs
no guard pages and no signal handler, which is what lets it live in an enclave at all.

## Measured on the box

| | |
| --- | --- |
| enclave_rt.lib | 23 MB static library, linked into `ee-engine.dll` |
| Windows API imports it needs | **none** (only `malloc`/`free`, `mem*`, `fmod`, the f128 helpers) |
| platform hooks it needs | **two**: `wasmtime_tls_get/set`, and the slot argument matters |
| compile (cranelift, VTL0) | 294 ms for a 47 KB component -> 101 KB of bytecode |
| load into the enclave | 16-21 ms |
| request handled in VTL1 | **0.28-0.32 ms** (first call 21 ms: the staging buffer grows once) |
| the platform's hello-world (wasi:http) in VTL1 | **0.069 ms** a request, 0.8 ms to load |
| the same app in VTL0 | 0.22 ms, so the enclave costs ~30% on this path |
| through the relay and the tunnel | 0.7-0.9 s round trip, which is the network, not the enclave |
| an app calling the model in VTL1 | 10.6 s for 16 tokens of qwen2.5-0.5b through the shielded path |

## What a tenant gets, exactly

- **Code and memory inside the enclave**, covered by the same attestation as the model beside it.
  Neither the Windows session, its administrator nor its kernel can read them.
- **Inference without leaving the enclave**: the `generate` import calls the engine in this same
  image, so a prompt and its completion exist in the clear only in VTL1, and the untrusted card
  still only ever sees masked activations.
- **Not** private traffic from the host: VTL0 owns the socket and carries the request and response
  frames, exactly as the platform's relay does for every other box in the fleet. Sealing that leg
  is the next piece of work; the enclave already mints a transport key for sealed inference.

## The world an app is built for

`wit/app.wit`, `enclave:app@0.1.0`: `handle(request) -> response`, plus four imports (`now-ms`,
`random`, `log`, `generate`). It is a function call, not a server, because VTL1 has no sockets.
`../enclave-app-hello` is the reference app. `worldOf()` in `../node/appframe.mjs` reads the world
out of the artifact's own bytes and answers one of three things: `enclave-app`, `wasi-http` (served
by src/wasihost.rs, unchanged from the catalog) or `wasi-cli` (a socket server, refused by name
with its lease handed back). Nothing is run outside the enclave for a tenant.

## Building it

Both halves must use the same wasmtime version: a cwasm records the engine version and its
tunables, and the runtime refuses a mismatch (it must - see below).

```
windows/enclave-rt/build-win.cmd      on the box: enclave_rt.lib + ee-precompile.exe
windows/enclave-engine/build.cmd      links the .lib into the enclave image
windows/enclave-rt/host/build-apptest.cmd   the VTL0 harness, for testing the runtime alone
```

Cross-building the library from Linux also works and is what the repo was developed with:
`cargo +nightly build --release --target x86_64-pc-windows-msvc -Zbuild-std=core,alloc,panic_abort`.

## What cost time, so it does not cost it again

1. **`memfd`/`rustix` pull std in on Linux.** The `no_std` experiment only compiles for a Windows
   target, which does not have them in its graph. Cargo also unifies proc-macro features with
   normal ones unless you pass `--target`.
2. **`panic = "abort"` must be in the WORKSPACE root profile.** In a member manifest it is
   silently ignored, and the build fails with "unwinding panics are not supported without std".
3. **The tunables have to match on both sides, and be ones an enclave can honour.** The first
   artifact was refused with "virtual memory disabled at compile time -- cannot enable CoW": both
   halves now set `memory_init_cow(false)`, `memory_reservation(0)`, `memory_guard_size(0)`,
   `memory_reservation_for_growth(0)`, `signals_based_traps(false)`.
4. **`wasmtime_tls_get/set` take a SLOT index.** Ignoring it aliases wasmtime's two thread-local
   pointers and the activation list eats itself: `assertion failed: core::ptr::eq(head, self)`.
5. **Do not allocate the response buffer per call.** Sizing it to the host's whole capacity cost
   50-70 ms a request, all of it the enclave heap committing and zeroing VTL1 pages. Persistent
   staging buffers took it to 0.3 ms.
6. **Panic messages have to be formatted into stack bytes.** There is no std and no allocator
   guarantee at panic time; without that the only report is "enclave-rt panic" and the assertion
   above is invisible.

## Open

- **The traffic leg**, above: seal request and response frames to the enclave's attested key so
  the agent carries ciphertext it cannot read.
- **Publishing**, which currently needs a stand-in. `ipfs.enclave.host` serves an S3 bucket from an
  enclave, and that adapter is a fleet TENANT: `POST /add-wasm` 502s because no host in the fleet is
  running it, not because of any one machine. Caddy on nan falls back to its local kubo for
  `/ipfs/*` reads, which is why reads still work and writes do not. The fix is a host that can run
  the adapter, and the adapter is a wasi:cli socket server (see above), so it is the brokered-socket
  build that unblocks publishing. The artifact for
  this proof was pinned locally, the CID computed to kubo's convention, and fetched into the node
  through the node's own CID verifier over ZeroTier. Nothing about the record is fictional: the
  catalog holds the true CID of the bytes. It is simply not fetchable from the public gateway until
  that tenant is back.
- **Approval**: `enclave-hello:0.1.0` is pending, so it runs only for the box owner
  (chain.mjs claimPolicy mirrors the platform's approval gate).
- **One app at a time per call**: the gate serializes, which is why the TLS slots can be globals.
  Concurrency inside the enclave needs the slot map made thread-local first.
