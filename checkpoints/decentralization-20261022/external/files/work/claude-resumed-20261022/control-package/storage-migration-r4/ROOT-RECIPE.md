# Root recipe r4 (ROOT ONLY; nothing here was run on the VM by its author)

r4 = r3 plus the review-access fixes G1-G3, nothing else:
- the controller refuses a POSIX access ACL on indexd.yml, and lstats every path component;
- the preflight and evaluator read and judge exactly the same two facts: `config.acl` and `config.path_components`.

Kept unchanged:
- r1, r2 and r3 (r3 `PINS.sha256` still verifies), the profile (byte-identical to r3) and `vm-digest-optin.sh` (byte-identical to r3);
- the database code paths, so the Postgres suites were not re-run.

## Where things stand

| | State | Evidence |
|---|---|---|
| Fresh read-only readiness (B1) | DONE by root, read-only, point in time | r3 preflight 04:58:07Z `0a93816f`: r3 evaluator READY_FOR_FRESH_BACKUP, 0 blockers/unknowns, all 9 r3 access facts in that single capture. Separate metadata read 04:58:32Z `fdf528ab`: ACL absent; /etc/enclave-indexd, /etc and / are root 0755 directories. |
| Under the r4 evaluator | the 04:58:07 capture alone is UNKNOWN (it lacks the 2 r4 facts); with the separate 04:58:32 read, those 2 facts pass (a cross-capture result, not a single READY) | `preflight/test_evaluate.py` R4PathAndAcl |
| Combined indexd binary (c2-enclave = v0.6.0 + fence + G-C2 + enclave-small) | NOT BUILT | source only: `storage-migration/source-candidate/` |
| Fresh quiesced backup (B2) | NOT DONE (user hold) | — |
| Migration 26→27→28 (Phase C) | NOT DONE (user hold) | — |

## Remaining steps, in order

1. **Phase A: build (root or a root-authorized Go worker; queue 1024; no production).**
   - `storage-migration/source-candidate/assemble-trees.sh <out>` produces `fence-enclave/` and `c2-enclave/`.
   - Run `release/build.sh` twice on each tree from empty Go caches and record the 2 shas. They do not exist yet.
   - Then `go test ./contracts/... ./cmd/...`, the C2 fixture (8 stages), and the SDK `real_indexd`/`real_fence` regressions.
   - Then `rehearse-c2.py` with the NEW pins, on root's existing captures.
2. **Fresh r4 preflight, read-only, right before B2.** Readiness is point in time.

       timeout -k 10 330 bash -s < preflight/vm-preflight.sh > pf.out
       python3 preflight/evaluate-preflight.py pf.out

   The run needs READY, or a root-reviewed REVIEW_REQUIRED.
3. **B2: fresh quiesced coupled backup (root; brief indexd stop; when the user lifts the hold).**
   - Database, consensus.db, binary and config, in the existing encrypted off-host pattern (`storage-vm/backup-encrypt.py`, `replicate-backup.py`).
   - Then `indexd-c2-production-rehearsal/preflight-fresh-backup.sh <dir>`, and a rehearsal on THAT backup with the step 1 pins.
   - Disk: needs 4 × (561191048 + 30725823) + 1 GiB ≈ 3.44 GB; 59.5 GB is free.
4. **Phase C: in place, still ONE indexer (root; production; user hold).**
   1. Install the CURRENT binary 2d7a637e as a release. Set `releases/current`. Add the drop-in `20-fence-release.conf` and run `daemon-reload` (no restart).
   2. Place `controller-profile/migration/*` (r1), `controller/replicactl.py` (r4) and `controller/live-primary.profile.json` (r4).
      - Fill the two ROOT_DECIDES values: admin_password_file must be a root-created 0600 file; backup_dir must be 0700.
      - `replicactl preflight` must pass. It accepts indexd.yml only under the declared 0640 root:enclave-indexd model: no ACL, and every path component a safe directory.
   3. `install` the fence-enclave build, then `upgrade --sha256 <fence-enclave>` (expects v27 with the digest preserved).
   4. `install` the c2-enclave build, then `upgrade-c2 --sha256 <c2-enclave>` (expects v28; durability check).
   - **Manual step (existing code/doc mismatch, not changed in r4):** `cmd_upgrade` and `cmd_upgrade_c2` take a backup but never call `verify-backup`, although their docstrings say so. Run `replicactl verify-backup <dir>` on each upgrade's backup right after the upgrade. It restores into a scratch DB of about 30 MB.
   - Rollback is unchanged from MIGRATION-PLAN.md: `rollback-c2`, then `rollback` to 2d7a637e. The last resort is to restore B2 with the same seed.
5. **Phase D: blocked on external prerequisites, unchanged.**
   - N ≥ 3 replicas in distinct failure domains, non-DigitalOcean ingress, Sia funding, the operator descriptor signature, the C2 sia-s3 publish, and an rc3 host-role package carrying the c2-enclave build.
   - Storage remains a single-minipc dependency until then.

## Permissions

- **Steps 1–2:** root's routine authority.
- **Steps 3–4:** they wait on the user's hold, which is the user's own statement and not a new requirement.
- **Wallet, spend, hardware:** none of steps 1–4 needs a wallet key or new spend, and no hardware beyond the disk already verified.
