# Rollback ordering (TOCTOU) fix (RESULT-ROLLBACK-ORDER, 2026-10-23)

**Status.** Source and fixture evidence only. No production step, no SSH, no wallet, no push. D exports the immutable
`6fd7a929`; this is appended, with no history rewritten.

**Commit.** Repository `storage-write-release/`, branch `storage/write-release`:
- `6fd7a929` → `bbf0a00` → **`fbaecfced41da552a9e138082ecd0bd821c9e0f8`**. Author and committer: SteveDeFacto.
- Patch: `rollback-order.patch` (`git format-patch -1 fbaecfc`), sha256
  `cb043a448f98ea638cacc5218e89f7dcb416f281616b36756d8b326777becb21`.
- 11 paths changed.
- Scans on the added and modified files: `scan-crypto-keys.py` exit 0; gitleaks no leaks (`logs/gitleaks-rb.json` = `[]`).
- Root's `ROOT-*.txt` notes are not committed.

## 1. The defect (root's review of 6fd7a929)

- `cutover.py rollback_decision` returned `LEGACY_REDEPLOY_SAFE` from a zero-count snapshot and only THEN instructed
  "stop any C2 instance, then redeploy 0.1.8". CUTOVER.md (old lines 150-156) read the state before the stop too.
- A C2 instance, a node respawn or a request already in flight can enrol between that read and the stop. The plan then
  sends 0.1.8 against an enrolled account, which cannot write: there is no online downgrade.
- e1 covered only an already-killed C2, never this ordering.

## 2. The fix

**`tools/cutover.py` `rollback_decision(vm_text, c2_activation_disabled)`** (`fa4eca76`; CLI `--c2-activation-disabled`).
Observation alone never authorizes a legacy redeploy:

| decision | when |
|---|---|
| `FORWARD_ONLY` | any fenced or CAS-enrolled account, in ANY snapshot. Enrolment is sticky, so this cannot be undone by later state. |
| `LEGACY_REDEPLOY_SAFE` | zero counts AND the same snapshot shows the barrier AND the owner's attestation that C2 activation and its retries are disabled |
| `UNKNOWN` | everything else, with `missing` and the ordered `steps`; repair forward if the barrier cannot be established |

The barrier, in the same snapshot:
- `allowLiveStart=absent`;
- `unit.ActiveState` inactive or failed with `MainPID=0`;
- empty `writerPids`;
- empty `controllerSessions` and `toolSessions`.

**`primary/vm-state.v2.sh`** (`adacd37f`) is the pinned read-only `vm-state.sh` (`5ac71122`) plus one line,
`allowLiveStart=present|absent`, read before the database counts. The original script cannot show the barrier, so its
output is always UNKNOWN for zero counts.

**`CUTOVER.md` §4** (`f1884b17`), the ordered procedure. It reuses the reviewed tools; the decision comes LAST:

| step | who | does | establishes |
|---|---|---|---|
| R1 | owner | Disables C2 activation AND its retries: the deployment goes back to the 0.1.8 catalog version, or is stopped. Confirms no C2 instance remains. | No new attempt starts. It cannot recall a request already sent. |
| R2 | root | `mv /etc/enclave-indexd/ALLOW_LIVE_START …held-<run>` | The unit's `ConditionPathExists` stops systemd from starting indexd. |
| R3 | root | The reviewed controller `1543577f` `stop` | The only service that applies an enrolment is down and cannot restart, so nothing in flight can complete. |
| R4 | root | `vm-state.v2.sh`, AFTER R2-R3 | The barrier lines and the counts read behind it, in ONE snapshot. |
| R5 | root | `rollback-decision --vm-state <R4> [--c2-activation-disabled]` | the decision |

After `LEGACY_REDEPLOY_SAFE`:
1. Keep C2 disabled.
2. Restore the guard and start indexd.
3. Run 0.1.8.
4. Post-check with `vm-state.v2.sh`: still 0/0. If an account is enrolled now, the decision is FORWARD_ONLY.

**What these steps establish, and what the offline parser cannot.**
- **The parser verifies** one snapshot's barrier lines and counts, and that zero counts were read while indexd could not
  run.
