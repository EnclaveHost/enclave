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

## (c) Cross-generation id reuse (node ↔ ee-host boundary)

The monotonic id is never reused WITHIN one ee-host process, but the counter resets to 1 every
time ee-host restarts, so across a process generation the same numbers name different apps.
Review (Codex) asked whether a stale queued request or old mapping in the node could reach a new
app under a reused number.

What already existed: on an ee-host restart `agent.mjs`'s `start.host` reconnects and, once the
port is up, `host.mjs` does `host.apps.clear()` — the old `EnclaveApp` objects (holding stale
slots) are dropped and the apps are reloaded from the leases with fresh ids. Nothing persists a
numeric slot (`host-state.json` holds only deployment ids and the blocked set). That is coarse
invalidation, but it leaves a narrow window: an in-flight request holding a pre-restart
`EnclaveApp` object could still send its old slot after the new ee-host is up and has reused the
number.

**A node-only guard is not enough (correction).** The first version of this section (c8f18eea)
claimed the boundary was "closed by construction at the node": `agent.mjs` bumps a `hostGen` on
every ee-host (re)start, each `EnclaveApp` stamps the generation it was opened in, and
`handle`/`stop` refuse once it is stale. An independent audit (Codex) showed two async races that
guard cannot close, both reproduced against the real `EnclaveApp`:

1. **Deferred open.** `start()` sampled the generation AFTER awaiting `appopen`. Open A in gen 1,
   hold the reply, restart (gen 2), release the old reply: A was stamped gen 2, looked current, and
   a later `stop()` sent `appclose 1` to the new ee-host — whose slot 1 was a different app.
2. **Queued command.** `hostCmd` enqueues the job before `net.connect`, so an `appclose`/`appstop`/
   `apphandle` already in the funnel when ee-host restarts connects to the NEW ee-host. A check at
   `EnclaveApp` entry cannot recall a command already queued, and for `appstop`/`appclose` the side
   effect happens at the receiver before any node-side check could run after it.

A guard that only decides whether to SEND is a filter, not an authority. **The fix puts the check at
the side-effecting end: a per-boot epoch in ee-host.** `ee-host.c` mints `g_app_epoch` (a random
nonzero `u32`, `rand_s`) when it starts serving and logs it; `appopen` answers
`ok <id> <load_us> <epoch>`; `apphandle`, `apprun`, `appstop` and `appclose` must carry it
(`<cmd> <epoch> <id> ...`) and a mismatch is refused (`err stale epoch`) BEFORE any `do_app_*` call.
A command minted under a dead boot carries that boot's epoch, so the next boot refuses it no matter
how it was queued or when it connects. The node:

- stores `this.epoch` from `appopen` and sends it on every id-scoped command;
- samples the generation BEFORE the `appopen` await (race 1's stamp), and if a restart happened
  during the open, releases the slot under the reply's OWN epoch (only the boot that minted it can
  accept that, so it can only ever close the app this open created) and fails the start —
  `host.tick` reloads the app from its lease;
- treats `stale epoch` like `no such app` in `host.mjs` (the app is gone; reload it);
- keeps the `hostGen` check as a local filter so a known-stale app sends nothing at all.

So the node guard is NOT the only thing between a stale handle and a live tenant any more; ee-host's
epoch check is the authority and the node guard is the first filter. An epoch collision across two
boots (1 in 2^32) would only degrade to the node filter.

**Fail-closed on a mismatched pair; deploy ee-host.exe and the node TOGETHER.** A new node refuses
an `appopen` reply without an epoch (`the enclave host returned no app epoch`) rather than use an
unbound id; a new ee-host refuses the old epoch-less grammar (`err bad id`/`bad request`). Either
half alone therefore opens no app, and `host.mjs` gives a lease back after three failed starts —
`windows/node/sync.sh` on its own (node files only, old `ee-host.exe`) would do exactly that.

`hostCmd` moved verbatim into `appframe.mjs` as `makeHostCmd(port)` (already on `sync.sh`'s file
list, already imported by `agent.mjs`) so the tests can drive the real funnel; `agent.mjs` delegates
to it through its hoisted `hostCmd` function, so there is no behavior or ordering change.

`windows/node/apptool.mjs` (the hand tool) speaks the same grammar: `run`/`open <world> <cwasm>`
print the id AND the epoch, `get <epoch> <id> <path>`, `close <epoch> <id>`, and it refuses an
epoch-less `appopen` reply. (Its old `open <cwasm>` sent no world and was already refused by
ee-host as usage.)

Tests:
- `test/enclave-app-epoch-funnel.test.mjs` (7; emulator in `test/helpers/ee-host-emu.mjs`) — through the REAL funnel against a loopback server
  speaking ee-host's app protocol with its epoch check, with a real restart (the old process stops
  accepting, a new one binds the same port with ids from 1 and a new epoch): the deferred-open race
  and the queued-appclose race each leave the new host having executed nothing under the old epoch
  and the other tenant intact; each runs again with the emulator's epoch check OFF and shows the
  cross-tenant close actually lands (the interleaving is real, so the tests are not vacuous); and
  every id-scoped command with a dead boot's epoch, and the old grammar, is refused; `apptool`
  run/get/close carry the epoch, a dead boot's epoch and an epoch-less host are refused.
