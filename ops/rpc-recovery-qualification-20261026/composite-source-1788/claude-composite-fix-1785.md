# composite-mdbx-validation-stage/r2: review 1784 A2/m1/m2 fixes + job hardening (1785). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n` and sha256.
- **Not done by me:** tests, builds, mounts, production processes, original reads, commits or pushes.
- **Preserved (SUMS re-verified):** r1 (`7a9993d6…`) and every pinned stage. The pins are byte-identical to r1.
- **Untouched:** the batch driver and the queue.

## Stage `composite-mdbx-validation-stage/r2/`, SHA256SUMS `681c88f1380091a8977a513e350362f07fe122b20fcd701857ffbc1da687a9b2`
| file | sha256 |
|---|---|
| `composite_session.py` (500 lines) | `248bc897ade746520581820d558552d9825dd8c68cf426818aef0cefe4e95186` |
| `tests/test_composite_session.py` (**10 tests**) | `11dddf8eeb5457d0d5f4fbd9d56e1d468424fb6d0c39ad332042255f9f1a5661` |
| `jobs/common.sh` | `fe114c0e…` |
| `jobs/tests.sh` | `c237ae42…` |
| `jobs/root-composite-validate.sh` (**disabled**) | `470976c3…` |
| `jobs/stop-session.sh` (= r1) | `ba1568db…` |
| `README.md` | `258e757f…` |

## Fixes
**A2, cleanup steps.** `cleanup()` runs every step through `safe()`: an exception is recorded in `cleanupErrors`, the cleanup is marked incomplete, and the **next step still runs**. The order:
1. exec group;
2. adopted orphans;
3. nbdfuse;
4. qemu-nbd;
5. each pidfd and each log;
6. a final orphan reap;
7. socket;
8. `holders()`;
9. mount;
10. still-alive children.

Missing evidence counts as incomplete.

**`end_child` behaviour:**
- **The unmount** goes through `unmount()`, which records a timeout or failure and never raises; a failure makes the cleanup incomplete.
- **The child's group is then ALWAYS ended** with r9 `stop_group`. If that raises, a KILL of our unreaped group plus a reap is attempted.
- **If our mount is still present after its server ended,** it is lazily detached with the **pinned** `fusermount3 -u -z` (our mount only), and the run stays **CLEANUP-INCOMPLETE**.
- **Last resort:** the outer handler catches `BaseException`.
- **No false CLEAN:** CLEANUP-INCOMPLETE (rc 4) overrides every outcome.

**m1, stale outputs:** a run dir already holding `work`, `receipt*`, `mdbx-report.json`, `validator.out` or `session.pid` is refused (REFUSED, nothing exposed, files untouched).

**m2, full coverage:** CLEAN additionally requires the report's `preflight.mdbxDatBytes` == the view's `logicalSize`. A mismatch, a missing value or no expected size gives INCONCLUSIVE.

**Fault injection (fixture only):** `--fixture-unmount-exe PATH` replaces only the FIRST, normal unmount, with a 3 s timeout. The lazy fallback always uses the pinned binary. Production (`--expect-kind production`) refuses the option.

## Tests: expected `Ran 10 tests`
- **1–6:** = r1.
- **7:** the classifier, extended. A clean report on a short or unknown byte count is INCONCLUSIVE.
- **8 (injected unmount timeout):** a hung `fusermount3` stand-in. Asserts:
  - rc 4 CLEANUP-INCOMPLETE and `unmount.normal = "timeout"`;
  - **qemu-nbd and nbdfuse both ended and reaped** (returncode set, `/proc/PID` gone);
  - `childrenAlive = []`, no mount, no holder;
  - production refuses the injection.
- **9 (REAL unmount failure):** the test process (not the session's child) holds the exposed `mdbx.dat` open, so `fusermount3 -u` fails EBUSY. Asserts:
  - rc 4 CLEANUP-INCOMPLETE and the normal unmount recorded as failed;
  - the lazy detach is rc 0;
  - **both servers ended and reaped**, no mount left.
- **10 (stale outputs):** each of `mdbx-report.json` (a stale "rc 2" report), `validator.out`, `session.pid` and `receipt-1.json` refuses with no work dir; the stale file is unchanged.

## Jobs and queue (no queue change; root 1785 / `work/claude-test-queue.py` read in full)
**How the queue enforces exclusivity:**
- the supported caps are `256, 512, 768, 1024, 1408, 1536, 1792, 2560, 4096`;
- every job with `--mib` ≥ 512 holds the **same exclusive main flock** (`claude-test-queue.lock`) from admission through `child.wait()` of its systemd scope; only 256 MiB jobs run beside it;
- so `cmv-r2-tests` at **512** cannot overlap the 1024 MiB preservation sessions;
- if the lock is held, the queue exits 98 after 60 s and `q-exit-status.sh` retries every 30 s, up to 240 times.

**Correct invocation:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r2-tests 512 bash composite-mdbx-validation-stage/r2/jobs/tests.sh     # expect "## PASS (10)"
```
Run it as the owner, not under unshare (FUSE).
- **No STOP request** and no driver modification.
- **No queue cancellation:** `stop-session.sh` signals only the recorded session PID. A queue SIGTERM SIGKILLs the scope after 1 s, which would leave only PDEATHSIG for the servers.

**`jobs/common.sh` admission (defensive, actual state only):**
- **Refuses** on a live `orchestrate.py`/`overlay_session.py`/`composite_session.py` process of this user, or a mount under `/recovery-multipart-stage/`, `/recovery-overlay-stage/` or `/composite-mdbx-validation-stage/`.
- **Does not block** on an idle batch driver.
- The peer snapshot (identical before and after) remains.

**`jobs/tests.sh` retention:**
- PASS needs: exactly 10 tests, last line OK, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, peers unchanged, no mount left, and the stage unchanged.
- **`$O/tmp` (the fixtures) is removed ONLY after a PASS with no mount under `$O`.** Any failure retains every fixture, run dir and receipt.

**Production:** `jobs/root-composite-validate.sh` **refuses unconditionally**. It documents the intended invocation with the supported cap **2560**, a placeholder rather than a measurement. Enabling needs a new reviewed revision after:
- an actual fixture PASS;
- all 265 parts verified in CONFIRMED sessions;
- an r6 production view;
- a memory and time window.

## Explicit limits
- **Unproven until root's fixture run:**
  - `nbdfuse -o ro` gives ST_RDONLY;
  - libmdbx opens the FUSE file without-lck;
  - exact cmdline binding;
  - zeroed metas give mdbx_chk rc 1–3;
  - **test 9's ordering:** nbdfuse exits on SIGTERM even though libfuse's own unmount fails EBUSY, and the lazy detach then succeeds;
  - test 8 assumes libfuse unmounts on SIGTERM when not busy.

  Any deviation is a test FAIL, never a false CLEAN.
- **The lazy detach is recorded, never treated as success.** The run is CLEANUP-INCOMPLETE. A holder of the detached file (as in test 9) is no longer visible by path to `holders()`; the normal-unmount failure already makes the run incomplete.
- **m3 (unchanged):** any process whose cmdline, cwd or fd names `RUN/work` makes the run CLEANUP-INCOMPLETE (fail-closed false positives).
- **Output retention (unchanged):** the r4 wrapper's report keeps only the last 8 KiB of mdbx_chk text; `validator.out` keeps the wrapper's own output.
- **Not exercised:** production scale (~1.13 TB through vmdk → NBD → FUSE, ~556 MB pagemap, days of runtime).
- **Never claimed:** chain, state, trie, canonical-root, RPC or SNP validation, or recovery acceptance.
