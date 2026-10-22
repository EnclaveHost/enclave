# controller-integration: ONE derived real-PostgreSQL integration run of the r5 rev2 controller (prepared, NOT run)

Prepared by Claude on 2026-10-22, for root's immediate review.
- Nothing here has been executed against Docker or PostgreSQL. Only static tests and `--plan` ran, through the queue
  at 256.
- The frozen fixture, the r5 package and the fresh-restore suites are unchanged: their SHA256SUMS verify, and this
  package only reads them.
- No production, network, chain, funding or shared PostgreSQL is used. There is no new permission flow.

## What runs
`run-integration.py` is the root-passed eight-stage C2 fixture (storage-enclave-fixture, run 32418fa137c5c05c) with
exactly the derivation in `run-integration.patch` (vs the frozen `run-c2-fixture.py` 4b09043a; AST-checked: only pins,
work, finish and main changed, and `_load_c2fx` was added):
1. **Controller:** `storage-migration-r5/integration/replicactl.fixture-r5.py` 2ab98b4d (r5 rev2 = the fixture
   controller 91dc928d + the identical r5 delta) instead of 91dc928d.
2. **Frozen files read-only with EXACT pins:** c2fx.py ff1b092c, make-fixture-node.py 48c3d501, run_c2_fixture_test.py
   6496b2d5 (the 8 stages, unchanged), rollout_seed_test.go c0355fd8, migration/* 7f4b137f / 629f186e / 1043b645.
   The binaries are fence-enclave c67ffa4d and c2-enclave 2c0e5b06, with the matching tree and pins as the fixture.
3. **Order:**
   - the fixture's own setup: journal, exclusive stage, labelled volume and container (`--pull never`, 127.0.0.1
     ephemeral port, 256m), the v27 seed, the node;
   - `integration_checks.py pre`;
   - the 8 stages;
   - `integration_checks.py post`;
   - the reviewed c2fx cleanup: PID files never signal, own-scope drain, labelled removal, exclusive-stage removal.
4. **Pass:** exit 0 only if all 8 stages, every check, finalize AND cleanup are certain. Results go to
   `runs/<id>.result.json`, `runs/<id>.c2-fixture-results.json` and `runs/<id>.integration-results.json`.

## The real-PostgreSQL checks (integration_checks.py; strict assertions, no either-pass-or-fail branch)
**pre** (before stage 1): create `indexd_verify` (r4's fixed name) and `indexd_verify_c2c2c2c2c2c2c2c2` (a valid scratch
name), each holding a random marker row. Both must NOT pre-exist.

The 8 stages then run with them present. Stage 2's `verify-backup` and stages 3 and 8's `upgrade-c2` all use the r5
verifier.

**post** (indexd stopped, v28):

| check | setup | must hold |
|---|---|---|
| X1 success | `backup` + `verify-backup` | exit 0; ok, cleanupOk, digest and v28 match; scratchState `dropped`; record `dropped`; only the 2 markers remain |
| X2 forced collision | in-process controller, `token_hex` fixed to the pre-created name | `already existed: not ours, untouched`; marker row intact; nothing dropped |
| X3 killed restore, no detached writer | template1 event trigger `pg_sleep(20)` on ddl_command_start; `verify_timeout_seconds: 2` | exit 1; ok false; `pg_restore failed`; the lingering backend is waited out (15 s ≤ elapsed < 140 s), then `dropped`, cleanupOk true; afterwards 0 backends on `*_verify*` and only the markers |
| X4 total query budget | trigger `pg_sleep(30)`; `verify_timeout_seconds: 2`, `verify_query_seconds: 6` | exit 1 within 20 s; cleanupOk false; scratchState `KEPT …`; the scratch EXISTS and is named in `verify-<scratch>.json` (cleanupOk false). Then the harness waits (≤ 90 s) for its backend and drops exactly that validated name |
| X5 | `rollback-c2 --acknowledge-cas-downgrade` | v27, current = fence (the precondition for X6/X7) |
| X6 corrupt backup | in-process seam: one byte of the upgrade's fresh dump flipped before verification | upgrade-c2 exit 1, `hash mismatch`, nothing created; current unchanged; resume `{resumed: true, release: fence, dbVersion: 27}`; readiness v27; digest unchanged |
| X7 server-refused restore | template1 trigger `RAISE EXCEPTION`; real CLI `upgrade-c2` | exit 1; verify ok false, cleanupOk true, `dropped`; current unchanged; resume as in X6 |
| X8 final | | both markers intact; no other `*_verify*`; 0 backends; no `c2it%` trigger; current = fence |

**Determinism (root's "no flaky restore-too-fast"):**
- The event trigger lives only in THIS run's container's `template1`, only for that check (installed, then removed in
  `finally`, and verified absent; finalize repeats the removal).
- Every scratch database the controller creates copies it, so its first DDL sleeps 20/30 s, far beyond the 2 s restore
  bound, or raises.
- With PostgreSQL's default `client_connection_check_interval` (0), the backend outlives the KILLed `pg_restore` until
  its sleep ends. That is a real detached writer, which the verifier must wait out (X3) or report as KEPT (X4).
- The trigger names are `c2it_delay` and `c2it_refuse` only.

## Exact command (ROOT; ONE job)
    python3 work/claude-test-queue.py --mib 768 --log work/resume-after-checkpoint-20261022/controller-integration/logs/run1.guard.log -- \
      python3 -B -u work/resume-after-checkpoint-20261022/controller-integration/run-integration.py \
      --execute a300b94a426160da21fffa65d9bc94791fef36b55cd342ed557f4884797158d5 \
      > work/resume-after-checkpoint-20261022/controller-integration/logs/run1.out 2>&1

- **Exit codes:** 98 = not started (retry with a new log); 99 = killed; neither is a pass.
- **Results:** read `runs/<id>.result.json`, `.integration-results.json` and `.c2-fixture-results.json`.
- **On exit 3:** run `python3 work/claude-test-queue.py --mib 256 --log <new> -- python3 -B -u .../run-integration.py --recover <id>`.
- **Manifest changes** if any pinned file changes: rerun `--plan`.

## Resource budget
| part | cap |
|---|---|
| the queue job: runner, seed `go test` compile (GOMEMLIMIT 400MiB), indexd (GOMEMLIMIT 320MiB, one at a time), controller, client, checks | 768 MiB (cgroup MemoryMax; the runner refuses a larger scope) |
| the PostgreSQL container (dockerd, outside the queue) | 256 MiB `--memory/--memory-swap`; during X3/X4 one extra sleeping backend, plus one scratch copy of the small fixture database |
| **total** | **1024 MiB** |

Time bounds: pre ≤ 300 s, the 8 stages ≤ 3600 s, post ≤ 1800 s (child timeouts). X3 takes about 21 s, X4 about 6 s
plus up to 30 s of harness wait, and X5–X7 about 20–60 s each.

## Finding for root (r5 rev2 controller; NOT changed here, because the controller under test is pinned)
`QueryBudget` is created BEFORE the restore, so the restore's own time is charged against `verify_query_seconds`. The
rev2 docstring says "bounds every verification query and sleep EXCEPT the restore".

Consequence: with defaults (restore bound 3600 s, query budget 600 s), any restore longer than about 600 s makes the
digest step raise `TimeoutError`. The verification then fails, with the scratch PRESERVED and no switch. That is safe,
but it refuses an upgrade whose backup is valid.

- **Production:** the database is about 30 MB, so restores take seconds; this is not hit.
- **This run:** the checks hold either way (X4 asserts KEPT within 20 s, true with or without restore time counted).
- **Minimal fix** for a later revision: start the budget after the restore, or pause it during the restore.

## Local evidence (this package)
| log | what | result |
|---|---|---|
| logs/static1.out (256) | test/test_static.py, 9 tests: reference = frozen runner; delta limited; exact pins + frozen/r5 SHA256SUMS; `--plan` no side effects + wrong manifest refused; checks order X1-X8; no container lifecycle/IF EXISTS/0.0.0.0/--network; the only DROP DATABASE is the validated, recorded X4 leftover; own triggers in template1 removed in finally/finalize; strict assertion values | 9/9 OK |
| logs/plan1.out (256) | `--plan` | exit 0, no mismatches, fence tree 218 files, manifest a300b94a…, nothing created |
