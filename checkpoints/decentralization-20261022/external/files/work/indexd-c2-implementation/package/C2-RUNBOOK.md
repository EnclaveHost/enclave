# G-C2 runbook addendum (indexd v0.6.0-fence.2-c2, db_version 28) — NOT ACTIVATED

This addendum extends `work/indexd-replica-rollout/ROLLOUT.md`. That package is unchanged; this one is a separate
copy (`work/indexd-c2-implementation/package`). Protocol: `work/indexd-c2-implementation-interface.txt` (DRAFT v4.0 +
R1 + R2), chosen by root as the canonical wire. Nothing here activates anything. Root owns activation.

## 1. What changes
- **Application API.** Changes are additive and backward-compatible:
  - a v4 request form (`op` [+ `sq`]);
  - 412 C2 refusals;
  - `"mode":"cas"` on POST /fence;
  - extra GET /fence fields: `lastOp`, `lastOpDigest`, `mode`, `capabilities` = `["fence-v3","cas-v4","op-nonce"]`;
  - R2: a fresh, never-stored `opNonce` in every GET /fence answer, sent with `Cache-Control: no-store`. A writer
    takes a new invocation's op id from it, so cloned writers with copied RNG still send distinct operations.
- **Unchanged:**
  - unfenced accounts behave as stock 0.6.0;
  - fenced accounts that never enrol keep the R5 v3 behaviour;
  - the admin API is byte-identical (U1-B block/unblock, all platform administration);
  - no contract or ledger change; ledger16d support is unchanged.
- **Schema:** db_version 27 -> 28, additive (`migration/up-27-to-28.sql`, an audit copy; the binary applies it itself in
  one transaction): `accounts.last_op`, `accounts.last_op_digest`, `accounts.cas_mode` (+2 CHECK constraints).

## 2. Preconditions (in addition to ROLLOUT.md G1-G8)
- **C1.** The fence release (v27) is live on every indexer the account uses (ROLLOUT.md P1/P2).
- **C2.** EVERY indexer an SDK account uses runs the G-C2 binary BEFORE that account enrols. The SDK checks
  `capabilities` contains `cas-v4` on each endpoint and fails closed otherwise. The operator never enrols an account:
  the SDK writer does, with POST /fence `{"fence", "mode":"cas"}`.
- **C3.** The real SDK candidate (two-phase/majority) has passed real-indexd integration against this binary. That run
  is the SDK worker's gate and is recorded in `work/claude-indexd-c2-implementation-result.txt`.
- **C5.** PostgreSQL is durable before the answer: `fsync=on`, and `synchronous_commit` is on, local or remote_apply
  (`upgrade-c2` refuses otherwise). indexd sets neither, and the units set neither (checked), so PostgreSQL's
  defaults apply. Indexers are crash-fault, not Byzantine: a restored-from-old-backup or rolled-back database is a
  fork for the SDK, which it never tolerates.
- **C4.** A production-seed rehearsal of this upgrade (the G5 procedure, with root's fresh quiesced backup) is done
  once the protocol is final. It has NOT been run for C2: by instruction, the expensive real-production-copy
  rehearsal waits for the final protocol.

## 3. Upgrade (per indexer; v27 -> v28)
```
replicactl.py --profile P install release/indexd-v0.6.0-fence.2-c2-linux-amd64 --sha256 <SHA256SUMS> --confirm install
replicactl.py --profile P upgrade-c2 --sha256 <same> --confirm upgrade-c2
```
- `upgrade-c2` does: stop -> quiesced backup (must be v27) -> verify -> switch -> start (the migration runs in one
  transaction) -> ready at v28.
- It succeeds only if the acknowledged-metadata digest (`migration/digest.sql`) is unchanged.
- No account is enrolled by the upgrade. v3 writers continue unchanged (fixture stage 3).
- Verify config and seed before the first start: the migration runs before the wallet-seed check (G5 finding).

## 4. Rollback (per indexer; v28 -> v27)
```
replicactl.py --profile P rollback-c2 --fence-sha256 61413110... --confirm rollback-c2 --cas-writers-stopped \
    [--acknowledge-cas-downgrade]
```
- **Without the acknowledgement:** `down-28-to-27.sql` REFUSES while any account is enrolled. The controller then
  restarts the unchanged G-C2 release. Nothing is dropped (fixture stage 6).
- **With it:**
  - the C2 columns are dropped; db_version is 27; the digest is preserved;
  - the schema is IDENTICAL to the pre-upgrade v27 schema (fixture stage 7);
  - consequence: enrolled accounts lose CAS protection, so a v3 request with the exact credential is accepted again.
    That is why every writer of every enrolled account must be stopped first.
- A rolled-back indexer reports `mode: null` and no `cas-v4`. An enrolled SDK treats that as a fork and fails closed;
  it never silently downgrades.
- Re-upgrading does not resurrect an enrolment. The writer must re-enrol with a higher fence (fixture stage 8).
- There is NO online downgrade (root decision): a writer's app key cannot clear `cas_mode`.

## 5. Failure behaviour (tested)
- **indexd SIGKILL:** enrolment, head, lastOp and digest are durable. An identical replay of the last operation still
  answers `replayed` (fixture stage 5; Go store/HTTP tests).
- **Concurrent writers at the same head:** exactly one wins; the others get 412 seq (Go tests).
- **Two identical copies:** one applies, the other gets `replayed`.
- **A refusal after the CAS check** (451 blocked, 400 unpinned slab, 404): the transaction rolls back. The head and the
  operation record are unchanged.

## 5b. Fixture verification (fixture/run-c2-fixture.sh; results fixture/c2-fixture-results.json, 8/8 PASS)
Binaries: release 61413110... (v27) and G-C2 e6e812fd... (v28). The database is seeded at v27 through the release
store code. Stages:
1. v3 writer under the release: backfill head 12; stock writes refused 409; no G-C2 fields.
2. Quiesced backup + restore-verify.
3. `upgrade-c2`: v28, digest preserved, capabilities listed, NOT enrolled; the v3 writer continues.
4. Enrolment and CAS (op from opNonce): identical replay -> replayed; altered -> 412 op; stale -> 412 seq;
   v3 -> 412 mode; stock -> 409; plain raise -> 412 mode.
5. indexd SIGKILL: mode, head and lastOp are durable, and the replay still settles.
6. `rollback-c2` without the acknowledgement: refused, nothing dropped, the G-C2 release serves again.
7. Acknowledged rollback: v27, digest preserved, schema IDENTICAL to the pre-upgrade v27 backup's schema, every
   object readable, v3 accepted again (the named consequence).
8. Re-upgrade: not re-enrolled; re-enrolment works.

The disposable container, volume, secrets and node were removed afterwards.

## 6. Not covered here (remaining gates)
- G1 capacity is NOT met (ROLLOUT.md R2.1: 0 of 4 providers fit).
- G8: front/generation binding is not provided by C2 and stays open. C2 binds the storage semantics only; it adds no
  confidentiality and no physical-singleton proof, and it does not cover Byzantine indexers.
- Production-seed rehearsal of 27 -> 28 -> 27 (C4).
- The real SDK C2 candidate integration (C3), if not yet recorded as passed.
