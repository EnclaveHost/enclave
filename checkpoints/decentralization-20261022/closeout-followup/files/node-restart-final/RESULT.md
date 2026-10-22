# Two-file node-only window (chain.mjs + host.mjs) on minipc: bounded helper, tests and lease arithmetic (source only)

## CORRECTION 2026-10-22 (supersedes the helper hash, section 3's full-return rows and section 5's expectedIds advice)

**Helper `helper/node-pair-restart.ps1` is now `656d642a5af471c6d15582a5aede5521ee864386e279ac91932061edf1358e00`** (742 lines).

**Other hashes:**
- template `7f595c58…`;
- provenance `7e23c324…`: 39 verbatim / 6 modified / 10 new, the new one being `RunningSetDiff`;
- `pair-test.py` `2c29575b…`;
- `pair-mock.ps1` `15bf276d…`;
- `compose.py` `25d042d1…`.

**1. Exact running set (the subset mistake is closed).** `expectedIds` must equal EXACTLY the set of deployments with status `running` on the node. This is checked twice:
- at the pins, after the lease read;
- again in `BeforeStop`, immediately before the stop.

An added running deployment, a missing one, or a repeated id refuses with nothing stopped. Root's 21:44 preflight showed ONE running deployment (the adapter) and four Hyper-V VMs. The VMs are no proof of other running deployments, and the helper does not assume either way: the fresh live read decides. The post-checks still compare ALL Hyper-V and manager VM sets.

**2. Finite return budget (the infinite-recursion defect is fixed).** `lease.reserve: "terminal-return"` is an explicit option:
- **only with `-Mode rollback`**, and requires `lease.revertSec = 0`;
- **is refused for apply**; apply never runs with a zero reserve;
- **`revertSec 0` without `terminal-return` is refused in every mode.**

All other gates are unchanged:
- its own full `forwardMinSec` (stop after the lease read 135 + swaps 100 + `startNodeSec`) plus margin;
- the measured `startNodeSec` floor of 480;
- process identity, scheduler parent, files, updater, lease, the exact running set;
- consistent-pair start, unknown and mixed-pair refusal.

It journals loudly, in the pins line, the post-check and every non-success outcome, that no return reserve remains after it.

**3. The full return now covers the return run's fresh pins.** `reserve: full-return` requires `lease.returnPinsSec > 0` and `revertSec ≥ returnPinsSec + forwardMinSec`.
- `returnPinsSec` is root's allowance for deciding, launching the task, and the return run's own pins up to its lease read.
- The bounded pins alone are ≤ ~210 s worst case. Native duration is unmeasured.
- The decision and launch latency is human and task-scheduler dependent: it cannot be guaranteed.

**4. Budget (bounds; S = `startNodeSec`; F = 135 + 100 + S; P = `returnPinsSec`; M = margin).**
- An apply with `full-return` needs `L ≥ F + (P + F) + M`.
- A `terminal-return` rollback needs `L ≥ F + M` at its own lease read.

