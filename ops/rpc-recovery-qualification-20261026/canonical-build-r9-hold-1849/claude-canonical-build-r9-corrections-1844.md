# 1844: base-state-readonly-stage/r9 = r8 + the review 1841 / root 1843 corrections (FROZEN, SOURCE ONLY: UNTESTED, NOT built, NOT PASS; production HOLD)

**Scope:**
- **What I executed:** reading review 1841 and root 1843; copying the r8 sources into a NEW r9; text edits; `ast`; `bash -n`; `cmp`; `sha256sum`.
- **Disclosure:** one in-process sanity call of the PURE `ro_tree_ok` parser on a synthetic mountinfo string. That is not a test suite, mount or namespace.
- **Not done:** tests, builds, queue jobs, mounts, namespace or scope changes, part/original reads, network, installs or commits. No paused job was resumed.
- **Integrity:** r8 (`49a41e28…`) and r7 re-verify unchanged.

**Actual r8 evidence (root, preserved):** the guard tests 10 + 6 + 11 and the 4 namespace tests PASSED, at `r8/runs/guard-tests-20261027T063200Z-2864392` and `ns-tests-20261027T063230Z-2864943`, archived as 77ca5aefc. Review 1841's "no tests run" means only that the reviewer did not run them.

**Observation:** `r8/jobs/__pycache__/bsro_gate.cpython-314.pyc` exists (dated 23:32, not in r8's SUMS, not created by me). I left r8 untouched. The copy was excluded from r9, and r9 contains no bytecode.

## Frozen r9: `base-state-readonly-stage/r9/SHA256SUMS` = **`f7470ced1fecc19f9fd62620b96e94693eb3825b84a632120a2d164f2a6159e5`** (22 files, all listed, read-only)
**Byte-identical to r7/r8** (`cmp` OK):
- `src/main.rs` `597a499a…`, `src/bin/mk_fixture.rs` `1db170dc…`, `Cargo.toml` `42dcdc8f…`;
- `jobs/disk_guard.py` `b42cf8fd…` (= r5);
- `jobs/mount_identity.py` `fc4d1ede…`;
- `tests/test_disk_guard.py` `366878f5…`, `tests/guard_wrapper.py` `6c6e231c…`, `tests/test_mount_identity.py` `ac6b2308…`.

**Changed:**

| file | sha256 | change |
|---|---|---|
| `jobs/bsro_gate.py` | `00d344a9965ab27ebc1ed031f2fb627852f4601f21fdab360bbc856badef9f78` | `parse_mountinfo`, `ro_tree_ok`, `ns_checks`; `RO_ROOTS`; the inner gate uses `ns_checks`; new read-only `ns-check` CLI; the guard success fields in `authenticate`; a rewritten `run_capture` (dict result); `outer` adapted (sink error → not verified); suites 14/5 |
| `jobs/ns.sh` | `13edde9580ae5b87e9167f0216848347a1c6dbbf3c79dc819af5433aba288705` | `make-rprivate /`, then `mount --rbind -o ro=recursive` (fallback: rbind + `remount,bind,ro=recursive`), then `make-rprivate DIR` |
| `jobs/build.sh` | `8ffbf1d9cdd3f009a462755a5d9b459cbdc88dc532a74a5f3b7fca8efa5b9d6d` | comments (PB1, m4) and r9 labels only. **Same order and the r7 guard command** |
| `jobs/guard-tests.sh` | `421ecd32270d8b0596b4a6911e9143d6369a49a12a47575ba7d51675e855cc12` | `test_bsro_gate` 14; receipt format r9 |
| `jobs/ns-tests.sh` | `fa29f3a176930d434da3058538418a7a2897987df47e1c08ed5f32f5fcc8d3d6` | `test_ns` 5; **refuses while a recovery/composite stage mount exists**; format r9 |
| `tests/test_bsro_gate.py` (14) | `c599f66853f8720fa00a9347b62d10b185b7bf4f675643687a54b8970df2c231` | tests 3, 6–9 extended or adapted; new 12–14 |
| `tests/test_ns.py` (5) | `45d2dadb1886c6269e3d7736cc6e67b34968d6b3dfe21fdab85a35111f2c7bc4` | tests 1–4 kept; new 5 |
| `README.md` | `bce10eda49346563714366a4e6c7a8a8bc96d21efd46116ed2a3471054c2e291` | r9 |

**Label-only changes** (r8 → r9 names and formats; no logic):

| file | sha256 |
|---|---|
| `jobs/build-outer.sh` | `10539340…` |
| `jobs/build-inner.sh` | `f18db50b…` |
| `jobs/env.sh` | `2bb5c3ac…` |
| `jobs/preflight.sh` | `6619feb0…` |
| `jobs/positive.sh` | `01aa26d2…` |
| `jobs/fixtures.sh` | `c02db4e0…` |

## Corrections
**PB1: locked inherited submounts.**
- **`ns_harden`:**
  1. `mount --make-rprivate /` **before any bind**;
  2. for `/home/steven` and `/tmp`: `mount --rbind -o ro=recursive DIR DIR`. util-linux 2.42 clones the subtree and sets RDONLY on every mount via `mount_setattr(AT_RECURSIVE)`, keeping locked flags such as `nosuid`/`nodev`;
  3. if that is refused: `--rbind` then `remount,bind,ro=recursive`;
  4. then `mount --make-rprivate DIR`.
- **Verification (the inner gate, also the `ns-check` CLI):** `ns_checks` = private propagation + ST_RDONLY of the listed paths + **`ro_tree_ok`**. `ro_tree_ok` finds the single top mount at each root (the top of any stack there) and requires it and **every mount below it in the mount tree** to carry `ro`. Shadowed originals hanging off another parent are unreachable by path and are ignored. It works from **mountinfo options only**, with no `statfs` on FUSE (USB) mounts.
- **The result is fail-closed:** zero or more than one top, or any non-ro mount in the tree, refuses.
- **This is specific enforcement for `/home/steven` and `/tmp`;** `/var` and other paths are not covered.

**Root #1: the guard must have ended clean.** `authenticate` now also requires `guard-receipt.json` to have `reason` **present and null**, `childRc` **exactly int 0** (not `false`, not `"0"`), and `groupLeftAlive` **exactly false**. A missing, wrong or failed value means not verified, so a build rc of 0 becomes final 10. This also applies in preflight mode.

**Root #2 / m1: deadlines tick under continuous output.**
- **The loop:** each iteration reads at most 64 × 64 KiB, then ALWAYS ticks the lifecycle:
  1. leader exit (`waitid WNOWAIT`; the leader stays unreaped);
  2. after `grace` (120 s) since the leader exited, OR `term_wait` (120 s) since our TERM without an exit, **SIGKILL of our group** (the leader is still unreaped, so the pgid is ours);
  3. `hard` (30 s) after that, abandonment.

  EOF ends the loop. **Output throughput can no longer postpone any deadline.**

**m2: no signal window.** The forwarding handlers are installed **before** `os.open`/`Popen`. A signal before the child exists sets `pending`, and ONE TERM is sent to its group as soon as `Popen` returns.

**Root #3: failures handled with owned, ordered cleanup.**
- **Spawn failure:** the capture fd is closed in `finally`, the handlers are restored, and the exception propagates (the outer records rc 127 with `sinkError: spawn…`).
- **Capture-sink write or fsync failure:** recorded, writing stops (draining continues), and **ONE SIGTERM goes to our group**. `build.sh`'s trap keeps the shell while `disk_guard` stops **its own separate build group** in order and exits (rc 73). The deadlines above bound everything. The outer marks it **not verified**.
- **Any other unexpected error:** the read end is closed (writers get EPIPE, never block), TERM, a bounded wait (`term_wait`), KILL of our group if still alive, the single reap, then re-raise.
- **Never** a queue or unrelated-group kill; no subreaper.

**m3: descendants outside our group.** A holder outside our group that still holds the pipe after our KILL means `abandoned = true`, reading stops and it is **never a success**. Ending it is left to the queue's own tree kill (by design: no subreaper framework). If the owned guard exits normally, the grace bound still applies before the KILL of our verified own group.

**m4:** documented in `build.sh` and the README. A TERM before the trap (early checks, hardening, inner gate) ends `build.sh` with rc 143. **Nothing has started then:** no guard, no build.

**m5:** documented. `positive.sh`/`fixtures.sh` take the **/vm `guard.outDir`** named by a verified build receipt, not the root symlink.

**Additional (namespace job hygiene):**
- **The problem:** any mount namespace pins clones of every mount it copied, including a LIVE preservation FUSE session's mount, until it exits. That could delay the session's FUSE teardown.
- **The fix:** `ns-tests.sh` now **refuses** (rc 9, never a pass) while any recovery/composite stage mount exists.
- **Lane:** run it in the **512 main lane**, which is exclusive with the 1024 preservation batches, so no session mount exists then.

## Tests: PREPARED, NOT RUN
**`jobs/guard-tests.sh`** (`unshare -Urn`, 256 small lane): the unchanged `test_disk_guard` (10) and `test_mount_identity` (6), plus **`test_bsro_gate` (14):**
1. completion;
2. exact maps;
3. propagation tags **+ `ro_tree_ok`** (a stacked `/tmp`, an rbind copy of a fuse submount, a shadowed rw original ignored, the octal-escaped path; refusals: a rw submount, a rw top, no bind, two tops);
4. lane and root floor;
5. qualifying receipts;
6. bounded capture (dict result);
7. owned and foreign holders, now also asserting **no surviving group member**;
8. forwarded SIGTERM;
9. authentication **+ 9 guard-receipt negatives** (reason `diskFloor` or missing; `childRc` 1, `false`, `"0"` or missing; `groupLeftAlive` true, null or missing);
10. accounting;
11. `env.sh` placement;
12. **NEW:** continuous output. An owned endless writer is killed after the grace (rc 3, bounded time, no surviving group member). A **foreign** `setsid` endless writer is abandoned in bounded time; the test kills its own stray.
13. **NEW:** a sink failure (`RLIMIT_FSIZE` 64 KiB in the driver only, so EFBIG). ONE TERM reaches a stand-in shell with a `build.sh`-like trap and a stand-in guard that exits 73. The rc propagates as 73, the bounded file is ≤ 64 KiB, `sinkError` is set and no group member is left.
14. **NEW:** a spawn failure. `FileNotFoundError`, **no fd leak** (the `/proc/self/fd` count is unchanged), the handlers restored, and an empty output file.

**`jobs/ns-tests.sh`** (`unshare -Urnm`, **512 main lane**; refuses outside a namespace or while a stage mount exists): **`test_ns` (5):**
- tests 1–4 as in r8, on TEST dirs (now through the recursive `ns_harden`);
- **NEW test 5:** the PRODUCTION `ns_harden /home/steven /tmp` and `bsro_gate.py ns-check --ro /home/steven --ro /tmp --ro-root /home/steven --ro-root /tmp` run in a **nested private mount namespace child** (`unshare -m --propagation private`). Inside it, writes under `/home/steven` and `/tmp` must fail. **After the child exits,** the test writes under `/home/steven` again (its own namespace and the host are unchanged) and removes its probes. No file contents are read; nothing is written to USB or the original.

**Gates:** exact counts, OK, empty stdout, no ResourceWarning/skip/FAIL/ERROR/Traceback (unchanged).

## Exact test commands (root; no build, no part data)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh bsro-r9-guard-tests 256 unshare -Urn  bash base-state-readonly-stage/r9/jobs/guard-tests.sh   # expect PASS (10/6/14)
bash jobs/q-exit-status.sh bsro-r9-ns-tests    512 unshare -Urnm bash base-state-readonly-stage/r9/jobs/ns-tests.sh      # expect PASS (5)
```
**Production stays on HOLD:** no `build-outer.sh preflight|build` until all 265 parts are CONFIRMED, root has reviewed r9, and these tests have actually passed.

## Residual risks
1. **The `-o ro=recursive` with `--rbind` path depends on libmount 2.42's new-API handling.** If it silently applied ro only to the top mount, `ro_tree_ok` refuses (fail-closed). ns test 5 shows which way it behaves.
2. **Read-only enforcement covers `/home/steven` and `/tmp` only.** `/var/tmp` and other root paths are not stopped (TMPDIR, HOME and CARGO_HOME point to /vm).
3. **The read-only binds will fail the build** if cargo or rustup must write the cached store or the rustup home. Run `preflight` mode first.
4. **The disk guard's 20 GiB cap is sampled** (15 s plus the walk), so overshoot is unmeasured. There is ≈ 14 GB of start margin above 64 GiB at an expected ≈ 83 GB free.
5. **Abandoned foreign descendants** (m3) are not ended by r9. The queue's tree kill is the backstop. A D-state process has no bound.
6. **After a sink failure,** the build is stopped (rc 73) and never verified: a fail-closed loss of that run, not a partial success.
7. **Momentary mount clones:** `unshare -Urnm` (the build and the ns tests) clones all host mounts for its lifetime. The build runs only when no session exists (outer gate); the ns tests refuse while a stage mount exists. Persistent non-stage mounts (the ro USB original, `l1-files`) are cloned read-only and released on exit.
8. **Memory** (`-j 4` in 4096 MiB) and **timeouts** (7200/7500 s) are unmeasured; both fail closed.
9. **A successful build plus fixtures proves the helper on synthetic fixtures only:** not production database integrity, canonical state or RPC readiness.
