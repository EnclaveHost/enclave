# App slot ownership + host socket cleanup

Two defects behind the recurring nucbox-k11 "app listens but never answers" wedges
(2026-09-24/25, seen on `s3-ipfs-adapter` 0x7ae476a3, `ipns-publisher` 0xd9798e4c,
`risc-box` 0xe64f7cba). Diagnosed read-only from `enclave.log` + `agent.log` and a
thread/RIP sample of `ee-host`; the recovery for the live outage was the scheduled-task
node restart. This branch is the source fix. **Not deployed** — the box runs deployed
bytes at `ef1b2077`; d1 owns `windows/**` and the box build + review.

## (b) Cross-tenant slot reuse — tenant safety

`ee_rt_run` used to `APPS[id-1].take()` the running app OUT of its slot so the run
thread could own the non-`Send` `Store`. That left the slot reading `None`, so the next
`ee_rt_open` reused it and handed a SECOND live app the SAME handle. From then on:

- `ee_rt_stop(3)` bumped whatever engine sat in `RUN_ENGINES[2]`, and
- `ee_rt_close(3)` freed whatever app sat in `APPS[2]`,

so an ordinary owner-initiated restart of one tenant could stop or free a **different
tenant's** app. In the 09-25 logs two live apps shared "slot 3" (`0x7ae476a3` +
`0xd9798e4c`) and two shared "slot 1". This is a cross-tenant action from an in-bounds
handle — a safety bug, not just reliability.

**Fix:** an app table addressed by a handle that is NEVER reused, `src/slots.rs`.

- The handle is a GLOBAL monotonic id (1, 2, 3, …) minted per open; it identifies the
  occupancy, not an array slot. A running or mid-request app KEEPS its entry (`Running` /
  `Busy`), so nothing overwrites a live app.
- Every accessor finds the app by id, so a handle for an app that has stopped (its id
  retired) matches no entry and reaches nothing, and a handle never names a later app.
- `finish_run` (run thread) and `checkin` (request path) act only when the id still names
  their occupancy, so an app's teardown racing a new app cannot free the newcomer.
- `ee_rt_stop` gets the engine only for the app running under that exact handle
  (`running_engine`), so a wrong-tenant stop is impossible by construction.

**Why a monotonic id and not a generational index.** The first version of this fix packed a
generation into an array-index handle. Review (d1) then an independent audit showed that only
narrows the window: a generation field is finite, so once its counter WRAPS a retired handle
can equal a live one again and reach a different tenant — the exact thing the patch exists
to forbid (masking the field fixed truncation but not reuse). A never-reused id removes the
failure mode rather than shrinking it.

**Exhaustion is fail-closed.** `u32` gives 4,294,967,295 opens per node boot. When the id
space is exhausted `insert` REFUSES a new app rather than wrap and risk reuse; a node restart
resets the counter. At any real rate exhaustion is never reached (decades of continuous
uptime), and refusing to open a new app is safe while reusing a handle is not. The table is
still bounded to `MAX_APPS` concurrent apps; only the ADDRESS changed from an index to an id,
and lookup is a scan of at most `MAX_APPS` entries.

**Spinlock, no yield (deliberate).** The lock uses `spin_loop()` with no OS yield. Every
critical section is a handful of array/field reads or writes; nothing else runs under it. The
one non-trivial operation is `running_engine`'s `Engine` clone, which is an `Arc` refcount
bump (wasmtime documents `Engine` as cheaply clonable) — no host call-out, no allocation, no
app execution. Every value or engine a transition DISCARDS is moved into a local declared
before the guard so it DROPS AFTER the lock is released, never under it — a dedicated test
(`engine_drops_happen_outside_the_lock`) enforces this with an engine whose `Drop` panics if
the table lock is held. On a single-vCPU guest a spinner could burn its quantum if the holder
is descheduled mid-section; acceptable here because the sections are that short and this runs
on multi-vCPU enclaves. If the enclave ever runs pinned to one vCPU under heavy app churn,
revisit.

The handle is the opaque id and the host only echoes it back. **Cosmetic:** the node's
"loaded into the enclave as slot N" line now prints that id rather than 1..8.

## (a) Leaked host sockets on trap, and shared tenant ports

A wasi:cli app that traps has its `Store` dropped by `ee_rt_run`, but dropping a
`Store`/`ResourceTable` runs each resource's Rust destructor, NOT the WIT
`tcp-socket.drop` method that calls `ee_net_close`. So the app's **listener was never
closed on a trap**: the host kept the port bound by a dead app (observed as listener
handle 7 still held after the instance was replaced). Because the host also bound the
tenant port with `SO_REUSEADDR`, the relaunch bound the SAME port beside the corpse and
new connections went to the dead listener — a port that accepts and never answers.

**Fix, two parts:**

