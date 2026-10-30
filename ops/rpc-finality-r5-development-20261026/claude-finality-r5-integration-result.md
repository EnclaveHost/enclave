# Finality r5: operational gaps closed in source (PREPARED; NOT run; NOT production qualification)

**Stage:** `base-finality-proof-stage/r5/` (new). `SHA256SUMS` sha256 `81e3050bc00176d8ebeda682e2532cd7300e4038768fe9f142b65ede101a6b3b`, 30 files.
- **Preserved:** r4 is untouched, as are r2, recovery r7, capture r4, the readiness stages and the candidate tree. Every base is checked by the job.
- **What Claude did:** static checks only: `ast.parse` on every Python file, `bash -n`, a manifest sha recheck and patch generation.
- **Not done:** no tests, builds, queue jobs, installs, live service changes or commits.
- **Flags:** every review flag is **False** in source: `FINALITY_PROOF_REVIEWED`, `FINALITY_PROTOTYPE_REVIEWED`, `LAUNCH_PRODUCER_REVIEWED` and `A1_CAPTURE_REVIEWED`.

## Changed sources and byte pins (consistent; the job checks them)

| File | sha256 | Base and patch |
|---|---|---|
| `harness/a2a4.py` | `a074d732…` | r7 `5e2658f7` + `integration/harness-r7-to-r5.patch` |
| `src/finality_state.py` | `546036c1…` | r4 + `finality_state-r4-to-r5.patch`; pins harness `a074d732` |
| `wrapper/chain_service.py` | `5e0218b1…` | r4 + `wrapper-r4-to-r5.patch` |
| `producer/base_launch.py` | `5637eb24…` | r4 + `producer-r4-to-r5.patch`; `RECOVERY_A2A4_SHA256` = `a074d732`, `FINALITY_STATE_SHA256` = `546036c1` |
| `readiness/readiness_sampler.py` | `0154b821…` | `pruned-readiness-stage/patched` `9aa80ab8` + `sampler-pruned-to-r5.patch` |
| `install/install_verified.py`, `install/MANIFEST.json` | `e972dc6e…`, `1457bb62…` | new |

Unchanged and reused: `src/finality-core.mjs`, `vendor/`, `a1gate/`, the JS tests and helpers (r2), and `harness/selection.py` (r7).

## The fixes

1. **Status no longer goes stale right after a record.**
   - `finality_state.status` accepts exactly **one** journal entry after the proof's recorded head, and only if it is `bootstrapped` with `evidence.finalityEntrySha256` equal to **this** qualified entry's sha, and the recorded head entry is unchanged.
   - Anything else (another entry, a different named entry, a replaced head, a restart or permit) is `stale-launch-changed`. The process binding is still required (`stale-after-restart`).
   - Status now also returns `process`, `freshBlockHash`, `launchSha256` and `recordedAs`.
2. **One shared admission-ledger path, enforced before admission.**
   - Harness r5 adds the constant `A1_ADMISSION_LEDGER = /etc/enclave-rpc/base-a1-admission.jsonl`, equal to the wrapper's.
   - `_ledger_paths` refuses `a1_ledger_path` for any other path before the ledger or its lock is read or written. It is used by `admit_captures` and the new `check_admissible`.
   - `gate_a1(..., admit=True)` is r7's default. `admit=False` applies the same replay rule in memory, for `finality_state check`. The private-copy mechanism is removed.
   - The finality tool refuses if the wrapper and harness name different ledgers. The producer's `arm` check from r4 stays.
3. **Restart cannot serve a DB rolled back in place below the floor.**
   - New journal states:
     - `bootstrapped → restart-permitted → restarted`;
     - `restarted → bootstrapped | restart-permitted | rolled-back`;
     - **`bootstrapped` and `restarted` never start by themselves.**
   - **`permit-restart` (producer)**, on the STOPPED DB through the **real harness**, checks:
     - the launch's dev/ino;
     - `gate_static`;
     - **every stage checkpoint ≥ the latest recorded floor N'**, else `below_floor`. This is the same-inode, in-place rollback case.
     - the DB header at N' hashes to the floor block, else `floor_conflict`;
     - the file is unchanged during the reads.
   - The permit records the file's exact dev/ino/size/mtime. The wrapper consumes it once, appending `restarted`, starting with **no `--bootstrap.anchor`**, and only if the DB is identity-unchanged since the permit.
   - A crash needs a new permit (fail closed, no automatic restart). The floor is never lowered.
