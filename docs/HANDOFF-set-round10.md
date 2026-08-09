# Handoff: SET (shared-everything-threads), after round 10

**Read this before touching anything.** `docs/HANDOFF-set-threads.md` is older and
its "DONE on the engine side" framing is stale — the parallelism numbers in it
are still true, the readiness claim is not.

## Where this actually stands

Nine adversarial review rounds have run against the SET patch stack. **Not one
has cleared.** Round 10 was deliberately NOT a review round: rounds 8 and 9 both
concluded the *class* was wrong rather than the instance, so it did the two
design items instead. Both landed, with probes that fail against the previous
image and pass against the new one.

**Round 10 also found a CRITICAL in round 9's own fix, without reviewing for
it** — it fell out of building an honest probe. Round 9's MEDIUM leak fix
(`__wasilibc_set_release_path_bufs`) called `free()` on a pointer borrowed from
the guest's path string, on the NORMAL exit path of every worker that opened a
file in a guest without `chdir`. Heap corruption when the bytes looked
plausible; an out-of-bounds trap inside `__pthread_exit` when they did not,
which killed the worker mid-teardown so its joiner blocked forever. That is the
fourth round running in which the previous round's fix was the next round's
worst finding.

The running record is `wasm/SET-DO-NOT-PROMOTE.md`. Read its round 8, 9 and 10
sections in full before forming an opinion.

## The standing constraints — do not violate these

1. **Do not promote until a round finds nothing.** The engine patch stays as
   `wasm/wasmtime-set-threads.patch.wip`; the `.wip` suffix keeps it out of the
   `wasmtime-patch-check.yml` glob and out of `wasm/Dockerfile.wasmtime`'s chain.
   Verified still true as of round 10.
2. **The fleet `WASMTIME_IMAGE` repin is a MEASUREMENT EVENT and is Steven-gated.**
   Do not run the toolchain workflow dispatch or repin `wasm/Dockerfile.wasm`
   unprompted. Untouched by round 10.
3. Commit and push to `main` after any repo change. Beware `git add -A` — the
   working tree carries unrelated in-flight work (contracts, relay, site,
   supervisor). Stage the SET files explicitly.

## Do this next: a review round, and it should be a hard one

The two design items the round-9 handoff asked for are **done**. What blocks
promotion now is that **round 10's own code has never been reviewed.** It is
roughly 500 lines of new logic in exactly the area that has produced a CRITICAL
in every round: musl stdio internals, the descriptor table, thread exit, and
store teardown.

Give reviewers:

* `enclave-wasipsetc-build:r9c` (round-9 libc) and `:r8` (round-7 libc) for A/B.
* An explicit mandate to build **reactor** components, not just commands — that
  blind spot hid a CRITICAL for eight rounds. `tools/parallelism-probe/set-http-handler.c`
  and the README section next to it are the working recipe.
* A requirement that every claimed fix comes with a probe that demonstrably
  fails without it, AND a native (`gcc`) control for anything that asserts what
  "correct" means. A probe encoding a bug as the spec has happened **six** times
  now; the sixth was round 10's own first draft of `worker-file-owner.c`.

Areas round 10 touched, i.e. where to look hardest:

* **`FILE` ownership** (`stdio_impl.h`, `__fdopen.c`, `fflush.c`,
  `__stdio_exit.c`, `__stdio_write/read/seek.c`). `f->set_ns` is
  `owner_namespace + 1` so `0` means SHARED. Question worth asking: is every
  `FILE` constructor really zeroing the struct, and is `SHARED` still sound for
  0/1/2 on every path?
* **The worker floor on indices 0/1/2** (`table_allocate`,
  `descriptor_table_remove`, `DUP_OP_DUPFD`). The first cut of this broke every
  worker's stderr by flooring the stdio population itself. The exemption is a
  thread-local `set_stdio_populating` flag — is that window exactly right, and
  is there any other path that frees or allocates an untagged index?
* **The thread-exit flush** (`__wasilibc_set_flush_owned_files` in `ofl.c`).
  Lock order, the try-lock, restart-from-head, termination, and the fact that it
  must run before `__wasilibc_set_release_thread_state`. This is a new
  cross-layer teardown mechanism in the area that has deadlocked twice.
* **The store-teardown reaper** (`crates/wasmtime/src/runtime/store.rs`). One
  detached OS thread per teardown that still has a live worker. Is the fast-path
  `live_is_zero` check racy in a way that matters? Is spawning a thread in
  `Drop` safe on every path that reaches it?
* **`__wasilibc_set_release_path_bufs`** — now guarded, but the whole function is
  the one that turned a MEDIUM into a CRITICAL. Is `*_len != 0` genuinely the
  ownership marker on every path?

## Open, not code: fleet cgroup config (Steven's call, unchanged)

Round 8 withdrew the spawn rate limiter on the grounds that the cgroup charges
thread creation to the tenant. That is true in **accounting** and false in
**enforcement** as deployed:

* `WASM_CPU_WEIGHT: "100"` is pinned in all three fleet configs
  (`enclaves/{cpu,gpu,gpu8}/tinfoil-config.yml`), overriding the proportional
  `round(cpu_share * 10000)` in `wasm/wasm_manager.py`. **Every tenant gets an
  equal 1/N share regardless of what it bought.**
