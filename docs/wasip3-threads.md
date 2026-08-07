# Cooperative threads (wasip3 🧵) on the platform

Status, 2026-08-07: platform support implemented and locally verified
end-to-end; INERT on the fleet until the WASMTIME_IMAGE repin (the fleet
binary is wasmtime 45, which cannot parse a coop guest). C/C++ publishers can
build threaded apps today (`wasm/Dockerfile.wasip3c-build`); Rust guests are
gated upstream on rustc landing LLVM 23. This file is the design record and
the rollout map; the publisher story lives in the develop guide.

## What this is

A cooperative-threading guest implements pthreads / `std::thread` ON TOP OF
component-model async: `pthread_create` lowers to the `thread.new-indirect`
canon builtin, futexes to waitable-sets, the shadow stack and TLS base ride
in per-task canonical context slots (`context.get/set i32 0|1`). Threads
INTERLEAVE on the instance's async runtime — a blocking futex wait suspends
the thread instead of aborting the instance (the p1/p2 "don't block — it
aborts" rule dies with this), but they do not run in parallel: no extra
cores, no shared-memory data races, the process/cpu-share model untouched.
That is most of what "let apps use threads" means in practice: thread-shaped
code ports without surgery.

What it is NOT: shared-everything-threads (true multi-core inside one guest).
That proposal is still unimplemented in wasmtime and has no toolchain; if it
lands someday, the opt-in cgroup CPU controls in wasm_manager.py go from
nice-to-have to prerequisite. Nothing here builds on it.

## The verified chain (2026-08-07, all local)

Guest (C/C++, `wasm/Dockerfile.wasip3c-build`):
  - wasi-sdk-34.0-rc.2 (clang 23 + wasm-ld 23 — LLVM 23 is the ABI floor)
  - wasi-libc rev 6d8745c8, `-DTARGET_TRIPLE=wasm32-wasip3
    -DENABLE_COOP_THREADS=ON` (upstream CI's own configure line). The SHIPPED
    SDK sysroot is a no-threads build — pthread_create returns ENOTSUP at
    runtime. The coop flavor must be compiled from source.
  - wasm-component-ld ≥ 0.5.28 (SDK ships 0.5.27, which fails to ENCODE the
    coop core module; wasi-libc's cmake pins the same 0.5.28 floor). The
    image REPLACES the SDK's copy — clang's driver invokes it by absolute
    path, so PATH-shadowing does nothing.
  - link with `-Wl,--cooperative-threading` (the image's entrypoint bakes it).

Engine (fleet toolchain, `wasm/Dockerfile.wasmtime`):
  - wasmtime at dev commit ac0772970 (49.0.0 line, 2026-08-06) with the full
    8-patch enclave stack rebased on (see "the rebase" below)
  - `-Sp3 -W component-model-threading` at launch (component-model-async
    already rides with -Sp3)

Proof: a 4-thread pthread suite (spawn/join, mpsc-style handoff, contended
mutex held across yields — the exact pattern the old futex aborted on) built
through the publisher image and run under the PATCHED enclave binary:
`ALL THREAD TESTS PASSED`, mutex counter exact.

## Two lessons that shaped the wiring

1. **Help text is a liar.** wasmtime 47.0.3 advertises
   `-W component-model-threading` in `-W help` and even compiles
   `(canon context.set i32 1)` — and still cannot parse the
   `thread.new-indirect` builtin every coop guest is linked around ("failed
   to parse WebAssembly module"). So the manager's capability probe is not a
   help-token grep: it COMPILES a minimal probe component using the builtin
   (`_threads_supported`, text WAT written at probe time — wasmtime parses
   .wat natively, no artifact to ship). Unproven means DO NOT PASS, the
   loopback doctrine unchanged.

2. **The stock sysroot lies at runtime.** The wasi-sdk sysroot links clean
   and then ENOTSUPs at pthread_create. The publisher image's smoke test
   therefore asserts the `[thread-` intrinsic imports are PRESENT in its own
   output — a stub-libc regression fails the image build, not a publisher's
   deploy.

## Platform wiring (all shipped, all inert on a 45 box)

- **Marker**: a coop guest's core module imports `[thread-new-indirect-v0]`
  and siblings — length-prefixed names verbatim in the bytes. Raw prefix scan
  (`[thread-`), same doctrine as the wasi: world scan. Calibrated: coop build
  ~12 hits, non-coop build of the same source zero.
- **Publish**: CLI + site stamp `threads: true` into the version config from
  the bytes (binary authoritative BOTH directions — an over-declared key is
  dropped). Gateway's classifier reports `threads` for parity. Lockstep is
  test-pinned (wasm-p3 + wasm-threads suites).
- **Claim routing**: supervisor gates like p3 — `threadsOfConfig(g.config)` →
  the manager's `/health` `coopThreads` must be true, unreachable fails
  closed. Relay carries a `coopThreads` fleet-AND next to `p3`. Availability
  forwards per box, so pinned canary deploys work while the AND is false.
- **Launch**: manager re-sniffs the actual bytes (`_needs_coop_threads`);
  a threaded guest on an incapable box fails with a readable error, never
  instantiation noise. The engine flag is PER-TENANT (`_threads_flags`):
  only marker-carrying guests get the experimental 🧵 surface.
- **Kill-switch**: `WASM_COOP_THREADS=0`, same shape as WASM_P3.

## Rust guests: blocked upstream, staged here

rustc nightly (2026-08-04) still bundles LLVM 22: its wasip3 spec already
emits `--cooperative-threading`, but LLVM-22 codegen produces the
globals-based thread-context ABI and the link dies with "object file uses
globals for thread context". std::thread on wasi now routes through the unix
pthread path, so the moment rustc lands LLVM 23 (LLVM 22 is EOL upstream),
the Rust recipe's retirement event fires and threads come with it — see the
staged note in `wasm/Dockerfile.wasip3-build`. No platform work will be
needed; re-run the thread suite and announce.

## The rebase (45 → 49-dev), for the record

All 8 patches (`wasm/wasmtime-*.patch`) were rebased onto ac0772970 and
regenerated from a commit stack; `git apply --check` passes in Dockerfile
order and the full fleet feature set type-checks. Three patches SHRANK:
upstream unified the p2/p3 TCP hosts onto one socket state machine and the
p2/p3 HTTP send paths into `default_send_request.rs`, so the egress dial swap
and the loopback policy now hook ONE site each instead of two. Other upstream
moves absorbed: cap-std dropped (vault ported to cap_primitives + std
handles), DirPerms/FilePerms unified into FsPerms, SocketAddrUse renamed its
UDP variants and grew TcpListen/TcpAccept (the wall allows both — bind was
the gate), and v45's `handle_worker_error` debug-format fix is upstream
behavior now (that hunk retired). Base image bumped rust:1.93 → 1.97
(wasmtime 49's MSRV is 1.95). Dockerfile.wasmtime now accepts a commit sha
as WASMTIME_VERSION (init+fetch pattern) because this capability shipped
between releases.

wasmtime 49 serves wasi 0.3.0-FINAL (verified: a final-flavored component
instantiates). The wasip3-build (Rust) recipe's 0.3.0-rc pin reasoning is
tied to the fleet being on 45 — when the fleet repins, revisit that recipe's
libc flavor and the wasip3 crate pin in the same event.

## Rollout (the gated part)

1. Platform code (this commit): live everywhere, inert on 45 boxes — probes
   answer false, claim gates refuse threaded apps, nothing else changes.
2. Toolchain workflow (MANUAL): run "Wasmtime Toolchain" with
   `ac0772970b9ad2cd53866d95db69e26311fe3b75`, then pin the printed digest in
   Dockerfile.wasm's WASMTIME_IMAGE. That commit triggers the ordinary
   wasm-manager rebuild. WASMTIME_IMAGE-changing updates need fleet-op
   stop→start on the 1-GPU account (ggml pin-bump runbook applies: re-verify
   the hand-built structs against the mm28 shim before trusting nn on the
   new build).
3. Canary: kryptos devDeploy pin first (the wasip3 rollout's own pattern) —
   deploy the threads suite as a private app, verify /health coopThreads,
   the claim gate, and a real threaded request end-to-end.
4. Fleet release pin: when wasmtime cuts the next RELEASE carrying the coop
   parser (49.0.0; dev is versioned 49 and 48 was never tagged), move
   WASMTIME_VERSION to the release tag, rebuild, re-verify the same suite,
   and repin the fleet. Running tenants on the dev-commit build is a
   Steven-gated call; the dev commit IS the locally verified binary, but it
   has not had release QA.
