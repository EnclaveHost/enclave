# storage-migration-r5: candidate fix for root's two production-controller blockers

Prepared by Claude on 2026-10-22, from source plus mocked tests.
- Nothing ran against a real database: no production, wallet, service or Docker mutation.
- r4, the frozen fixture and the frozen rehearsal are untouched: r4 `PINS.sha256 -c` passes, and the copies here are
  byte-exact.

## Pins
| file | sha256 |
|---|---|
| base: storage-migration-r4/controller/replicactl.py (`ref/replicactl.r4.py`) | 1b189bab58436b63e56e4859c2d57f19d3e156b6e53335d8d3c627dc3015450b |
| **r5 candidate: `controller/replicactl.py`** | **a23e644fe3a8ef59fd55bd46899171bc39080dd2cec832411a828777da045737** |
| diff `controller/replicactl.r4-to-r5.patch` | 94a15e1e1714d15347167bea7f6ec289bff81cd8fe3ebe66ae3f6e3efdc24306 |
| fixture controller 91dc928d (`ref/`) | 91dc928de335473997fefbc4aa9031d009072492147f5314b79e43ab95ac53d6 |
| fixture-r5 candidate (`integration/replicactl.fixture-r5.py`, for the integration run only) | 1b1b471cac9b5ce8ce9b66972530b82c25526e1cb085d9c16d9b1507647e27ee |

## The fix (only root's two blockers; AST-checked: only cmd_verify_backup, cmd_upgrade and cmd_upgrade_c2 changed)
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
| logs/verify7.out (256) | test_verify.py on r5: 23 tests (below) | 23/23 OK, queue EXIT 0 |
| logs/verify-fixture-r5-1.out (256) | the same behavioural tests on the fixture-r5 candidate | 22/22 OK, static r4-delta check skipped (r5-only) |

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
