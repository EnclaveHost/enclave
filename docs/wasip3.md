# WASIp3 (component-model async) on the platform

Status, 2026-07-31: platform support implemented behind per-box capability
gating; canary rollout pending the next fleet release. The p2 path is
untouched at every point — a box that proves nothing serves wasip2 exactly as
before.

This is the design record for platform-side p3 support and the answers the
app side (enclave-apps) asked for before starting migration. Publisher-facing
instructions live in the develop guide (`site/develop.html`, WASIp3 chapter);
this file is the *why* and the operational map.

## What p3 buys, and what already existed

wasip3 components are async at the component-model level: one instance holds
many in-flight requests, imports don't block the instance, and bodies/tokens
are native `stream`s. That is the right substrate for agent workloads (LLM
tool loops are I/O-bound). Threads are NOT part of this: wasi-threads is
p1-only, shared-everything-threads has no toolchain, and nothing here changes
the one-process-per-deployment model.

More was in place than anyone remembered:

- The fleet wasmtime (v45.0.0, `wasm/Dockerfile.wasmtime`) has
  component-model async compiled in, and `wasm_manager.py` has passed `-Sp3`
  on every launch since the wasmtime-45 verification pass (`WASM_P3=0` is the
  operator kill-switch).
- The egress patch and the cross-tenant loopback wall were written
  p3-inclusive from the start: they hook `wasi-http/src/p3/request.rs` and
  the p3 sockets host as well as the p2 paths. **Dedicated-IP egress and the
  loopback wall hold for p3 guests with no further toolchain work.**
- Every layer/preamble gate (upload gateway, CLI, browser, runner) keys on
  the component LAYER field, which is deliberately version-proof: p3
  components were never refused.

What was missing — and what this change adds — is everything that lets the
platform *know* a component is p3: world-contract detection at publish,
`wasi` in version metadata, per-box capability probing, claim routing, and a
reproducible p3 build recipe.

## 1. Instancing and billing (the decision)

**Instancing.** A deployment is still exactly one `wasmtime serve` process.
Within that process, wasmtime 45 gives p3 components **long-lived, reused
instances serving concurrent requests**: by default an instance is reused for
up to 128 requests, serves up to 16 concurrently, and is dropped after 1s
idle. p2 components keep strict instance-per-request. We adopt wasmtime's
defaults rather than inventing our own; a publisher tunes them per VERSION in
the config envelope:

```json
{ "wasi": "0.3", "p3": { "maxConcurrent": 4, "maxReuse": 256, "idleSeconds": 5 } }
```

(`wasm_manager._p3_tuning`; clamped to concurrent 1–64, reuse 1–1024, idle
0–120s; unknown keys ignored; only emitted for a component classified 0.3.)

**Isolation.** Unchanged where it matters: tenants are isolated by process,
memory cap, MPS caps, the loopback wall, and the egress path — none of that
moves. What p3 changes is *within one deployment*: concurrent requests to the
same instance share linear memory and guest state. That is one tenant's own
app sharing state with itself — the same trust domain — and it is precisely
the feature (agent session state without a database). Publishers whose
handler assumes per-request isolation set `"p3": {"maxConcurrent": 1}` (they
still gain instance reuse: state warm across sequential requests) or stay p2.

**Billing: unchanged, deliberately.** Billing is per-second of the share you
hold while leased. It never counted requests, so "per-instance-serial" was an
accident of p2's instancing, not a billing term. A p3 instance serving 16
concurrent requests burns the same share-seconds as one serving 0 — the
concurrency is the app's throughput win on capacity it already bought. No
per-request billing dimension is introduced. The share still bounds real
resources: linear memory is capped by `-W max-memory-size` regardless of how
many requests share it, and CPU time by the share's cgroup/MPS envelope.

## 2. Detection, metadata, claim routing

- **Detection** reads the binary, never asks the publisher. The top-level
  component export section decides, in the same order `wasmtime serve` tries
  instantiation: `wasi:http/handler@0.3.*` → p3 (`service` world),
  `wasi:http/incoming-handler@0.2.*` → p2 (`proxy`), `wasi:cli/run@0.3|0.2.*`
  → run-mode. Mixed imports are expected and ignored — rustc's wasip3 std
  still imports WASIp2 APIs by design, and serve links both API sets into one
  linker. Four lockstep copies: `wasm_manager._component_contract`
  (authoritative, at launch), `scripts/ipfs-add-gateway.py` (reports
  `{cid, wasi, world}` from `/add-wasm`), `cli/enclave.mjs` and
  `site/js/pages/apps.js` (stamp the version config at publish).
- **Metadata**: `"wasi": "0.3"` in the version config envelope — the
  `gpuOptional`/`_media` pattern. No catalog schema change, no new column, no
  contract redeploy, and nothing touches `EnclaveDeployments` (which has ~78
  bytes of EIP-170 headroom and must not be edited for this). Undeclared =
  "0.2": every pre-p3 version, correctly.
