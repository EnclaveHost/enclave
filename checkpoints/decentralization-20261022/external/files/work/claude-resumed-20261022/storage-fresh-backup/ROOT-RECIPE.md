# Phase B2: fresh, quiesced, coupled indexd backup — ROOT RECIPE (nothing here was run against the VM by its author)

Scope: the live single indexd on the minipc `enclave-storage` VM (schema 26, binary v0.6.0 2d7a637e). The capture covers
the database, consensus.db, the binary, indexd.yml and GeoIP. It is encrypted off-host on the local workstation with the
existing GPG pipeline, verified, and turned into the input for the existing offline restore rehearsal.

Permission: the effective requirements (2026-10-22 provenance correction) record no human storage hold. Root runs this
after its own review of the source, tests, preflight and rollback. No wallet, spend, installs, DigitalOcean hosting,
or contract or admin changes are involved.

All commands below run from `/home/steven/Documents/Codex/2026-10-18/wo`. Notation:
- `PKG=work/claude-resumed-20261022/storage-fresh-backup`
- `R4=work/claude-resumed-20261022/control-package/storage-migration-r4`
- `VMSSH='ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1'`

This is the transport of the existing `work/storage-vm/backup-encrypt.py`.

## 0. Pins (`$PKG/PINS.sha256`; reviewed inputs in `$PKG/REVIEWED-INPUTS.sha256`)

| file | sha256 |
|---|---|
| runner/vm_fresh_backup.py | 1460169a15b7bc44748d0f8a6891f208ca045cf92de6abdcedc74956c0c5d1c6 |
| local/common.py | be0a9b0cd45ebcc5df1691c7169ceb7eb83c1e0ff1973d3cb56a60124fff9ba3 |
| local/pull_encrypt.py | ad297d480cdd282875b55b7cacc55ac27713b9c0c495a364d3375d2d87c4a073 |
| local/verify_archive.py | b4f71bbb83ac7db0d0f0d5a06a57729cb63dd81c6129cefc3f987f4cc3fb7e78 |
| local/rehearsal_input.py | ff7e51a39845283f7c77898e3156de413e74832c1469686a9f8f6bfcec9aa1a2 |

Check: `(cd $PKG && sha256sum -c PINS.sha256)`.

## 1. Evidence required BEFORE the mutating step

Collect all of it, in this order, within 15 minutes of step 3.

**E1. Fresh r4 read-only preflight**
- Command, unchanged: `timeout -k 10 330 $VMSSH 'sudo bash -s' < $R4/preflight/vm-preflight.sh > pf.out`, then `python3 $R4/preflight/evaluate-preflight.py pf.out`.
- The verdict must be `READY_FOR_FRESH_BACKUP`, or a root-reviewed `REVIEW_REQUIRED`. `UNKNOWN` or `BLOCKED` stops here.
- From that single capture, these exact facts must hold:

  | fact | required value |
  |---|---|
  | `preflight.complete` | `yes` |
  | `unit.active` | `active` |
  | `allow_live_start` | `present` |
  | `binary.path_sha256` | `2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc` (passed as `--expect-binary-sha256`) |
  | `geoip_sha256` | `18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933` (the profile value; `--expect-geoip-sha256`) |
  | `db.version` | `26` |
  | `pg.running` | `true` |
  | `pg.inner_timeout.status` | `ok` |
  | `disk.var_lib_free_bytes` | `>= 2*state.du_bytes + 2*db.size_bytes + 1073741824` |

- The runner re-checks every one of these itself before stopping anything, and refuses (exit 5) on any difference.

**E2. No concurrent writer change**
- Phase C has not started: no `replicactl upgrade` or migration is in progress, and `/opt/enclave-indexd/releases/current` is absent, or the binary path is unchanged (`binary.is_symlink=no`).
- Check with a read-only `$VMSSH 'systemctl list-units --all "enclave-indexd-fresh-backup-*" --no-legend'`. It must list nothing active.
- The runner also takes the existing snapshot lock, `/run/enclave-indexd-snapshot.lock` (non-blocking).

**E3. Staged runner identity**
- After step 2, `$VMSSH "sudo sha256sum $VMRUNNER"` must equal `1460169a…d1c6`.

**E4. Workstation**
- `stat -c '%a %U' work/private/indexd-recovery` must be `700 steven`. Last read: `700 steven`.
- `stat -c '%a' work/private/indexd-recovery/backup.pass` must be `600`. Stat only; never read or print it.
- Free disk must be at least 2 GiB under `work/private`.
- None of these exist for this run id: `work/private/indexd-recovery/indexd-minipc-fresh-$RID.tar.gpg*`, `outputs/storage-fresh-backup-$RID*.json`, and the chosen rehearsal input directory.

**E5. Transport**
- `$VMSSH 'sudo -n true'` must return exit 0.

## 2. Stage the runner (root; one small write on the VM)

```
RID=$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets;print(secrets.token_hex(4))')
VMRUNNER=/root/fresh-backup/vm_fresh_backup-1460169a.py
$VMSSH "sudo install -d -o root -g root -m 0700 /root/fresh-backup && sudo sh -c 'set -C; umask 077; cat > $VMRUNNER'" < $PKG/runner/vm_fresh_backup.py
$VMSSH "sudo sha256sum $VMRUNNER"          # E3
```

