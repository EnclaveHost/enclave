# QMP transport + launch diagnostics repair: source-author report (UNRUN)

Status: SOURCE ONLY. Nothing was executed, imported, compiled, bound or connected by the author: no tests, no py_compile,
no sockets, no systemd/QEMU/SSH, no image/DB access. All tests below are AUTHORED, NOT RUN. Nothing here claims runtime
recovery, DB health, mask success or RPC readiness.

## Incident boundary
evidence/production-failure/RESULT.json records `BlockingIOError: [Errno 11]` with no phase, no stack, an empty console, and
cleanup reporting the unit gone and pidGone. **The cause is UNKNOWN.** In the seed code, EAGAIN could have come from several
syscalls, and that record cannot tell them apart. These fixes target defects that can be reviewed on their own in the source.
They do not explain the incident, and no authored test can prove its cause after the fact. The new diagnostics only make a
FUTURE failure attributable (phase, syscall step, errno).

## Changed paths
| path | change |
|---|---|
| candidate/maint_boot.py | modified (only product file changed) |
| candidate/test_qmp_transport.py | new, authored regression tests (UNRUN) |
| candidate/test_maintenance_diagnostics.py | new, authored regression tests (UNRUN) |
| candidate/REPORT.md, candidate/CLOSURE.json | new reports |

Unchanged: guest_mask.py, test_root_maintenance.py, SHA256SUMS (seed evidence; it still lists the SEED maint_boot.py hash
`10e41ac8…f1ff`, so it will not match the modified file, which is intended). No candidate/qmp_transport.py was created. The
helper runs as `#!/usr/bin/python3 -I`, and isolated mode leaves the script directory off sys.path, so a sibling import would
fail in production. Loading it by path would add a second unpinned file to deploy. The transport therefore lives in maint_boot.py.

Original tests: test_root_maintenance.py stays byte-identical. Its recorded seed hash (SHA256SUMS / seed-pins.json) is
`e35025e3c119b449a558fa1965260c2245107a44d8073fb5ac5bb3a434442951`. It has **13 test methods: Host 10 + Guest 3**. Root
should re-hash it externally; the author computed no hash. The 3 that touch QMP-adjacent code (cleanup foreign invocation,
guest_shutdown_seen, powerdown with a SimpleNamespace fake) still work through the legacy seam described below.

## Changed symbols (maint_boot.py)
- New constants: `QMP_CMD_S=30, QMP_FRAME_MAX=1 MiB, QMP_RECV=64 KiB, QMP_EVENTS_KEEP=64, QMP_ABANDONED_MAX=4, QMP_EINTR_MAX=16,
  QMP_CONNECT_RETRY={ENOENT,ECONNREFUSED,EAGAIN}, QMP_MUTATING={cont,system_powerdown,quit}, QMP_EVENT, QMP_REASON,
  LAUNCH_PHASES, TB_FRAMES=8`. No existing constant (LIMITS, MEMORY_MAX, floors, FLAGS, properties…) was touched.
- New: `safe_text, errno_name, unix_stream, QMPError(Refuse), aware, qmp_cmd, qmp_pump, qmp_usable, qmp_uncertain, qmp_close,
  open_qmp, exc_brief, exc_info, Trace`.
- Replaced: `class QMP` (`__init__, _fail, _io, _frame, _send, _event, events (property), _reply, _late, _abandon, usable, cmd,
  pump, close, stats`).
- Modified: `Ctx.__init__` (+`self.trace=None`), `verify_prelaunch`, `wait_ssh`, `powerdown`, `cleanup`, `cmd_launch`, `main`.
- Untouched: every pin/host/argv/backup/capacity/guard function, `guest_shutdown_seen`, `same_process`, `wait_unit_inactive`,
  `run_guest`, `cmd_prepare`, `cmd_finish`.