- `test/windows-node-stale-epoch.test.mjs` (1) — `host.mjs`'s mapping: a queued `apphandle` that
  the new ee-host refuses as `stale epoch`, through `Host.proxy` with `hostGen` wired, is answered
  `app_gone` and marks the app and its record failed so `host.tick` reloads it (reverting the
  regex to `/no such app/` fails it: a record that says running while every request fails).
- `test/enclave-app-host-generation.test.mjs` (5) — the audit's cross-generation scenario at the
  node filter, the epoch on every command, fail-closed on an ee-host that returns no epoch, and
  `appstop <epoch> <slot>` for a server-shaped app.
- Mutations: stamping the generation after the await (race 1 exactly) fails 3 tests; dropping the
  epoch from `stop` fails 4; the `host.mjs` regex revert fails 1; the old `apptool` fails 2 (d1
  added: removing the mid-open release fails 3, accepting an epoch-less reply fails 1).

**Not proven by these tests, so nobody reads more into them.** The emulator MIRRORS `ee-host.c`'s
check; the C is compiled on the box (MSVC 19.51, `/W3`: 0 warnings, 0 errors) and reviewed, but no
test executes it. And the epoch is a generation tag, NOT authentication: any local process can read
it from ee-host's "serving on" log line or an `appopen` reply and present it. The loopback protocol
had no authentication before either, so this is not a regression, only a limit on what it claims.

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

- `ipns-publisher` 0xd9798e4c: 100% USER CPU, pinned 20/20 at `ntdll` RVAs 0xFC9B/0xFCA0/0xFCA6.
  **Symbolized** against the public PDB for that exact build (10.0.26100.9444; the DLL's own
  CodeView record and the PDB share key `C3093720177DA6851519DCFFE8DF53FE1`): the RVA is
  **`RtlpWaitOnCriticalSection`+0x2DB**, and the exception directory puts it inside one unchained
  function [0xF9C0, 0x1007F). The three RIPs are the tail of one loop, which walks a linked list
  (`cur = cur->[+0x10]; cur->[+0x18] = prev`) until it finds a node whose `[+0x20]` is nonzero,
  with no null check and no other exit. A waiter list is a few nodes long, so being pinned there
  means the walk never terminates: a **cycle in a critical section's wait list**. It is a
  corrupted lock, not an exception storm. (The first reading, "RTL exception/unwind region after
  `RtlRaiseException`", came from exports only and was WRONG.) Not determined: WHICH critical
  section. The sample holds RIPs only, and the candidates are ee-host's `g_log_cs`/`g_sock_cs` plus
  CRT, loader and winsock-internal locks. Ruled out: a `g_socks[]` overrun corrupting an adjacent
  lock (`handle` is `uint32_t` and every index is checked `< 256`). Evidence and method:
  `~/enclave-bench/wedge/sym/README.txt` on the workstation.
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

Not buildable on this workstation: the full `enclave-rt` crate (needs the box's `wasmtime-set`
path dep, nightly `-Zbuild-std`, no_std) and `ee-host.c` (MSVC). **d1 type-checked d93c7356 on the
box** (`cargo check --release --offline` against the real `wasmtime-set`, scratch copy): 0 errors.
**Full box build of c8f18eea** (enclave-63, 2026-09-25 04:24:38–04:26:08Z, scratch
`C:\Users\claude\e63-build`, box's own toolchain, nothing deployed): `enclave_rt.lib`, then
`ee-engine.dll` relinked from the prebuilt engine objects + that lib, and `ee-host.exe`; all exit 0.
The epoch change touches only `ee-host.c` and the node, so `enclave_rt.lib`/`ee-engine.dll` are
unaffected and only `ee-host.exe` was rebuilt for it: b3447eb7, 2026-09-25 04:55:12–04:55:14Z,
`build.cmd host` at BelowNormal priority, exit 0, cl.exe 19.51.36247.0 (MSVC 14.51.36231), `/W3`
0 warnings. Sentinel `C:\Users\claude\e63-build\BUILD-SENTINEL-b3447eb7.txt`:

| artifact | sha256 | from |
|---|---|---|
| `ee-host.c` | `2259ace797a02bd9bd9b6d4b1151b821329a81ef344cbbaec734ddebee679825` | git blob at b3447eb7 |
| `ee-host.exe` | `ec7ba0a2612da7a2a8a4ed545fd73b3d79787e8788213b1ef1f5151f3cc139b5` (215552 B) | that source |
| `ee-engine.dll` | `dd26b524ba28530e54aebf029b51748e81621d6a958d74ea2f5953fd03b39c15` | c8f18eea build (unchanged) |
| `enclave_rt.lib` | `762c3682b7f71062fb9842d3f58170d2298940d1ecf8845bf680c83237095006` | c8f18eea build; rt sources identical |

MSVC output is not bit-reproducible, so an exe hash names a BUILD, not a source: `build.cmd link`
falls through into `:host`, and the c8f18eea run's `ee-host.exe` was `0b5be00d…85b1` (written by
the link step), not the `0e0be1cd…` its earlier `host` step printed.

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