- **Claim routing**: the manager probes its own binary for `-S p3` (`-S help`
  contains `p3[=y|n]` — the loopback-probe doctrine: never pass an option the
  binary doesn't prove, unproven means don't pass), reports `p3` on
  `/health`; the supervisor forwards it on `/availability`; the relay ANDs it
  across the claiming fleet. `considerClaim` refuses a `wasi: "0.3"` version
  on a box that doesn't serve p3 — same shape as the volume and secrets
  gates. Launch re-classifies the actual bytes, so a config that lies fails
  loudly on the box, not silently in routing.
- **Coexistence**: versions are append-only and each declares its own
  contract, so one slug serving a p2 version and a p3 version side by side is
  the normal case, not a special one.

## 3. wasi:nn (the decision: 3a now, 3b next toolchain cut)

**3a — the 0.2 bridge — works today with zero toolchain changes.** wasmtime's
serve command links wasi-nn into the same linker both worlds instantiate
from, so a p3 component importing `wasi:nn@0.2.0-rc-2024-10-28` resolves
against our patched backends (ggml, onnx/CUDA, sdcpp, `-S nn-graph`
preloads) exactly as a p2 one does. All six nn apps can migrate their http
surface to p3 without waiting for anything.

The bridge's one real cost: 0.2 `compute()` is a **sync** hostcall. In a p3
instance's event loop a sync hostcall blocks the loop, so during an inference
the instance's other in-flight requests stall. Guidance for nn apps on the
bridge: set `"p3": {"maxConcurrent": 1}` (correct serialization, and reused
instances still keep guest state warm between requests — already better than
p2's fresh-instance-per-request), or accept the stall if requests are short.

**3b — `wasi:nn@0.3-draft` — is authored and committed** at
`wasm/wit/wasi-nn-0.3-draft/wasi-nn.wit`: 0.2-shaped (tensor/graph/errors
unchanged; ports are adapter swaps) with `load`/`compute` async and
`compute-stream: async func(...) -> result<stream<u8>, error>` — the host
pushes tokens/frames and closes; guest-side polling loops disappear, and
first-byte/heartbeat behavior falls out of forwarding the stream. Host
implementation lands as a new patch in the wasmtime toolchain stack at the
**next WASMTIME_IMAGE cut** (manual `toolchain.yml` run + digest repin in
`Dockerfile.wasm` — the same operational event as any toolchain move, and it
changes the measurement, so it is scheduled, not slipped in). Both interface
versions link into one process and share the preload registry, so 3a and 3b
coexist during migration.

## 4. Reproducible builds (the decision: pinned container, publish gate open)

First, the honest correction: **there is no byte-for-byte source-rebuild
verifier today — for p2 either.** The app trust chain is: CID re-derived
in-enclave from the fetched bytes by the attested wasm-manager before launch
(`ipfs_fetch.fetch_verified` + the attestation's explicit "the CID itself is
NOT in a hardware register" coverage note), publish-time CID readback in the
browser, and Sigstore provenance for the platform itself. "Rebuild the CID
from source" is a property publishers can offer their users, not a platform
gate. p3 must not be held to a bar p2 never met, so the p3 publish gate is
OPEN, not held for tier-2 std.

What we ship instead is the recipe that makes independent rebuilds
*possible*: **`wasm/Dockerfile.wasip3-build`**, the blessed container —

- base image by digest (the repo's standard discipline),
- **`nightly-2026-07-25`** (rustc 1.99.0-nightly, da86f4d07 2026-07-24) with
  `rust-src`, because stable ships no wasip3 std and `-Zbuild-std` is
  nightly-only (verified against the dist manifest: wasm32-wasip3 has no
  artifacts at all),
- wasi-sdk 25.0 by sha256 for wasi-libc's C side,
- `RUSTFLAGS=--remap-path-prefix…` and `--locked` baked in, so checkout paths
  and unlocked resolves can't change the bytes,
- one command: `cargo build --release --target wasm32-wasip3
  -Zbuild-std=std,panic_abort --locked`.

Publishers commit `Cargo.lock` (enclave-apps already does) and note the
container tag in their README. When rustc ships tier-2 wasip3 std, the
container pin moves to that stable and the nightly clause retires. When a
rebuild verifier is built, it verifies p2 and p3 through the same door; the
p3 recipe was designed so that day needs no new decisions.

One canary-order caveat: the nightly's std binds the `wasip3` crate 0.6.x,
wasmtime 45 serves `wasi:http@0.3.0-rc-2026-03-15`. The rc snapshots must
agree for the EXPORTED world (imports stay p2 and always link). The p3
hello-world on the canary is exactly the test of that alignment — if it
fails to instantiate, the fix is moving one pin (app-side wit-bindgen
bindings or the nightly), not a redesign.

## 5. Gateway behavior (documented; no fix needed)

The ~180s cut is an **idle** timer, not a wall clock, at two places: the
api-relay's `proxyTo` (`timeout: 180000` on the upstream socket, path B) and
the SNI relay's spliced-socket `IDLE_MS` (path A). Any body byte resets
either. p3 native streams therefore behave exactly like p2 streams: **emit
something every <180s or be cut.** SSE comment heartbeats pass through
untouched — verified: there is zero SSE-aware, content-type-aware, or
buffering code in either proxy (`proxyTo` pipes; the in-CVM `/x/:id` hop
pipes with no timeout; response bytes are tenant-owned). Two standing
sharp edges, p2 and p3 alike, worth repeating to app authors:

- Nothing flushes headers before the first body byte. Emit an early byte
  (SSE `: comment` is fine) if clients need the 200 promptly.
- Path A (app subdomain, TLS-in-CVM) forwards the browser's
  `accept-encoding`, so a guest that gzips an SSE stream buffers it — send
  `content-encoding: identity` for streams. Path B strips it.
- Tunnel-attached enclaves (metal0) fully buffer request and response —
  streaming is structurally impossible there. p3 streaming apps belong on
  hosted boxes; the canary is one (below).

App-to-app egress is a byte-transparent SOCKS5-CONNECT + splice with no HTTP
parsing and no idle timer post-handshake; the transparent-egress patch hooks
BOTH wasi versions' outbound paths. IPv6-only default and all SSRF checks
unchanged. Nothing in the egress plane can tell a p3 guest from a p2 one.

## 6. Rollout

1. This change lands **inert**: detection stamps metadata, probes prove the
   flag the fleet already passes, no version on-chain declares `wasi: "0.3"`
   yet, so no behavior changes anywhere. p2 regression surface: none (the
   only p2-visible edits are a probe in front of a flag the binary provably
   has, and additive fields).
2. **Canary = kryptos** (the hosted GPU box). It runs the current
   wasmtime-45 toolchain (probe proves p3), it is not tunnel-attached (real
   streaming), and it carries the nn stack the six nn apps will eventually
   need. metal0 is exempted naturally: its stale manager advertises no `p3`,
   so it refuses p3 claims and drags the fleet-AND false — which is the
   correct public signal during canary.
3. **Publisher opt-in** is the existing dev flow: publish the p3 version
   (stamped automatically), deploy it `--private` pre-approval (devDeploy),
   pinned to the canary — console: pick kryptos in the target list (the p3
   gate allows a picked p3-capable box and says so); CLI: deploy warns and
   names the capable boxes, `enclave move <id> kryptos` pins; MCP:
   `claim_hint {id, enclave}`. Incapable boxes refuse the claim with a
   readable reason, so a mis-routed p3 deployment queues instead of burning
   a lease.
4. **General availability** = every claiming box's probe proves p3 → the
   relay's fleet-AND flips true → consoles offer p3 without the canary
   warning. No flag day, no forced migration: p2 versions serve forever
   (the proxy world stays linked), and publishers keep p2 builds published
   alongside p3 ones for as long as they want.

## Answers to the app side's four questions

1. **Instancing/billing**: long-lived reused instances, ≤16 concurrent
   requests per instance (wasmtime 45 defaults; per-version `p3` tuning
   knob). Billing unchanged: per-second share billing, no request dimension;
   intra-instance isolation is the app's own concern (`maxConcurrent: 1` to
   opt out). See §1.
2. **nn path**: 3a bridge is live NOW (import `wasi:nn@0.2.0-rc-2024-10-28`
   from p3 worlds unchanged; set `maxConcurrent: 1` for long computes). 3b
   `wasi:nn@0.3-draft` WIT is committed (`wasm/wit/wasi-nn-0.3-draft/`) —
   bind guest code against it when you're ready; the host lands at the next
   WASMTIME_IMAGE toolchain cut. See §3.
3. **Toolchain**: pinned-nightly blessed container,
   `wasm/Dockerfile.wasip3-build` (nightly-2026-07-25 + rust-src + wasi-sdk
   25.0 + build-std, determinism flags baked). Recipe also in the develop
   guide's WASIp3 chapter. Publish gate is open; commit your Cargo.lock. See
   §4.
4. **Canary**: kryptos, via the existing private/devDeploy path pinned to it
   (console target pick / `enclave move` / MCP `claim_hint {enclave}`).
   Fleet-AND `p3` on `/availability` is the GA signal. See §6.

Migration order stays as the app side proposed: pure wasi:http apps first
(adapter swaps), nn apps on the 3a bridge immediately after, 3b streams when
the toolchain cut lands.
