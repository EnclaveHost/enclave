# Handoff: SET (shared-everything-threads), after round 9

**Read this before touching anything.** `docs/HANDOFF-set-threads.md` is older and
its "DONE on the engine side" framing is stale — the parallelism numbers in it
are still true, the readiness claim is not.

## Where this actually stands

Nine adversarial review rounds have run against the SET patch stack. **Not one
has cleared.** Every round found real defects, and the majority of recent ones
were the *previous* round's fix. Round 9 found 3 CRITICAL + 4 HIGH, and two of
the three CRITICALs were not in the delta being reviewed at all:

* every HTTP app was broken — a reactor re-runs `_initialize` per spawned thread
  against a run-once flag in shared memory, so the first spawn trapped and the
  request hung forever. Nothing had ever been the right shape to meet it: every
  probe in the tree is a *command* component under `wasmtime run`.
* an orphan stdio-lock cycle that had been in the tree **since round 3**, wedging
  every sibling's `pthread_create` permanently at 0.2s of CPU.

The running record is `wasm/SET-DO-NOT-PROMOTE.md`. It is the source of truth
for what each round found, what was verified clean, and what is still open. Read
its round 8 and 9 sections in full before forming an opinion.

## The standing constraints — do not violate these

1. **Do not promote until a round finds nothing.** The engine patch stays as
   `wasm/wasmtime-set-threads.patch.wip`; the `.wip` suffix keeps it out of the
   `wasmtime-patch-check.yml` glob and out of `wasm/Dockerfile.wasmtime`'s chain.
   This gate has caught real UB in every round it has been applied to.
2. **The fleet `WASMTIME_IMAGE` repin is a MEASUREMENT EVENT and is Steven-gated.**
   Do not run the toolchain workflow dispatch or repin `wasm/Dockerfile.wasm`
   unprompted.
3. Commit and push to `main` after any repo change. Beware `git add -A` — the
   working tree carries unrelated in-flight work (contracts, relay, site,
   supervisor). Stage the SET files explicitly.

## Do this first, and do NOT open another review round before it

Rounds 8 and 9 both concluded the *class* was wrong rather than the instance.
Another narrow pass will most likely just find round 9's fixes. Two pieces of
design work should land first.

### 1. Per-thread stdio / `FILE` ownership under SET (highest value)

This subsumes at least four open findings. The mismatch: the fd table is
per-thread, but musl's `FILE` objects and the `__ofl` open-file list live in
shared memory, and `f->fd` is a **per-thread name**. Indices 0/1/2 are
deliberately untagged, so a worker's index 1 and main's index 1 are the same
*number* naming different objects. Consequences, all reproduced:

* a worker doing `close(1); open("/d/x"); printf(secret)` gets bare fd 1 and its
  bytes are delivered by main's exit flush to the **operator's container log**,
  while the guest's own file stays empty — exactly inverted from the same source
  built natively. Round 8 refused `dup2(f,1)`; that was one of four doors.
  `open`/`dup`/`socket`/`accept`/`pipe`/`fcntl(F_DUPFD)` all reach it via
  `table_allocate`, which hands out the lowest free index.
* a worker's `fflush(NULL)` walks the global `__ofl` and writes each `FILE`
  through an fd that names something else on that thread — **destroying** main's
  buffered bytes (measured: 19 bytes gone, `F_ERR` set, exit status 0).
* `freopen` on a worker closes the shared `stdout` on its failure path, leaving a
  dead `FILE` on `__ofl` with `F_ERR` stuck for every thread while `printf` keeps
  returning success.
* a worker's unflushed `FILE` is silently discarded at exit.

Two coherent options, and neither is a patch to `dup2`:
(a) stamp the owning namespace into the `FILE` at creation and check it wherever
`f->fd` is used (`__stdio_exit`, `fflush(NULL)`, `__stdio_write/read/seek`) —
this closes the untagged leak, the tagged silent-discard and the `dup2` case by
one rule; or (b) tag 0/1/2 for workers too, losing `write(1, ...)` and
`STDOUT_FILENO` on a worker.

A round-9 reviewer worked out a **safe** thread-exit flush (lock order, the
try-lock that avoids a new hang axis, why it must run before
`__wasilibc_set_release_thread_state`, and why it must NOT go in the death hook).
That analysis is in the round-9 reviewer output; re-derive it rather than
trusting this summary.

### 2. Store teardown: `join_set_threads` blocks a tokio worker