- **It cannot verify** (each needs root or the owner):
  - that no C2 instance remains or will be respawned (the owner's R1 attestation; node state is invisible from the VM);
  - that the snapshot is the live primary's latest;
  - that nobody restores the guard before the decision.
- **It never takes** an earlier zero count, or a caller-supplied timestamp alone, as quiescence.

**T1 quiescence corrected:**
- T1.1 quiescence = the legacy writer STOPPED, with node respawn and client retries disabled and in-flight requests
  drained (the owner's attestation, `legacyStoppedAt`).
- Root's object and account counts are only a NECESSARY cross-check. Equal counts do not prove no writes: an overwrite, a
  delete-and-create or a replacement keeps every count.
- `t1_preflight`'s docstring and its reason text say so, and CUTOVER T1.1/T1.3 no longer imply otherwise. The preflight
  checks the ORDER of the attested stop against the authenticated capture time, not the stop itself.

**PINS.json** (`87fd654d`) gains `primary.vm-state-v2` (`adacd37f`, `derivedFrom` `5ac71122`): 21 pinned files, all
matching the workspace (unit test).

## 3. Tests (all through `claude-test-queue.py`)

| run | what | lane / peak | result |
|---|---|---|---|
| **r2** `rehearsal/main_rollbackorder.py` `b13b7a41` + `_base.py` `bd92f094`; the original `cutover.py` of 6fd7a929 (`1b05047c`) extracted from git as the negative control; the new `cutover.py` `fa4eca76` | Two REAL v28 indexers with their own databases and wallets, 30 RHP4 hosts, the exact live 0.1.8 and the final 00e9cde0, one account per indexer. **U (unsafe ordering):** U1 0.1.8 writes. U2 a zero snapshot read while indexd RUNS: the ORIGINAL decision says LEGACY_REDEPLOY_SAFE; the NEW one says UNKNOWN even with the attestation. U3 with C2 activation still enabled, C2 enrols **0.21 s** after that snapshot. U4 following the original plan, the redeployed 0.1.8 PUT gets **500**. U5 the new procedure (R1-R4) on that state says **FORWARD_ONLY**. **S (safe, never-enrolled):** S1 0.1.8 writes and reads. S2 C2 runs while its indexer is down, is never ready, and no instance remains. S3 behind the barrier the counts are zero: UNKNOWN (missing only the attestation), then LEGACY_REDEPLOY_SAFE with it. S4 following it: 0.1.8 serves the legacy object on the first attempt, reads byte-exact and writes; the post-check still shows 0 fenced / 0 CAS. | 1536 / 878 MiB | **19/19 PASS**, queue EXIT 0, cleanup complete |
| r1 (kept as `runs/r1-failed`) | the same U checks all passed; 2 failures were driver defects: a shared expected-key set across the two accounts, and 0.1.8 panicking after its indexer restarted, which crashed the driver | 1536 / 817 MiB | FAILED 13/2, NOT counted |
| `package/tests/test_cutover.py` `4dfc1051` | 14 tests. **New:** the original 6fd7a929 module (loaded from git) says SAFE on a running zero snapshot, while the new one says UNKNOWN even with the attestation; SAFE only with every barrier field and the attestation, and UNKNOWN when any one is missing (including the original `vm-state.sh` without the guard line); any enrolment is FORWARD_ONLY with or without the barrier; unreadable is UNKNOWN. Plus all the earlier tests. | 512 | **14/14 OK** |
| `package/backup/test/test_backup_provenance.py` | unchanged; rerun for the reworded preflight | 512 | **3/3 OK** |

The e1 (11/11) and m3 (42/42) evidence is preserved unchanged. m3 was not repeated.

**Observed once, not diagnosed (r1):**
- Right after its indexer restarted, the live 0.1.8 panicked on a GET for a key that account did not hold:
  `sia_storage download.rs:336`, "index out of bounds: the len is 27 but the index is 28".
- r2 read only existing keys and did not see it.
- CUTOVER notes that after a LEGACY_REDEPLOY_SAFE restart 0.1.8 may need the node's respawn before it serves.

## 4. Limits

- **Fixture only.** The vm-state lines in r2 are DERIVED from fixture state: the unit, PID and writer lines from the
  harness indexer's up/down; the guard from the driver's own hold; the counts from each indexer's own database. On
  production they come from `vm-state.v2.sh` on the VM.
- **Two steps depend on root and the owner.** The R1 attestation (no C2 instance or respawn) and the "one operator"
  assumption cannot be checked by the parser.
- **Not validated live.** No production rollback, barrier or controller stop was run.
- **Ownership.** D and root own publication and activation. F owns the policy-mirror race fix, which is not touched here.
