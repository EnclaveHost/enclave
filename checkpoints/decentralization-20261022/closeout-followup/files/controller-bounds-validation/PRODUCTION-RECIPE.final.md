# Phase C production recipe, FINAL: live primary 26 → 27 → 28 (ROOT ONLY; its author ran nothing on the VM)

Supersedes the draft `production-migration-closeout/PRODUCTION-RECIPE.md` (912b4705). Changes from the draft:
- the final controller and the B2 runner copy are pinned;
- the bounds evidence is recorded;
- health is judged against a baseline from direct indexd probes.

**Conditional on ONE root run:** integration r4 (`controller-bounds-validation/integration-r4`, manifest `b7d2aae0…`,
command in ROOT-READY.json) must PASS. It runs the root-passed eight stages plus X1–X8 with the refined barrier
checks and the bounded fixture copy `0a6f5686`, which is equivalence-checked against the production copy.

| controller | sha256 | status |
|---|---|---|
| r5 rev2 `3e8a8c3f…` | — | **DO NOT USE.** a7e53855 X3b: its restore bound crash-restarts PostgreSQL. |
| restore fix `fd097a2a…` (fixture `4e0a76a0…`) | — | G0 RESOLVED: root's run a4cdf02552931ec3 passed all 8 stages and 9 checks. Superseded by the next row. |
| **FINAL**: restore fix + bounds `$V/frozen/replicactl.r5-production.restorefix.bounds.py` | `1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83` | Local real-PostgreSQL validation 73bdaa1334c68be5: 11/11 PASS, cleanup certain. Unit checks 6/6 on both copies. Integration r4 is pending (root). |

Before r4 passes, the fallback is the restore fix alone, `fd097a2a`. Its pg_dump/psql are then unbounded inside the
container (G1), and runs carry no exact tag.

Notation: everything runs from `/home/steven/Documents/Codex/2026-10-18/wo`.
- `VMSSH='ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1'`
- `C=work/resume-after-checkpoint-20261022/production-migration-closeout` (vm-state.sh, proposed profile)
- `V=work/resume-after-checkpoint-20261022/controller-bounds-validation` (final controller, B2 runner copy)
- `M=work/claude-resumed-20261022/control-package/storage-migration/controller-profile/migration`
- `B=work/claude-resumed-20261022/storage-enclave-build/out`
- `MRID=$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets;print(secrets.token_hex(4))')`
- `D=/root/indexd-migration/$MRID` (on the VM) and `CTL=$D/replicactl.py`, `PROF=$D/live-primary.profile.json`
- `RC="sudo /usr/bin/python3 $CTL --profile $PROF"`

## 0. Pins

