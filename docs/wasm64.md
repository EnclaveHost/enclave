# wasm64 (memory64): guests past the 4 GiB line

Written 2026-08-13, rewritten 2026-09-04 when the class changed shape.
Built against the engine rather than read about: every claim below was
produced by running something.

Short version: **an app built by `wasm/Dockerfile.wasm64p2-build` — C or
Rust — addresses more than 4 GiB of linear memory on the exact wasmtime
binary the fleet runs, and serves ports, sockets and HTTP while it does.**
No engine changes, no `WASMTIME_IMAGE` repin, no measurement change. The
classifier copies, the launch gates, the capability chain and the memory
ceiling all know the class; the wasm32 majority takes byte-identical paths.

## Why this exists

wasm32 linear memory tops out at 4 GiB — the ceiling behind
`WASM32_MAX_MEM_MB` in `wasm_manager.launch()`. Big-model *weights* already
route around it (wasi-nn keeps them host-side), but an app that wants a
>4 GiB *heap* — in-memory datasets, large caches, graph analytics, a machine
emulator's guest RAM — had nowhere to go. memory64 is the standardized fix
(64-bit addresses), and the pinned wasmtime 49 engine has it **enabled by
default**: probed live on the extracted fleet binary (`ac07729…`, image
digest `057dcd24…`), which ran a 4.58 GiB WAT probe with no flags, refused
it under `-W memory64=n`, and accepted `-W max-memory-size=8589934592` (the
older generation's memory-reservation refusal — the second reason for the
4096 clamp — is gone in 49).

## One class, not two

A >4 GiB guest is a **memory64 wasip2 COMPONENT**: an ordinary Enclave app
whose main core module carries a 64-bit memory. It keeps everything a
component has — ports, sockets, HTTP, /data, volumes, config, stdio — and
the only launch differences are two engine switches and the ceiling lift.

It was not always. From 2026-08-13 the class was a **wasm64-wasip1 core
MODULE**, because no memory64 component toolchain existed anywhere: the only
way to reach a 64-bit memory was clang against a patched wasi-libc, and
preview1 has no socket surface on this engine, so such a guest could only
ever run portless as a compute guest. That class is **gone** as of
2026-09-04. Core modules are refused at every door again, and the C programs
that needed it build as components now (`enclave-wasm64-cc`). The history
matters mainly because the two shared one routing key, `mem64`, and
conflating them cost a wrong publish refusal.

## Two walls, and how each is walked through

**No 64-bit WASI.** The engine's `wasi_snapshot_preview1` is typed for
wasm32 — i32 pointers, u32 sizes, wasm32 struct layouts — and a native
"wasm64 p1 ABI" does not link (probed: the host rejects the import
signature). The old module class solved this in the libc:
`wasm/wasi-libc-mem64.patch` replaces the truncating-cast bottom half with a
marshalling shim (`__wasilibc_real_wasm64.inc`) that passes low buffers
through, bounces >4 GiB buffers through a 128 KiB static low arena in legal
short-count chunks, and rebuilds every pointer-width'd layout in wasm32
shape. **That shim now compiles only for wasip1 builds, which the platform
no longer makes.** What the wasip2 sysroot still takes from the same patch
is the pointer-width work underneath it: musl's `a_cas_p`, the
`__stack_pointer` globaltype (i64 on wasm64), and the `wasip1.h` ABI asserts
gated on `__WASI_PTR_SIZE`. The wasip2 bottom half needs no shim — its
generated bindings size every return area from `sizeof(void*)`.