4. **The readiness gate that requires a post-restart proof is now connected.**
   - The sampler gate is **`post-anchor-finality`** in `readiness_sampler.py` (in `GATES`). The sampler's `overall` is **READY only if every gate passes**, so without a current proof the report is INCOMPLETE (exit 4) or FAIL (exit 3).
   - **What the gate checks:**
     - the status file is root-owned, not group/other writable, and bounded;
     - its format is `enclave-base-finality-status/v1`;
     - `state` is `qualified`;
     - the proven process's **pid and kernel start time are unchanged** in `/proc`.
   - **After any restart** it reports `finality-stale-after-restart`, then `finality-not-current` once republished, until a **new post-restart proof** is recorded and republished.
   - **The connection:** root's `finality_state.py status-publish <launch-dir> <chain.json> <finality-dir> <rpc-url> <out.json>` writes the file atomically (0644, fsynced), and the sampler reads it with `--finality-status <out.json>`.
5. **CLI.**
   - Producer `record-finality <launch-dir> <chain.json> <finality-dir> <rpc-url>`: the installed r5 wrapper plus `load_finality()` (exact pinned bytes).
   - Producer `permit-restart <launch-dir> <a2a4-config>`: the pinned harness.
   - Tool `status-publish` (above).
   - All are root-only and still HOLD by flag.
6. **Guarded installation of the qualified bytes** (`install/install_verified.py`, root-only).
   - **Default dry run.** `--commit` writes. `--replace` keeps the old bytes as `.pre-<UTC>`. `--include-wrapper` is required for `/opt/enclave-rpc/chain_service.py`, and is refused while any process runs it.
   - **Requires:**
     - the stage `SHA256SUMS`;
     - a passing root run of **this** stage: rc 0, `## finality-r5 rc=0` and `## r5 SHA256SUMS <this sha>`, which the job prints;
     - every manifest sha, and the noble tree (every file plus digest `e17fdd7c`);
     - root-owned, no-symlink parent directories;
     - the review-flag lines still `= False`.
   - **Writes:** atomic (temp, fsync, rename, directory fsync), then re-verified.
   - **Manifest:** 12 files plus 247 tree files, installed to `/opt/enclave-rpc/{finality/{src,vendor,a1gate,deps},a2a4-recovery,a1-capture,base-launch,readiness}` and `chain_service.py`.

## Tests (focused, real tools)

| Suite | Count | Covers |
|---|---|---|
| `tests/test_finality_integration.py` | 11 (was 9) | Real r5 harness, capture r4 module, shared ledger, core, wrapper, producer and sampler gate. New: status current right after a record; `bootstrapped` alone refused, then permit, one restart without the anchor, then stale; the harness refusing another ledger path before any lock or write; and an end-to-end readiness case (current, restart, stale, post-restart proof, current, record, still current). The restart permit is a journal stand-in here. |
| `tests/r7-ported/test_reanchor_recovery.py` | 24 (19 + 5 `FinalityRestart`) | `permit-restart` over the **real harness** on r7's fake-reth pipeline: permit then one ordinary start without the anchor, and the permit consumed; an in-place rollback below the floor (same inode) refused `below_floor`; another block at the floor refused `floor_conflict`; a DB written after the permit refusing the start; a permit only for bootstrapped launches; rollback stays terminal. The floor entry is a stand-in written with the wrapper's own appends. |
| `tests/test_finality_state.py` | 30 | Adds the status-exception cases and published status → the real sampler gate. |
| `readiness/test_readiness_sampler.py` | 91 (89 + 2) | `argv()` attaches a current status for the test process, so READY cases stay READY. Focused gate tests added. |