| what | local source | sha256 | VM destination |
|---|---|---|---|
| stock v0.6.0 (v26) | the live `/opt/enclave-indexd/indexd`; the same bytes are in `work/indexd-production-rehearsal/retirement-snapshot/indexd` | `2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc` | `/opt/enclave-indexd/releases/2d7a637e…/indexd` |
| fence-enclave (v27) | `$B/fence-enclave-a/indexd` (= `-b`) | `c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568` | `/opt/enclave-indexd/releases/c67ffa4d…/indexd` |
| c2-enclave (v28) | `$B/c2-enclave-a/indexd` (= `-b`) | `2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7` | `/opt/enclave-indexd/releases/2c0e5b06…/indexd` |
| digest.sql | `$M/digest.sql` | `7f4b137f7049753df1cc414e89e0fa2da563b84c290cf533d8d2f11765104247` | `/opt/enclave-indexd/migration/` |
| down-27-to-26.sql | `$M/` | `2127a7e2fb9f4ccb7d3e9944a913a51fd9eaf8275119a5d683843930e227485c` | same |
| down-28-to-27.sql | `$M/` | `629f186e28a7f48a36e9bd9ac94139e6a3d24c40784fc26c6190075d212cc873` | same |
| up-26-to-27.sql (audit copy; the binary applies its own) | `$M/` | `8d66b19b542b9b81146250418a5e1521c2fc1fbd7ea687c6ffe20e21d59029e5` | same |
| up-27-to-28.sql (audit copy) | `$M/` | `1043b6452c0279258214ee3527d80d9d2962fea7f3202505acb02b81fc35a225` | same |
| unit drop-in | `work/indexd-replica-rollout/systemd/primary-upgrade.conf` | `f1597cc26c1a5ad1e86ce9e7c53210792ca2580980d3c9dc537489128f6c9fbb` | `/etc/systemd/system/enclave-indexd.service.d/20-fence-release.conf` |
| live unit (unchanged, reference) | `work/storage-vm/enclave-indexd.service` | `cb96c3bee807d8196f5f4947d1e6f3a9f3b4128fa211161a3f9514ceb09b41b3` | (`Restart=on-failure`, `RestartSec=10`, `TimeoutStopSec=180`, ALLOW condition) |
| profile | `$C/live-primary.profile.proposed.json` | SHA256SUMS | `$PROF` |
| read-only state probe | `$C/vm-state.sh` | SHA256SUMS | piped, never stored |
| B2 runner (`--foreground` copy of 1460169a; patch `$V/b2/B2-RUNNER-FOREGROUND.patch`) | `$V/b2/vm_fresh_backup.foreground.py` | `62f4369029f6f66d1811ce25f9358a326b030913f67e1592df0f367600c67eb4` | `/root/fresh-backup/vm_fresh_backup-62f43690.py` |
| controller (FINAL) | `$V/frozen/replicactl.r5-production.restorefix.bounds.py` | `1543577f4bdbc1bc94dca950e55ac0ece5eb6a65272622aa90244ef2ba7c0e83` | `$CTL` |

The release version map is exact: `2d7a637e` → 26, `c67ffa4d` → 27, `2c0e5b06` → 28. Nothing else is a release.

## 1. Gates immediately before (read-only)

1. **r4 preflight:**

       timeout -k 10 330 $VMSSH 'sudo bash -s' < work/claude-resumed-20261022/control-package/storage-migration-r4/preflight/vm-preflight.sh > pf.out
       python3 work/claude-resumed-20261022/control-package/storage-migration-r4/preflight/evaluate-preflight.py pf.out

   It must be READY, as in root's 18:19Z run.
2. **State probe:** `$VMSSH 'sudo bash -s' < $C/vm-state.sh`. It must show:
   - `containerTimeout` contains `GNU coreutils`;
   - `dbVersion=26`, `fsync=on`, `synchronous_commit` in on, local or remote_apply;
   - `scratchDatabases`, `controllerSessions` and `toolSessions` empty; `lockHeld` no;
   - `unit.ActiveState=active`, `SubState=running`, and `runningExeSha` 2d7a637e.

   These checks are the H3 gate: a wrong schema or durability setting is caught here, before anything stops.
3. **No operator psql/pg_dump/pg_restore** sessions during the window.

## 2. Fresh coupled encrypted backup B2' (tested B2 runner with `--foreground`, new RID)

Follow `work/claude-resumed-20261022/storage-fresh-backup/ROOT-RECIPE.md` sections 1–5. Only the runner file and its
hash change, so `PKG` stays for the local tools:
- **Stage:** `VMRUNNER=/root/fresh-backup/vm_fresh_backup-62f43690.py`, and stage it from
  `$V/b2/vm_fresh_backup.foreground.py`, not `$PKG/runner/…`.
- **E3:** `sha256sum $VMRUNNER` must equal `62f4369029f6…7eb4`.
- **Unchanged:** the capture flags (`--expect-db-version 26 --expect-binary-sha256 2d7a637e… --expect-geoip-sha256
  18bf1695… --quiesce-budget 600 --dump-timeout 300`) and `local/pull_encrypt.py` / `local/verify_archive.py`. Neither
  local tool pins the runner.

Result required: `complete`, coupled, `sourceResumed true`, and the archive integrity check passes.

Run it BEFORE the layout step L, as in the tested 07:50Z run.

What the copy changes: its psql and pg_dump run as `exec timeout --foreground -k 5 …`. Its pre-stop probe also
requires `timeout --foreground` to work, so a BusyBox timeout is refused before anything stops. Evidence:
- 16/16 of the runner's own mock tests pass against the copy;
- run 73bdaa13 cases C6a–C6c: its shapes are bounded, with no crash and no orphan;
- C6e shows the ORIGINAL runner's KILL phase crash-restarting PostgreSQL. That is G4, now closed.

