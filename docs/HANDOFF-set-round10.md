# Handoff: SET (shared-everything-threads), after round 12

**Read this before touching anything.** `docs/HANDOFF-set-threads.md` is older and
its "DONE on the engine side" framing is stale — the parallelism numbers in it
are still true, the readiness claim is not.

## READ THE PATCH, NOT THIS FILE, FOR WHAT THE CODE DOES

Round 11's fourth reviewer briefed itself from `wasm/SET-DO-NOT-PROMOTE.md`,
reviewed the image that document implied was current, and discovered SIX HOURS IN
that the committed patch had moved and contained five stdio mechanisms the
document never described. **The authority is `wasm/wasi-libc-set-threads.patch`
and `wasm/wasmtime-set-threads.patch.wip`.** Diff them against whatever image you
are about to review, before you start. This file and the record are narrative;
they lag.

## Where this actually stands

TWELVE review passes have run and **not one has cleared**. Rounds 10-12 plus a
late fourth reviewer from round 11 have all landed; the current toolchain image
is `enclave-wasipsetc-build:r13a`, built from the committed patch (40 files).

The severity trend is real and worth knowing: **no new CRITICAL in the last
three passes.** Rounds 3-9 produced component wedges, heap corruption and
guest-bytes-to-operator-log leaks. Rounds 11, 12 and late-11 produced HIGHs that
are mostly cross-thread stdio semantics diverging from native — with two
exceptions that were NOT benign: a teardown thread that died permanently on an
EPIPE, and `vfprintf` leaving a shared FILE buffering into a dead thread's stack.

What has NOT improved is the pattern this record exists to track: **in five
consecutive rounds the worst finding was the previous round's fix**, and twice
the fix for a finding was itself the next defect within the same round.

## What rounds 10-12 changed, in one place

* **`FILE` ownership.** `f->set_ns` = `owner_ns + 1`, 0 = SHARED (what every
  constructor already leaves). Checked in `fflush`, `__stdio_exit`, the
  `__stdio_write`/`read`/`seek` vtable, `fclose`, `__toread`, `fseek`,
  `__stdout_write`. Non-owners BUFFER rather than drain in `__fwritex` and
  `__overflow` — draining is the only thing that needs a descriptor.
* **A thread rebinding its own 0/1/2 CLAIMS the shared FILE**
  (`__wasilibc_set_claim_std_stream`), wired at all four doors plus `close`,
  each preceded by `(void)set_fd_ns_claim()`. This exists because the request
  handler under `wasmtime serve` runs on the MAIN thread, and the worker-only
  rule left it able to send a worker's `printf` to the operator's log.
* **Thread-exit flush** of a worker's own FILEs, then a re-stamp to SHARED so a
  dead thread's FILEs stay reclaimable.
* **The orphan-lock walk detaches a FILE buffer inside the dying thread's stack**
  (`vfprintf` puts an unbuffered stream's buffer in its caller's frame).
* **Store teardown never blocks**: one process-global reaper thread, both join
  paths gated on `is_finished()`, `wasmtime run` drains before exit, and the
  reaper is panic-proof (a failed stderr write used to kill it permanently).
* **Leaks fixed**: `chdir`'s path cache (released weakly — the weakness is
  load-bearing), and round 9's borrowed-pointer `free()`.

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

## Do this next

Round 13 was in flight when this was written. Beyond it, the two things the
reviewers keep pointing at are DESIGN items, not patches, and both are the
reason the HIGH rate is not falling:

1. **Process-wide 0/1/2 under SET.** A shared three-entry table for the standard
   descriptors is what would make `__WASILIBC_FILE_SHARED` sound *by
   construction* and make a redirect apply to every thread as POSIX says.
   Everything shipped so far — the worker floor, the claim, the per-call
   refusals — patches symptoms of not having it.
2. **The thread-exit flush is defeated by an ordinary `flockfile()`.** It uses
   `ftrylockfile` because a blocking acquire in `__pthread_exit` is a new hang
   axis, so a FILE another thread has locked is silently skipped: measured 3/3,
   zero bytes written, no error anywhere. That is a limit of the design, not a
   bug to patch.

Also still true: **round 12's and late-11's fixes have not been reviewed.**

Give reviewers:

* `enclave-wasipsetc-build:r9c` (round-9 libc) and `:r8` (round-7 libc) for A/B.
* An explicit mandate to build **reactor** components, not just commands — that
  blind spot hid a CRITICAL for eight rounds. `tools/parallelism-probe/set-http-handler.c`
  and the README section next to it are the working recipe.
* A requirement that every claimed fix comes with a probe that demonstrably
  fails without it, AND a native (`gcc`) control for anything that asserts what
  "correct" means. A probe encoding a bug as the spec has happened **seven**
  times now, most recently in round 10's and round 11's own first drafts — each
  caught only by the native control, never by review.

Areas rounds 10-12 touched, i.e. where to look hardest:

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
* **The store-teardown reaper** (`crates/wasmtime/src/runtime/store.rs` +
  `vm/component/set_threads.rs`). Now ONE process-global reaper thread, not one
  per teardown — the per-teardown version measured ~1950 engine-created OS
  threads/second that no limiter could see. Both join paths are gated on
  `is_finished()` because both were blocking (the fast path is 74-76% of
  requests). It is panic-proof because a failed stderr write used to kill it
  permanently, and `wasmtime run` drains it before exit.
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
