# Minimal disposable-PostgreSQL integration for storage-migration-r5 (NOT RUN; root approval required)

## Goal
Prove on a REAL PostgreSQL 18.6 (the pinned image), with REAL `pg_dump`/`pg_restore`/`psql`, what the mocks model:
1. verify-backup creates a fresh `<db>_verify_<16 hex>`, restores, compares, waits for zero backends and drops only it;
2. a pre-existing `indexd_verify` and a pre-existing name equal to a forced scratch name are never touched;
3. CREATE/DROP outside transaction blocks really work (CREATE DATABASE refuses inside one);
4. `timeout -s KILL` exists in the image and bounds `pg_restore`, and the killed restore leaves no backend before the drop;
5. upgrade / upgrade-c2 restore the backup BEFORE switching, and a failed verification leaves `current` unchanged and
   resumes the unchanged source release.

## Cheapest route: the existing, root-passed eight-stage fixture with the fixture-r5 controller candidate
`integration/replicactl.fixture-r5.py`:
- sha256 2ab98b4d, revision 2;
- = the fixture controller 91dc928d plus the IDENTICAL r5 function, class and constant delta (AST-checked);
- passes the same 36 behavioural mock tests (`logs/rev2-verify-fixture-r5-1.out`).

The fixture stays frozen. Root would create a DERIVED copy, pinning this controller instead of 91dc928d. Nothing else
changes; the PINS entry and manifest change.

Already covered by the eight stages:
- stage 2 runs `verify-backup` (points 1, 3);
- stages 3 and 8 run `upgrade-c2`, with the pre-switch verification (point 5, success path);
- stage 7 runs `rollback-c2`, which is unchanged by r5.

Explicit additions for that derived run, around stage 2, with the disposable container only:
- (a) `CREATE DATABASE "indexd_verify"` holding one marker table; after the run it must still exist with its marker
  (point 2);
- (b) a one-shot negative run of `verify-backup` with `verify_timeout_seconds: 1` in a COPY of the profile. On a
  non-trivial dump the restore is KILLed; expect `ok: false`, `scratchState: dropped`, `cleanupOk: true` and zero
  remaining `*_verify_*` databases (point 4).
  - Point 5's failure path (resume) is not exercised against real PostgreSQL by this route. The mocked tests cover it.
    A real run would need a corrupt-dump injection, which root may add as (c): flip one byte of the stage-2 backup's
    dump copy, then `upgrade-c2` must refuse with `current` unchanged and `resume.resumed: true`.
- (d) BOUNDED FAILURE (root note 3): one `verify-backup` with `verify_query_seconds: 1` in a profile COPY. It must end
  within about `verify_timeout_seconds + 61` s plus a few seconds, exit 1, and either verify or report the exhausted
  budget. Any scratch database it leaves must be named in `<backup>/verify-<scratch>.json` with `cleanupOk: false`. The
  container teardown then removes it.
- (e) KILLED RESTORE and NO DETACHED WRITER: in (b), assert after the run that `pg_stat_activity` shows no backend on
  any `*_verify_*` database.

## Budget and ownership
- **Queue lanes:** the fixture's own: one queue job at 768 MiB, plus the PostgreSQL container's separate 256 MiB docker
  cap.
- **Restore load:** the scratch restore adds one more database of the fixture's size, which is small, inside the same
  container.
- **Ownership:** the reviewed c2fx owns every resource (journal, exclusive stage, labelled container and volume,
  scope drain), as in the passed run.
- **Data:** no production data; dummy secrets; the offline image (`--pull never`); loopback only.

## What it does NOT cover
Production specifics, for root's preflight:
- the real 0640 indexd.yml access model;
- the systemd runner;
- the production volume's free space for one extra database copy during each verification.
