# Root recipe: B1 read-only preflight r2 (ROOT ONLY; NOTHING here was run on the VM)

r2 repairs root review R1/R2 of the r1 preflight (r1 is preserved unchanged in `storage-migration/preflight/`).
B1 is a read-only check within root's routine authority once root has reviewed r2. It needs no user approval, wallet key,
spend or hardware. The live backup (B2) and the service upgrade (Phase C) are NOT authorized now.

## 0. Verify pins locally

    cd storage-migration-r2 && sha256sum -c PINS.sha256

## 1. On the VM, as root (root's own transport; the script never reads stdin, so `bash -s < vm-preflight.sh` also works)

    timeout -k 10 330 bash vm-preflight.sh > pf.out; echo "exit=$?"     # 0 = ran; 2 = not root (pf.out says preflight.error=not-root)

- It starts, stops, restarts, writes and repoints nothing. It creates no file and does not read indexd.yml (it only stats it).
- There is no full-data digest.
- Worst-case walltime: 300 s. This is the script's own budget: a fact that could end past it is skipped and reported as
  `skipped:walltime-budget`. Normal: seconds.
- The outer `timeout 330` is only a backstop.

## 2. Locally

    python3 preflight/evaluate-preflight.py pf.out; echo "exit=$?"

| exit | verdict | meaning / root action |
|---|---|---|
| 0 | READY_FOR_FRESH_BACKUP | Every required fact was read successfully and has a canonical value, the session proved read-only/5s/1s, and the facts match the rehearsed pins. This authorizes nothing. |
| 1 | BLOCKED | A definite mismatch with a rehearsal pin or a controller precondition (binary, db version, schema, image, fsync/synchronous_commit, indexd.yml mode, consensus.db, /fence, disk). Fix it or re-plan. |
| 2 | REVIEW_REQUIRED | All checks pass, but a table count is below the 2026-10-20 dump. Deletes, pruning and renewals can cause this: it is drift, not proof of loss. Root reviews it, and B2 re-baselines. |
| 3 | UNKNOWN | A read failed, timed out, was skipped, is malformed or duplicated, or the capture is truncated. See `<key>.status` / `<key>.err` in pf.out; re-run after the cause is gone. Never treat it as READY. |

## 3. What the run costs the live VM

- PostgreSQL:
  - 16 one-statement psql sessions: SHOW/catalog queries, pg_database_size, and 4 counts capped at 100001 tuples.
    - Session options: `default_transaction_read_only=on statement_timeout=5s lock_timeout=1s idle_in_transaction_session_timeout=5s`.
    - Inside the container: `timeout -k 2 10`. Outside: `timeout -k 5 15`.
  - One `pg_dump --schema-only --lock-wait-timeout=5000` under an in-container `timeout -k 2 50` and an outer 60 s.
    - pg_dump resets statement_timeout on its own connection, so it runs ONLY if the image has `timeout` (`pg.inner_timeout`).
      The pinned image 74935e72 has /usr/bin/timeout; this was checked on the local copy of that image.
    - It holds ACCESS SHARE on every table while it reads the catalogs. Normal DML is unaffected; DDL, VACUUM FULL and other
      ACCESS EXCLUSIVE work waits for that time.
    - Its own lock wait is at most 5 s, and a waiting lock request can queue behind or ahead of others for that long.
  - After the first SQL timeout, no further SQL is sent.
- Files:
  - sha256 of the binary, the GeoLite file and the 2 unit files: at most 60 s each;
  - `du -sb` of the state dir under nice 19 / ionice best-effort 7: at most 60 s;
  - stat, df, /proc/meminfo, systemctl show and docker inspect: at most 10 s each;
  - one unauthenticated `GET http://127.0.0.1:9982/fence`: at most 5 s.

## 4. Optional, separate, NOT part of B1

`preflight/vm-digest-optin.sh --full-data-digest --max-db-bytes <N> <digest.sql 7f4b137f>` is one full read of every digested
table.
- It refuses:
  - an unpinned digest.sql;
  - a database above N bytes, or one whose size is unknown;
  - a container without an inner timeout.
- Bounds: 30 s per statement, 300 s total.
- It prints md5 aggregates only.
- The controller computes the same digest on the quiesced database during upgrade, so B1 does not need it.
- Evaluate with `python3 preflight/evaluate-preflight.py --digest digest.out`.

## 5. Then (not authorized now; the user's hold, not a new permission requirement)

B2 fresh quiesced coupled backup -> `preflight-fresh-backup.sh` -> rehearsal -> Phase C, per MIGRATION-PLAN.md.
Genuine prerequisites:
- the Phase A enclave builds and tests (Go, root, queue 1024);
- a READY B1, or a root-reviewed REVIEW_REQUIRED;
- the B1 disk check.
