# storage-migration-r5 (revision 2): candidate fix for root's two production-controller blockers and review notes 1-4

Prepared by Claude on 2026-10-22, from source plus mocked tests.
- Nothing ran against a real database: no production, wallet, service or Docker mutation.
- r4, the frozen fixture and the frozen rehearsal are untouched: r4 `PINS.sha256 -c` passes, and the copies here are
  byte-exact.

## Pins
| file | sha256 |
|---|---|
| base: storage-migration-r4/controller/replicactl.py (`ref/replicactl.r4.py`) | 1b189bab58436b63e56e4859c2d57f19d3e156b6e53335d8d3c627dc3015450b |
| **r5 revision 2: `controller/replicactl.py`** | **3e8a8c3fde252d80a46e0e445b114fb7a61fcd1fd247dcedc2144f41b2431f63** |
| diff r4 → rev2 `controller/replicactl.r4-to-r5.patch` | 210c6e155592c3725f74142631f7dab3ea9102a1e6fdf219faddf07062ae440c |
| diff r5 initial → rev2 `controller/replicactl.r5-initial-to-rev2.patch` | e5aa966d8786e85e6ae24040416054ca6f013882ab1f8a4e95466c29272176b2 |
| r5 initial, preserved (`ref/r5-initial/replicactl.r5-initial.py`, plus its tests, logs and SHA256SUMS 08abf8dd) | a23e644fe3a8ef59fd55bd46899171bc39080dd2cec832411a828777da045737 |
| corrected recipe `ROOT-RECIPE.r5.md` (no manufactured user-hold claims) | see SHA256SUMS |
| fixture controller 91dc928d (`ref/`) | 91dc928de335473997fefbc4aa9031d009072492147f5314b79e43ab95ac53d6 |
| fixture-r5 candidate, revision 2 (`integration/replicactl.fixture-r5.py`, for the integration run only) | 2ab98b4d359fd0f3dcd34458ddfdf61a32b0dfb66652328418e453d4bc679151 |

## Revision 2: root review notes 1-4 (ROOT-R5-REVIEW-NOTES.txt)
1. **Exceptions at the pre-switch boundary.**
   - `verify_backup` now REPORTS every ordinary exception (it never raises one). That covers the `command -v timeout`
     timeout, psql_rc and restore launch OSErrors, manifest, file and JSON errors, and record failures.
   - If the CREATE was already sent, the scratch database is PRESERVED (never dropped) and `cleanupOk` is false.
   - `verify_before_switch` adds a second net (`except Exception`), and both lead to the safe unchanged-source resume.
   - `resume_unchanged` itself never raises an ordinary exception: a start failure is reported as `resumeFailed`.
   - KeyboardInterrupt and SystemExit propagate and are never turned into a result (tested).
2. **Ambiguous CREATE never clean.**
   - Only a server-reported SQL error (psql exit 3 under ON_ERROR_STOP) proves nothing was created: "already exists"
     means not ours; any other ERROR means not created.
   - A timeout (lost answer) or any other exit code (e.g. 2, connection lost) is AMBIGUOUS, `cleanupOk: false`, never
     dropped, whatever an immediate count says.
   - Tested with a late CREATE: the count is 0 at first and the database appears later, yet it is never dropped.
3. **Bounded total.**
   - ONE `QueryBudget` (`verify_query_seconds`, default 600) bounds every verification query and every sleep except
     the restore. The restore keeps its own bound: `timeout -s KILL tmo` in the container, `tmo + 60` on the host.
   - Each query gets min(120 s, what is left); the session-wait loop is capped by `sessions_wait` AND the budget.
   - The scratch digest and db_version reads are bounded: `Node.psql`/`digest`/`db_version` gained an optional
     `timeout`, and None keeps r4's behaviour for every other caller.
   - On the initial r5, a hanging-query case ran until the 500 s job timeout killed it (exit 124,
     `logs/rev2-negative-r5initial3.out`); on rev2 it ends within the budget.
4. **Exclusive owned records.**
   - `VerifyRecord` creates `verify-<scratch>.json` O_EXCL | O_NOFOLLOW (an existing record is refused and kept).
   - Each update writes a fresh random-named temp, created exclusively (an existing temp is never reused or removed).
   - The temp replaces the record only while the record is still the inode this verification last wrote; a replaced
     record is not overwritten.
   - Only our own temp, checked by inode, is ever removed.

