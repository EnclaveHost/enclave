# production-final: root-run step scripts for Phase C (live primary 26 → 27 → 28)

Prepared by Claude on 2026-10-22. ROOT ONLY: read each script, then run it from `/home/steven/Documents/Codex/2026-10-18/wo`
as `MRID=<one id for the window> bash work/resume-after-checkpoint-20261022/production-final/<step>.sh`.

These scripts are the reviewed commands of `controller-bounds-validation/PRODUCTION-RECIPE.final.md` (§1, L–L7, C1,
C2, post-checks) and `postgres-init-stage/RECIPE.md` (step I), with exact pins and stop-at-first-failure checks.
- **No orchestration:** each step is separate and starts nothing after itself.
- **No automatic deletion, DROP, kill, force or broad rollback.**
- **No CAS enrolment, and no credential output.**

## ⚠ INCIDENT (my error, 2026-10-22 19:26:20Z): one script reached the production VM

My local self-check ran `20-layout.sh` expecting its integration-r4 gate to refuse. Root's r4 run had passed minutes
before, so the script ran for real.

What it did on the VM, in order:
1. **Read-only state probes:** `vm-state.sh` and the PostgreSQL unit hash.
2. `sudo install -d -o root -g root -m 0700 /root/indexd-migration /root/indexd-migration/20991231T000000Z-0badc0de`.
3. **Four exclusive file writes into that directory:** `replicactl.py` (1543577f), `live-primary.profile.json`
   (abcd3612), `fence.indexd` (c67ffa4d, 39 MB) and `c2.indexd` (2c0e5b06, 39 MB). The loop completed without error.
4. **The hash check then failed** (a `cd` into the root-only directory; fixed here), and the script stopped.

**Nothing else:**
- no release dir, migration dir, symlink, drop-in, daemon-reload, credential file or backup dir;
- no unit stop/start;
- no database statement beyond vm-state.sh's read-only queries.

The state it read (evidence in `INCIDENT-selfcheck-20261022T192620Z/`): indexd active/running stock 2d7a637e since
19:21:54Z, NRestarts 0, dbVersion 26, GNU timeout, no scratch/controller/tool sessions, lock free. The PostgreSQL unit
is already **59b60ddd** (`--init`).

**Root, at your discretion (inspect first; explicit names; no -r/-f):**

    $VMSSH 'sudo ls -la /root/indexd-migration /root/indexd-migration/20991231T000000Z-0badc0de; sudo sha256sum /root/indexd-migration/20991231T000000Z-0badc0de/*'
    $VMSSH 'cd /root/indexd-migration/20991231T000000Z-0badc0de 2>/dev/null; sudo rm -- /root/indexd-migration/20991231T000000Z-0badc0de/replicactl.py /root/indexd-migration/20991231T000000Z-0badc0de/live-primary.profile.json /root/indexd-migration/20991231T000000Z-0badc0de/fence.indexd /root/indexd-migration/20991231T000000Z-0badc0de/c2.indexd && sudo rmdir /root/indexd-migration/20991231T000000Z-0badc0de'

`/root/indexd-migration` itself (0700 root, otherwise empty) can stay: `20-layout.sh` creates it idempotently. The
leftover does not collide with a real MRID (year 2099) and is never read by any step.

The self-check now runs with a stub `ssh` first in PATH, asserted effective: `selfcheck.sh`, `logs-selfcheck2.out`.

## Status: tested/current versus prepared

| item | status |
|---|---|
| controller FINAL `1543577f` (restore fix fd097a2a + bounds) | **TESTED.** Root's integration r4 run `2303c2fd33d86cc0`: `outcome stages-and-checks-passed`, exit 0, cleanup certain (local result.json). Also local real-PG 73bdaa13 11/11, units 6/6. G0/G1 closed. |
| B2 runner `62f43690` (`--foreground`) | **TESTED and USED.** Mocks 16/16, real-PG C6a–c. Root's capture `20261022T191749Z-603f3b39` is complete, coupled, sourceResumed. G4 is closed for B2' itself. |
| B2' off-host encrypt + archive integrity | **IN PROGRESS (root)**: not yet a passed claim. It gates `10-init-swap.sh`, `11-init-rollback.sh` and `20-layout.sh` (a precondition, checked by root). |
| `--init` unit `59b60ddd` | **LIVE** per the accidental read at 19:26Z (root applied step I). Root's own step-I evidence is authoritative. |
| these step scripts | **PREPARED only.** `bash -n`; parser and refusal self-check with stub ssh. Never run against the VM except the incident above. |