## Root command

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r5
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log $ST/logs/root-finality-r5-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r5-tests.sh > $ST/logs/root-finality-r5-tests.out 2>&1; echo $? > $ST/logs/root-finality-r5-tests.rc
```

**Gates:**
- the r5, r4 and r2 `SHA256SUMS`, and the r7 manifest;
- capture `db81ea49` and the sampler base `9aa80ab8`;
- every changed file equals its base plus its patch;
- pin consistency, the manifest shas, and the four flags False.

**Executed:** each needs its exact count, no skip and rc 0.

| Suite | Count |
|---|---|
| tool | 30 |
| integration | 11 |
| sampler | 91 |
| r7 copy with the r5 harness, wrapper, producer and port: reanchor-recovery | 24 |
| same copy: r3-regression | 27 |
| same copy: recovery-existing | 34 |

**Reused:** JS core 20 (r2 0234) and baseline-existing 34 (r6 0336 via r7 0345).

**Cap:** 768 MiB, an estimate.

**After a passing run (root):**
```
python3 -I -B $ST/install/install_verified.py --qualification $ST/logs/root-finality-r5-tests.out --rc $ST/logs/root-finality-r5-tests.rc            # dry run
python3 -I -B $ST/install/install_verified.py --qualification $ST/logs/root-finality-r5-tests.out --rc $ST/logs/root-finality-r5-tests.rc --commit   # + --include-wrapper with the units stopped
```
Installing bytes activates nothing. The flags stay False until root approves the evidence with a source change, which means re-qualifying the changed bytes.

## Below-floor snapshot recovery (fail-closed route; described, not implemented)

1. `permit-restart` refuses `below_floor` or `floor_conflict`. Root runs `rollback` (terminal), then `retire`. The watermark store is **never** edited.
2. **Quarantine:** root renames the datadir to `<datadir>.quarantine-<launchSha256>`, root-owned 0700. It is never started in release mode and is not deleted until root has reviewed it.
3. A new launch must re-anchor at a **fresh A1 anchor N ≥ floor**. `gate_watermark` already refuses anything below the floor, or another block at it. `step_plan` needs every DB checkpoint ≥ N. A snapshot whose head is below the floor therefore **cannot be anchored**. Two routes:
   - **(a)** a newer published snapshot whose head is at or above the floor; or
   - **(b)** an isolated forward sync of the downloaded snapshot. This uses the wrapper's non-release start (no launch record, no handshake), which never passes the readiness gate (no finality proof, so never READY). Once its stopped DB is past the floor, run the full A2–A4 re-anchor at a fresh A1 anchor at or above the floor, then arm, start, prove and record.

   In both routes the floor is retained. Route (b)'s consumer-port exposure during the sync is a unit-configuration question for root.

## Remaining (honest)

- **Nothing has run.** The first run qualifies these tests. Risks:
  - r7's r3 or wrapper suites asserting the old `JOURNAL_NEXT`;
  - the ported `FinalityRestart` fixture assumptions (`gate_static` after a start in the fake-reth fixture, `node_ran` headers);
  - capture timing (~20 real captures).
- **What the sampler gate does not check.** It binds pid plus start time. The publisher (root) binds that process to the port, the release sha and the mdbx file. The sampler does not cross-check `freshBlockHash` against the served chain.
- **No timer or unit for `status-publish`.** None was created, since that would be a live service change. Root adds one. The sampler copy chosen is `pruned-readiness-stage/patched`; root should confirm it is the current one.
- **Restarts need root.** Every restart, including after a crash, needs a root `permit-restart`. This is fail closed by design.
- **Install not exercised.** The installer and CLI have not run, and root install paths are untested.
- **Inherited limits:** Helios-relative A1, no SNP, no live node, no mainnet proof.

PREPARED only. Custody v2 stays REFUSED and lease consumers stay on HOLD.
