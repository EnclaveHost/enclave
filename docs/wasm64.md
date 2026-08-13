# wasm64 (memory64): guests past the 4 GiB line

Written 2026-08-13, built against the engine rather than reading about it.
Every claim below was produced by running something.

Short version: **a C program compiled by `wasm/Dockerfile.wasm64c-build`
malloc'd, verified, and did file I/O across 6 GiB of linear memory on the
exact wasmtime binary the fleet runs — with zero engine changes.** No
toolchain rebuild, no `WASMTIME_IMAGE` repin, no measurement change. The
platform's four classifier copies, the launch gates, the capability chain and
the memory ceiling all know the new guest class; the wasm32 majority takes
byte-identical paths.

## Why this exists

wasm32 linear memory tops out at 4 GiB — the ceiling behind
`WASM32_MAX_MEM_MB` in `wasm_manager.launch()`. Big-model *weights* already
route around it (wasi-nn keeps them host-side), but an app that wants a
>4 GiB *heap* — in-memory datasets, large caches, graph analytics — had
nowhere to go. memory64 is the standardized fix (64-bit addresses), and the
pinned wasmtime 49 engine has it **enabled by default**: probed live on the
extracted fleet binary (`ac07729…`, image digest `057dcd24…`), which ran a
4.58 GiB WAT probe with no flags, refused it under `-W memory64=n`, and
accepted `-W max-memory-size=8589934592` (the older generation's
memory-reservation refusal — the second reason for the 4096 clamp — is gone
in 49).

## The wall, and the shim that walks through it

There is no 64-bit WASI. The engine's `wasi_snapshot_preview1` is typed for
wasm32: i32 pointers, u32 sizes, wasm32 struct layouts. A native "wasm64 p1
ABI" (i64 pointer args) does not link — probed, the host rejects the import
signature. What DOES work, verified on the fleet binary: **a memory64 module
importing the existing i32-typed preview1**, because function signatures are
independent of memory width and the engine happily indexes a 64-bit memory
through i32 offsets. The constraint is only that every pointer the HOST
touches must sit below 4 GiB.

Two facts make that constraint cheap:

- `wasm-ld` lays out data and the shadow stack LOW; only the malloc heap
  ever crosses the 4 GiB line. Almost every syscall pointer (stack locals,
  stdio buffers, iovec arrays) is host-addressable as-is.
- The p1 read/write family legally returns short counts, and every libc
  caller already loops — so a >4 GiB buffer can bounce through a low arena
  in chunks without any semantic change.

`wasm/wasi-libc-mem64.patch` implements this at the one honest boundary,
wasi-libc's bottom half (`__wasilibc_real_wasm64.inc`, compiled in place of
the truncating-cast wrappers when `__wasm64__`):

- low buffers pass straight through (the common case: zero copies);
- >4 GiB buffers bounce through a 128 KiB static low arena, chunked
  (short-count calls return partial; full-fill calls like `random_get` loop
  internally);