**Stale claims removed:**
- the draft `PRODUCTION-RECIPE.md` (912b4705) "restore fix … in test" and "G0 blocker";
- the final recipe's "integration r4 pending" and "G1 blocker" (r4 has now passed);
- my init RECIPE note that "B2' runs under the non-foreground runner (G4 open for B2')".

**No user hold and no external funding gate the primary migration.** Phase D items (Sia funding, replicas, ingress)
are outside Phase C. The app smoke is recorded and never gates.

**Real gates that remain:**
- B2' archive integrity (root);
- the fresh read-only state checks in each step;
- each step's own result checks;
- the v27 soak before v28;
- root's review before every script.

## Steps (in order; each stops at its first failed check and writes `<stamp>.<step>.PASS|DONE` evidence in `runs/<MRID>/`)

| script | does | VM changes |
|---|---|---|
| `00-gate.sh` | local pins of every input; r4 preflight (must be READY_FOR_FRESH_BACKUP; valid only BEFORE layout L, whose release dir/drop-in make it non-READY); vm-state (v26 stock, quiet); PG unit e0a45f51 + docker-init present; one `--rm --init --network none` probe container prints `docker-init` | one ephemeral auto-removed container |
| `10-init-swap.sh` | step I: stage both units in `/root/pg-init-$MRID`, stop indexd, BEFORE probe, clean PG stop + no container, install 59b60ddd, daemon-reload, start, AFTER probe, `compare.py --expect init`, start indexd, vm-state | PG unit swap; indexd + PG restart |
| `11-init-rollback.sh` | ONLY by root's decision after a failed 10: back to the exact e0a45f51, compared with the window's original BEFORE probe | PG unit restore; restarts |
| `20-layout.sh` | requires r4 PASS; §L staging into `/root/indexd-migration/$MRID` (exclusive, hash-checked), L1 migration files, L2 three installs, L3 `current`→stock, L4 access, L5 drop-in + daemon-reload (no restart), L6 admin.pass (0600, never printed), backup dir, controller preflight/readiness, L7 baseline | layout only; indexd keeps running stock |
| `30-upgrade-v27.sh` | requires 20 PASS; source-state + VM-pin gate; ONE `systemd-run … upgrade --sha256 c67ffa4d…`; checks ok/dbVersion 27/backupVerified/digestPreserved/fence 401; records the backup path. Refuses to start twice | the migration step |
| `50-postcheck.sh 27` | read-only: readiness against the step's verified manifest + baseline network, verify record `dropped`, vm-state (c67ffa4d, v27, quiet), NRestarts/warnings. Run now and again ≥ 10 min later | none |
| `40-upgrade-v28.sh` | requires two v27 post-check passes ≥ 600 s apart with equal NRestarts; ONE `systemd-run … upgrade-c2 --sha256 2c0e5b06…` | the migration step |
| `50-postcheck.sh 28` | as for 27, plus `casEnrolledAccounts=0` (the upgrade enrols nobody) | none |

**Skipping step I:** if root already applied step I with `postgres-init-stage/RECIPE.md`, as the 19:26Z read shows,
skip 00/10. `20-layout.sh` checks the state itself and accepts either PG unit hash, recording it.

**Failures:** every STOP message names the state left behind. Upgrades never retry. Reconciliation and rollback stay
the manual, reviewed `PRODUCTION-RECIPE.final.md` §R / §B; they are deliberately not scripted.

## Pins (lib.sh)
- **Releases:** stock 2d7a637e, fence c67ffa4d, c2 2c0e5b06.
- **Controller and inputs:** controller 1543577f, profile abcd3612, vm-state 5ac71122, drop-in f1597cc2,
  migration files (digest 7f4b137f, down-27 2127a7e2, down-28 629f186e, up-27 8d66b19b, up-28 1043b645).
- **r4 preflight:** vm-preflight ee359b57, evaluator 8a827258.
- **PG unit and init tooling:** old e0a45f51, new 59b60ddd, probe 78db5755, compare 2e56c3a5.
- **Image:** postgres@sha256:74935e72…
