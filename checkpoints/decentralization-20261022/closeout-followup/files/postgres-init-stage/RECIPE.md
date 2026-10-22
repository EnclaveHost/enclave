# Step I: one-flag `--init` for enclave-indexd-postgres (ROOT ONLY; its author ran nothing on the VM)

**Why.** Restore-timeout diagnosis E3 showed that with `docker run --init`, a docker-init (tini) PID 1 reaps orphaned
processes. Without it, the postmaster is PID 1, reaps a SIGKILLed orphan as a crashed backend, and reinitializes the
server.
- This is defense in depth; the controller restore fix is still required.
- No test is repeated here.

**When.** In the planned quiesced window of `../production-migration-closeout/PRODUCTION-RECIPE.md`:
- AFTER §2: the fresh encrypted backup B2' must be complete, coupled, `sourceResumed true`, with its archive verified;
- BEFORE §L: §L assumes indexd is running 2d7a637e, and step I ends with indexd running again.

Expected indexd downtime is about 1–3 minutes.

## Inputs (this directory)
| file | sha256 | role |
|---|---|---|
| `enclave-indexd-postgres.service.candidate` | `59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183` | the new unit |
| `enclave-indexd-postgres.service.rollback-e0a45f51` | `e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012` | the exact live unit (= `work/storage-vm/enclave-indexd-postgres.service`; recorded live in the r4 preflight that started 18:23:17Z, READY_FOR_FRESH_BACKUP) |
| `enclave-indexd-postgres.service.init.patch` | SHA256SUMS | the diff |
| `pg-init-probe.sh` | SHA256SUMS | READ-ONLY probe, piped and never stored. It embeds `migration/digest.sql` 7f4b137f verbatim. |
| `compare.py` | SHA256SUMS | local before/after check |

**The diff** adds ONE token, `--init`, after `--rm` in ExecStart. Everything else is byte-identical: image digest,
bind mount, `--network host`, `--read-only`, `--memory 1g`, env-file, tmpfs, postgres arguments, ExecStop, Restart,
TimeoutStopSec and Install. `systemd-analyze verify` gives no output and rc 0 for both units.

Notation (from `/home/steven/Documents/Codex/2026-10-18/wo`): `VMSSH` as in PRODUCTION-RECIPE.md, and

    S=work/resume-after-checkpoint-20261022/postgres-init-stage
    IRID=$(date -u +%Y%m%dT%H%M%SZ); VD=/root/pg-init-$IRID
    install -d -m 0700 $S/runs

## I0. Read-only gates (nothing stops)

    $VMSSH 'sudo sha256sum /etc/systemd/system/enclave-indexd-postgres.service; sudo stat -c "%a %U:%G" /etc/systemd/system/enclave-indexd-postgres.service; systemctl show enclave-indexd-postgres -p DropInPaths -p ActiveState -p SubState --no-pager'
    $VMSSH "sudo docker info --format '{{.InitBinary}}'; sudo docker version --format '{{range .Server.Components}}{{.Name}}={{.Version}} {{end}}'"
    $VMSSH 'sudo timeout 60 docker run --rm --init --pull never --network none --entrypoint cat postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 /proc/1/comm'

Required:
- the unit is `e0a45f51…`, `644 root:root`, with an empty `DropInPaths` and active/running;
- the components list contains `docker-init`;
- the last command prints `docker-init`.
  - It creates and auto-removes ONE unnamed container from the already-present image: no mount, no network, no pull.
  - It proves `--init` works on this daemon before the server is stopped.

**If any gate fails, STOP.** Nothing has changed. Continue the migration under the old unit; G4/defense in depth stays
open.

## I1. Stage both units on the VM

    $VMSSH "sudo install -d -o root -g root -m 0700 $VD"
    $VMSSH "sudo sh -c 'set -C; umask 077; cat > $VD/new.service'" < $S/enclave-indexd-postgres.service.candidate
    $VMSSH "sudo cp -p /etc/systemd/system/enclave-indexd-postgres.service $VD/old.service"
    $VMSSH "sudo sha256sum $VD/new.service $VD/old.service"      # 59b60ddd…, e0a45f51…

## I2. Quiesce: stop indexd FIRST, then take the BEFORE probe

    $VMSSH 'sudo systemctl stop enclave-indexd; systemctl show enclave-indexd -p ActiveState -p SubState --no-pager; pgrep -u enclave-indexd -x indexd || echo no-writer'
    $VMSSH 'sudo bash -s' < $S/pg-init-probe.sh > $S/runs/$IRID.before.out

Required:
- `inactive`/`dead` and `no-writer`;
- in the probe:
  - `container.running=yes`, `pid1.comm=postgres`, `postmaster.pid=1`;
  - `pg.otherClientSessions=0`;
  - `db.version=26`;
  - `digest.rc=0`;
  - `probe.complete=yes`.

`enclave-indexd` has `Requires=enclave-indexd-postgres`, so it is stopped explicitly first and never left to the
dependency.

## I3. Stop PostgreSQL cleanly, confirm the old container is gone

    $VMSSH 'sudo systemctl stop enclave-indexd-postgres; systemctl show enclave-indexd-postgres -p ActiveState -p SubState -p Result --no-pager'
    $VMSSH 'sudo journalctl -u enclave-indexd-postgres -n 60 --no-pager -o cat | grep -E "shutdown request|database system is shut down"'
    $VMSSH 'for i in $(seq 1 30); do sudo docker ps -a -q --filter "name=^/enclave-indexd-postgres$" | grep -q . || { echo container-absent; break; }; sleep 1; done'

