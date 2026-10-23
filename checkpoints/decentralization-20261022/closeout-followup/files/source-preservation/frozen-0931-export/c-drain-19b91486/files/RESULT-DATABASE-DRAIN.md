# PostgreSQL drain before the rollback decision (RESULT-DATABASE-DRAIN, 2026-10-23)

**Status.** Source and fixture evidence only.
- Nothing ran live: no production step, no SSH, no SQL on the live database, no wallet, no push.
- Nothing is deployed or staged on the VM.
- Root owns activation. D exports the immutable candidate.
- fbaecfce and 5a3ee31 are unchanged; this is appended, with no history rewritten.

**Commit.** Repository `storage-write-release/`, branch `storage/write-release`:
- `6fd7a929` → `bbf0a00` → `fbaecfce` → `5a3ee31` → **`5293405969d510571897f2bd5b53c2806c6123b8`**.
- Author and committer: SteveDeFacto.
- Patch: `database-drain.patch` (`git format-patch -1 5293405`), sha256
  `285188464e108c0770627ba63fcb81b45e653f919a0583c470c66bd4fd1a5d34`.
- 45 paths changed.
- Scans on every staged file: `scan-crypto-keys.py` exit 0; gitleaks no leaks (`logs/gitleaks-dd.json` = `[]`).
- Root's `ROOT-*.txt` notes are not committed.

| file | sha256 |
|---|---|
| `package/primary/db-barrier.sh` (new; pinned as `primary.db-barrier`) | `70cfef1fd28d3555e6340af13e1d1630e08d4474d48b1efaebd0037024a037bc` |
| `package/tools/cutover.py` | `fb4fcbb2c01fbf7b023ffa48eae92e563a65f6b03abc8b229c2ccb044b7f8e6f` |
| `package/tests/test_cutover.py` | `3e6918d4c953053a2b0870336b8dc94c1e717c48a8833580ed1d1a7bdf69ccf6` |
| `package/CUTOVER.md` | `1c831ee0…` (§1 item 9, §4 R3-R5, the R4 note, the stop guarantees, the decision table) |
| `package/PINS.json` | `a0e158ef…` (22 pins) |
| `rehearsal/dbdrain.py` / `rehearsal/dbdrain.sh` | `d04654297c59da35…` / `dadbb97e…` |

Each of these is byte-identical to what fixture run d3 and the queued unit run executed: d3 printed the hashes of its
inputs at start.

## 1. The defect (root's review of fbaecfce; counterexample `555dc752`)

- `rollback_decision` (fbaecfce) accepted, as the barrier:
  - a unit that was `inactive` OR `failed`, with `MainPID=0`;
  - no indexd process;
  - no controller/tool session.
- It never looked at indexd's own database sessions.
- A PostgreSQL backend whose client is gone finishes the statement it is running. That includes a `COMMIT` the client
  already sent.
- So zero counts read in that window are followed by CAS=1, and the decision said LEGACY_REDEPLOY_SAFE.
- Root showed this with an actual SQL primitive and a synthetic snapshot. Fixture d3 D1 (§4) reproduces it with the actual
  indexd 2c0e5b06, the actual controller 1543577f and the actual `vm-state.v2.sh`.

## 2. Stop guarantees (exact source; the fixture observation)

Sources:
- indexd: `c2-enclave` `cmd/indexd/run.go` 377-404 and `main.go` 279;
- `persist/postgres/store.go` (`transaction`/`doTransaction`, `Close`) and `fence.go` (`RaiseFence`);
- pgx v5.11.0;
- the unit `storage-vm/enclave-indexd.service` (`cb96c3be…`): no `KillMode`, so control-group; `TimeoutStopSec=180`;
  `Restart=on-failure`; `MemoryMax=1G`; `ConditionPathExists=…/ALLOW_LIVE_START`;
- controller 1543577f: `stop` = `systemctl stop` (systemd runner), or SIGTERM then wait (process runner);
  `crash-indexd` = SIGKILL.

`RaiseFence` makes two transactions, each through `doTransaction`, which uses `context.Background()` and so is never
cancelled. The enrolment, the second one, takes `SELECT … FOR UPDATE` on the account row. One `UPDATE` then sets the fence,
the receipt and `cas_mode`, and the transaction commits. Nothing of it is visible before that COMMIT: d3 D1 read 0 fenced
and 0 CAS while it was pending.