## Before -> after
| defect (seed) | repaired behaviour |
|---|---|
| Constructor created/connected the socket outside any cleanup. Connect, greeting, decode or capabilities failure leaked the fd, and each readiness retry could leak another. | `self.s` and all fields are initialised first. `except BaseException: self.close(); raise` covers every path, including non-OSError exceptions. `close()` is idempotent and never raises; a close errno is recorded and does not replace the primary error. |
| The successful connection was never closed. | `cmd_launch` `finally` calls `qmp_close(q)` on success and on failure, after cleanup has finished using it. |
| `_read` called `settimeout(timeout)` before EVERY recv, so a peer dribbling bytes reset the clock forever. Per-attempt 10 s connect/greeting budgets restarted on each retry. | Every blocking call goes through `_io`, which computes `end - clock()` and treats `<= 0` as expired. The constructor gets ONE absolute end covering connect, greeting, capabilities and every partial read/write/event. `open_qmp` passes the same `c.clock()+qmpS` (180, unchanged) to every attempt. Already-buffered frames are deadline-checked too. |
| `cmd` used a 30 s per-recv timeout; an event flood or dribble never ended. | `cmd(name, end=None)` uses one absolute end, `min(end, now+30)`. The caller's phase end can only shorten it. |
| `pump(seconds)` used a per-recv timeout; nested calls in wait_ssh/powerdown/cleanup could pass the phase end. | `pump(seconds, end)` stops at `min(end, now+seconds)`. `wait_ssh`, `powerdown` and `cleanup` pass their phase end. In cleanup, one graceful-phase end of `2*30+powerdownS` bounds every command and pump. |
| Readiness caught `FileNotFoundError, ConnectionRefusedError, TimeoutError` from the whole constructor. Raw EAGAIN escaped unclassified. | `open_qmp` retries ONLY `QMPError` with `(stage,op)==('connect','connect')` and errno in {ENOENT, ECONNREFUSED, EAGAIN}. The failing attempt has already closed its own socket. Each retry re-checks the owned unit state, and the pause is `sleep(min(1, remaining))`. EAGAIN, EACCES, timeouts and protocol errors at greeting, capabilities, recv or send fail immediately. |
| No request ids; any non-event frame (even a stale or unrelated reply) answered the current command. | Each connection numbers its requests `maint-N`, and a reply must carry the exact id. A mismatched, duplicate or unknown id fails closed (`correlate`), and so does a reply received during pump. ONE late reply per abandoned id is absorbed (at most 4, bounded). |
| No envelope validation; `json.loads` errors propagated raw. | Greeting must be exactly `{"QMP":{version:dict, capabilities:list}}`. A reply must have one of `return`/`error`, a string id, and nothing else; an error must be `{class:str, desc:str}`. Events must match `[A-Z][A-Z0-9_]{0,63}` with an object for data and keys limited to event/data/timestamp. A non-object, non-JSON, invalid-UTF-8 or deeply nested frame fails closed. |
| `events` list grew without bound and kept raw payloads. | Only summaries are stored (`{'event': name}`; SHUTDOWN also keeps `guest` as bool/None and a regex-validated `reason`), last 64 retained, drops counted. The first trustworthy `SHUTDOWN data.guest is True` is pinned and cannot be evicted, and `guest_shutdown_seen` sees it. Guest False/None/non-bool is never upgraded. |
| A partial or uncertain send had no recorded outcome; cleanup would resend system_powerdown. | `_send` loops on `send()` with remaining time and tracks the bytes sent. `sent=none` means not-sent, connection still usable. `partial` means outcome unknown, connection broken. A full send with no verified reply means outcome unknown and the id is abandoned. Mutating commands with unknown outcome go into `q.uncertain`. Cleanup never resends a `quit`/`system_powerdown` whose outcome is unknown (`notResent`); it only observes. No code path resends any command. |
| EOF inside a frame was silently dropped. | Partial EOF fails closed (`op=eof`, `trailingBytes`). A clean EOF before a reply is `op=eof`, outcome unknown. |
| RESULT.json carried only `Class: message`. A cleanup exception of an unlisted type skipped the owned stop and replaced RESULT. | `res['error']` is unchanged. A new `res['diagnostics']` is always written. Cleanup's graceful QMP part now catches any `Exception`, so the owned stop below always runs, and records `qmpDiag`. A cleanup exception goes into `cleanupError` and never replaces `error`. |
| verify_prelaunch put the raw query-status dict in its message; a non-dict/non-list reply crashed with AttributeError. | Same acceptance conditions. The message carries only a bounded status and a running bool. Non-object/non-list replies are refused explicitly. |

## Diagnostics schema (`enclave-rpc-maint-diag/r1`)
In RESULT.json `diagnostics`, and in REFUSED-launch-*.json `diagnostics` for launch refusals that happen before RESULT exists:
- `phase` is from LAUNCH_PHASES: load-prepared, single-use, pins, host-checks, backup-intact, capacity, plan-match,
  unit-absent, run-dir, systemd-run, unit-state, qmp-ready, prelaunch-verify, cont, ssh-wait, guest, powerdown, done
  (+ cleanup, qmp-close, console-tail, result-write for later steps). Any other value is written as 'unknown'.
