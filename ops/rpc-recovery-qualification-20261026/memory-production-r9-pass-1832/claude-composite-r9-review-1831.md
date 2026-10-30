# 1831: independent narrow review of composite-mdbx-validation-stage/r9 vs r8 (author 1829; root 1828; review 1827). r9 tests NOT run; nothing is PASS

**Scope:** source only.
- **What I read:** the r8→r9 changes in `memory_gate.py` (the `_tick` wrapper, `runtime_identity`/`stop_session`, `memory_session_argv`/`guard`, `evidence`), tests 11–15, `jobs/final-status.sh`, `jobs/root-composite-validate.sh` and `jobs/stop-session.sh`.
- **Not re-reviewed:** the unchanged r8 memory policy and qualification design.
- **Not done:** tests, mounts, scope or queue changes, byte/original reads, edits or activation.

| item | sha256 |
|---|---|
| r9 `SHA256SUMS` (7 entries, `sha256sum -c` OK; r8 also unchanged) | `9337f1359ec43cff2bc718e7d6262677548e32fa08ab6a00e7b6a37e1ea36185` |
| `memory_gate.py` | `1103a509ca1657f93f0b1623f55a2220f4e70a56fe2c89982e86f5fd40bbc4d1` |
| `tests/test_memory_gate.py` (15 `test_` methods; `jobs/tests.sh` gate `Ran 15`) | `1555b67a5d4773d2509cf25e1f73725f9365f7767b5a9e7939ee8fb02ef58756` |
| `jobs/root-composite-validate.sh` | `91b82154e8618291e087ea7c0b2bfe3c6a7798d6ca1da9c948ad742ff91f56af` |
| `jobs/final-status.sh` | `a665d03a04d4e2f913a117bbe17da0b5e355362da2dfe4e4937555e40533269c` |
| `jobs/stop-session.sh` | `129f31d2846bb2385478922175258763f24af92963db6e2129037e0095f137df` |
| `jobs/tests.sh` (256 lane in the header) | `262fafdcb39c51aa7c413e24c1e8e5bbdcd332db67e7b2f5a7a233be299d5878` |

## Concrete blocker before PRODUCTION (it does not block running the 15 unit tests)
**B1. A failed peer-snapshot, mount or process command is silently treated as clean evidence** (`jobs/root-composite-validate.sh`, the before snapshot and the post-run subshell).
- **The before snapshot:** `( ulimit -f 1024; peer_snapshot > $J/peers-before.txt )`. Its exit status is **ignored**.
- **In the post-run subshell:**
  - `peer_snapshot > peers-after.txt`;
  - `grep -F "$O" /proc/self/mountinfo > mounts-left.txt`;
  - `pgrep … | grep -v pgrep > processes-left.txt`.

  Only the **last** command (the receipt generator) sets `jrc`. The statuses of these three are discarded.
- **How it fails open:** `peer_snapshot` (the r6 function: `grep … /proc/self/mountinfo | awk | grep -v | sort; pgrep … | grep -v | sort`) can fail or be cut short in several ways:
  - a mountinfo read error (`grep` exit 2);
  - `pgrep` failing (exit ≥ 2);
  - `sort`/`awk` failing;
  - the 1 MiB `ulimit` being hit (SIGXFSZ kills the writer, truncating the file).

  It then yields empty or identical output **both** times, so `peersUnchanged` is true. Likewise a `grep -F` error gives empty `mounts-left` (`noMountLeft` true), and a `pgrep` error gives empty `processes-left` (`noProcessLeft` true).
- **The consequence:** with runtime rc 0 and an otherwise clean receipt, the job exits **0** although the final evidence was never actually produced. That violates the required "fail closed when peer snapshot commands fail".
- **Minimal fix (no redesign):**
  - run the two snapshot pipelines, the mountinfo grep and the pgrep explicitly in r9, capturing `PIPESTATUS` and the exit codes;
  - accept only `grep`/`pgrep` ∈ {0, 1} and `awk`/`sort` = 0, with no SIGXFSZ (status 153), for the before snapshot too;
  - write the statuses to a small `J/snapshot-status` file;
  - have the generator add a `snapshotsOk` check (all statuses acceptable, files present), and add it to `JOB_CHECKS` so `evidence()` requires it;
  - add one shell-path test: a failing snapshot command with runtime rc 0 must give final 10 plus the mark.

## Verified (no change needed)
**Stop helper** (`memory_gate.py stop_session`, `jobs/stop-session.sh`).
- **Process pinning:** `pidfd_open(pid)` comes **before** the identity checks. Those checks are:
  - the `/proc` start time == `session.pid`'s startTime (integers, not bool, pid > 1);
  - the owner == us;
  - the exact runtime argv `/usr/bin/python3 -I -B <this r9 memory_gate.py (realpath)> runtime --tree-root-pid N -- …`, with exactly one `--run-dir` == SESSION, `--expect-kind production` and no fixture options.
