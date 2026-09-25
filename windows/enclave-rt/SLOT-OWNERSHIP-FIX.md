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

**Fix:** a generational slot table, `src/slots.rs`.

- A running or mid-request app KEEPS its slot (`Running` / `Busy`), so `insert` can never
  reuse a live slot and mint a duplicate handle.
- Every handle carries the generation of the occupancy it was minted for. A handle for an
  app that has since stopped no longer resolves to whatever app took the slot next.
- `finish_run` (run thread) and `checkin` (request path) act only when the generation
  still matches, so an app's teardown racing a new occupant of the same slot cannot free
  the newcomer.
- `ee_rt_stop` gets the engine only for the app running under that exact handle
  (`running_engine`), so a wrong-tenant stop is impossible by construction, not merely
  unlikely.
- Access is serialised by a tiny spinlock held only for table transitions, never across an
  app's execution (an app is checked out of the table to run/serve and back in after). The
  old `static mut` access from the run thread and the gate thread was an unsynchronised
  data race.

The handle is now opaque (slot in the low 3 bits, generation above) and the host only
echoes it back. **Cosmetic:** the node's "loaded into the enclave as slot N" line now
prints that opaque id rather than 1..8.

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

The two live wedges themselves had distinct proximate causes that are separate from this
bookkeeping and still open:

- `ipns-publisher` 0xd9798e4c: its ee-host thread spun 100% in `ntdll` exception dispatch
  (20/20 RIP samples near `RtlRaiseException`); the brokered call never returned, so the
  accept loop stalled. Cause of the exception storm not yet identified.
- `s3-ipfs-adapter` 0x7ae476a3: its thread was blocked in `NtWaitForAlertByThreadId`
  (10/10 samples, 0 CPU) — a wait that never completes.

These fixes remove the leaked-listener and cross-tenant-reuse amplifiers that made a
single app's stall look like a whole-node, un-restartable failure, and make a per-app
restart safe to target. They do not by themselves explain why those two threads stalled.

## Tests (run locally, no wasmtime needed)

`slots.rs` and `netset.rs` are dependency-free and unit-tested with `cargo test` /
`rustc --test`:

- `slots.rs` — 13 tests: two simultaneous apps get distinct slots; a running/busy app
  keeps its slot so open cannot reuse it; stop reaches only the named app; a stale handle
  after slot reuse resolves to nothing; a stale close cannot free the new occupant; an old
  completion racing a new occupant is a no-op; close-during-request frees on checkin; the
  table fills and refuses a ninth app; handle 0 / out of range never valid; a 4-thread
  open/run/stop churn stays consistent.
- `netset.rs` — 6 tests: a listener left open by a trap is closed by teardown; a
  guest-closed socket is not closed again; failed calls never enter the set; add is
  idempotent; drain leaves the set empty.

Not built here: the full `enclave-rt` crate (needs the box's `wasmtime-set` path dep,
nightly `-Zbuild-std`, no_std) and the `ee-host.c` change (box MSVC). Both parse clean
(`rustc -Zunpretty=ast-tree`, 0 errors); the type-check and the C build are d1's on the
box. The wiring in `lib.rs`/`wasihost.rs` is mechanical over the tested modules.

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