* `cpu.max` is implemented (`wasm_manager.py` ~2929) but `WASM_CPU_MAX_PCT` is
  commented out everywhere, so nothing caps an uncontended node.
* `pids.max` is absent; only `+cpu` is written to `cgroup.subtree_control`.
* cgroup placement fails **open** with a log line ("tenant runs uncapped").

The right lever is `cpu.max`, not a new in-engine limiter: kernel-enforced
outside the guest, so it charges the spawn *and* the retry-spin (which defeated
the refusing limiter) and cannot be evaded by moving cost off CPU (which defeated
the waiting one). Note this is independent of SET promotion — it is live fleet
behaviour today.

## Probe corpus: what changed in round 10

* Added `worker-stdio-leak.c`, `worker-file-owner.c`, `worker-stdio-freopen.c`,
  `worker-preopen-oom.c`. Each verified to FAIL against `:r8`/`:r9c`.
* `worker-mem-grow.c` now asserts the tenant's RAM ceiling instead of printing
  it; pass the cap in with `--env MAX_MEMORY_SIZE=<same as -W max-memory-size>`.
  Verified it can fail (no engine cap → 1 GiB → non-zero exit).
* `worker-preopen-retry.c` is kept but **cannot reach the bug it names** — it
  fails at preopen index 0. `worker-preopen-oom.c` is the one that reaches it.
* **`HOLE` in `worker-preopen-oom.c` is a byte offset into dlmalloc's layout and
  MOVES when any libc struct changes.** Sweep 0..16; do not assume one value.
* **Exit codes are pass/fail only.** WASIp2's `wasi:cli/exit` carries a `result`,
  not a number, so every non-zero guest exit reaches the host as `1`. Detail is
  on stderr.

## Practical recipes

**Trees.** Engine: `/home/steven/Projects/wasmtime-set` (base
`ac0772970b9ad2cd53866d95db69e26311fe3b75`, wasmtime 49 dev). wasi-libc and all
scratch state live under the session scratchpad; if yours is fresh, re-derive
from the committed patches, which are the source of truth. Verify a fresh
wasi-libc tree by applying `wasm/wasi-libc-set-threads.patch` and regenerating
it — the round-trip is byte-identical when the tree is right.

**Toolchain images.** `enclave-wasipsetc-build:r10c` is current; `:r9c` is the
round-9 libc and `:r8` the round-7 libc, both kept for A/B. Rebuild with
`docker build -f Dockerfile.wasipsetc-build -t <tag> .` from `wasm/`. The image
builds the patched tree a **second** time with `ENABLE_SET_THREADS=OFF` as a
guard — round 9 found the canonical patch did not compile in its default
configuration.

**Build and run a C probe.**
```sh
docker run --rm -v "$PWD":/src enclave-wasipsetc-build:r10c probe.c -O2 -o probe.wasm
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
/home/steven/Projects/wasmtime-set/target/release/wasmtime run $W -S cli --dir d::/d probe.wasm
```

**The HTTP shape — use it, it is how the platform actually runs.** See
`tools/parallelism-probe/set-http-handler.c` and the README section next to it.
Needs host `wit-bindgen` (the image has no C `wasi:http` bindgen) and `-S cli`
(the SET libc imports `wasi:cli/exit`, which the bare proxy world lacks).

**Seeing which store-teardown path ran:**
`WASMTIME_LOG=wasmtime::runtime::store=debug` prints a line when a store hands
live workers to a reaper, and nothing when it takes the inline fast path.

**Regenerating the patches — this has silently produced a broken patch before.**
* libc: in the wasi-libc tree, `git add -A && git diff --cached > wasm/wasi-libc-set-threads.patch`.
* engine: the SET patch is a **subset** of the working tree (the other 9 enclave
  patches are also applied), so it is generated from a reconstructed 9-patch
  baseline tree. Copy the changed files into that tree and use
  **`git diff HEAD`**, not `git diff` — most files there are staged, and plain
  `git diff` silently produced a 2-file patch instead of 48.
* Verify all three ways, every time: `grep -c '^diff --git'` should be 48, every
  post-image blob hash should match `git hash-object` of the tree file, and
  `git apply --check` against a fresh baseline worktree must pass.

**TSan lies** about this code unless built with `--cfg rustix_use_libc` (rustix's
raw `munmap` hides fiber-stack frees; 200 workers reported 12 false races without
it, zero with it). **Not re-run since round 10's changes.**

## Promotion sequence, when it is finally earned

`git mv wasm/wasmtime-set-threads.patch.wip wasm/wasmtime-set-threads.patch`; add
the wasmparser 0.254.0 vendor step (sha256
`d5769a29f799fbab136aaf65b4fe5384cd7d93fe6fc9ba0dcb6c8382a1f16e27`, verified to
reproduce the live vendor tree byte-for-byte) + `wasmparser-set-relax.patch` +
the SET patch after `wasmtime-nn-arbiter.patch` in `wasm/Dockerfile.wasmtime`;
extend `.github/workflows/wasmtime-patch-check.yml` from 9 patches to 10 and
update its header; delete `wasm/SET-DO-NOT-PROMOTE.md` and fix its references in
this file and `docs/wasm-parallelism.md`. **Then stop** — the fleet repin is a
separate, Steven-gated step.
