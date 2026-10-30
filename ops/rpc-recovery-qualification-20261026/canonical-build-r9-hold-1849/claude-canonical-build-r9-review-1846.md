# 1846: independent narrow source review of base-state-readonly-stage/r9 vs r8 (review 1841, root 1843, author 1844)

**Scope of MY activity:** source reading only.
- **What I read:** `jobs/ns.sh`; in `jobs/bsro_gate.py`: `parse_mountinfo`, `ro_tree_ok`, `ns_checks`, `run_capture`, `authenticate`, `outer`, `inner-gate`/`ns-check`; in `jobs/build.sh`: the hardening and gate wiring; in `jobs/ns-tests.sh`: the stage-mount refusal; and the new or changed tests (`test_bsro_gate` 12–14 + 9; `test_ns` 5).
- **Not done:** tests, builds, queue jobs, mounts, namespace or scope changes, production or original reads, network, installs, commits or edits.
- **Results:** root may be running the actual r9 tests concurrently. **Nothing here claims or denies their results.** All r9 bytes are preserved.

| item | sha256 |
|---|---|
| r9 `SHA256SUMS` (22 entries, `sha256sum -c` OK, no bytecode; r8 unchanged) | `f7470ced1fecc19f9fd62620b96e94693eb3825b84a632120a2d164f2a6159e5` |
| `jobs/bsro_gate.py` | `00d344a9965ab27ebc1ed031f2fb627852f4601f21fdab360bbc856badef9f78` |
| `jobs/ns.sh` | `13edde9580ae5b87e9167f0216848347a1c6dbbf3c79dc819af5433aba288705` |
| `jobs/build.sh` | `8ffbf1d9cdd3f009a462755a5d9b459cbdc88dc532a74a5f3b7fca8efa5b9d6d` |
| `jobs/ns-tests.sh` / `jobs/guard-tests.sh` | `fa29f3a1…` / `421ecd32…` |
| `tests/test_bsro_gate.py` (14) / `tests/test_ns.py` (5) | `c599f668…` / `45d2dadb…` |
| Rust sources, `Cargo.toml`, `disk_guard.py` (= r5), `mount_identity.py`, three r7 tests | byte-identical to r8 |

## Verdict
**No concrete remaining blocker in the reviewed scope.** The 1841 PB1 and root 1843 #1–#3 are addressed in source. What remains below is documented residual risk plus one minor edge.

The actual production build stays forbidden until all 265 parts are CONFIRMED-verified, root has reviewed r9, and its tests have actually passed.

## PB1: recursive namespace hardening and mount-tree verification
**`ns.sh` (`:9-18`):**
1. `mount --make-rprivate /` first;
2. per directory, `mount --rbind -o ro=recursive DIR DIR`. With util-linux 2.42, that is a recursive clone plus `MOUNT_ATTR_RDONLY` on every cloned mount, keeping locked `nosuid`/`nodev`. The fallback is `--rbind` + `remount,bind,ro=recursive`;
3. then `make-rprivate DIR`.

The recursive form avoids the locked-children EINVAL of r8's non-recursive bind.

**`ro_tree_ok` (`bsro_gate.py:195-211`):**
- per root, exactly one **visible top** among the mounts at that path (stacked binds resolve to the topmost);
- then the transitive child set of that top;
- every mount in it must carry per-mount `ro`.
- **Shadowed originals** hanging off another parent are correctly ignored: they are unreachable by path.
- **The fallback's partial first bind,** if any, is shadowed by the second top and so also ignored.
- **Zero or more than one top, or any rw mount in the subtree, refuses.**
- It parses mountinfo only (with octal unescaping), with no `statfs` on FUSE or USB mounts.

**Inner wiring:**
- `build.sh:33-35`: `ns_harden /home/steven /tmp`, then `inner-gate`, which calls `ns_checks(…, RO_ROOTS)`: private propagation + ST_RDONLY of the `--ro` paths + `ro_tree_ok` for `/home/steven` and `/tmp`;
- the trap comes after these (m4, documented).

**Test 5 safety** (`tests/test_ns.py`):
- the production `ns_harden /home/steven /tmp` and `ns-check` run only in a **nested** `unshare -m --propagation private` child inside the ns-tests user namespace;
- write probes are attempted only after `ns-check` succeeds;
- one probe is under `TEST_TMP` (stage runs) and one is `/tmp/bsro-r9-ns-probe-PID`; both are removed in `finally`;
- after the child exits, the parent's write proves its own namespace and the host are unaffected;
- no file contents are read, no FUSE request is needed (a clone and attribute change only), and nothing is written to USB.