1. `src/netset.rs` (`SocketSet`) tracks every host socket an app holds
   (listen/accept/connect). `WasiState`'s `Drop` closes whatever is still open when the
   store is torn down for any reason, including a trap; the WIT `tcp-socket.drop` removes
   the handle first, so a socket is closed exactly once whether the guest closed it or
   teardown did. (`src/wasihost.rs`.)
2. The tenant listener binds `SO_EXCLUSIVEADDRUSE` instead of `SO_REUSEADDR`
   (`enclave-engine/ee-host.c`, mirrored in the harness `enclave-rt/host/ee-net-host.c`),
   so two apps that ask for the same port (e.g. two risc-boxes both defaulting to
   `tcp:2222`, seen in the logs) no longer both "succeed" — the second bind fails with
   EADDRINUSE. A closed listener frees its port immediately, so a relaunch on the same
   port still binds; only a LIVE double-bind is refused.

## What is NOT fixed here

The two live wedges themselves are separate from this bookkeeping and still open. A
registers-only thread sample (03:10Z) localized one and, on offline review, did NOT localize
the other:

- `ipns-publisher` 0xd9798e4c: 100% USER CPU, pinned 20/20 in an ~11-byte window at `ntdll`
  RVA 0xFC9B — the un-exported region right after `RtlRaiseException` (0xF700), before
  `RtlSleepConditionVariableCS` (0x11230), i.e. the RTL exception/unwind machinery. A genuine
  live-lock that never returns to the accept loop. The exact function needs `ntdll` PDBs; do
  not assert "exception storm" as fact, only "pinned in that region".
- `s3-ipfs-adapter` 0x7ae476a3: 10/10 in `NtWaitForAlertByThreadId`, 0 CPU — but this is
  INCONCLUSIVE. s3's loop is a non-blocking `srv.poll()` sweep then `thread::sleep(25ms)`, and
  that sleep maps to `ee_sleep_ms` → `WaitOnAddress` → `NtWaitForAlertByThreadId`; a HEALTHY
  idle s3 samples identically. The thread sample does not localize s3's wedge — that is
  established only by the port state (CLOSE_WAIT, not answering) and the node's record, and
  needs a different method (counting `accept()` call-outs, or the app's `conns.len()`).

These fixes remove the leaked-listener and cross-tenant-reuse amplifiers that made a
single app's stall look like a whole-node, un-restartable failure, and make a per-app
restart safe to target. They do not by themselves explain either wedge.

## Tests (run locally, no wasmtime needed)

`slots.rs` and `netset.rs` are dependency-free and unit-tested with `cargo test` /
`rustc --test`:

- `slots.rs` — 15 tests: two apps get distinct handles; a running/busy app keeps its entry
  so open cannot reuse its id; stop reaches only the named app; a retired handle resolves to
  nothing; a close of a retired handle cannot free a later app; an old completion racing a new
  app is a no-op; close-during-request frees on checkin; **a retired handle never reaches a
  later app even at the counter boundary** (the audit's scenario); **exhaustion fails closed
  and never mints 0 or a reused id**; **engine drops happen outside the lock** (a Drop that
  panics if the lock is held); the table fills/refuses a 9th and reopens with a fresh id after
  a free; handle 0 / unknown ids never valid; a 4-thread open/run/stop churn stays consistent.
- `netset.rs` — 6 tests: a listener left open by a trap is closed by teardown; a
  guest-closed socket is not closed again; failed calls never enter the set; add is
  idempotent; drain leaves the set empty.

Not built on this workstation: the full `enclave-rt` crate (needs the box's `wasmtime-set`
path dep, nightly `-Zbuild-std`, no_std) and the `ee-host.c` change (box MSVC); both parse
clean here (`rustc -Zunpretty=ast-tree`, 0 errors). The `lib.rs`/`wasihost.rs` wiring is
mechanical over the tested modules. **d1 type-checked the branch on the box**
(`cargo check --release --offline` against the real `wasmtime-set`, scratch copy, nothing
deployed): 0 errors. Still not done: a link/DLL build and the `ee-host.c` MSVC build.

## Review asks d1 raised, addressed

- Slot released by the owner that took it: `finish_run`/`checkin` are gen-checked, so only
  the occupancy that took the slot clears it.
- `ee_rt_stop` refuses a wrong-tenant stop by construction: `running_engine` yields an
  engine only for the exact handle's running app.
- `SO_REUSEADDR` shown at the call site (`ee-host.c` EE_OP_LISTEN), now
  `SO_EXCLUSIVEADDRUSE`.
- "Nothing closes host handles when EeAppRun returns" — the return path is
  `ee_rt_run` → `drop(taken)` → `Store` drop → `WasiState::drop` → close remaining
  sockets; before this branch there was no such close.