`set -C` means staging never overwrites an existing file. If one exists, compare its sha256; do not replace it.

## 3. Capture (MUTATING: brief indexd stop; root)

It runs as a transient system unit, so a dropped SSH session cannot kill it. systemd starts the unit with a clean
environment, so the test-only `FB_ROOT` cannot leak in; the output line `fb.root=/` proves this.

```
$VMSSH "sudo systemd-run --unit=enclave-indexd-fresh-backup-$RID --collect --wait --quiet \
  --property=RuntimeMaxSec=1500 --property=TimeoutStopSec=300 --property=KillMode=mixed \
  /usr/bin/python3 $VMRUNNER capture --run-id $RID --confirm fresh-backup --expect-db-version 26 \
  --expect-binary-sha256 2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc \
  --expect-geoip-sha256 18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933 \
  --quiesce-budget 600 --dump-timeout 300"; echo "systemd-run rc=$?"
$VMSSH "sudo journalctl -u enclave-indexd-fresh-backup-$RID -o cat --no-pager"     # fb.* lines: no secret content
$VMSSH "sudo python3 $VMRUNNER status --run-id $RID"                              # the authoritative read-back
```

**What the runner does, in order.** Every step is journaled and fsync'd to `/var/lib/enclave-indexd/fresh-backup/$RID.journal.jsonl`.
1. Read-only checks; any failure here refuses with exit 5 and nothing changed.
2. Creates `fresh-backup/$RID/` exclusively (mode 0700), with an O_EXCL `.owner` marker holding a random token. It records the directory's dev/inode.
3. `systemctl stop enclave-indexd`, only if the unit was `active/running`. The stop is confirmed by `inactive`, `MainPID 0`, and no `enclave-indexd`-owned `indexd` process.
4. Copies the following, each written to a new O_EXCL 0600 file, within the 600 s budget. PostgreSQL keeps running.
   - `pg_dump` (custom format; under `timeout` inside the container; `-U ${POSTGRES_USER:-postgres}`, `--lock-wait-timeout`);
   - consensus.db, the binary (through any symlink; `binaryPathWasSymlink` records which), indexd.yml (bytes only, never parsed), and GeoIP;
   - the four row counts and `db_version`, from read-only psql sessions.
5. Coupling check: the unit is still stopped and no writer exists. Otherwise the backup is invalid.
6. Resume, in `finally`, also on SIGTERM/SIGINT/SIGHUP; further signals are ignored during the resume. The unit is started only if this run stopped it. The resume is verified as `active/running` with `MainPID>0`.
7. Hashes every file and writes `manifest.json`, then re-confirms ownership. It writes `$RID.receipt.json` (O_EXCL) and the final `fb.outcome=`.

**Outcomes** (exit code = `systemd-run` rc with `--wait`):

| exit | `fb.outcome` | meaning | root's next action |
|---|---|---|---|
| 0 | `complete` | backup complete and coupled; unit resumed, or left inactive as found | step 4 |
| 3 | `failed:state-restored…` | no usable backup. The unit was verified back in its prior state, and the own partial plaintext was removed (`fb.partial=removed`), or kept if ownership was not confirmed (`preserved:…`, under `.discard-$RID-<token>`) | read the journal; fix; new run id |
| 4 | `UNRESTORED:…` / `UNKNOWN:…` | the prior state was NOT verified restored | **check and restart the unit yourself** (`systemctl start enclave-indexd`; confirm `active/running`). A `backup-complete` variant keeps its valid plaintext for you, but `pull_encrypt` refuses it (sourceResumed false). Decide separately. |
| 5 | `refused:…` | nothing was changed | fix the named precondition |

**Transport loss rule.**
- A missing or failed network response proves nothing: it cannot claim a restart, and it cannot claim a complete backup.
- Run `status` and `systemctl is-active enclave-indexd-fresh-backup-$RID`.
  - While the transient unit is `active`, the run is still in progress. Wait; never start a second run.
  - A missing receipt after the unit ended means UNKNOWN. Read the journal phases, and `fb.status.unit_now` and `writer_process_now`, before anything else.

## 4. Encrypt off-host (workstation; the existing backup-encrypt.py pipeline)

```
python3 $PKG/local/pull_encrypt.py --run-id $RID --passphrase-file work/private/indexd-recovery/backup.pass
```

- **Refuses unless** the VM receipt has `outcome=complete`, `backupComplete`, `coupled` and `sourceResumed`, and the manifest equals the receipt.
- **Stream:** `ssh sudo tar` of exactly the 7 names, into `gpg --symmetric --cipher-algo AES256 --compress-algo ZLIB`.
- **Archive:** `work/private/indexd-recovery/indexd-minipc-fresh-$RID.tar.gpg`. It is written to an O_EXCL `.partial`, published by `link()` (never overwriting), and the partial is removed on any failure.
- **Bounds and logs:** ssh keepalive, plus a 1800 s wall deadline for both processes. ssh/gpg stderr goes only to `fresh-backup-$RID.log` (0600).
- **Receipt:** `outputs/storage-fresh-backup-$RID.json`, public metadata: hashes, sizes and the manifest. It records `replicas: []` and `decryptionKeyReplicated: false`.