| S | F | P | M | apply full-return needs | zero-rate slack (≤ 1800) | paid slack (≤ 2085) | terminal-return needs |
|---|---|---|---|---|---|---|---|
| 600 (recommended) | 835 | 60 | 120 | 1850 | **−50: never** | 235 | 955 |
| 600 | 835 | 60 | 180 | 1910 | **never** | 175 | 1015 |
| 540 (root's candidate) | 775 | 60 | 120 | 1730 | 70 | 355 | 895 |
| 540 | 775 | 60 | 180 | 1790 | 10 | 295 | 955 |
| 540 | 775 | 210 (worst pins) | 120 | 1880 | **never** | 205 | 895 |
| 480 (floor) | 715 | 60 | 120 | 1610 | 190 | 475 | 835 |

- **Section 3 superseded.** Its earlier full-return rows (R = F) lacked P and are superseded by this table.
- **S = 540 is not chosen here.** It is 64 s over the slowest observed pass (476 s), and it is inside the accepted parameter range (≥ 480). It is root's decision, only after fresh single-app timing.
- **The 600 s recommendation and the 480 floor are unchanged.**

**5. Remaining risks (honest).**
- **`NOT_READY` can leave the new node RUNNING.** A return must stop it. That is covered only by `full-return` (its F includes the stop after the lease read), not by `recovery-start`, which only fits cases where the node is already stopped.
- **The return can be refused.** The return run gets its own fresh immutable params and pins (the new agent's identity) and uses the existing reverse two-file CAS. If root's decision, launch and pins exceed P, it refuses at its lease gate: never a blind retry.
- **The terminal return is the last one.** If it fails, nothing further fits the cycle and root acts manually.
- **No external timing is guaranteed:** RPC, Task Scheduler, adoption, ACME, renewal success. All bounds are bounds on this script's own waits.
- **No automatic repeated or uncertain-task retries anywhere.**

**6. Tests (queue cap 512; offline; ssh/scp/sftp denied).**
- **`logs/suite-r3.log`** (rc 0, peak 352 MiB): compose, case lint (none), provenance PASS, `pair-test` **31/31**.
  - The full pair set was re-run once, because the pins/`BeforeStop` path changed for every scenario.
  - The unchanged unit and real-child suites were NOT repeated: they exercise unchanged functions.
- **New tests:**
  - apply never takes a zero reserve (terminal, full-return, recovery-start);
  - a rollback with `revertSec 0` needs the explicit terminal return, and a terminal return with `revertSec ≠ 0` is refused;
  - the terminal return needs its own full window: refused at 954 s, ROLLED_BACK at 955 s. The readiness floor and `forwardMinSec` gates still apply to it, and its journal says no reserve remains;
  - a failing terminal return (`NOT_READY`) says no reserve remains;
  - an exact running set at the pins: extra, missing, subset, and repeated ids are refused AT the pins (no `stop-node` step);
  - the running set is checked again before the stop: added and removed cases are refused, nothing stopped;
  - a full return needs F + P + F + M (1850 / 1849, and P missing refused).
  - The existing unknown/mixed-pair and partial-swap cases pass unchanged inside the 31.
- **Mutation controls** (`logs/mutants-r3.log`, `logs/mutants-r4.log`, `logs/n3b-r2.log`): N1 terminal-for-apply, N2 zero-without-terminal, N4 no check before the stop, N5 no return-pins allowance, N6 terminal without its own window: all KILLED.
  - N3 (no pins check) was first "killed" by an unbalanced-brace edit: invalid evidence, so I discarded it.
  - The valid-syntax N3b died only on message wording, because the before-stop check still refuses.
  - The test now asserts refusal AT the pins. It passes on the real helper and fails on N3b (`n3b-r2.log`).

**Section 5 correction:** "`expectedIds` normally ONLY the adapter" is withdrawn. It must be exactly the live running set at both checks.


Worker: Claude. Date: 2026-10-22. Nothing was run on minipc. No SSH, RPC, ExecutionPolicy change, secret, fee, lease-window
change, contract or policy change, and no new agent. Root stages, pins, chooses the window and activates.

## Verdict

1. **The helper is implemented and tested on Linux mocks plus real child processes:** `helper/node-pair-restart.ps1`.
   - It does stop → swap BOTH pinned modules through the reviewed `bundle-swap.ps1` → start → readiness, as one bounded window.
   - All suites pass: 59 checks plus 11 mutation controls (below).
   - **It is NOT native PowerShell 5.1 / Task Scheduler / CIM evidence.**
2. **With today's numbers it does NOT fit a zero-rate lease** under the strict reserve.
   - Forward worst case: 835 s (`startNodeSec` 600).
   - Full return: 835 s. Margin 180 s.
   - Total needed: **1850 s > 1800 s.** A zero-rate renewal is exactly now + 1800 s (`EnclaveDeployments.sol:1194`), so no instant ever qualifies. The helper refuses that window before stopping anything (tested).
3. Only these configurations fit a zero-rate lease, and only when started within the stated slack of a renewal landing (all expected leases renewed together):
   - the explicit `reserve: recovery-start`;
   - margin 120 s;
   - `startNodeSec` at the measured floor (480 s).

   Each one weakens a guarantee, and each is root's decision (table in section 3).
4. **A paid lease fits all four `startNodeSec` 600 configurations.** A paid renewal extends from `leaseUntil` (`:1194`, `from = d.leaseUntil` at `:1128`), giving up to ~285 + 1800 = 2085 s.
5. The live lease rate is unverified here: root must recheck it.

## 1. Files (exact hashes)

| file | sha256 | role |
|---|---|---|
| `helper/node-pair-restart.ps1` | `063a29304ad449f48e72a4ba4615337faf0934ee0385ee6ef809113b7f15d88a` | THE helper (721 lines), composed by `tools/compose.py` |
| `helper/provenance.json` | `22150a16…` | verbatim / modified / new function inventory |
| `tools/helper-template.ps1` | `56f6bc5d…` | the template (verbatim markers + the new code) |
| `cron-startup-20261021/respawn-activation/bundle-swap.ps1` | `21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103` | **reused unchanged**, one child per file |
| `source/node-hold-cutover.df2e58f2.ps1` | `df2e58f2…` | the root-reviewed source of the verbatim functions |
| tests | `tools/pair-test.py` `0e0891e6`, `pair-mock.ps1` `e7245126`, `swap-prelude.ps1` `507c36b9`, `child-test.ps1` `d416fb41`, `provenance-test.ps1` `f107b73b`, `stop-proof-test.ps1` `14127d94`, reused `task-budget-test.ps1` `50e206bb` and `query-failure-test.ps1` `d37ab6f6` | |

**Provenance.** The provenance test proves by AST that every one of these 39 functions is byte-identical to `df2e58f2`:
- **Lifecycle:** `StopNode`, `NodeTask`, `Invoke-TaskCommand`, `WaitNodeGone`, `AgentUp`, `LeaseReady`, `OwnsAgentPort`.
- **Bounded reads:** `Invoke-BoundedQuery`, `Query`, `NodeProcs`, `Same`, `ById`, `Listeners`, `Manager`, `Privacy`, `Vms`, `HostState`, `UpdateState`.
- **Guards and budget:** `UpdateDecision`, `Lim`, `LeaseLeft`, `NeedForward`, and others.

It also proves that 6 functions differ from the source and that 9 are new:
- **Modified (6):**
  - `ForwardLeft`: there is no in-run revert, so the post-checks are reserved instead.
  - `BeforeStop`: pinned files instead of configs, plus the updater horizon.
  - `StartNode`: a scheduler-parent pin and new-identity check.
  - `Others`: bounded, with only Node excluded.
  - `HyperV`: bounded.
  - `Recovery`: records the pair and journals.
- **New (9):** `TaskAction`, `UpdateHorizon`, `UnchangedFiles`, `PairNow`, `NewIdentity`, `Invoke-SwapChild`, `SwapJournal`, `SwapStep`, `SwapPair`.

## 2. What the helper does

Interface: `-Mode identify | apply | rollback -ParamsFile P -ParamsSha S`. This is root's existing loader pattern: a one-shot SYSTEM task runs the hash-verified bytes as a ScriptBlock. There is no `-File` and no ExecutionPolicy change.

**Pins (nothing changed; any mismatch is REFUSED).**
- **Files:** exactly two, `chain.mjs` and `host.mjs`, at exactly `C:\Program Files\Enclave\control\windows\node\`.
  - Each has an old and a new sha256, a staged file and its own `bundle-swap` work directory, all inside the stage.
  - The work directories must be distinct.
  - `bundle-swap.ps1` must be the pinned bytes, and `node.exe` (for `node --check`) the pinned sha.
- **Inspect:** `bundle-swap.ps1 -Mode inspect` for each file (CAS, staged sha, `node --check` on the exact bytes) BEFORE the stop.
- **Node task:** the `\Enclave\Node` action equals the pinned one.
- **Processes:**
  - the cmd and agent are the pinned PID+start;
  - the agent's parent is the cmd;
  - the cmd's parent is the pinned Task Scheduler process (PID + start + name + command line);
  - 9600 is owned by the pinned agent alone.
- **Unaffected components:** the manager and privacy agent are the pinned PID+start, the manager and Hyper-V VM sets equal the pins, and the other `\Enclave\` tasks are snapshotted for the post-check.
- **Unchanged files:** pinned and compared before and after (`run-node.cmd`, `node-config.local.cmd`, …).
- **Updater:** `UpdateDecision` (verbatim) PLUS `UpdateHorizon`: the next updater run must also be after root's reserved return.
- **Lease and budget:** see section 3. `startNodeSec` below the measured 480 s is refused.

**Stop.** Verbatim `StopNode`:
- fresh identity;
- `BeforeStop`, which re-reads the updater, the lease, the pair and the files immediately before the stop;
- the bounded task request, with no retry when its outcome is unknown;
- a kill only of the verified PID;
- then the 9600 listener must be gone.

A stale listener, a changed module or a changed file means nothing is written and the node is NOT started.

**Swap (node proven stopped).** `chain.mjs` then `host.mjs`; rollback mode runs them in reverse. Each step is ONE `bundle-swap.ps1` child that:
- re-hashes its own bytes;
- is capped at 30 s, killed on overrun, with its exit confirmed;
- is judged by the coordinator's own read of the target sha and the swap journal.

| step outcome | condition | consequence |
|---|---|---|
| **done** | exit 0 + success decision + target = after-sha + journal closed | next step |
| **conclusively unchanged** | exit confirmed + target = before-sha + journal not `started` + not `noop` | earlier PROVEN steps undone (inverse `bundle-swap`, newest first, each proven), then the FROM pair is started |
| **unknown** | anything else: timeout, unconfirmed child, other bytes, journal `started`, `noop`, an undo not proven | nothing more is written; the node is NOT started; RECOVERY_REQUIRED with the actual state (shas, journals, processes, listener, lease seconds left) |

Before any start, the pair is re-read and must be consistent: both TO or both FROM. **A mixed pair is never started** (new host.mjs with old chain.mjs, or the reverse).

**Start and readiness.** The node is started only if `startNodeSec` still fits the forward budget. The new agent is accepted only if all of these hold:
- the new cmd's parent is the pinned Task Scheduler process;
- both cmd and agent are new identities (a reused PID with a new start counts as new);
- 9600 is owned by the new agent before AND after the readiness read;
- `leaseReadiness` shows not in flight, `startedAt ≥` the new agent's start, `completedAt` within 5 s, and every expected id `ready` + `running` + leased beyond the margin (`LeaseReady`, verbatim).

Otherwise the run ends **NOT_READY**, with no retry, stop or swap.

**Post-checks:** manager, privacy agent, scheduler, Hyper-V and manager VM sets, other tasks, the pair and the unchanged files; node.log counts.

**Final outcomes:**
- `DONE` or `ROLLED_BACK`;
- `SWAP_REFUSED_OLD_PAIR_RESTARTED` or `RETURN_REFUSED_NEW_PAIR_RESTARTED`;
- `*_CHECK` (a post-check failed);
- `NOT_READY`;
- `RECOVERY_REQUIRED`;
- `REFUSED` (nothing changed).

**The helper never touches:** configs, the privacy agent / Network, the manager / Shield, Relay, Card, Update, VMs, wallet, contracts, keys or policy. Only the Node task and the two module paths are affected.

**Bounds (honest).** Every child query (≤ 15 s), task request (≤ 20 s) and swap child (≤ 30 s) is capped by its own limit and by the remaining global bound. The forward path is also capped by the lease deadline minus root's reserve. Local hashing and journal appends are not individually bounded. `boundSec ≤ 1140` fits root's 20-minute task limit.

## 3. Lease arithmetic (rate 0 vs paid)

**Definitions.** `L` is the seconds from `BeforeStop`'s lease read to the FIRST expected lease end. The gate is `L − margin − reserve ≥ forwardMinSec ≥ F`.

**Forward worst case** `F = STOP_AFTER_LEASE 135 + SWAP_WORST 100 + startNodeSec`.
- STOP_AFTER_LEASE = task 20 + cmd gone 30 + agent gone 30 + identity 15 + kill wait 10 + empty snapshot 15 + listener 15.
- Steps before the lease read (identity snapshot, updater) do not count against the lease. The stop's full worst case of 170 s is still used for the global bound.
- SWAP_WORST = 2 steps + 1 proven undo, at 30 s each plus reads.

**Readiness timing.** A first full pass was measured at 6m47s–7m56s (407–476 s).
- `startNodeSec` 600 is the recommended value.
- 480 is the hard floor (refused below), leaving only ~4 s over the slowest measured pass.

**Reserve options.**
- `full-return` (default): a complete second window, ≥ `forwardMinSec`.
- `recovery-start` (explicit opt-in, journaled): resolving the files plus ONE completed pass (≥ 100 + `startNodeSec`).
- Process availability alone is never accepted as a reserve: renewal happens inside the pass, and its timing within the pass is unknown.

**Maximum `L` after a renewal lands:**
- **zero-rate:** exactly 1800 s (`until = now + leaseSec`);
- **paid:** ≤ 285 + 1800 = 2085 s. The node renews below 285 s left (renewWindow 300), and a paid renewal extends from `leaseUntil`.

**Slack** is how many seconds after the renewal lands `BeforeStop` may read the lease. That includes root's launch and the helper's pins (natively an estimated 30–60 s; not measured):

| startNodeSec | F | reserve | R | margin | needs L ≥ | zero-rate slack | paid slack |
|---|---|---|---|---|---|---|---|
| 600 | 835 | full-return | 835 | 180 | 1850 | **−50: never** | 235 |
| 600 | 835 | full-return | 835 | 120 | 1790 | **10: impractical** | 295 |
| 600 | 835 | recovery-start | 700 | 180 | 1715 | 85 | 370 |
| 600 | 835 | recovery-start | 700 | 120 | 1655 | 145 | 430 |
| 480 | 715 | full-return | 715 | 180 | 1610 | 190 (≈4 s readiness headroom) | 475 |
| 480 | 715 | full-return | 715 | 120 | 1550 | 250 (≈4 s readiness headroom) | 535 |
| 480 | 715 | recovery-start | 580 | 180 | 1475 | 325 (≈4 s readiness headroom) | 610 |
| 480 | 715 | recovery-start | 580 | 120 | 1415 | 385 (≈4 s readiness headroom) | 670 |

The boundary rows are tested exactly:
- 1850 is refused at 1800;
- 1790 passes at 1790 and is refused at 1789;
- 1655 passes at 1655 and is refused at 1654.

**Further limits.**
- **Leases renewed together.** `L` is the MIN over all expected ids. If the expected ids' leases were not renewed together, the spread subtracts directly: the free leases' phases were spread over ~872 s on 10-21, so a multi-app expected set is infeasible.
- **Recommendation.** With a single expected id (the adapter), the only zero-rate configurations that keep the 600 s readiness allowance are the two `recovery-start` rows (slack 85 or 145 s). Both weaken the in-cycle return guarantee. Root decides; nothing is defaulted.
- **Ruled out.** Per-app readiness from a fresh pass (root's review) could cut `startNodeSec`. The gate is NOT changed here, because there is no source or evidence justification. Fees, `leaseWindow` edits, contract changes and manual renewals are not used to manufacture a window.
- **Bounds, not typical times.** The gate uses bounds. Typical durations are far shorter: stop ~2–5 s, swaps ~5 s, readiness ~7–8 min. Only the bounds make the lease claim a guarantee.

## 4. Tests

All runs used `work/claude-test-queue.py` at 512 MiB (real pwsh children), offline in a network namespace, with ssh/scp/sftp denial stubs.

**`logs/suite-r2.log` (rc 0, peak 344 MiB):**
- case lint: no collisions;
- provenance: 39 verbatim / 6 modified / 9 new;
- `task-budget-test` 6/6 and `query-failure-test` 7/7: earlier workers' tests, reused unchanged against this helper;
- `stop-proof-test` 8/8;
- `child-test` 13/13: REAL children. An overrunning read is killed within budget and confirmed gone. A task request is confirmed only on exit 0; hang and throw are unknown. A swap child that hangs is killed, a wrong script sha exits 3 and never runs, and a crash code is reported. Quoting is safe.
- **`pair-test` 25/25.** It runs the REAL `bundle-swap.ps1` in child pwsh processes on real files, with a test prelude for the ACL cmdlets and injected faults. Cases:
  - apply → DONE, callee first, inspect before the stop;
  - rollback → ROLLED_BACK in reverse order;
  - a partial return refused conclusively → a proven re-apply → the new pair restarted;
  - the second file refused conclusively → the first proven-undone → the OLD pair restarted;
  - a first-file child crash before any write → the old pair;
  - a hung swap child, an unprovable undo, an ACL not restored (journal `started`), a child dying after the replace → all UNKNOWN, mixed pair or journal left as recorded, node NOT started;
  - a stale 9600 listener, a module or config changed while stopped → nothing written, not started;
  - a launcher with a foreign parent → NOT_READY;
  - PID reuse with a new start → accepted;
  - an unkillable agent → killed only by its verified PID;
  - unknown task outcomes after stop and after start → no retry;
  - never-ready, stale-readiness, app-not-ready and foreign-9600 → NOT_READY;
  - updater due, in the reserve, or queued before the stop, a lease shrinking before the stop, a short lease → nothing stopped;
  - the zero-rate infeasibility and the exact boundary rows;
  - budget parameter refusals, slow pins;
  - params, pins and tampered staged-file refusals;
  - the lock and a wrong params sha (exit 4);
  - post-check failures → `DONE_CHECK`.

**Mutation controls** (`logs/mutants-r1.log`, `logs/mutants-r2.log`): 11 mutants, 9 KILLED and 2 that survive only because a second layer exists.

| mutant | result |
|---|---|
| a timed-out swap counted as unchanged | KILLED |
| proven steps not undone | KILLED |
| no undo AND no consistent-pair check | KILLED |
| scheduler parent unchecked | KILLED |
| stale listener ignored | KILLED |
| measured floor removed | KILLED |
| an old identity accepted as the new agent | KILLED |
| updater horizon removed at the pins only | SURVIVED: `BeforeStop` re-checks; removing both layers (M6b) is KILLED |
| unknown swap still starts the node | SURVIVED: the consistent-pair re-check refuses a mixed pair; removing both (M7b) is KILLED |

## 5. Activation shape (root; NOT performed)

**Stage** (SFTP / `scp -3` into a new private SY+BA stage, sha-verified remotely):
- `node-pair-restart.ps1` `063a2930…`;
- `bundle-swap.ps1` `21d85c69…`;
- the FINAL `chain.mjs` and `host.mjs` (hashes pending from the renewal worker);
- the params file.

**Identify.** Run `-Mode identify` (read-only, bounded). It records the pins:
- the task action;
- cmd/agent PID+start;
- the scheduler PID, start, name and command line;
- the 9600 owner;
- manager, privacy agent, VM sets and other tasks;
- the updater;
- deployments and leases;
- the file shas.

**Params** (all fields required unless noted):

| field | value |
|---|---|
| stage, runId | the private stage; a fresh run id |
| boundSec | 1140 (≤ 1140) |
| bundleSwap | {path, sha `21d85c69…`} |
| nodeExe, nodeSha | the agent's own runtime `node.exe` |
| files | two entries: name `chain.mjs` / `host.mjs`, target = the exact live path, oldSha = live, newSha = final, newFile in the stage, workDir = stage\swap-chain / stage\swap-host |
| unchangedFiles | at least `run-node.cmd` `0fdc3699`, `node-config.local.cmd`, `privacy-config.json` |
| task | {execute, arguments} |
| node | {cmdPid, cmdStart, agentPid, agentStart} |
| scheduler | {pid, start, name `svchost.exe`, commandLike (e.g. `*-s Schedule*`)} |
| manager | `pid@start` |
| privacy | {pid, start} |
| vms, hyperv | from identify |
| expectedIds | normally ONLY the adapter, `0x7ae476a3…` |
| runner | the node's runner |
| lease | {marginSec, revertSec, forwardMinSec, startNodeSec, reserve}: a section 3 row that fits |

**Launch.** Use the existing `root-node-hold.py` LOADER/LAUNCH pattern with this script's sha and `-Mode apply`. The task's ExecutionTimeLimit (20 min) must be at least boundSec + 60.

**Validation window afterwards:** as adapter-activation-review S7.

**Outcomes and root's responsibilities:**
- `DONE` → validation window.
- `SWAP_REFUSED_OLD_PAIR_RESTARTED` → the old node runs; investigate.
- `NOT_READY` → the node runs (unproven):
  - observe;
  - a `-Mode rollback` run needs its OWN lease window (pins require the running new pair), possibly only after the next renewal;
  - if the new node does not renew, the lease lapses (residual risk).
- `RECOVERY_REQUIRED` → manual, from the recorded state:
  - per-file `bundle-swap.ps1 -Mode rollback -ExpectCurrent <current>` or `apply`, by CAS, then `Start-ScheduledTask \Enclave\Node`;
  - **never a blind retry**;
  - never start a mixed pair.

## 6. Remaining native evidence and limits

- **Native unknowns (Linux mocks only):** PS 5.1 behaviour of the new code (`Invoke-SwapChild` from a SYSTEM task, its `-EncodedCommand` loader, `bundle-swap` run as a child), Task Scheduler/CIM/ACL behaviour and real timings.
  - The verbatim functions keep their earlier native evidence (bounded queries and task requests: native sessions 19126 / 77866 / 74915).
  - `bundle-swap.ps1` apply was used natively on 10-21.
- **Native pin read:** the scheduler-parent pin (cmd's parent = the Schedule service svchost) is unverified natively. The identify output must show it before use.
- **Preflight duration:** the native pins' duration (the slack consumed between the renewal landing and the stop) is unmeasured. Measure it with identify first.
- **ExecutionPolicy:** the pending RemoteSigned harness request is untouched; no ExecutionPolicy change of any scope.
- **Not addressed here:** renewal reliability (the RPC quorum failures), per-app readiness semantics, and the final chain.mjs/host.mjs hashes belong to the renewal worker and root.