`crates/wasmtime/src/runtime/store.rs` ~1926 does `increment_epoch()` +
`std::thread::sleep(1ms)` in a loop, bounded by `ENCLAVE_SET_JOIN_TIMEOUT_MS`
(default 2000). It is reached from `Drop for Store`, which under `wasmtime serve`
runs inline on a tokio worker for every request whose guest spawned. This is the
same shape round 8 called CRITICAL and removed from `take_spawn_token`. It is
`Drop`, so it cannot `await` — fixing it properly means changing how a store with
live workers is torn down. Measured at ms to ~0.3s, and it *does* burn CPU, so
unlike the round-8 case it is visible to `cpu.weight`.

## Open, not code: fleet cgroup config (Steven's call)

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
the waiting one).

## Probe integrity — fix this or the next round is theatre

* **`worker-preopen-retry.c` cannot reach the bug it is cited as testing.** It
  induces failure by namespace exhaustion, which fails at preopen index 0, so the
  cleanup loop that held round 8's CRITICAL never runs. It passes *identically*
  against the buggy round-7 libc. The probe that does reach it uses OOM with a
  tuned heap hole and `-W max-memory-size=8388608`.
* **Only three probes carry an exit code** (`worker-dup2.c`, `worker-fd-alias.c`,
  `worker-fd-recycle.c`). Everything else `return 0`s and reports by printing.
  `worker-mem-grow.c` guards the tenant's purchased RAM ceiling and would exit 0
  if growth escaped the cap entirely.
* A probe encoding a bug as the spec has happened **five times** now
  (`worker-dup2.c` four rounds running, plus the above). When you fix something,
  prove the probe **fails against the previous libc image** and passes against the
  new one. `enclave-wasipsetc-build:r8` is the round-7 libc and is kept for
  exactly this A/B.

## Practical recipes

**Trees.** Engine: `/home/steven/Projects/wasmtime-set` (base
`ac0772970b9ad2cd53866d95db69e26311fe3b75`, wasmtime 49 dev). wasi-libc and all
scratch state live under the session scratchpad; if yours is fresh, re-derive
from the committed patches, which are the source of truth.

**Toolchain images.** `enclave-wasipsetc-build:r9c` is current;`:r8` is the
round-7 libc for A/B. Rebuild with
`docker build -f Dockerfile.wasipsetc-build -t <tag> .` from `wasm/`. The image
now builds the patched tree a **second** time with `ENABLE_SET_THREADS=OFF` as a
guard — round 9 found the canonical patch did not compile in its default
configuration, under a comment claiming it was identical to stock.

**Build and run a C probe.**
```sh
docker run --rm -v "$PWD":/src enclave-wasipsetc-build:r9c probe.c -O2 -o probe.wasm
W="-W threads,shared-everything-threads,component-model-threading,shared-memory"
/home/steven/Projects/wasmtime-set/target/release/wasmtime run $W -S cli --dir d::/d probe.wasm
```

**The HTTP shape — use it, it is how the platform actually runs.** See
`tools/parallelism-probe/set-http-handler.c` and the README section next to it.
Needs host `wit-bindgen` (the image has no C `wasi:http` bindgen) and `-S cli`
(the SET libc imports `wasi:cli/exit`, which the bare proxy world lacks).

**Regenerating the patches — this has silently produced a broken patch before.**
* libc: in the wasi-libc tree, `git add -A && git diff --cached > wasm/wasi-libc-set-threads.patch`.
* engine: the SET patch is a **subset** of the working tree (the other 9 enclave
  patches are also applied), so it is generated from a reconstructed 9-patch
  baseline tree. Copy the changed files into that tree and use
  **`git diff HEAD`**, not `git diff` — most files there are staged, and plain
  `git diff` silently produced a 2-file patch instead of 48.
* Verify both ways: `grep -c '^diff --git'` should be 48, every post-image blob
  hash should match `git hash-object` of the tree file, and
  `git apply --check` against a fresh baseline worktree must pass.

**TSan lies** about this code unless built with `--cfg rustix_use_libc` (rustix's
raw `munmap` hides fiber-stack frees; 200 workers reported 12 false races without
it, zero with it).

## What a round 10 should look like, if you run one

Only after the two design items above. Then: fresh reviewers over the *whole*
libc/engine surface rather than a delta, with an explicit mandate to build
**reactor** components and not just commands — that single blind spot hid a
CRITICAL for eight rounds. Give them `enclave-wasipsetc-build:r8` for A/B and
require that every claimed fix comes with a probe that demonstrably fails
without it.

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