## L. One-time release layout (no restart; indexd keeps running 2d7a637e)

    $VMSSH "sudo install -d -o root -g root -m 0700 /root/indexd-migration $D"
    for f in replicactl.py:$V/frozen/replicactl.r5-production.restorefix.bounds.py live-primary.profile.json:$C/live-primary.profile.proposed.json \
             fence.indexd:$B/fence-enclave-a/indexd c2.indexd:$B/c2-enclave-a/indexd; do
      $VMSSH "sudo sh -c 'set -C; umask 077; cat > $D/${f%%:*}'" < "${f#*:}"; done
    $VMSSH "sudo sha256sum $D/*"                      # = 1543577f…, profile abcd3612…, c67ffa4d…, 2c0e5b06…

- **L1, migration files** (root:root, 0644; dir 0755):

      $VMSSH 'sudo install -d -o root -g root -m 0755 /opt/enclave-indexd/migration'
      for f in digest.sql down-27-to-26.sql down-28-to-27.sql up-26-to-27.sql up-27-to-28.sql; do
        $VMSSH "sudo sh -c 'set -C; umask 022; cat > /opt/enclave-indexd/migration/$f'" < $M/$f; done
      $VMSSH 'sudo sha256sum /opt/enclave-indexd/migration/*'      # = §0

- **L2, releases.** Run under `umask 022`: the controller's `mkdir`/`copyfile` inherit it, and `User=enclave-indexd`
  must be able to traverse the directories and execute the binaries.

      $VMSSH "sudo sh -c 'umask 022; /usr/bin/python3 $CTL --profile $PROF install /opt/enclave-indexd/indexd --sha256 2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc --confirm install'"
      $VMSSH "sudo sh -c 'umask 022; /usr/bin/python3 $CTL --profile $PROF install $D/fence.indexd --sha256 c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568 --confirm install'"
      $VMSSH "sudo sh -c 'umask 022; /usr/bin/python3 $CTL --profile $PROF install $D/c2.indexd --sha256 2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7 --confirm install'"

- **L3, `current`:** a relative target, as the controller's own `switch_current` writes it. `ln` fails if the name
  already exists.

      $VMSSH 'sudo ln -s 2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc /opt/enclave-indexd/releases/current'

- **L4, check access:**

      $VMSSH 'sudo stat -c "%a %U:%G %n" /opt/enclave-indexd/releases /opt/enclave-indexd/releases/*/ /opt/enclave-indexd/releases/*/indexd; sudo -u enclave-indexd test -x /opt/enclave-indexd/releases/current/indexd && echo exec-ok'

  Expect directories 755 root, binaries 755 root, and `exec-ok`.
- **L5, drop-in, then daemon-reload only.** This changes ExecStart for the NEXT start; the running process is untouched.

      $VMSSH 'sudo install -d -m 0755 /etc/systemd/system/enclave-indexd.service.d'
      $VMSSH "sudo sh -c 'set -C; umask 022; cat > /etc/systemd/system/enclave-indexd.service.d/20-fence-release.conf'" < work/indexd-replica-rollout/systemd/primary-upgrade.conf
      $VMSSH 'sudo systemctl daemon-reload; systemctl show enclave-indexd -p ExecStart -p NeedDaemonReload -p ActiveState -p SubState'

  Required: ExecStart path `/opt/enclave-indexd/releases/current/indexd`, `NeedDaemonReload=no`, still active/running.
  Without this drop-in an "upgrade" would restart the OLD binary path.
- **L6, credential and backup directory.** The password is never printed. Key `adminAPI.password` is the one
  `live-admin-check.py` uses.

      $VMSSH "sudo python3 -c 'import yaml,os; c=yaml.safe_load(open(\"/etc/enclave-indexd/indexd.yml\")); fd=os.open(\"/root/indexd-migration/admin.pass\", os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600); os.write(fd, c[\"adminAPI\"][\"password\"].encode()); os.close(fd)'"
      $VMSSH 'sudo install -d -o root -g root -m 0700 /var/lib/enclave-indexd/migration-backups'
      $VMSSH "$RC preflight"                                     # ok:true (secret modes, geoip, current release 2d7a637e)
      $VMSSH "$RC readiness --expect-version 26"                 # ok:true; fenceRoute must be an HTTP status (a connection error = wrong app_url; expect non-401 on stock)
      $VMSSH 'sudo bash -s' < $C/vm-state.sh                     # §1 conditions again