Required:
- `inactive`/`dead`, `Result=success`;
- the journal shows the shutdown request AND `database system is shut down`;
- `container-absent`.

If the container still exists:
- **Exited state only:** `--rm` removal failed, so remove it with `sudo docker rm enclave-indexd-postgres`.
  - Use NO `-f` and NO `-v`: docker refuses a running container, and the data is a bind mount that `rm` never
    touches.
- **Any other state:** STOP and review.

If the clean-shutdown line is missing (the 120 s `docker stop` ran out and killed it), do not change the unit. Go to
R3 with the old unit; crash recovery replays WAL, and B2' exists.

## I4. Install the candidate unit, reload

    $VMSSH "sudo install -m 0644 -o root -g root $VD/new.service /etc/systemd/system/enclave-indexd-postgres.service && sudo systemctl daemon-reload && sudo sha256sum /etc/systemd/system/enclave-indexd-postgres.service && systemctl show enclave-indexd-postgres -p NeedDaemonReload -p ExecStart --no-pager"

Required:
- `59b60ddd…`;
- `NeedDaemonReload=no`;
- ExecStart argv `/usr/bin/docker run --rm --init --name enclave-indexd-postgres …`.

## I5. Start PostgreSQL, wait until ready, verify

    $VMSSH 'sudo systemctl start enclave-indexd-postgres'
    $VMSSH 'sudo bash -s -- wait' < $S/pg-init-probe.sh > $S/runs/$IRID.after.out
    python3 $S/compare.py $S/runs/$IRID.before.out $S/runs/$IRID.after.out --expect init      # must print PASS

`compare.py` checks the following.
- **Equal before and after:**
  - the system identifier, data directory, server version, databases, roles and fsync/synchronous_commit;
  - `db_version` 26 and every `digest.*` line (name|rows|md5);
  - the container's image digest/id, mounts, network, read-only, memory, tmpfs, entrypoint, cmd and env NAMES;
  - the unit file mode.
- **After only:**
  - `pid1.comm=docker-init`, `container.init=true`;
  - a postmaster pid ≠ 1 with comm `postgres`;
  - `wait.ready=yes`, unit active/running with `NeedDaemonReload=no`;
  - a new postmaster start time, and a startup line `database system was shut down at …` (a clean restart, no crash
    recovery);
  - 0 other client sessions, and indexd still inactive.

**If it prints FAIL, go to R1.**

## I6. Resume indexd, then continue PRODUCTION-RECIPE §L

    $VMSSH 'sudo systemctl start enclave-indexd; sleep 15; systemctl show enclave-indexd -p ActiveState -p SubState -p NRestarts --no-pager'
    $VMSSH 'sudo bash -s' < work/resume-after-checkpoint-20261022/production-migration-closeout/vm-state.sh

Required:
- active/running;
- vm-state §1 conditions: `runningExeSha` 2d7a637e, `dbVersion=26`, `containerTimeout` GNU, no scratch/controller/tool
  sessions.

Then continue at §L unchanged. From now on the r4 preflight reports `pg.unit.fragment_sha256=59b60ddd…`: an INFO key,
not a blocker.

## Rollback (exact old unit; the data directory, volume and seed are never touched)

**R1.** Stop indexd if it runs, then PostgreSQL, and confirm the container is absent:
- `sudo systemctl stop enclave-indexd`, then `sudo systemctl stop enclave-indexd-postgres`;
- the I3 checks.
- A failing new unit may be looping on `Restart=on-failure`; `systemctl stop` ends that.

**R2.** Reinstall the exact old unit:

    $VMSSH "sudo install -m 0644 -o root -g root $VD/old.service /etc/systemd/system/enclave-indexd-postgres.service && sudo systemctl daemon-reload && sudo sha256sum /etc/systemd/system/enclave-indexd-postgres.service"   # e0a45f51…

If `$VD` is unavailable, stage the identical local copy first:

    $VMSSH "sudo sh -c 'umask 077; cat > /root/pg-init-old.service'" < $S/enclave-indexd-postgres.service.rollback-e0a45f51

**R3.** Start and verify against the ORIGINAL before-probe:

    $VMSSH 'sudo systemctl start enclave-indexd-postgres'
    $VMSSH 'sudo bash -s -- wait' < $S/pg-init-probe.sh > $S/runs/$IRID.rollback.out
    python3 $S/compare.py $S/runs/$IRID.before.out $S/runs/$IRID.rollback.out --expect rollback   # PASS: e0a45f51, postgres PID 1, identity/digest equal

**R4.** Resume as in I6.

**Never** run any of these: `docker volume rm`, `docker rm -v`/`-f` on the PG container,
`rm`/`chown`/`initdb` on `/var/lib/enclave-indexd/postgres`, or any edit of `/etc/enclave-indexd/postgres.env`.

## Notes
- **Shutdown and startup are unchanged.** `docker stop` still sends SIGTERM to PID 1: now tini, which forwards it to
  postgres (smart shutdown), with the same 120 s/150 s bounds. The image's entrypoint and arguments are unchanged.
- **This step is not a replacement for the controller restore fix.** The fix (fd097a2a, integration-r3 a4cdf025 PASS)
  stays required. The old r5 3e8a8c3f stays forbidden.
- **B2' itself still runs under the old unit.** This order is root's: backup first, so gap G4 (the B2 runner's
  non-foreground `timeout -k 5`) is closed only for the steps after I.
