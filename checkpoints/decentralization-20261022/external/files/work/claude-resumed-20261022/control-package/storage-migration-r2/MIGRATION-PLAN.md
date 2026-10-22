# Live indexd v0.6.0-enclave2 -> G-C2: data-preserving staged migration and rollback (source-level; NOTHING executed)

r2 copy of storage-migration/MIGRATION-PLAN.md (r1 73c2afcc, unchanged in place). Only Phase B1 changes (the bounded, fail-closed r2
preflight that repairs root review R1/R2). The Phase C wording is clarified. Sections 1, 2, 3A, 3D and 4 are unchanged, and so are the
source overlays: storage-migration/source-candidate/ stays as it is.

storage-closeout is frozen unchanged (its RESULT file hashes re-verified). This scope adds no host role and claims no
replica. Root owns every production step.

## 1. Exact versions and fields (from local source and root's own receipts; nothing inferred)

| item | live (as of root's 2026-10-19T15:27Z quiesced snapshot) | fence release | G-C2 (rc2 host-role package) |
|---|---|---|---|
| binary | 2d7a637e… "v0.6.0-enclave2" = v0.6.0 ddaf24b + enclave-small.patch 503e6fc9 (README "On nan", retirement snapshot "minipc / enclave-storage") | 61413110… v0.6.0-fence.1 | e6e812fd… v0.6.0-fence.2-c2 |
| db_version | 26 (25 migrations) | 27 (+1, additive) | 28 (+1, additive) |
| schema sha (rehearsal method) | 27d75078… (snapshot AND the 2026-10-20 live dump) | — | — |
| migration 27 | — | fence source | byte-identical function in the C2 source (checked) |
| `minContractGrowthRate` | **8 GiB** | 256 GiB | 256 GiB |
| `serviceAccountFundTargetBytes` | **1 GiB** | 16 GiB | 16 GiB |
| app API server timeouts | **5 min read/write + IdleTimeout 5 min** | 30 s, no IdleTimeout | 30 s, no IdleTimeout |
| config format (`config/`) | stock | stock (no diff) | stock (no diff) |
| seed binding | `global_settings.wallet_hash`; a different seed is refused | same | same |

**INCOMPATIBILITY (blocking for the live primary): the fence and G-C2 builds do NOT carry enclave-small.patch.**
- Upgrading with `61413110` or `e6e812fd` would revert two production fixes:
  - the 2026-10-16 "http: i/o: early eof" PUT failures (30 s write timeout);
  - contract sizing. Stock sizing "locked ~1,277 SC into a single contract, about 500x our needs"
    (`sia-readback/indexd/README.md`). That is an unauthorized-spend risk.
- No combined build exists locally.
- Repair, prepared (source only, no build): `source-candidate/`. It holds the same patch on both tested trees:
  - the fence tree, as `v0.6.0-fence.1-enclave`;
  - the G-C2 tree, as `v0.6.0-fence.2-c2-enclave`.
  - The three patched files are stock in BOTH tested trees, so the patch applies with zero fuzz.
  - Each assembled tree differs from its tested source in exactly 4 files (verify-assemble-2.out).
  - Patched-file shas: run.go d0973435…, form.go 998951c5…, funding.go 2f694085…; meta.go fence 2f1580ac…, c2 d24498dc….

## 2. What already proves data preservation (prior evidence, kept; not re-run)

- G5 and C2 rehearsals on disposable copies of the real snapshot and the live dump, isolated and offline:
  26->27->28->27->26.
  - Acknowledged-metadata digests are identical at every stage.
  - The schema after the full rollback is identical to the restored production schema.
  - Production accounts are never enrolled or fenced by a migration.
  - An enrolled account blocks the 28->27 rollback until it is explicitly acknowledged.
  - Admin block/unblock is preserved throughout.
  - Results: `work/claude-indexd-production-rehearsal-result.txt` and `work/claude-c2-production-rehearsal-result.txt`
    (run2 33eabe10…).
- Limits, unchanged:
  - The production SEED was never used (fixture seed, wallet_hash NULL on copies), so wallet identity, contracts and
    chain sync were not the production runtime.
  - The inputs were not a fresh quiesced coupled cutover backup.
  - The rehearsed binaries lacked enclave-small (section 1).
- Why the data CANNOT move into a new host-role replica:
  - indexd binds the database to the wallet seed;
  - copying the database or phrase would make two indexers revise the same contracts (ROLLOUT.md section 2).
  - So the live database, seed and contracts are preserved ONLY by upgrading the live indexer IN PLACE.
  - New replicas always start empty, with their own seed, and are backfilled by sia-s3 membership.

## 3. Staged plan

Phase A (software; independent of hosts, ingress and funding; root or a root-authorized Go worker):
- A1 `source-candidate/assemble-trees.sh <dir>`, then build both trees with `release/build.sh` through the queue at
  1024 MiB, twice each from empty Go caches. Record the shas; they don't exist yet and are not invented.
- A2 For both builds:
  - `go test ./contracts/... ./cmd/...`;
  - the C2 fixture (`package/fixture/run-c2-fixture.sh`, 8 stages);
  - the SDK `real_indexd`/`real_fence` regressions.
- A3 Re-run `work/indexd-c2-production-rehearsal/rehearse-c2.py` with the two NEW pins, on root's EXISTING captures
  (or on the fresh backup from B2).

Phase B (root, read-only, then one root-owned quiesced backup):
- B1 (read-only; root's routine authority, after root review of r2; no user approval, wallet, spend or hardware needed).
  - Run `bash preflight/vm-preflight.sh > pf.out` AS ROOT on the VM. Optionally wrap it as `timeout -k 10 330`; the script's own budget
    is 300 s.
  - Evaluate locally with `python3 preflight/evaluate-preflight.py pf.out`.
  - The full-data digest is NOT part of B1. `preflight/vm-digest-optin.sh` is a separate, explicit, size-capped opt-in that B1 does not
    need, because the controller digests the quiesced database itself during upgrade.
  - READY_FOR_FRESH_BACKUP requires every one of these facts to have been read successfully, with valid canonical values:
    - binary 2d7a637e; db 26; schema 27d75078 (from a complete pg_dump only);
    - fsync on; synchronous_commit on|local|remote_apply;
    - indexd.yml present without group/other bits (else replicactl refuses);
    - consensus.db present;
    - PostgreSQL image 74935e72; /fence 404;
    - disk >= 4x(state+db)+1 GiB;
    - the session proves read-only/5 s/1 s.
  - The other verdicts:
    - UNKNOWN: any failed, timed-out, skipped, malformed or duplicate fact. Re-run, or inspect the reported `.status`/`.err`.
    - BLOCKED: a definite mismatch.
    - REVIEW_REQUIRED: a table count below the 2026-10-20 dump. This is drift, which maintenance can cause; it is not proof of loss.
      Root reviews it, and B2 re-baselines.
- B2 A fresh quiesced COUPLED backup: database + consensus.db + binary + config, in the existing encrypted off-host
  pattern (`storage-vm/backup-encrypt.py`, `replicate-backup.py`). The earlier pauses were 1-2 s.
  - Then `indexd-c2-production-rehearsal/preflight-fresh-backup.sh <dir>`, and a rehearsal on THAT backup (A3).

Phase C (root-owned production; brief stop/start per step; still ONE indexer). B2 and Phase C are NOT authorized now (user, 2026-10-22 UTC).
They run when the user/root schedules the live backup/upgrade. That is the user's stated hold, not a new permission requirement.
Genuine prerequisites: Phase A build/test results, a READY (or root-reviewed REVIEW_REQUIRED) B1, and B2.
No wallet key or new spend is needed for B1-C, and no new hardware if the B1 disk check passes. The in-place upgrade keeps the live seed, contracts and enclave-small sizing.
1. Install the CURRENT live binary as a release, without changing it:
   `install /opt/enclave-indexd/indexd --sha256 2d7a637e…`.
   - Then point `ln -sfn <2d7a…sha> /opt/enclave-indexd/releases/current`.
   - Then the drop-in `indexd-replica-rollout/systemd/primary-upgrade.conf` as
     `enclave-indexd.service.d/20-fence-release.conf`, and `daemon-reload`, NO restart.
   - A crash restart now runs the same bytes.
2. Place `controller-profile/migration/*` at /opt/enclave-indexd/migration and the profile (ROOT_DECIDES fields
   filled by root). `replicactl preflight` must pass.
3. `install` the fence-enclave build. `upgrade --sha256 <fence-enclave>` does stop, backup, verify, switch, start,
   then checks v27 with an identical digest.
4. `install` the c2-enclave build. `upgrade-c2 --sha256 <c2-enclave>` does stop, backup (v27), the durability check,
   switch, start, then checks v28 with an identical digest.
   - No account is enrolled. The unfenced sia-s3 and adapter are unchanged; there is no repoint.
- Rollback:
  - `rollback-c2 --fence-sha256 <fence-enclave> --cas-writers-stopped`; it refuses while any account is enrolled, and
    nothing is enrolled in Phase C;
  - then `rollback --stock-sha256 2d7a637e… --fenced-writers-stopped` (down-27-to-26.sql) back to the original binary;
  - schema identical (rehearsed).
  - Last resort: restore B2 with the SAME seed on the same VM.

Phase D (BLOCKED on prerequisites that stay explicit; storage-closeout RESULT): N >= 3 replicas on distinct failure
domains, non-DigitalOcean ingress, Sia funding, the operator descriptor signature, the C2 sia-s3 publish/redeploy and
app-key registration. Then the REPLICATION.md 1->3 procedure:
- the upgraded primary runs one maintenance pass (`record.admitted`, epoch 1);
- the new members are backfilled;
- epoch 2 commits.

The rc2 host-role package carries `e6e812fd` (stock sizing). New replicas need an rc3 package with the c2-enclave
build, for the same spend reason.

## 4. Still unproven (honest)

- The production runtime with the production seed: wallet, contracts and chain, under upgraded code.
- The enclave variants: built, tested, rehearsed. Phase A has not been executed.
- Live state since 2026-10-19/20: B1 has not been run.
