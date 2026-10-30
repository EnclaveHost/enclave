# 1852: narrow source review of base-state-readonly-stage/r10: the capture lifecycle only (root 1847, author 1848)

**Scope of MY activity:** source reading only.
- **What I read:** `jobs/bsro_gate.py` (`group_alive`, `run_capture`) and the changed or new regressions in `tests/test_bsro_gate.py` (tests 7, 8, 12, 13, 15, 16 and `kill_test_group`).
- **Taken as reported, not re-reviewed:** the namespace (unchanged from r9 except labels; root reports the actual r9 ns-tests 5 PASS at `20261027T072409Z-2910017`).
- **Not done:** tests, builds, queue jobs, mounts, scope changes, production reads, network, installs, commits or edits.
- **Results:** root's actual r10 unit tests may be running; nothing here claims or denies their result. All r10 bytes are preserved.

| item | sha256 |
|---|---|
| r10 `SHA256SUMS` (`sha256sum -c` OK; r9 unchanged) | `0034b392709ec2142ab465b4a50a993e47738a99cecd620d17876560218c36df` |
| `jobs/bsro_gate.py` | `e91116aa46f621c0366cbb0bee3c22982363c430f349a5642090b7fec1c20beb` |
| `tests/test_bsro_gate.py` (16) | `d727f4ab1d06b10db1486d1bfeeb21c1902c7ea257afb9a76a56dca7d73d7f46` |

## Correction of my review 1846
1846 stated that every `killpg` was "gated by `unreaped()` on our own unreaped leader". That was **wrong**:
- **What the code actually did:** r9's `unreaped()` returned `waitid(…WNOHANG|WNOWAIT) is None`, which means **still running**.
- **The consequence:** after the leader **exited** (a zombie, still unreaped), both `term_group` and `kill_group` became no-ops.
  - The post-exit grace KILL never reached surviving owned group members (tests 7/12's holders); the run only ended via `hard` → `abandoned` with those members still alive.
  - The EOF-then-unbounded-`p.wait()` path existed as well.

**Root 1847 was right,** and I missed both while not tracing the return value. This review traces the conditions explicitly.

## r10 `run_capture` (`bsro_gate.py:333-437`): traced conditions
**When a signal can be sent:** only through `signal_group(sig)`, which acts iff `p is not None and not st["final"]`.
- `final` is set **only** immediately before the single `p.wait()` (`:433-434`).
- **Why the pgid stays ours:** until then the leader (`start_new_session`, so pid = pgid = sid) is our child and **not reaped**. Running or zombie, its pid stays allocated, so no other process can own a group with that id (a new group's id is its creator's pid). Existing members keep it.
- **So `killpg(p.pid, …)` before `final` reaches only our group,** including after the leader exited, which is what 1847 required.
- **Only we reap:** no code other than our final `p.wait()` reaps this child.

**TERM:** `term_group()` sends at most one TERM (`sentAt`), never after `final`. Its triggers:
- `fwd` (our SIGTERM/SIGINT/SIGHUP; handlers installed before `os.open`/`Popen`, with `pending` replayed after the spawn);
- `sink_failed` on a write **or** an EOF fsync error (`:366-369`, `:394-398`, `:402-405`);
- the error cleanup.

**KILL:** `signal_group(SIGKILL)` runs once (`killed_at`) when either:
- (leader exited and `now − exited_at > grace`), **regardless of EOF** or member liveness; or
- (leader running, our TERM sent, and `now − sentAt > term_wait`), **regardless of EOF.**

**Loop exits (only two):**

| exit | condition | result |
|---|---|---|
| (a) done | `eof` (all writers closed; the sink was fsynced at that moment) **and** the leader exited **and** `group_alive(pgid)` false (no live non-zombie member) | `:409-411` |
| (b) abandoned | `now − killed_at > hard` | `:415-416`: a pipe holder outside our group, or members that survived SIGKILL; never a success (`outer` refuses verification) |

**Every other state keeps ticking.** That includes EOF with the leader still running: the r9 hole is closed, because if a TERM was sent, `term_wait` escalates to KILL.

**Unexpected exception** (`done` false; `:425-432`):
- close the read end, then TERM (once), then wait ≤ `term_wait` while `running() or group_alive`;
- if either still holds, KILL the owned group (also after the leader exited);
- `final`, the reap, then re-raise.

**Spawn failure:** `p` is None, so no signal or reap; the fd is closed and the handlers restored.

**After the reap:** the handlers are restored only after `p.wait()`. A handler that fires during or after the reap sees `final` and sends nothing.

**`group_alive`:** a `/proc` scan for non-zombie members with that pgrp (`:318-330`). It is called only after the leader exited, or in error cleanup. A leader zombie or reaped-member zombie does not count.

## Production effect (the build path `outer` → `unshare -Urnm bash build.sh` → `disk_guard.py` → its own build group)
**Normal end:** `disk_guard` stops and reaps its build group, `build.sh` exits, all pipe writers close, and the group is empty. That is exit (a), promptly (no grace wait).

**Cancel or sink failure:** ONE TERM goes to our group. The `build.sh` trap keeps the shell while `disk_guard` stops its own group (rc 73), and then exit (a). If the shell does not exit within `term_wait` (120 s), the KILL reaches our group.

**Residual, unchanged:** if our KILL hits `disk_guard` before it stopped its separate build group, that group is outside our pgid. It then holds the pipe until `hard`, giving **abandoned** (never verified), and continues only under cargo's own `timeout -k 30 7200` and the queue's tree kill.

## Findings
**Concrete production blockers in the reviewed scope: none.** The 1847 items are implemented as traced above:
- signalling allowed until the final reap;
- EOF keeps ticking;
- fsync failure → TERM;
- error cleanup kills surviving owned members;
- no signal after the reap.

**Documented residual risk (not blockers):**
- **Unbounded final waits:** an abandoned run with members or a leader that survives SIGKILL (D-state) leaves the final `p.wait()` unbounded.
- **Escaped descendants** outside our group are never ended by r10 (abandoned only; the queue's tree kill is the backstop).
- **No deadline for a normal build:** a running leader with no TERM sent has no deadline here (by design: the build's own bounds are disk_guard's 7500 s and cargo's 7200 s).
- **`group_alive` per tick:** a `/proc` scan every 0.05 s tick after the leader exit, until done or abandoned (bounded by grace + hard).

**Test limitations (the regressions are meaningful and bounded, but note):**
- **The foreign-holder cleanup assumes util-linux `setsid` does not fork:** the caller (a background job of a non-interactive bash) is not a group leader, so pid = new sid = pgid, and `kill_test_group(fpid)` matches. If it ever forked, the stray `sleep 300` / `while :` would survive the test (manual cleanup: `ps -eo pid,pgid,sid,cmd | grep -E 'sleep 300|while :'`).
- **Test 16 patches `os.fsync`** in the driver process (the module shares `os`), so it does not exercise a real device fsync error.
- **Timing bounds** (≤ 20–60 s) assume a normally loaded host.
- **Never exercised in a test:** no test exercises disk_guard's separate build group under our capture with a real build.

## Verdict
**r10 corrects the capture ownership defect,** with the return conditions traced, and I found no remaining concrete production blocker in the reviewed scope. The test limitations above apply.

Production stays on HOLD until all 265 parts are CONFIRMED-verified, root's actual r10 guard tests (10 + 6 + 16) and ns tests (5) pass, and root reviews.
