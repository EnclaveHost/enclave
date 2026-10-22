# node-pair-activate.ps1: one node-only restart for 2afa (source + offline tests; root decides, nothing run live)

The approach and changed constraints are in `INITIAL.md` (unchanged since it was written). This file records what was
built, the evidence, and root's concrete recipe.

## 1. Artifacts (new; nothing frozen was edited)

| file | sha256 |
|---|---|
| `helper/node-pair-activate.ps1` (768 lines) | **`7ac1d8734af872c7c7309ebe7bc8d00981de48d5e99d41c73a4315cef24f79ed`** |
| `helper/provenance.json` | `2a7c2805…` |
| `tools/activate-template.ps1` | `a0e3da7b…` |
| `tools/compose.py` | `beb8ac75…` |
| `tools/provenance-test.ps1` | `8fcf695e…` |
| `tools/activate-test.py` | `63c9c053…` |
| `tools/pair-mock.ps1` (656d's mock + per-row in-flight passes, `listener-lost`, `lease-shrinks-after-start`) | `4aea08a1…` |
| `tools/ast-case-lint.ps1` | `aa637f83…` |
| `jobs/mutants-r1.py` | `bc28ad24…` |

**Unchanged and re-verified:**
- helper `656d642a…`;
- runner `a1c950f2…`;
- 656d `pair-test.py` `2c29575b…`, `pair-mock.ps1` `15bf276d…` and template `7f595c58…`.

**Provenance** (AST, function extent text):
- 37 functions verbatim from df2e58f2;
- 13 reused byte-identical from 656d: ForwardLeft, Others, HyperV, TaskAction, UpdateHorizon, RunningSetDiff,
  UnchangedFiles, PairNow, NewIdentity, Invoke-SwapChild, SwapJournal, SwapStep, SwapPair;
- 2 modified vs 656d: BeforeStop (one line), Recovery (records `rollbackBy` instead of the terminal-return note);
- 6 new: RestartMin, PassStarted, ServingRows, OwnedNow, RestartNode, WaitServing;
- dropped: LeaseReady, AgentUp, StartNode.

## 2. Evidence

**Suite** (queue cap 512, offline netns):
- `logs/suite-r2.log`: compose, AST lint, provenance, then **25/25** scenario tests in 158 s, peak 345 MiB. They run the
  REAL bundle-swap 21d85c69 children.
- The tests cover:
  - M2 accepted with the pass in flight;
  - a slow sweep not awaited;
  - a pending row ending in `DONE_NOT_SERVING_CHECK` with rows and `rollbackBy`, after the full 660-s observation;
  - not-ready, other-pass, lease-mismatch, other-runner and within-margin rows never accepted;
  - no M1 (stale pass, no pass loop, foreign 9600, foreign parent) ending `NOT_READY` with one start, no retry, no kill;
  - a lost listener after M1 ending `NOT_READY`;
  - module or config changed while stopped, and a stale listener: nothing written, no start;
  - partial swap with proven undo, giving the old pair restarted;
  - unknown swap/undo/ACL/crash outcomes: no start;
  - task-outcome failures never retried;
  - kill only the verified PID; a reused PID is a new identity;
  - post-checks catch a replaced VM or another task;
  - exact running set before the stop;
  - a lease shrinking before the stop refused AT BeforeStop;
  - budget 1550 / 1549 / 1800;
  - every parameter refusal;
  - updater refusals;
  - rollback at 475 / 474, R ≠ 0 refused, rollback from a running-not-serving node, rollback not yet serving, partial
    return;
  - lock and params sha.

**Mutants** (`logs/mutants-r2.log`): **11/11 killed**. Every mutant parses (checked), and each was run only against its
targeted tests: N1–N11 over sequence, status, lost listener, M1 since-agent, reserve size, rollback reserve, margin,
not-yet→DONE, completed-pass-only, the BeforeStop lease layer, and runner.

**Lint finding** (pre-existing, in 656d too; harmless):
- One case collision: script `$Run` vs function-local `$run` in RunningSetDiff. Assignment inside a function creates a
  local, and RunningSetDiff never reads `$Run`.
- 656d's regex lint passed only because an apostrophe in a comment opened a fake single-quoted span that hid
  RunningSetDiff. That lint pass was not evidence for that function. `tools/ast-case-lint.ps1` reads the AST instead.

**Not proven:** native Windows behaviour (Task Scheduler, CIM, ACLs, real timings), the M1 duration (`processUpSec`), and
the per-row time in a first pass after restart (bounded only by the 602-s completed pass).

## 3. Root's recipe (exact; root runs it, nothing here was run)

1. **Re-stage.** The existing stage holds 656d. Run:
   `root-node-pair.py --stage --helper node-activate-min/helper/node-pair-activate.ps1 --helper-sha 7ac1d873…f79ed --chain <candidate chain.mjs> --chain-sha 3e9fae03… --host <candidate host.mjs> --host-sha 4bebf7db…`
   The runner uploads the bytes under its fixed name `node-pair-restart.ps1`. The pin is the sha.
2. **`--run identify`** (fresh) gives the identities below. The 23:03Z values are for shape only. Re-identify
   immediately before the apply.
3. **Apply params** (PARAMS.md schema; the runner accepts the extra lease keys):
   - `files`: chain `oldSha 86c81124…`→`newSha 3e9fae03…`; host `9634cb40…`→`4bebf7db…`.
   - `nodeSha b3094d0b…`.
   - `unchangedFiles`: node.exe `b3094d0b…`, run-node.cmd `0fdc3699…`, node-config.local.cmd `405db912…`,
     lease-gas-config.cmd `2324904b…`.
   - `runner 0x2fcef48d…447a`, as identified.
   - `expectedIds` = EXACTLY the running set (at 23:03Z only `0x7ae476a3…ce33`).
   - `node`/`scheduler`/`manager`/`privacy`/`vms`/`hyperv` from identify. `boundSec 1140`.
   - `lease: { marginSec 120, revertSec 415, forwardMinSec 1015, startNodeSec 660, processUpSec 120, returnPinsSec 60 }`
     (`reserve` absent or null).
4. **Launch window.** The helper's lease read must see ≥ **1550 s** left on the adapter lease. On a zero-rate lease
   (now + 1800 at the renewal), that means within ~250 s of the renewal landing, minus the pins.
   - The updater's next run must be ≥ 1140 + 415 + 60 = 1615 s away. With the hourly :13:36 run, launch between about
     :13:40 and :46:40.
   - Otherwise the helper refuses with nothing stopped.
5. **Read the final:**
   - `DONE:` means M1 + M2 + post clean.
   - `DONE_NOT_SERVING_CHECK:` means the new node runs but not every app was ready. Poll read-only (public-health). Wait
     if rows progress; if not, launch the rollback by `rollbackBy` (in the journal).
   - `NOT_READY` means a defect signal: roll back.
   - `RECOVERY_REQUIRED` means a manual decision from the recorded state; nothing was retried.
6. **Rollback params:** the same stage, a NEW runId, `node` = the apply's `start-node` agent/cmd, and
   `lease: { marginSec 120, revertSec 0, forwardMinSec 355, startNodeSec 660, processUpSec 120 }`. It needs ≥ 475 s left.
   Acceptance is M1 on the old pair, and serving is reported (`ROLLED_BACK:` / `ROLLED_BACK_NOT_SERVING_CHECK:`).
7. **Activation is complete** only when root's read-only poll shows the new process RENEWED the adapter: `leaseUntil`
   advanced after the restart, with the 30-s keeper working inside the renew window. Then let a few windows pass with the
   app healthy.

## 4. Outage and recovery (as INITIAL; restated)

- **Planned interruption.** From the stop until M2, node policy, renewal and adoption pause for every running app. The
  VMs are not touched. Whether app traffic flows while the node is down is unproven, so plan for up to F ≈ 17 min worst
  case (typically the stop, swaps and first-pass row time).
- **If no process renews before `leaseUntil`, the lease lapses.** Nothing extends or ignores it. The existing host and
  network rules stop or reclaim it, or another host claims it.
  - A reclaim may relaunch the adapter VM: a new certificate (LE 5/168 h) and a cold start.
  - This is the same recovery as the 10-22 lapses.
- **Remaining gaps:**
  - **A rollback after `rollbackBy` is refused.** Its lease gate refuses while the lapsed app still shows `running`;
    root waits for the host to settle it.
  - **Rollback with an empty running set.** It cannot launch, because runner a1c950f2 requires non-empty `expectedIds`
    (`root-node-pair.py:165-167`). That one-line runner change would be root's; I did not make it.
  - **Rollback of a crashed or absent node** is manual (no pinned identity).
  - **The `processUpSec` 120 is unmeasured.** Root can read the current agent's start-to-first-tick time from node.log
    (read-only).
  - **The updater is unverified.** Whether the hourly updater could re-install release node modules over the activated
    pair was not checked here; it was equally unchecked for 656d.