| stop | process (source) | guarantee for the database | fixture d3 |
|---|---|---|---|
| one SIGTERM (controller `stop` = `systemctl stop`), within 180 s | The root ctx is cancelled. `http.Server.Shutdown` waits for active handlers; the handler's transaction cannot be cancelled. The deferred `store.Close()` → `pgxpool.Close()` blocks until every connection is released, then closes them. Exit 0. | When THIS path runs to exit 0, every pool transaction has ended. **An exit 0 does not show that this path ran**, so it is reported (`seen.stopKind`) and never used. | **D2:** the COMMIT was pending (deferred check held it 8 s). The controller's `stop` returned after 8.1 s, exit 0, with 1/1/1 committed and no indexd backend left. The client got its 200. The barrier then: lock wait 0 ms, FORWARD_ONLY. |
| a second SIGTERM during Shutdown (run.go allows it; systemd and the controller do not send one) | `Shutdown` returns ("graceful shutdown was interrupted"). Then the same deferred closes run, including `pgxpool.Close()`. | Not relied on. | **D3:** exit 0 after 8.0 s, AFTER the commit (1/1/1, no pending COMMIT at exit). The interruption was logged, and the client lost its answer (rc 1): an enrolment that committed while its client saw an error. |
| SIGKILL: `TimeoutStopSec` exceeded, an OOM kill at `MemoryMax`, the controller's `crash-indexd`, or a crash | Nothing runs. The unit is `failed`, `MainPID=0`. `Restart=on-failure` is held off only by the absent guard. | **None.** A COMMIT already sent commits after the process is gone. | **D1:** see §4. |

## 3. The fix

### R4: `package/primary/db-barrier.sh`: a bounded database barrier, NOT read-only

Root runs `$VMSSH 'sudo bash -s' < db-barrier.sh` AFTER R1-R3. It prints, in one output:
1. `barrierScript=db-barrier.v1`;
2. `pre.*`: the unit (ActiveState, SubState, MainPID, Result, ExecMainCode, ExecMainStatus, InvocationID, NRestarts),
   `writerPids`, `allowLiveStart`;
3. `db.*`, from ONE transaction in the `indexd` database as the container's PostgreSQL superuser
   (`application_name=root-barrier`):

   ```sql
   BEGIN ISOLATION LEVEL READ COMMITTED;
   LOCK TABLE accounts IN EXCLUSIVE MODE;            -- waits for every transaction that holds/changed an accounts row
   SELECT 'lock=granted'; SELECT 'lockWaitMs=' …;
   SELECT 'otherBackends=' … FROM pg_stat_activity   -- client backends of this database other than itself (listed)
   SELECT 'preparedXacts=' … FROM pg_prepared_xacts;
   SELECT 'dbVersion=' …; SELECT 'fencedAccounts=' …; SELECT 'casEnrolledAccounts=' …;
   SELECT 'barrier=complete';
   ROLLBACK;
   ```
4. `db.exit`, then `post.*` (the same process lines as `pre.*`).

**Mutation versus read-only.** The barrier writes no row and changes no setting. But:
- `EXCLUSIVE` conflicts with every `ROW SHARE` and `ROW EXCLUSIVE`, so while it waits or holds the lock, every write and
  every `FOR UPDATE` on `accounts` waits; plain reads continue.
- PostgreSQL refuses this lock mode in a read-only transaction.

So it is labelled NOT read-only everywhere: the script header, CUTOVER §4, PINS (`access`), and the test asserts the label.
`vm-state.v2.sh` stays read-only and is no longer R4.

**Why this order and this lock.**
- `ROW SHARE` is taken by `SELECT … FOR UPDATE`, the enrolment transaction's first statement. A weaker `SHARE` lock would
  not wait for an enrolment that has locked the row but not yet updated it.
- READ COMMITTED gives each later statement a snapshot taken after the lock was granted.
- PostgreSQL releases a transaction's locks only after its commit is visible.
- Then, with the lock held:
  - the session check (`pg_stat_activity` is snapshotted once per transaction, at this first read);
  - the prepared-transaction check;
  - and only then the counts.