- **L7, BASELINE (read-only), kept locally.** Every later health judgement compares against this capture.

      $VMSSH "$RC readiness --expect-version 26" > baseline-readiness.json       # adminState, version, network, dbVersion, fence/seq route codes
      $VMSSH "$RC digest" > baseline-digest.json                                 # row counts + md5 per table (no row content)
      $VMSSH 'systemctl show enclave-indexd -p NRestarts; journalctl -u enclave-indexd --since -30min -p warning --no-pager | wc -l' > baseline-unit.txt

  Also record the result of root's usual app smoke (sia-s3 signed `/?sia-diag`) as the baseline, pass or FAIL. It can
  already be down for reasons outside indexd, such as an unfunded lease. Do not create a funding gate for the
  migration.

## C1. upgrade 26 → 27, then C2. upgrade 27 → 28

Each step runs in a transient system unit, so a dropped SSH session cannot kill it. The outer bound is
`RuntimeMaxSec=3600`, which lies above the sum of the inner bounds:
- stop ≤ 240;
- dump ≤ 660;
- verify: restore ≤ 660, other queries ≤ 1200 in total including the restore;
- start ≤ 120, wait_ready ≈ 120, digest ≤ 315.

`KillMode=mixed` applies. It is a last resort only: see §T for why killing the host process alone is insufficient.

    $VMSSH "sudo systemd-run --unit=enclave-indexd-migrate-27-$MRID --collect --wait --quiet \
      --property=RuntimeMaxSec=3600 --property=TimeoutStopSec=300 --property=KillMode=mixed \
      /usr/bin/python3 $CTL --profile $PROF upgrade --sha256 c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568 --confirm upgrade"; echo rc=$?
    $VMSSH "sudo journalctl -u enclave-indexd-migrate-27-$MRID -o cat --no-pager"   # last JSON line = result; stderr line = runId

**Success** means rc 0 and all of the following:
- the output has `ok:true`, `dbVersion:27`, `backupVerified:true`, `digestPreserved:true` and
  `fenceRouteStatusUnauthenticated:401`;
- `$RC readiness --expect-version 27 --expect-digest <backup>/manifest.json` is ok;
- `<backup>/verify-indexd_verify_*.json` has `scratchState` `dropped`;
- `vm-state.sh` shows `current`, `currentSha` and `runningExeSha` all c67ffa4d, `dbVersion=27`, `fencedAccounts=0`, and
  no scratch or controller sessions;
- `NRestarts` is unchanged over a 10-minute soak (`journalctl -u enclave-indexd`);
- **health is classified against the L7 baseline** (direct indexd probes, not the app):
  - indexd is healthy if `readiness` gives adminState 200 and the same `network`, and the digest equals the baseline
    (C1) or the backup's manifest;
  - and the warning rate and NRestarts show no new growth over the soak;
  - **app smoke:** if it passed in the baseline and fails now, while the indexd probes are healthy, investigate the app
    path first. If it already FAILED in the baseline, its failure is pre-existing and is not a migration regression.
    It never gates the step by itself;
  - an indexd probe failing (not ready, digest mismatch, a restart loop) IS a regression. Go to §R/§B.

Only then run C2, the same way:
- unit `enclave-indexd-migrate-28-$MRID`;
- command `upgrade-c2 --sha256 2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7 --confirm upgrade-c2`;
- expect `dbVersion:28`, `current` and `runningExeSha` 2c0e5b06, `casEnrolledAccounts=0` (the upgrade enrols nobody),
  and the same post-checks with `--expect-version 28`.

Stop window: in the A3 rehearsal stop→ready was about 5 s plus dump, verify and digest. The DB is about 30 MB and
consensus.db about 561 MB, so expect a few minutes per step. Disk use per step is about 0.6 GB of backup;
59.5 GB was free.