- `phasesReached[]`, `unitRequested` (systemd-run was invoked), `preLaunch` (failed before any unit/VM was requested,
  so not a guest/VM failure), `pidVerified`.
- `cont`: not-attempted | not-transmitted | rejected | outcome-unknown | acknowledged.
- `readiness`: `{attempts, sleeps, connectErrnos:{ENOENT|ECONNREFUSED|EAGAIN: n}}`.
- `error`: `{class, errno, errnoName, cause:{class,errno,errnoName}|null, where:[{file(basename),func,line}] (last 8),
  qmp?:{stage, op, errno, errnoName, cause, expired, command, requestId, sent: none|partial|full, outcome:
  not-sent|unknown|rejected}}`.
  stage: connect | greeting | capabilities | command | pump. op: socket | connect | send | recv | decode | frame | envelope |
  event | correlate | reply | eof | deadline | state | not-ready | unit-inactive.
- `qmp` (q.stats()): `{requests, eventsSeen, eventsKept, eventsDropped, guestShutdownEvidence, abandoned[], lateReplies{},
  outcomeUnknown{}, broken, peerClosed, trailingBytes, closed, closeErrno}`. `qmpClose`: `{closed, closeErrno|closeError}`.
- The diagnostics contain no exception messages, peer payloads, env, argv, SSH data, frame locals or source lines. QMP error
  `desc` appears only inside the existing `error` string, sanitised and cut to 160 chars. Peer-chosen reply ids are never
  echoed. Evidence files are still written by `write_new` (O_EXCL, 0600); permissions are unchanged.

## Limits
qmpS 180 (unchanged, ONE absolute end). Per command ≤ 30 s absolute, never widened by a caller end. Pump ≤ min(phase end,
now+seconds). Cleanup graceful phase ≤ 2·30 + powerdownS(300). Frame ≤ 1 MiB; receive buffer ≤ 1 MiB + 64 KiB. Events kept ≤ 64
(+1 pinned SHUTDOWN guest=true). Abandoned ids ≤ 4 (more makes the connection unusable). Late replies kept ≤ 4. EINTR
≤ 16 per operation. Readiness pause ≤ min(1 s, remaining). No threads, no unbounded sleeps or retries.

## Invariants preserved
No change to memory/CPU/floor/timeout limits, unit properties, argv derivation/validation, disk/seed/backup handling, or
activation. Prelaunch verification (paused status, exact MainPID argv, cgroup, memory.max/swap.max, block nodes) still runs
in full before `cont`, and `cont` is sent only after it succeeds. Cleanup still uses observed query-status (prelaunch → quit,
running → ACPI) and stops ONLY a unit whose InvocationID is ours. It never sends a signal to a PID. Success still requires
SHUTDOWN(guest true), QMP closed, unit inactive and PID gone. Nothing restarts, retries a previous invocation or replays a command.

## Intentional behaviour deltas for root review
1. **connect EAGAIN is now retried** within the same end, after the owned-unit check. On a non-blocking AF_UNIX connect it
   means the listener backlog is full; it is treated like ECONNREFUSED. This is NOT a claim that it caused the incident. If root
   prefers fail-fast, remove `errno.EAGAIN` from `QMP_CONNECT_RETRY` (one token).
2. A greeting/capabilities timeout is no longer retried. It now means the single readiness end has expired. For legacy
   injected factories, `TimeoutError` is likewise no longer retried.
3. `wait_ssh` treats `clock == deadline` as expired (`>=`, was `>`).
4. Additive evidence keys: `diagnostics`; cleanup `qmpDiag/notResent/qmpSkipped`; `cleanupError`; REFUSED-launch `diagnostics`.
   If cleanup itself raises, `main` now returns 1 with RESULT written, instead of the old path (exception → REFUSED → 2).
5. Stricter protocol: a malformed greeting or event, or an unknown event-name shape, fails closed.
6. `QMP.events` is now a read-only property of summaries.