- Root's point is met: backend counts are checked BEFORE the enrolment is read, never after.
- The session check covers EVERY client backend of the database, not only controller/tool application names.

**Serialization assumptions** (stated in the script, CUTOVER §4 and the decision's `notEstablished`):
- every enrolment is written by a client session of the indexd database;
- a backend whose client is gone can complete only the statement it is running;
- one operator during R4-R5.

Under these assumptions: once the lock is granted and there is no other session and no prepared transaction, no
transaction exists that could still commit. A later one needs a new session, and the process barrier (the guard absent,
the same unit invocation before and after) excludes that.

**Bounds.**
- Session-local `PGOPTIONS`:
  - `lock_timeout` 30 s;
  - `statement_timeout` 35 s;
  - `transaction_timeout` 60 s;
  - `idle_in_transaction_session_timeout` 10 s;
  - `client_connection_check_interval` 1 s.
- psql is `timeout --foreground -s KILL 75` inside the container, and the whole `docker exec` has `timeout 90`.
- No sleep, timestamp or checkbox is evidence. `lockWaitMs` is reported only.

**Failure outcomes** (all UNKNOWN, all observed in d3):
- **Lock timeout** (`db.message` "canceling statement due to lock timeout", no `db.lock`): F2.
- **Another session** (`db.otherBackends` > 0, listed): F1.
- **Interrupted, no `barrier=complete`:** F3. The killed barrier's own backend ended at its 30 s `lock_timeout`, not at
  the 1 s connection check, which did not end a lock wait.
- **pre ≠ post, or the guard present:** unit tests.

The barrier never ends another session. F1-F3 check that the other sessions survive, still holding their locks.

### `tools/cutover.py rollback_decision`

| decision | when |
|---|---|
| `FORWARD_ONLY` | any fenced or CAS account in ANY readable snapshot (vm-state or barrier, complete or not): enrolment is sticky |
| `LEGACY_REDEPLOY_SAFE` | a db-barrier.v1 output with **all** of the following, plus `--c2-activation-disabled` (the owner's R1): `pre`/`post` guard absent, unit inactive or failed with `MainPID=0`, no indexd process, `InvocationID` and `NRestarts` unchanged; `db.lock=granted`; `db.otherBackends=0`; `db.preparedXacts=0`; schema 28 with 0/0 read under the lock; `db.barrier=complete`; `db.exit=0` |
| `UNKNOWN` | everything else. That includes **any vm-state.v2.sh output** (`missing: ["databaseBarrier"]`), a `failed` unit or an exit 0 without the database barrier, an `activating` unit (an auto-restart is pending), and an unreadable state. |

- `seen` reports `stopKind` (`exited-0` / `abnormal` / `unknown`), `lockWaitMs`, the other sessions and the database
  message. None of them is used as proof.
- After a KILL, a `failed` unit is accepted only TOGETHER with the database barrier. It proves only that no NEW request
  can arrive.

### `CUTOVER.md` §4 (the runbook)

- R3 no longer claims that the stop drains anything. Root also waits until the unit is `inactive` or `failed`, not
  `activating`.
- R4 is db-barrier.sh, with its NOT-read-only note, its outcome table and its serialization assumptions.
- The stop-guarantee table is §2 here.
- §1 item 9 records the blocker.
- The original operator, C2-respawn and start-guard conditions are unchanged: R1 owner, R2 guard aside, R3 controller
  stop, the decision last.

## 4. Tests (all through `claude-test-queue.py`)

| run | what | lane / peak | result |
|---|---|---|---|
| **d3** `rehearsal/dbdrain.py` (see the next table for the setup and every scenario) | the actual indexd and controller on a private PostgreSQL 18.6, with the actual scripts | 768 / **314 MiB**, 98 s | **27/27 PASS**, queue EXIT 0, cleanup complete (PostgreSQL exited, no indexd, data/socket/secrets removed) |
| d2 (kept as `runs/d2-failed`, RETIRED) | the same; 26 passed | 768 / 319 MiB | FAILED 26/1, NOT counted. A driver expectation: it expected the fence visible before the COMMIT (`1/0/1`). One transaction writes both, and `0/0/1` was observed, which is correct. |
| d1 (kept as `runs/d1-failed`, RETIRED) | stopped at F2 | 768 / 242 MiB | FAILED, NOT counted: the fixture holder used `FOR UPDATE` with `count(*)`, which PostgreSQL rejects |
| unit `package/tests/test_cutover.py` (22) + `backup/test/test_backup_provenance.py` (3) | **New tests:** root's exact synthetic state, where fbaecfce says SAFE and the new decision says UNKNOWN (`databaseBarrier`); SAFE only from the complete barrier with the attestation; every barrier element required (20 variants); a failed unit or an exit 0 never the proof; enrolment FORWARD_ONLY even with a broken barrier; unreadable is UNKNOWN; the script's SQL order, single `BEGIN` + `ROLLBACK`, no COMMIT/terminate/ALTER/INSERT/UPDATE/DELETE, every bound, the NOT-read-only label, `pre` before and `post` last. **Real d3 captures** (`tests/fixtures/d3-*.txt`): the D1 negative control and the D1 barrier; N; F1-F3; B/D2/D3. | 512 / 71 MiB | **25/25 OK**, queue EXIT 0 |

**d3 setup** (`rehearsal/dbdrain.py`):
- the actual indexd 2c0e5b06, offline, on a private PostgreSQL 18.6 with server defaults: `client_connection_check_interval=0`,
  `lock_timeout=0`, `max_prepared_transactions=0`, fsync and `synchronous_commit` on;
- the indexd role is not a superuser;
- the actual controller 1543577f (`start`/`stop`/`crash-indexd`, process runner);
- the c2rclient `e76693f6` `register`/`raise-cas` (the enrolment POST C2 makes);
- the actual `db-barrier.sh` and `vm-state.v2.sh`, each run as a copy that differs only in the guard path (checked).

**d3 scenarios:**
- **N (never enrolled):** stop exit 0.
  - F1: an idle session → UNKNOWN; the session survives.
  - F2: a holder of accounts rows → the lock times out after 30.1 s → UNKNOWN; the holder still holds its lock.
  - F3: the barrier KILLed in its lock wait → UNKNOWN; its backend gone after 30.0 s; the holder untouched.
  - Cleanup: no lock on accounts remains.
  - vm-state alone: fbaecfce says SAFE, the new decision UNKNOWN.
  - The barrier: lock granted, 0 sessions, 0 prepared, 0/0 → UNKNOWN without the attestation, **LEGACY_REDEPLOY_SAFE** with it.
- **B:** enrolled while running, then stop → FORWARD_ONLY.
- **D1:**
  - the COMMIT is pending (a deferred check holds it 15 s);
  - `crash-indexd` (SIGKILL): unit failed, `MainPID 0`, no process;
  - counts `0/0/1` with one pending backend running `commit`;
  - the **actual `vm-state.v2.sh`** in that window → **fbaecfce LEGACY_REDEPLOY_SAFE** (and 6fd7a929 too); the new
    decision UNKNOWN;
  - the barrier started 0.3 s after the kill and **waited 14,439 ms** for the lock, then read `1/1` → **FORWARD_ONLY**;
  - finally `1/1/1`.
- **D2 / D3:** §2.

**What the fixture mutates** (FIXTURE ONLY, the private cluster): roles, databases and, in D1-D3, a `DEFERRABLE INITIALLY
DEFERRED` constraint trigger. The trigger holds the COMMIT of the transaction that flips `cas_mode`, which deterministically
opens the window root's probe opened with `pg_sleep`. indexd's SQL is unchanged.

**What the fixture derives.** The unit lines come from the fixture's `systemctl` shim. It reads them from the ACTUAL indexd
process: running, or its reaped exit status, mapped to systemd's `ActiveState`/`Result`/`ExecMainCode`/`ExecMainStatus`.
systemd itself, the 180 s timeout and `Restart=on-failure` were not run.

## 5. Root commands (bounded; NOT executed here)

On the live VM, only after R1, the owner's attestation that C2 activation and its retries are disabled and that no C2
instance remains:

```sh
# R2 - start guard aside
$VMSSH 'sudo mv /etc/enclave-indexd/ALLOW_LIVE_START /etc/enclave-indexd/ALLOW_LIVE_START.held-<run>'
# R3 - the reviewed controller 1543577f (systemctl stop: SIGTERM, at most TimeoutStopSec=180 then SIGKILL)
$VMSSH 'sudo python3 <replicactl 1543577f> --profile <live profile> stop'
$VMSSH 'systemctl show enclave-indexd -p ActiveState -p MainPID -p KillMode -p TimeoutStopUSec -p Restart'   # inactive|failed and 0, NOT activating; confirms the live stop settings
# R4 - NOT READ-ONLY: one transaction, LOCK TABLE accounts IN EXCLUSIVE MODE <= 30 s, no row written, ROLLBACK; <= 90 s
sha256sum package/primary/db-barrier.sh                                # 70cfef1fd28d3555e6340af13e1d1630e08d4474d48b1efaebd0037024a037bc
$VMSSH 'sudo bash -s' < package/primary/db-barrier.sh > r4-barrier.txt
# R5 - offline
python3 package/tools/cutover.py rollback-decision --vm-state r4-barrier.txt --c2-activation-disabled
```

- **UNKNOWN:** follow `missing` and CUTOVER §4. Re-run R4 after a lock timeout or another session; never end a session
  to get through. If the barrier cannot be established, repair forward (C2).
- **LEGACY_REDEPLOY_SAFE:** keep C2 disabled; restore the guard; `replicactl … start`; owner runs 0.1.8; post-check with
  the read-only `vm-state.v2.sh`.
- **FORWARD_ONLY:** keep C2.
- No forced unenrolment, no restore after writes, admin rights untouched.

## 6. The 0.1.8 download panic (separate; recorded, not diagnosed further)

- **Observed once** (r1): the live 0.1.8 panicked with `sia_storage download.rs:336` "index out of bounds: the len is 27
  but the index is 28".
- **The source line, by reading:** in `recover_shards`, line 287 creates
  `let mut shards = vec![None; self.state.sectors.len()];`. Line 336 then indexes it with the shard's original slab index,
  `shards[task.shard_index] = Some(Vec::from(data));`. When fewer sectors remain in `state.sectors` than the slab has
  shards, that index is out of bounds.
- **Not established:** what trigger made the list shorter after the indexer restart.
- **Where that code is:** every vendored copy of `sia-sdk-rs/sia_storage/src/download.rs` in the workspace is identical
  (sha256 `aa8b415a4849c637110a892883db71e410c3ca11f0477f3cbda55e16e24d03d9`), including
  `storage-c2-implementation/sia-s3`.
- **Not established for C2:** whether the C2 artifact 00e9cde0 was built from that exact file. The same line therefore
  probably exists in C2. This gate ran no C2 download, and no C2 panic was observed.
- **Before relying on a rollback,** root's "check candidate C2 impact" stays open. Nothing was redesigned.

## 7. Limits

- **Fixture only.**
  - The barrier and decision were exercised against the actual indexd, controller and scripts, but on a private cluster,
    through shims and a derived unit.
  - systemd's real `TimeoutStopSec` SIGKILL, OOM and `Restart=on-failure` were not run. They are SIGKILL-equivalent and
    covered by D1.
  - The live VM, its container and its data were never touched.
- **The unit facts come from the workspace copy** `storage-vm/enclave-indexd.service`. The live unit's ExecStart is
  `releases/current/indexd`. R3's `systemctl show` line confirms the live `KillMode`, `TimeoutStopUSec` and `Restart`. The
  barrier does not depend on them.
- **R4 blocks writes to `accounts` for up to 30 s.** Root runs it only with indexd stopped (R3), so no service write waits
  on it.
- **The serialization assumptions are not checkable by the parser:** one operator, writers only via the indexd database,
  dead-client backends finish only their current statement. The owner's R1 attestation is still required: node state is
  not visible from the VM.
- **T1 (forward) is unchanged.** Its quiescence remains the owner's attestation plus root's necessary-only count check.
  This gate does not address writes that 0.1.8 already sent to the RUNNING indexd before the T1.2 backup.
- **Ownership.** D exports the candidate and evidence; root owns activation.