- every pointer-width'd layout is rebuilt in wasm32 shape: iovec arrays
  ({u32,u32} staging), `size_t` out-params (u32 slot, widened), argv/environ
  pointer tables (staged low, rebased into the caller's 64-bit buffers),
  `prestat` (8-byte host form expanded);
- layout-identical structs (`fdstat`, `filestat`, `dirent`, `event`,
  `subscription`) are `_Static_assert`-pinned so a wasi-libc bump that
  changes one fails the BUILD, and a first-use check traps if the arena ever
  ends up above 4 GiB (the corruption class the shim exists to prevent);
- single-threaded by construction (`-mthread-model single`, `_REENTRANT`
  is a `#error`) — that is what makes the static arena sound.

The rest of the patch is small: the `wasip1.h` ABI asserts gated on
`__WASI_PTR_SIZE`, a pointer-width `a_cas_p` for musl, the `__stack_pointer`
globaltype (i64 on wasm64), and the wasm32 arm stays stock — the build image
proves that by compiling BOTH flavors (same guard the SET image earned in
round 9).

## Building a wasm64 guest

```
docker build -f wasm/Dockerfile.wasm64c-build -t enclave-wasm64c-build wasm/
docker run --rm -v "$PWD":/src enclave-wasm64c-build app.c -O2 -o app.wasm
```

The chain, every link pinned: wasi-sdk-34.0-rc.2 (the blessed clang 23),
compiler-rt builtins built for wasm64 from the SDK clang's own llvm-project
commit (the SDK ships wasm32 builtins only), and wasi-libc at the thread
images' rev with the mem64 patch, `TARGET_TRIPLE=wasm64-wasip1`, static only
(`BUILD_SHARED=OFF`; guests are statically linked and wasm64 shared objects
do not exist upstream). The image's smoke test compiles a
malloc-past-4-GiB program and structurally asserts the output is a layer-0
module whose memory section carries the 64-bit flag — the same check every
publish path keys on.

What comes out is a **wasip1 CORE MODULE (layer 0), not a component** —
there is no memory64 component toolchain anywhere. Consequences:

- **compute guests, published PORTLESS.** Preview1 has no socket surface on
  this engine: wasi:sockets is component ABI, and the legacy p1 listener
  path (`-S tcplisten`/`-S listenfd`) is deleted in the 49 line — probed:
  the flags still print in `-S help` but `-S preview2=n`, the only thing
  that ever activated them, is refused ("no longer supported"). A version
  that declares ports promises an interface the guest cannot provide, so a
  port-declaring wasm64 publish/launch is refused with words at both ends.
  The launch shape (`_build_cmd`'s mem64 arm) grants no socket capability
  at all — which also means a wasm64 tenant physically cannot dial a
  sibling's loopback port.
- its interface is **/data (with quota), attached model volumes, encrypted
  volumes, ENCLAVE_CONFIG/secrets, and stdio/logs** — the big-heap
  batch/dataset class: index building, dataset transformation, large
  in-memory analytics over volume data. `main()` should run for the lease,
  not exit (readiness is the udp-style grace: alive == running).
- coop/SET threads are component features; a wasm64 guest is single-threaded.
  wasm64 + SET in one guest is a research project, not a flag. Inbound
  sockets for wasm64 would need an engine patch (a run-mode listener
  preopen for the modern p1 host) — a deliberate TCB change for another
  day, not a launcher flag.

## How the platform routes it

Same six-part chain as p3/coop/SET, one capability over:

1. classification, from the bytes, in four lockstep copies (runner
   `_module_mem64`, gateway `module_mem64`, CLI + site `moduleMem64`): a
   layer-0 module whose memory section (id 5) carries the 64-bit limits
   flag (0x04). Structural — a marker string cannot fake it. wasm32 core
   modules keep the historical refusal everywhere.
2. publish stamps `mem64: true` into the version config (binary-authoritative
   both directions); `mem64` is a ROUTING_KEYS member (three lockstep
   copies).
3. the manager probes its own engine — `wasmtime compile` of a memory64
   WAT with NO flags, because launch adds none (memory64 is default-on in
   the pin; if a future engine flips the default the probe fails and mem64
   guests refuse readably, which a repin re-proves) — and carries `mem64`
   on `/health`.
4. supervisor forwards it on `/availability`; the claim gate refuses
   `mem64: true` versions on boxes whose engine can't (`mem64OfConfig`).
5. relay fleet-ANDs it for clients.
6. launch re-classifies the bytes (routing is not trust) and lifts the
   memory ceiling: a mem64 guest's `-W max-memory-size` is its full RAM
   slice (`cpuShare × NODE_RAM_GB`), not the 4096 MB wasm32 clamp — applied
   after the sniff and before the RAM-budget admission, so the ledger
   charges exactly what the guest can grow to. A deployment that wants
   16 GiB buys the cpuShare that carries 16 GiB.

## Verification record (2026-08-13)

On the extracted fleet binary (wasmtime 49.0.0 ac0772970, all eleven
enclave patches, from the pinned toolchain image digest):

- bare memory64 WAT: grow to 4.58 GiB, store/load above 4 GiB — PASS, no
  flags; refused under `-W memory64=n` (the probe gates what we think it
  gates).
- memory64 + i32-typed preview1 imports, buffers below 4 GiB: `fd_write`
  prints from a 4.58 GiB memory — PASS (the shim's foundation).
- native i64-pointer p1 imports: REFUSED at instantiation (why the shim
  exists).
- the full C guest from the shipped image, run with the manager's exact
  mem64 launch shape (`wasmtime run -Scli --dir …::/data -W
  max-memory-size=8589934592`): six 1 GiB mallocs (heap top 6.00 GiB),
  every page pattern-verified (catches truncation aliasing), printf from a
  >4 GiB buffer, and an 8 MiB file write+readback+compare from >4 GiB
  buffers through the bounce arena — PASS, exit 0.
- `-W max-memory-size=2 GiB` on the same guest: the >4 GiB grow correctly
  refuses (the tenant cap binds for memory64 exactly as for wasm32).
- inbound TCP for p1: a wasm64 echo server against `-S tcplisten` —
  REFUSED ("components do not support --tcplisten" on the modern path,
  "`-Spreview2=n` is no longer supported" on the legacy one). This is what
  makes wasm64 a compute class today, and it is an engine fact, not a
  launcher choice.

`test/wasm-mem64.test.mjs` pins the classifier lockstep, both admission
carve-outs, the three launch refusals (portless, incapable engine, operator
switch), and both arms of the memory ceiling (32768 MB lifted / 4096 MB
control). The 6 GiB runtime proof needs the real engine plus 6 GiB of
commit, so it lives here rather than in CI; reproduce it with the image and
the extracted engine binary as above.

## Operator notes

- kill-switch: `WASM_MEM64=0` refuses mem64 guests with its own words.
- memory64 loads carry explicit bounds checks in the engine (no guard-page
  trick past 4 GiB) — a few percent on memory-heavy inner loops, paid only
  by mem64 guests. wasm32 tenants are untouched.
- the RAM ledger (`WASM_ACCOUNT_STORAGE_RAM`) admits `rec["mem_mb"]` AFTER
  the lift, so oversubscription math is honest for big guests.
- the arena is 128 KiB of the guest's own static memory; `M64_IOV_MAX` is
  64. Both are compile-time constants in the patch if a workload ever needs
  more.