## Integration call sites
`cmd_launch → open_qmp(c, plan, c.clock()+qmpS, trace)` (`c.qmp(path, end=, clock=)` when `DEADLINE_AWARE`, otherwise legacy
`c.qmp(path)`). `verify_prelaunch → q.cmd(...)` (30 s each, as before). `cmd_launch → q.cmd('cont')`.
`wait_ssh → qmp_pump(q, 1, sshDeadline)`. `powerdown → q.cmd('system_powerdown')`, then `qmp_pump(q, 1, end)`.
`cleanup → qmp_usable / qmp_cmd(…, qend) / qmp_uncertain / qmp_pump(…, end)`. `cmd_launch finally → q.stats(), qmp_close(q)`.
`main → c.trace.snapshot(e)`. Legacy seam: objects without `DEADLINE_AWARE = True` keep `cmd(name)`, `pump(seconds)`,
`.eof`, `.events`. This is chosen explicitly; there is no TypeError catch-and-retry.

## Proposed tests (AUTHORED, NOT RUN)
test_qmp_transport.py (FakePeer + FakeClock through the real `sock=`/`clock=` seams; UnixFixture uses one AF_UNIX listener in a
TemporaryDirectory with 5 s timeouts and a 10 s join):
Constructor (14 failure paths each close once, idempotent success close, socket-creation and non-OSError failures, close error
recorded), Classification (EAGAIN at connect / greeting recv / capabilities send+recv / command send+recv classified
distinctly and never retried, EINTR cap), Deadlines (dribbled greeting timeouts exactly 5,4,3,2,1; greeting + capabilities
sharing one end 6..1; caller end shortens but cannot widen; buffered event flood stops at the end; pump window and buffered
partial frame), Framing (overlong frame with and without newline, bounded buffer, partial and clean EOF, 10 malformed shapes
fail closed and send nothing more), Correlation (interleaved events, mismatched/duplicate/stale ids, bounded correlated error,
one late reply absorbed, unsolicited reply in pump, abandoned cap), SendOutcome (partial send then block → unknown, never
replayed; zero-byte block → not-sent; full send without reply → unknown, sent once), ShutdownEvidence (guest true pinned
across the cap, false/non-bool insufficient, payload not retained), Readiness (one end across 4 attempts with exact
remaining-time timeouts and sleeps 1,1,0.5, no retry outside connect, inactive unit, legacy seam), RealUnixSocket (real
framing/correlation/EOF, constructor failures leave no fd, 50 failed connects without fd growth, dribbling real peer bounded).
test_maintenance_diagnostics.py (real cmd_launch/cleanup/wait_ssh/main; fixture /proc, cgroup, meminfo; per-test mock
context managers only):
greeting EAGAIN before PID → phase qmp-ready + greeting/recv/EAGAIN, not retried, socket closed, exact owned stop; connect
EAGAIN×2 retried in ONE end → identity failure → quit, never cont; running before cont never continued; foreign InvocationID
never stopped; cont without reply → outcome-unknown, sent once; powerdown without reply not resent by cleanup; pre-launch
refusal labelled preLaunch in REFUSED with no systemd calls; success path unchanged (command order, ids, no stop, close, seed
LIMITS/properties/memory constants); cleanup under an endless event stream bounded by 2·30+300; uncertain quit not resent;
cleanup QMP failure still reaches the owned stop; wait_ssh pump never extends sshS.

These tests would check the repaired transport and wiring only. They cannot show what caused the incident, and they do not
show DB health, mask success or RPC readiness.

## Known gaps
- Nothing was run, including syntax. Root's admitted test stage should first run `python3 -I -m py_compile` on the three .py
  files, then the two new test files. The tests may contain authoring errors.
- test_root_maintenance.py is NOT hermetic: Host.setUp loads the pinned launcher from `M.DEFAULT_CFG['launcher']` and reads the
  live manifest path. Proposed future root-owned harness: a read-only copy of the exact pinned launcher (sha 38f8dc89…) and
  manifest (sha a2843215…) in a root-owned 0700 fixture dir, exposed through an explicit fixture-config path (not a widened
  product default). Run as uid 1000, no network, with an empty runtime dir; it must not touch images.
- `wait_unit_inactive` (not QMP) keeps `>`. The SSH subprocess timeout of 40 s plus `sleep(5)` can still overrun sshS by up to
  ~45 s, as in the seed; this is not caused by QMP.
- verify_prelaunch and the first `system_powerdown` keep their own 30 s per-command bound, as before. They are not tied to
  the readiness/powerdown ends.
- Legacy injected fakes cannot enforce deadlines inside their own cmd/pump; the outer loop bounds still apply.
- CPython already retries EINTR internally (PEP 475); the cap is defensive. The fd-count tests are Linux-only (/proc/self/fd).
- Nothing in this package can run on the guest side, on the DB, or recover the RPC. Those remain separately admitted root work.
