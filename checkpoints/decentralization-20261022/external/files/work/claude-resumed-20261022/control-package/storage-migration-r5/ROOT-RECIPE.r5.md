# Root recipe r5 (ROOT ONLY; nothing here was run on the VM by its author)

r5 = r4 (`storage-migration-r4/ROOT-RECIPE.md`, unchanged and frozen) with the controller replaced by
`storage-migration-r5/controller/replicactl.py` (revision 2, sha256 `3e8a8c3fde252d80a46e0e445b114fb7a61fcd1fd247dcedc2144f41b2431f63`).
The fixes are root's two controller blockers plus root's review notes 1-4 (README.md). Everything else in r4 is
unchanged: the preflight, the evaluator, the profile and the migration files.

**Permission wording corrected.** Per `work/effective-goal-requirements.txt` (PERMISSION PROVENANCE CORRECTION,
2026-10-22), r4's "NOT DONE (user hold)", "when the user lifts the hold" and "they wait on the user's hold" were
assistant-authored and are NOT human requirements. B2 and Phase C are bounded production steps that ROOT may perform
within the resumed task after concrete source, test, preflight and rollback review. This is not permission to skip
validation, spend funds, alter contract or admin ownership, or treat any unanswered wallet question as approved.

## Where things stand (as known to this package; root's own records are authoritative)
| | State |
|---|---|
| Phase A1 builds | DONE. fence-enclave `c67ffa4d`, c2-enclave `2c0e5b06`, reproducible (`storage-enclave-build`). |
| A2 eight-stage C2 fixture | PASSED with those binaries (root run `32418fa137c5c05c`), with the fixture controller 91dc928d, NOT r5. |
| A3 rehearsal | Prepared; tools reproduced and pinned (`storage-enclave-rehearsal`, manifest `ef410653`). Its run is root's. |
| B2 fresh quiesced backup | See root's own B2 record (storage-fresh-backup-b2); not re-verified by this package. |
| r5 controller | CANDIDATE: mocked tests 37/37; the disposable-PostgreSQL integration (`integration/INTEGRATION-PLAN.md`) awaits root approval. |
| Phase C (26 → 27 → 28) | NOT DONE. |

## Changed steps (everything else as in r4)
- **Step 4.2:** place `controller/replicactl.py` from **r5** (`3e8a8c3f…`) instead of r4. `live-primary.profile.json`
  (r4) is unchanged. Two optional keys have safe defaults:
  - `verify_timeout_seconds`: the restore bound, default 3600;
  - `verify_query_seconds`: the total budget for every other verification query, default 600.
- **Steps 4.3 and 4.4:** `upgrade` and `upgrade-c2` now restore and verify their fresh backup BEFORE the switch, into a
  unique scratch database `indexd_verify_<16 hex>`.
  - **Delete r4's manual step** "run `replicactl verify-backup <dir>` right after the upgrade". It is now built in.
    r4's `verify-backup` must not be used at all: it runs `DROP DATABASE IF EXISTS "indexd_verify"`.
  - **If an upgrade exits 1 with "backup verification failed before the switch":** nothing was switched. Read
    `resume` in its output:
    - `resumed: true`: the unchanged source release is serving again;
    - otherwise the reason or failure is named, and indexd may be stopped.
    `<backup>/verify-<scratch>.json` names the scratch database and its state.
  - **A scratch database reported AMBIGUOUS, PRESERVED or KEPT** is never dropped by the controller. Root inspects it,
    and drops it by its exact name only after confirming no backend uses it.
- **Disk:** add one transient scratch copy of the database (about 30 MB) inside the PostgreSQL volume during each
  verification.
- **Upgrade window:** each upgrade grows by one restore plus digest while indexd is stopped.

## Unchanged known limits (not fixed in r5; out of the review scope)
- An upgrade still exits WITHOUT restarting when the fresh backup's db_version, or (c2) the durability setting, is
  wrong, as in r4.
- `rollback` and `rollback-c2` take a backup but do not verify it.
- `pg_dump` in `backup` is unbounded.

## Permissions
- **A1 to A3 and the integration run:** root's routine authority, with no production effect.
- **B2 and Phase C:** bounded production steps that root may perform after review (see above). There is no human hold.
- **Wallet, spend, hardware:** none of these steps needs a wallet key, new spend or new hardware. Pending wallet
  decisions stay separate and are not implied by this recipe.