**The host's typed ABI is 32-bit.** wasmtime 49 parses and runs memory64
components, but the `Lower`/`Lift` machinery every `wasmtime-wasi` function
is bound through still reads pointers and lengths as u32 (wasmtime FIXME
#4311). A wasm64 component calling `get-arguments` directly reads garbage
out of its return area. What the engine *does* implement completely is the
component-to-component adapter, which transcodes between a 64-bit caller and
a 32-bit callee, resource handles included. So every build is composed
(`wac plug`) under `wasm64p2/wasiproxy`: a generated wasm32 component that
imports exactly the app's stable WASI interfaces and re-exports them verbatim.
`proxy-app.py` extracts the app's exact WIT versions and checks that both the
proxy and the composed result preserve its import set. The
host only ever sees a 32-bit caller. Cost: one copy per list or string
crossing, one handle indirection per stream, socket or pollable.

The encoder was a third, smaller wall: wit-component typed every canonical
pointer as i32, so a stock `clang --target=wasm64-wasip2` fails inside its
own linker ("type mismatch for function `poll`: expected [I32, I32, I32] but
found [I64, I64, I64]"). Both build wrappers stop at the core module
(`--skip-wit-component`) and encode with a patched wasm-tools that follows
the module's memory width.

## Building a wasm64 guest

```
docker build -f wasm/Dockerfile.wasm64p2-build -t enclave-wasm64p2-build wasm/

# C or C++
docker run --rm -v "$PWD":/src enclave-wasm64p2-build app.c -O2 -o app.wasm

# Rust (a cargo crate)
docker run --rm -v "$PWD":/src --entrypoint enclave-wasm64-rust \
  enclave-wasm64p2-build . -o app.wasm
```

Publish the result like any other component. The image pins every link:
wasi-sdk 34 rc.2 (clang 23), wasi-libc at the platform's rev with the
memory64 patch built for `wasm64-wasip2`, compiler-rt builtins for wasm64
from the exact llvm commit the SDK's clang came from (the SDK ships wasm32
builtins only, and wasm-ld hard-requires them — this is what makes the C
path link at all), wasm-tools v1.256.0 with the memory64 encoder patch, wac
on the same crates, and for Rust a widened rust-src copy plus patched
`wasip2`/`wit-bindgen`/`getrandom` (each gates its WASI backend on
`target_arch = "wasm32"`). `wasm64p2/prepare-toolchain.sh` is the same
recipe outside Docker.

## How the platform routes it

Same six-part chain as p3/coop/SET, one capability over:

1. classification, from the bytes, in four lockstep copies (runner
   `_component_mem64`, gateway `component_mem64`, CLI + site
   `componentMem64`): a layer-1 component carrying a core module whose
   memory section (id 5) has the 64-bit limits flag (0x04), at the top level
   **or nested** — a wasm64 app ships composed under the wasm32 proxy, so
   its 64-bit core sits inside a nested component beside a 32-bit module.
   Structural; a marker string cannot fake it. Core modules are refused
   everywhere, wasm64 or not.
2. publish stamps `mem64: true` into the version config
   (binary-authoritative both directions); `mem64` is a ROUTING_KEYS member
   (three lockstep copies).
3. the manager probes its own engine — **twice**. Plain memory64 is
   default-on in the pin, so `_mem64_supported` compiles a memory64 WAT with
   NO flags; the component-model half is not default-on and is passed
   explicitly, so `_cm64_supported` compiles a component with a 64-bit
   canonical memory under `-W memory64,component-model-memory64`.
   `/health` carries `mem64` = **both** (`_mem64_advertised`), because a box
   that proved only the first would win the claim and refuse at launch.
4. supervisor forwards it on `/availability`; the claim gate refuses
   `mem64: true` versions on boxes whose engine can't (`mem64OfConfig`).
5. relay fleet-ANDs it for clients.
6. launch re-classifies the bytes (routing is not trust), adds
   `-W memory64,component-model-memory64`, and lifts the memory ceiling: the
   guest's `-W max-memory-size` is its full RAM slice
   (`cpuShare × NODE_RAM_GB`), not the 4096 MB wasm32 clamp — applied after
   the sniff and before the RAM-budget admission, so the ledger charges
   exactly what the guest can grow to. A deployment that wants 16 GiB buys
   the cpuShare that carries 16 GiB. The two probe failures refuse
   separately, each saying what actually went wrong.

## Verification record

**2026-09-04, the component class**, on the extracted fleet binary:

- `tools/mem64-probe/mem64test.c` — the same program that proved the old
  class — built through `enclave-wasm64-cc` and run as a composed component:
  six 1 GiB mallocs (heap top 6.00 GiB), every page pattern-verified
  (catches truncation aliasing), printf from a >4 GiB buffer, and an 8 MiB
  file write+readback+compare from >4 GiB buffers — PASS, exit 0. So WASI
  from above the line works through the proxy, not only through the old
  libc shim.
- the image's build is byte-identical to the same source built on the host,
  and the image smoke-tests its own chain (5 GiB touched, structural check)
  on every build.
- a Rust crate through `enclave-wasm64-rust`: 5 GiB allocated and verified,
  environment and arguments intact across the proxy.
- RISC Box, the first real app: a 5 GiB guest filled 4.4 GB of tmpfs, the
  engine process reached 5.4 GB resident, and its snapshot resumed with two
  checksums intact (`enclave-apps/risc-box/docs/snapshot-handoff.md`).
- cost: ~1.5x on an interpreter's hot loop (explicit bounds checks on a
  64-bit memory; no engine flag buys it back — measured 3.1 s vs 4.6 s to
  the same boot marker, and `-O memory-reservation`/`memory-guard-size` are
  within noise).