## The fix (root's two blockers; AST-checked delta: cmd_verify_backup, cmd_upgrade and cmd_upgrade_c2, plus rev2's optional timeout in Node.psql/digest/db_version)
### 1. `verify_backup()` (used by `verify-backup` and by both upgrades)
- **Scratch name:** `<prefix>_verify_<16 hex>`. The prefix is the database name lowercased, `[a-z0-9_]` only and at most
  30 characters; the whole name is at most 63 bytes (PostgreSQL's limit) and matches `^[a-z0-9_]{1,63}$`. A fresh name
  is used for every verification.
- **Recorded first:** `<backup>/verify-<scratch>.json` is written (0600, atomic) BEFORE the CREATE, and updated at
  every step: the recovery record.
- **Separate statements:** `CREATE DATABASE "<scratch>";` and `DROP DATABASE "<scratch>";` are each a psql call of their
  own, outside any transaction block. There is NO `DROP ... IF EXISTS` anywhere, and the fixed `<db>_verify` of r4 is
  never named.
- **Ownership = our CREATE answered success.** Otherwise:
  - "already exists": not ours, untouched;
  - the server confirms it does not exist: nothing to clean;
  - anything else (lost or unclear answer, server unsure): **AMBIGUOUS, preserved, never dropped**, and
    `cleanupOk: false`.
- **Bounded restore:** `timeout -s KILL <verify_timeout_seconds> pg_restore ...` inside the container (default 3600 s;
  optional profile key, so the live profile does not change), plus a host timeout of 60 s more.
  - Inside the container, a `command -v timeout` check runs first: without it the restore is refused before anything
    is created.
  - The pinned image is Debian pgdg13 with coreutils, from read-only image metadata.
- **No detached writer:** before the DROP, the verifier waits (bounded, 120 s) until `pg_stat_activity` shows no backend
  on the scratch database. If one remains, the database is KEPT and named, and `cleanupOk` is false.
- **Confirmed drop:** the DROP must answer success AND `pg_database` must no longer list the name.
- **Result:**
  - the report's `ok` means the backup verified (digest and db_version vs its manifest);
  - `cleanupOk` means no scratch database of ours is left;
  - `verify-backup` exits 0 only if both hold;
  - the output keys `ok`, `restoredDbVersion` and `digestMatches` are kept, so fixture stage 2 and rehearsal S2 are
    compatible.

### 2. Verify BEFORE the switch in `upgrade` and `upgrade-c2`
Order: stop, then backup, then the version check (then durability, for c2), then **verify_before_switch**, then switch,
then start, then readiness.

On a failed verification, or one whose cleanup is uncertain:
- nothing is switched;
- `resume_unchanged()` restarts the unchanged source release, ONLY if `current` is still the pre-upgrade release and
  db_version is still the pre-upgrade version; otherwise it is "not restarted";
- the output names the backup and the verification record, which are kept as evidence, plus the resume outcome or its
  failure;
- the exit code is 1.

A successful upgrade's output gains `backupVerified: true`; its other keys are unchanged.

## Tests (local, mocked; `test/fake_pg_docker.py` as `docker` on PATH; no daemon, no PostgreSQL, no indexd)
| log | what | result |
|---|---|---|
| logs/rev2-verify3.out (256) | test_verify.py on r5 rev2: 37 tests, the 23 original cases plus the 14 Revision2 cases | 37/37 OK, queue EXIT 0 |
| logs/rev2-verify-fixture-r5-1.out (256) | the same on the fixture-r5 rev2 candidate | 36/36 OK (r5-only static check skipped) |
| logs/rev2-negative-r5initial3.out (256) | the Revision2 cases on the PRESERVED initial r5 (negative control) | every case that ran FAILED or ERRORED; the hanging-query case never ended (killed at 500 s, exit 124): all four notes reproduced |
| ref/r5-initial/logs/verify7.out, verify-fixture-r5-1.out | the initial r5's receipt | 23/23 and 22/22 (kept) |

The 14 Revision2 cases:
- a CREATE timeout with count 0, then a late CREATE, never dropped;
- a connection lost without creation, ambiguous;
- an existing same-scratch record refused and kept;
- a pre-existing temp never reused or removed;
- a replaced record not overwritten, the scratch preserved, only our temp removed;
- a never-leaving backend bounded by the budget;
- hanging queries bounded by the budget;
- the digest/version reads of the scratch bounded;
- a malformed manifest reported, not raised;
- `command -v timeout` timing out THROUGH `upgrade`: resumed, `current` unchanged;
- a restore launch failure THROUGH `upgrade-c2`: scratch preserved and recorded, resumed;
- an unexpected verify exception caught at the switch boundary: resumed;
- KeyboardInterrupt propagates and never switches;
- a start exception during resume reported.

Previous cases are all retained. Two assertions were updated:
- the definite-refusal wording ("not created …");
- the static delta list (rev2's helpers plus the Node timeout plumbing).

The fake now uses real psql exit codes (3 = server-reported SQL error, 2 = connection lost). The first rev2 runs
(rev2-verify1/2) errored in two new tests because of a test-helper `subprocess` stub, fixed in the test only.

What the 23 tests cover:
- **Verifier:**
  - unique scratch names per verification, dropped; no IF EXISTS; CREATE and DROP each alone; restore bounded; the
    record is written;
  - the legacy `indexd_verify` is untouched; names are bounded and valid for odd database names;
  - a pre-existing scratch name is never dropped;
  - an ambiguous CREATE (lost answer, or rc 2) is preserved;
  - a failed CREATE is clean;
  - a KILLed restore waits for its backend, then drops; a backend that never leaves keeps the scratch;
  - a host-side restore timeout is bounded and safe;
  - digest mismatch, restore failure and drop failure;
  - a hash mismatch or a container without `timeout` creates nothing;
  - the exit codes.
- **Upgrades:**
  - both upgrades restore before the switch, exactly once;
  - a failed verification does not switch and resumes the unchanged source (both paths, evidence kept);
  - a resume failure is reported;
  - an unsafe resume (`current` changed) is not restarted;
  - an ambiguous scratch blocks the upgrade.
- **Negative controls on r4:** r4 DROPs the unrelated `indexd_verify`; r4 switches without any restore.
- **Static:** the delta is limited to the two blockers.

Before the final runs, `logs/verify1-5.out` returned 98 (not started: the small lane was held); each retry used a new
log. `verify6` was 23/23 on the pre-override test file.

## Integration (`integration/INTEGRATION-PLAN.md`; not run, root approval required)
Proposed route:
- a derived copy of the root-passed eight-stage fixture pinning `replicactl.fixture-r5.py`;
- plus (a) a pre-created `indexd_verify` that must survive;
- plus (b) a deliberately too-short `verify_timeout_seconds` run that must KILL, then drop cleanly;
- optional (c): a corrupted backup that must make `upgrade-c2` refuse with `current` unchanged.

Budget: the fixture's 768 MiB job plus the 256 MiB docker cap.

## Implications for migration and rehearsal
- **ROOT-RECIPE (r4) step 3 manual note (line 45):** "run `replicactl verify-backup` after each upgrade" is no longer
  needed with r5, because it now runs BEFORE the switch. With r4, that manual call itself runs `DROP DATABASE IF EXISTS
  "indexd_verify"`, so if r4 stays in use it carries this hazard. Root should update the recipe and pins to r5
  (a23e644f).
- **Preflight / evaluator:** `test_alignment.py` loads `controller/replicactl.py` from its own package (r4); an r5
  package would need its own aligned copy. The capacity model (evaluate-preflight: backups + 1 GiB) should add one
  transient scratch database of about the production database's size (about 30 MB per the recipe) in the PostgreSQL
  volume during each verification.
- **Upgrade duration** grows by one restore plus digest per upgrade, while indexd is stopped. Readiness timeouts are
  unchanged.
- **Fixture and rehearsal:** both pin the fixture controller 91dc928d (r4 plus process identity) and remain frozen.
  - If root adopts r5 for them: switch them to `replicactl.fixture-r5.py`, which is identical in r5 code and changes
    their manifests.
  - Their stage and phase assertions still hold. The upgrade output only gains `backupVerified`, and the verify output
    keeps `ok`, `restoredDbVersion` and `digestMatches`.
  - Rehearsal S2 and the fixture's stage 2 call `verify-backup`, so they would then exercise the new verifier on real
    PostgreSQL.
- **Observed, NOT changed (outside root's two blockers):**
  - `cmd_upgrade`/`cmd_upgrade_c2` still `die` WITHOUT restarting when the backup's db_version or (c2) the durability
    settings are wrong, as in r4: indexd stays stopped;
  - `rollback`/`rollback-c2` take a backup but do not verify it (their docstrings do not promise it);
  - `pg_dump` in `cmd_backup` is unbounded.