- **The signal:** the start time is re-checked, then `pidfd_send_signal(SIGTERM)`. It never uses a PID number, group or queue.
- **The argv matches what the gate execs** (`argv2`: `PY3`, `THIS`), and r6 `main` writes `session.pid` from that same process.
- **Test 11** covers the matching stop and six refusal variants, with dummies killed and reaped in `finally`.

**Stale-process guard** (`memory_gate.py guard`).
- **What counts:** only a real Python invocation (the pinned r6 `session_guard.script_of`; `-c`/`-m`/stdin mean no script) whose script basename is `memory_gate.py`, with the next argument `gate`/`runtime`, from this uid, excluding itself and its ancestors.
- **What does not:** text mentions (shells, grep, vim, `python -c`, the `stop` subcommand) never match.
- **In the job:** it runs after the unchanged r6 `guards`, before any run dir, and on refusal prints PID, start time and argv[:6].
- **Test 13:** an owned dummy is detected, a live `python3 -c … memory_gate.py runtime` is ignored, and once the dummy is reaped the result is rc 0.

**Final job status**, apart from B1's inputs.
- **`final-status.sh`:**
  - a nonzero runtime rc is preserved exactly;
  - a non-numeric rc becomes 10;
  - runtime rc 0 becomes 0 **only** if `evidence()` accepts the receipt: ≤ 1 MiB parseable, format r9, `jrc == 0`, `rc == 0`, `receipt.rc == rc`, `structurallyCleanRun`, exactly the six checks all true, outcome CLEAN;
  - otherwise 10, plus `FINAL-EVIDENCE-FAILED`.
- **If evidence or the script cannot run:**
  - a missing or broken Python gives evidence ≠ 0, so final 10;
  - an unexecutable `final-status.sh` gives bash 126/127, which is nonzero (it replaces a nonzero runtime code, but still fails closed).
- **The generator:**
  - a missing runtime receipt becomes `{}` (not clean);
  - a malformed receipt becomes "MALFORMED runtime receipt";
  - a missing snapshot file raises, so `jrc` ≠ 0;
  - the 1 MiB cap means a receipt write failure also sets `jrc` ≠ 0.
- **`exit $final`** replaces r8's `exit $rc` (root 1828 #2).
- **Test 12** exercises the real `bash final-status.sh` for 11 decision cases.

**Bounded outer files:** gate and runtime files ≤ 32 MiB; r6 children ≤ 16 MiB; job-side files ≤ 1 MiB each (subshell `ulimit -f 1024`). Only the shared queue's own logs are external, as documented. **Caveat:** these caps make truncation possible, so B1's status capture is what turns a truncation into a failure.

**Telemetry exceptions** (`_tick`/`_tick_body`).
- **Counting:** the WHOLE tick is wrapped. `SoftStop` is re-raised, and any other exception is counted (≤ 20 messages plus a dropped counter).
- **Outcomes:** at validator end it only disarms; otherwise 3 consecutive failures cause an ordered soft stop, and a complete tick resets the count.
- **No REFUSED mislabel** can escape r6 `use()` any more (review 1827 A1).
- **Test 14** injects a processing KeyError: 2 counted, the 3rd soft-stops, and cleanup completes.

**Inherited `C.main` soft stop (test 15).**
- **The setup:** the UNCHANGED r6 `main` runs on a private instance whose `Session` is the r9 `MemorySession`, with only `prepare`/`expose`/`held("heldBeforeExec")` stubbed in the test.
- **The real path:** r6's own `use()` spawns an owned `sleep` stand-in via its fixture-exec argv (test-only; the r9 runtime CLI still refuses fixture kinds, test 10). The forced first tick raises `SoftStop` inside r6's loop. r6 `main` records it as interrupted and runs its ordered cleanup.
- **Asserted:** rc 5, CANCELLED, cleanup complete, `childrenAlive == []`, the stand-in gone, samples present, handlers restored.
- **Stated limitation:** there is no real view, FUSE, servers or mdbx_chk.

## Acceptable limits (not blockers)
- **Shared lanes:** the production guard refuses if an r9 test dummy (tests 11/13) is alive, and test 13 fails if a real r9 gate/runtime is live. Both fail closed. Run the tests outside a production window.
- **Test 15** leaves the test process a subreaper (all children are reaped); harmless.
- **Test coverage:** test 12 covers `final-status.sh`, not the production shell's snapshot and generator steps (that is B1's test).
- **Unchanged r8 limits:** MemoryHigh is not a ceiling and throttles the whole scope; the OOM victim is not guaranteed; the soft stop races the outer guard; production memory figures are estimates; a wrapper KILL skips ordered cleanup; D-state has no bound; CLEAN is structural only. None is claimed as guaranteed.

## Verdict
**The 15 unit tests are reasonable to queue** (root's 256 small lane, as for r8). Do not call them PASS before the actual receipt exists.

**Before ANY production activation, fix B1** so that a failed or truncated snapshot, mount or process command makes the final job status nonzero. No other new issue requiring a fix was found.