**2026-08-13, the retired module class**, kept because the engine facts
still hold: a bare memory64 WAT grew to 4.58 GiB and stored above 4 GiB with
no flags, and was refused under `-W memory64=n`; memory64 with i32-typed
preview1 imports printed from a 4.58 GiB memory; native i64-pointer p1
imports were REFUSED at instantiation; `-W max-memory-size=2 GiB` correctly
refused the >4 GiB grow (the tenant cap binds for memory64 as for wasm32);
and inbound TCP for p1 was refused by the engine — which is why that class
was compute-only, and ultimately why it is gone.

`test/wasm-mem64.test.mjs` pins the classifier lockstep (including the
nested/composed shape), the door refusing core modules, the two launch
refusals, the operator switch, the capability AND, the ceiling lift, and the
publish clients' behaviour. The 6 GiB runtime proof needs the real engine
plus 6 GiB of commit, so it lives here rather than in CI; reproduce it with
the image and the extracted engine binary as above.

## Operator notes

- kill-switch: `WASM_MEM64=0` refuses mem64 guests with its own words.
- memory64 loads carry explicit bounds checks in the engine (no guard-page
  trick past 4 GiB) — paid only by mem64 guests. wasm32 tenants are
  untouched.
- the RAM ledger (`WASM_ACCOUNT_STORAGE_RAM`) admits `rec["mem_mb"]` AFTER
  the lift, so oversubscription math is honest for big guests.
- a guest kernel or runtime must be able to *use* the memory it is given:
  RISC Box found that a Linux 5.4 image built with `CONFIG_MAXPHYSMEM_2GB`
  maps 2 GiB whatever the device tree says. That is a guest-side ceiling,
  invisible to the platform.

## Threaded memory64 and proxy attenuation (2026-09-04)

Threaded memory64 guests reserve virtual address space up to their existing
`max-memory-size` cap in both serve and port modes. Shared memory cannot move
on growth; without this reservation, one large allocation can fail even when
incremental growth works. Reservation does not increase the purchased cap or
commit all of that space to physical RAM.

The SET libc spawn function pointer keeps the builtin's `(i32, i32) -> i32`
shape on wasm64. Table slot getters and the componentizer's table fixup use
the table's real index width. Both changes live in the repository now.

Per-app proxy builds use `wasm32-unknown-unknown` to avoid Rust std adding
ambient WASI imports. Hello World's 15 imports and RISC Box's 24 imports are
preserved rather than expanded to 27; the C smoke app's WASI 0.2.0 surface
is also preserved. This restores import-based auditing; host capability
policy remains responsible for granting access.

The proxy path deliberately keeps validation enabled. The known wasm-tools
1.256 shared-memory component validation limitation still needs an upstream
fix before the ordinary publisher wrapper can support combined SET/memory64
builds without a separate engine validation workflow. The runner and libc
fixes do not by themselves ship that combined publisher toolchain or update
running fleet images.