## 5. Verify (workstation)

```
python3 $PKG/local/verify_archive.py --run-id $RID --passphrase-file work/private/indexd-recovery/backup.pass
```

`pass` requires all of the following:
- the archive sha256 equals the receipt;
- gpg exits 0 after the stream is consumed to its authenticated end;
- the members are exactly the 7 names, each once, all regular files;
- the archive manifest equals the pull-time manifest;
- every member hash matches;
- `coupled` and `sourceResumed` are true.

The result goes to `outputs/storage-fresh-backup-$RID-integrity.json`. No plaintext is persisted.

## 6. Restore-check prerequisites (workstation; then the existing offline rehearsal)

```
IN=work/private/indexd-fresh-rehearsal-$RID          # must not exist; created 0700
python3 $PKG/local/rehearsal_input.py --run-id $RID --passphrase-file work/private/indexd-recovery/backup.pass --out-dir $IN
bash work/indexd-c2-production-rehearsal/preflight-fresh-backup.sh $IN
```

- **What is persisted:** only `retirement-snapshot/{indexd.pgdump,consensus.db,indexd,GeoLite2-City.mmdb}`, plus the same quiesced dump as `live-indexd-$RID.pgdump`. Its two receipts follow the schema of root's `work/indexd-production-rehearsal`.
- **What is not:** indexd.yml is hashed in the stream and never written (`configAndOperationsSecretsExtracted=false`).
- **Preflight:** it must print `PREFLIGHT OK`. The mock test proves its layout and receipt sections pass on such an input. Its frozen-binary, image and capacity sections depend on the machine.
- **The rehearsal itself:** `RH_INPUT_DIR=$IN RH_LIVE_DUMP=live-indexd-$RID.pgdump work/indexd-c2-production-rehearsal/run.sh <id>`. It is root's existing tool. Update its pins to the Phase A builds first; that is the rehearsal worker's scope. Run it only through the queue at its documented size.
- **Note on the controller:** this offline rehearsal is the restore check. It does not use `replicactl verify-backup`, which restores into a scratch database inside the shared production PostgreSQL. That is not needed for B2.

## 7. Remove the VM plaintext (only after step 5 passes; step 6 preferred)

```
$VMSSH "sudo python3 $VMRUNNER remove --run-id $RID --token <fb.token from step 3> --confirm remove-plaintext"
```

- It refuses unless the receipt is `complete`, the token matches, and the directory's dev/inode equals the journal's `created` entry.
- It renames the directory to a private name and re-verifies the identity, marker and own names before unlinking.
- Foreign entries mean it preserves the directory and reports `preserved:`.
- The receipt and journal are kept.

## 8. Resource bounds (from root's 2026-10-22 captures)

| resource | bound |
|---|---|
| VM disk | about 2 × (consensus.db 561 MB + GeoIP + binary + config) + 2 × db size + 1 GiB, roughly 2.4 GB; 59.5 GB free. Plaintext stays at about 0.7 GB until step 7. |
| Stopped window | stop ≤ 200 s; capture ≤ `--quiesce-budget` 600 s (expected seconds: a ~30 MB DB plus a 0.6 GB copy); start ≤ 150 s, then ≤ 60 s readiness polling. Whole unit: `RuntimeMaxSec=1500`. |
| Transfer | about 0.7 GB over the existing tunnel, ≤ 1800 s. |
| Workstation | archive ≈ 0.7 GB; rehearsal input ≈ 0.7 GB; verification streams. |
| Memory | trivial (streaming 1 MiB chunks); the mock suite peaked at 96 MiB. |

## 9. Deliberately NOT part of B2

- `work/storage-vm/replicate-backup.py`, which copies to the four DigitalOcean hosts. The archive contains indexd.yml (wallet/config secrets). Requirements forbid treating DO-hosted backups as the architecture answer, and wallet seed material must not be placed on active replicas. The off-host copy is the local workstation; the passphrase file is not replicated. A second off-host location is root's decision, and must not be DO.
- No existing capture (`recovery-20261019`, `recovery-final-20261019`, existing archives or `backup.pass`) is read, moved or deleted. No production recovery replay; no PostgreSQL restore into production.

## 10. Existing controller code/doc gap (unchanged; matters for Phase C, not B2)

`$R4/controller/replicactl.py`:
- `cmd_upgrade` and `cmd_upgrade_c2` say "stop -> fresh backup -> verify backup -> switch". In fact they call `cmd_backup` and then switch, and never call `cmd_verify_backup`.
- Root must run `replicactl verify-backup <dir>` on each upgrade's backup right after that upgrade.
- Be aware that `verify-backup` does `DROP DATABASE IF EXISTS indexd_verify; CREATE DATABASE indexd_verify` in the shared production PostgreSQL, and restores about 30 MB into it.
- B2 itself avoids that shared-PG restore (§6).