**Exit 1 with "backup verification failed before the switch":** nothing was switched; read its `resume`. With
`resumed:true` the source serves again. Otherwise go to §R.

**Any other non-zero exit, a killed unit, or rc unknown:** go to §R. Do not re-run the step until §R says CONSISTENT
at the source.

## R. Manual reconciliation of ONE known step S (from F, to T)

Start from `vm-state.sh` (read-only). If `unit.ActiveState` is activating, auto-restart or failed-restarting, first
`$VMSSH 'sudo systemctl stop enclave-indexd'`. A stop is always safe; it gives `Restart=on-failure` no chance to
re-run a binary on a schema. Then re-read the state.

Never start a binary whose version differs from `dbVersion`. A start of the upgrade binary on the source schema IS the
migration, and only the controller step does that.

| current | dbVersion | action |
|---|---|---|
| F | v(F) | Step not done, source unchanged. If stopped and `writerPids` is empty: `systemctl start enclave-indexd`, then `$RC readiness --expect-version v(F)`. |
| T | v(T) | Step applied. If stopped: start, then readiness at v(T) with `--expect-digest <the step's backup>/manifest.json`, then the C1/C2 post-checks. |
| T | v(F) | Upgrade switched but not migrated, or a rollback whose down-SQL failed after the switch (impossible in the code order). Unit stopped, no writer: switch back to F, re-read, start, readiness v(F). |
| F | v(T) | A rollback's down-SQL applied, not switched. Unit stopped, no writer: switch to T, re-read, start, readiness v(T). |
| anything else, unreadable, a sha mismatch | — | Do NOT start. Keep it stopped and preserve the evidence (journal, backup dir). The choice is the step's controller backup (verified for upgrades) or B2' (§X). |

**Switch, atomic, to the exact pinned release:**

    $VMSSH 'cd /opt/enclave-indexd/releases && sudo sha256sum <H>/indexd && sudo ln -s <H> .current.root && sudo mv -T .current.root current'

Then re-run `vm-state.sh`. `current` and `currentSha` must equal H, `dbVersion` must equal v(H), and `writerPids` must
be empty. Only then start.

**Scratch databases** reported AMBIGUOUS, PRESERVED or KEPT are never dropped by the controller. Root drops one only:
- by the exact name in `<backup>/verify-<name>.json`;
- after `vm-state.sh` shows no session on it, twice;
- with `DROP DATABASE "<name>";` (no IF EXISTS, no FORCE) through the bounded `q` pattern, with
  `PGOPTIONS=-c statement_timeout=60000`.

**Lock-wait linger (validated, C5):** a KILLed pg_dump's backend that waits on a lock ends only at pg_dump's
server-side `--lock-wait-timeout` (30 s). A KILLed psql's backend ends at `statement_timeout = t`. Wait 35 s after
a failure before treating a tagged session as leftover.

**Leftover sessions** (bounds patch): they are identifiable exactly as
`application_name = 'replicactl-<runId>'`, where `runId` is in the journal's first stderr line and in every `die`
output. If the controller is gone and such a session remains past its bound, root may
`SELECT pg_terminate_backend(<pid>) FROM pg_stat_activity WHERE pid=<pid> AND application_name='replicactl-<runId>'`.
Never terminate by tool name or by time. Without the patch the controller's sessions carry no tag and none may be
terminated by inference (G1).

## B. Rollback decision tree (after a SUCCESSFUL step, when root decides to undo it)

- **At v28 (C2 done) → v27:** the precondition is that all writers of every CAS-enrolled account are stopped.

      ... systemd-run --unit=enclave-indexd-rollback-27-$MRID ... $CTL --profile $PROF rollback-c2 --fence-sha256 c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568 --confirm rollback-c2 --cas-writers-stopped

  - `casEnrolledAccounts=0` (the normal case right after the upgrade): no acknowledgement is needed.
  - `>0`: the SQL refuses, and the controller restarts the unchanged c2 release and reports `refused`. Add
    `--acknowledge-cas-downgrade` only by root's explicit decision. Those accounts accept v3 writes again.
  - Expect `dbVersion:27` and `digestPreserved:true`. Data written after the upgrade is kept.
