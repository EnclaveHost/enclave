# base-finality-proof-stage/r10-ops-followup-r2: journal-aware capture retention (FROZEN, PREPARED, UNRUN)

**Stage:** `SHA256SUMS` `f072202a6fcaf10a81d47f8d2b0dd8f0ab3c2697def93668789d2c8c0336a0b5`. It supersedes r10-ops-followup for root's run and composition.
- **Location:** a sibling directory, so r10 and r10-ops-followup are not altered.
- **What Claude did:** static checks only.
  - every file parses, and the job passes `bash -n`;
  - the job's r2-patch and manifest-delta checks were run locally (`manifest = r10 with reproof.py -> cc9ff0b41dc0`);
  - `SHA256SUMS` verifies.
- **Not done:** no tests, live operations or commits.

| File | sha256 | Origin |
|---|---|---|
| `src/reproof.py` | `cc9ff0b41dc04a5c2213f1e8a34649e41dd1095dc92a1f4a46b474c1f05dbdd3` | r10-ops-followup + `patches/r2-src_reproof.py.patch` |
| `tests/test_reproof.py` | – | r10-ops-followup + `patches/r2-tests_test_reproof.py.patch` (13 → 17) |
| `install/MANIFEST.json` | `098c36ad…` | r10's, with only the reproof sha changed |
| `install/install_verified.py` `b4ee634a…`, `tests/test_ops_installer.py` (18) | – | byte copies of r10-ops-followup (configs never replaced; `runtime-dirs`) |

## Root's finding (correct) and the actual dependencies

**The r1 defect:** r1 `_sweep` retired **every** leftover `.in-progress` attempt before status/adopt. A SIGKILL after a durable qualification or record (but before the receipt) skips the `except` block, so a valid proof's captures would have been renamed and eventually deleted. The r1 claim that "only nothing-qualified attempts are retired" was unproven.

**What the code actually does** (reviewed):

| Function | Durable writes / reads |
|---|---|
| `finality_state.qualify` | writes only (a) `append` to the launch's finality journal (`qualified`/`contradicted`, + `anchor_terminal` to the launch journal), and (b) the shared A1 admission-ledger admission in `fresh_a1` → `gate_a1(admit=write)`, which happens **after** `rules` (so post-anchor/`not_newer` refusals write nothing); `launch_lock` only opens an existing file |
| `status`, `entries` | read only the finality journal |
| `base_launch.adopt_pending` / `record_finality` | the watermark store and the launch journal |

**None of them reads capture bytes after qualification.** The bytes are still preserved whenever ambiguous, because they are the raw evidence of a possibly-durable proof.

## r2 design: a conservative phase barrier plus a durable-record digest

- **`_durable(c, W, root)`:** a sha256 over every non-empty file in the launch directory (finality journal, launch journal, launch record), the shared A1 admission ledger and the watermark store.
  - It excludes the capture root, workdir and status file.
  - Empty lock files carry no record and are skipped.
- **Qualify barrier:** before `F.qualify`, the digest is written to `<attempt>/.qualify-barrier` (fsynced file and directory).

| Situation | Classification | Action |
|---|---|---|
| failed/killed **before** the barrier | known failed | retired (`failed-*`, newest 2 keep bytes) |
| after the barrier, digest **unchanged** (e.g. `not_newer`, core refusal before append) | known failed / interrupted | retired |
| after the barrier, digest **changed** (append-then-raise before `q`, kill after qualify/record, or any other writer) | **ambiguous** | receipt written, **bytes stay in place**: never renamed, pruned or deleted by reproof |
| `q` bound, record failed | `qualified-unrecorded` | preserved (as r1) |
| recorded | `recorded` | the newest KEEP (4) pairs, as before; `_prune` now skips held (preserved or in-progress) attempts |

**Where the decision is made:** in-process failures go through `_settle`; a kill leaves no receipt, so the next run's `_sweep` (under the flock, before status/adopt) decides with the same rule. **Cleanup is not disabled:** cadence failures (`not_newer`, capture failures) are still retired and bounded.

**Explicit recovery policy for ambiguous attempts:**
- Reproof never removes them.
- Each one has `attempt.json` and an `attempts.jsonl` line (outcome `ambiguous`/`qualified-unrecorded`, code, phase).
- Root may archive or remove one by hand only after status shows a recorded proof (`recordedAs`) at or after that attempt (adopted, recorded, or superseded), or after the launch is retired.
- `grep -E '"outcome": "(ambiguous|qualified-unrecorded)"' attempts.jsonl` lists them.
- Each arises only from a crash or exception after a durable change: about 38 MB each, rare. Because any concurrent writer also yields "ambiguous", the misclassification direction is always preservation.

## New crash-boundary tests (real tools and fixture; a kill is emulated by skipping `_settle`, leaving exactly what SIGKILL leaves)

| # | Boundary | Shows |
|---|---|---|
| 1 | kill at the barrier, **before** any durable write | the next run retires it as `interrupted` (`durable records unchanged`) and proves normally; no ledger |
| 2 | `qualify` **appends then raises before `q`** (in-process) | `ambiguous`, captures intact; the next run (no capture allowed) `recorded`s that proof; the bytes are still there |
| 3 | kill **after durable qualification, before record** | the next run: `ambiguous` (marker cleared), action `recorded`, captures intact |
| 4 | kill **inside record after the watermark append** | the next run `adopted`; captures intact; history `recorded, ambiguous`; KEEP+1 later prunes never remove it |

The r1 tests are kept: bounded failures, `not_newer` retired with the recorded pair kept, killed before-barrier attempt retired, r10-era pair kept, qualified-unrecorded adopted.

## Bounded root job (UNRUN): ops-installer 18 + reproof 17

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-ops-followup-r2
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log $ST/logs/root-r10-ops-followup-r2-tests.guard -- unshare -rn bash $ST/jobs/root-r10-ops-followup-r2-tests.sh > $ST/logs/root-r10-ops-followup-r2-tests.out 2>&1; echo $? > $ST/logs/root-r10-ops-followup-r2-tests.rc
```

**Job** (`ca54173c…`):
- **Pins and verifies:** r10 (`1dbb3abb…`) and r10-ops-followup (`09fb4941…`).
- **Checks:**
  - the 3 r2 files = followup + r2 patch;
  - the 2 installer files = followup copies;
  - the manifest = r10 with only the reproof sha changed.
- **Runs:** both suites in a private r10 copy with the 5 files overlaid, under the exact count, bare `OK`, no-skip rule.
- **Ends with:** `## r10-ops-followup-r2 rc=<rc>`.

Root should **not** run the r1 followup job; this one replaces it.

## Remaining (actual)

1. **UNRUN.** Compose once, after this job, forward-repair 8 and 6d24's repairs pass: r10 + these 5 files + the forward-sync test, with a new `SHA256SUMS` and the installer qualification strings for that revision's name.
2. **The history file is unbounded by design:** a few hundred bytes per attempt.
3. **Ambiguous attempts** need root's manual release under the policy above. There is no automatic expiry.