## Capture (`run_capture`, `bsro_gate.py` ≈ `:313-410`)
- **Continuous output:** each tick reads at most 64 × 64 KiB, then ALWAYS evaluates leader-exit (`waitid WNOWAIT`), grace, term_wait, KILL and hard. Output rate cannot postpone any deadline (root 1843 #2 / m1). EOF ends the loop.
- **Signal window (m2):** the handlers are installed before `os.open`/`Popen`. A signal before the child exists sets `pending`, and ONE TERM is sent when `Popen` returns.
- **Spawn failure (#3):** `fd` is closed in `finally`, `p` is None (no reap), the handlers are restored, and the exception propagates. The outer records rc 127 and a `sinkError: spawn…`, never verified.
- **Sink failure (#3):** an `OSError` on write or fsync is recorded, writing stops (draining continues), and ONE TERM goes to our group. `build.sh`'s trap keeps the shell; `disk_guard` stops its own separate build group in order (rc 73). Deadlines still bound it, and the outer refuses verification on any `sinkError`.
- **Unexpected error:** the read end is closed, then TERM, a bounded wait (`term_wait`), KILL of our group, the single reap and a re-raise.
- **Unreaped identity:** every `killpg` (TERM or KILL) is gated by `unreaped()` on our own unreaped leader, so the pgid cannot have been reused. The single `p.wait()` comes last. There is no queue or unrelated-group signal.

**Minor edge (non-blocking):** between `p.wait()` and the handler restore (`finally`), a late signal would run `fwd → term_group → unreaped()`, and `waitid` on the reaped pid raises `ChildProcessError` inside the handler. That surfaces as an `OSError` in `outer`, so rc 127, not verified: fail-closed, never a false success.
- **Optional one-line hardening:** `unreaped()` returns False on `ChildProcessError` or when `p.returncode is not None`.

## Guard terminal-success authentication (root 1843 #1)
- **The check:** `authenticate` (`:432-434`) requires `guard-receipt.json` to have `reason` present and `None`, `childRc` of exact type int and == 0, and `groupLeftAlive is False`. Otherwise it refuses (not verified; final 10 if the child rc was 0).
- **The fields exist:** they are written by the unchanged guard (`disk_guard.py:175`).
- **The other checks are unchanged:** the single announced run dir under the pinned BASE, the in-place 0555 binaries == accounting with verdict ok, the mandatory root floor after the run, and refusal on abandonment or a sink error (`outer`).

## No USB writes
- **Nothing is written outside:** the guarded `/vm` run dir, the ≤ 1 MiB root metadata files, the test temp dirs, or the two test-5 probes (removed).
- **The USB-backed original** (`tr004-readonly`, already `ro`) is only cloned into the namespace and made ro recursively. Nothing opens it.

## Test fit (source assessment)
**`guard-tests.sh`** (`unshare -Urn`, **256 small lane**):
- the r7 suites plus `test_bsro_gate` (14): synthetic inputs, `TEST_TMP`, and owned subprocesses with short bounds (tests 12/13 grace 0.5–5 s, hard 1–10 s, term_wait 30 s);
- the foreign `setsid` writer is killed by the test itself;
- test 13's `RLIMIT_FSIZE` is set in the driver process only (children write only to the pipe);
- test 14 checks the fd count and the handler restore;
- **no preservation targets, sessions or `/vm` are touched.**

It fits the 256 small lane beside the recovery reservation.

**`ns-tests.sh`** (`unshare -Urnm`, **512 main lane**): it refuses while any recovery/composite stage mount exists (`:16-18`), and the 512 main lane is exclusive with the 1024 preservation batches. So the namespace's mount clones cannot pin a live session's FUSE mount. All binds are namespace-private. It fits the 512 exclusive lane.

## Residual documented risks (not blockers)
1. **Behaviour unproven by this review:** `-o ro=recursive` with `--rbind` depends on libmount 2.42 (test 5 shows it); if it only applies ro at the top, `ro_tree_ok` refuses.
2. **Enforcement scope:** `/home/steven` and `/tmp` only; `/var` and other root paths are not enforced.
3. **cargo/rustup and the read-only store:** if they need to write the read-only cached store or rustup home, the build fails closed (run `preflight` first).
4. **Disk guard overshoot:** its 20 GiB cap is sampled; overshoot is unmeasured.
5. **Escaped descendants:** those outside our group (m3) are only abandoned (never a success). The queue's tree kill is the backstop, and D-state has no bound. If our KILL ever reaches `disk_guard` before it stops its own build group, that group continues under cargo's own `timeout -k 30 7200` only.
6. **Unbounded leader wait:** an EOF while the leader still runs leaves `p.wait()` unbounded (forwarding stays active). This is acceptable for the owned build.
7. **Unmeasured:** memory (`-j 4` in 4096 MiB) and timeouts.
8. **What a successful build proves:** a successful build plus fixtures proves the helper on synthetic fixtures only.