- **At v27 → v26:** the precondition is that all fenced writers are stopped (`fencedAccounts=0` right after C1).

      ... $CTL --profile $PROF rollback --stock-sha256 2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc --confirm rollback --fenced-writers-stopped

- Rollbacks take a pre-rollback backup but do not verify it (a known r5 limit). Any failure goes to §R with
  F/T swapped accordingly.
- **X, last resort (data at risk):** restore B2' only if the database is unusable at every pinned version. Everything
  acknowledged after B2' is lost from the index. Restoring an archive onto the VM is UNTESTED (G5).

## T. Why a host timeout alone is insufficient, and how bounded tools are cleaned up

- `docker exec` asks containerd to spawn the command inside the container's PID namespace. Its parent is the shim, not
  the host `docker` CLI. Killing the CLI (a subprocess timeout, `RuntimeMaxSec`, `KillMode=mixed`) ends only the CLI;
  psql or pg_dump keeps running inside the container and keeps its backend.
- The bound must therefore live inside the container. With `sh -c 'exec timeout --foreground -s KILL "$2" psql …'`,
  `sh` is replaced by GNU timeout, which forks the tool.
  - At N seconds it SIGKILLs the tool only, then waitpid()s it itself.
  - The tool never becomes an orphan of the container's PID 1, the postmaster. A signal-killed unknown child is a crash
    to the postmaster, which ends every session and reinitializes the server. That is the a7e53855 X3b evidence.
  - Without `--foreground`, GNU timeout signals its whole process group, itself included under KILL. That was the bug.
  - psql and non-parallel pg_dump/pg_restore start no children, so killing the tool kills all its descendants.
- The tool's backend ends when its client socket closes. `statement_timeout`/`lock_timeout` via PGOPTIONS bound the
  server side regardless; pg_dump bounds its locks with `--lock-wait-timeout`.
- The host-side timeouts (t+15, t+60) only catch a hung docker CLI.

## Hazards and gaps (root decides)

| id | hazard | status |
|---|---|---|
| G0 | The controller restore bound crash-restarts PostgreSQL | RESOLVED: restore fix; root run a4cdf02552931ec3 passed. |
| G1 | `pg_dump`/`psql` unbounded inside the container (H1) | CLOSED by the bounds delta `1543577f`: in-container `timeout --foreground -s KILL`, server-side statement and lock timeouts, an exact `PGAPPNAME=replicactl-<runId>`. Local validation 73bdaa13 C1–C5 passed. Integration r4 is the remaining gate (**blocker**). |
| G2 | `systemctl` waits (H2) | Host timeouts 30/120/stop+60 s (unit-checked). The unit's TimeoutStopSec=180 bounds the stop job; RuntimeMaxSec is the outer bound. |
| G3 | A wrong schema or durability makes the step exit after stop without resuming (H3) | §1 gate before each step, plus §R. |
| G4 | B2 runner 1460169a lacks `--foreground` | CLOSED by the copy `62f43690` (C6a–C6c passed; C6e proves the hazard was real). Use only the copy. |
| G5 | Restoring an archive onto the VM is untested; the off-host copy is a single workstation copy; the key is not replicated | This is the last resort only. Phase D replication is outside this step. |
| G6 | H4: QueryBudget includes the restore time | Profile `verify_query_seconds = verify_timeout_seconds + 600` (proposed 600/1200). |
| G7 | The rollbacks' backups are not verified | Accepted (r5 limit). B2' and the verified upgrade backups cover it. |
| G8 | The fixture copy of the bounds | RESOLVED: `derive.py` E1–E5. Exact patch, the same 14 change blocks, the pre-existing fixture/production difference untouched (`0a6f5686`). |
| G9 | Error text: when `timeout` KILLs psql or pg_dump, the message is `psql failed: ` / `pg_dump failed: ` with empty stderr (C3, C5) | Cosmetic: the exit is still a failure and nothing is presented as verified. Not changed, to keep the tested hash. |
| — | Phase D (replicas, non-DO ingress, Sia funding, operator signature, C2 sia-s3 publish, rc3 package) | Still blocked externally. Not part of Phase C. |
