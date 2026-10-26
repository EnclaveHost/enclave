# Second (cached retention) Base download: reviewed guard + unit + root script: PREPARED, offline PASS 13/13; NOT run live

**Stage:** `base-retention-stage/activation/` (read-only). **Not done:** no SSH, no live execution, no network, no commits. The holder, the first download unit and `v2` are untouched.

| File | sha |
|---|---|
| `SHA256SUMS` | `bc9cfdbc9bf03d8ff785c166b31af59f95718ad9277ce342b10a94a6dd85d4e8` |
| `retention_guard.py` | `9bcfc4f358f91284e58a0e5e75afc2faea7629d76e14437843c83cb97c616a4e` |
| `enclave-base-retention.service` | `871cf44f9c6958e55833055d5b3aa8cb210014341707fbf9aca5f30044c553e1` |
| `retention_activate.sh` | `af9d2646c60b19ad972cdb7da234b15eece34d87a0e4e395ded72508590d92d3` |
| `cached_download_preflight.py` | `af70424c…` (byte copy of the tested `v2`) |
| `test_retention_guard.py` | `b15b4798…` |

## Sources used (in-tree; no live state read)
- **First download:** `payload-v2/units/enclave-rpc-base-snapshot.service`. A oneshot whose success path alone writes the root-owned `/srv/enclave-base-holder/snapshot-complete`; it has `Restart=on-failure`.
- **Holder:** `node-payload/units/enclave-base-holder.service`. The PLAN guest facts say the holder `.service` and `.path` are disabled.
- **Pins:**
  - base binary `9c44836d…` = r12-final `base_launch.py` `HARNESS_BINARY_SHA256` = the production `/opt/enclave-rpc/manifest.json` `binaries.base`;
  - snapshot manifest `1f0c4e6c…` = `harness-first/a2a4.py:52 MANIFEST_SHA`.
- **Policy:** the tested `v2/cached_download_preflight.py` (36 + 6 tests OK): history ≥ 48000000, state history ≥ 52500000, never `--force`/`--prune-unlisted`.

## Guard (`retention_guard.py`, root, read-only except `post`)
**`pre`** (exit 0 admitted, 3 refused, JSON). It requires **all** of:
1. **First download done:** `enclave-rpc-base-snapshot.service` is loaded, `inactive`/`dead`, `Result=success`, `ExecMainStatus=0`, **and** `snapshot-complete` is a root-owned regular file. A running, failed, restarting or never-completed first download refuses; the guard never touches it.
2. **Holder off:** `enclave-base-holder.service` and `.path` are not active/activating, and **not enabled** (`disabled`, `masked` or `masked-runtime` only).
3. **Datadir unused:** no process has cwd/root/exe/open fd under `/srv/enclave-base-holder/data`, and no process runs the base binary (a `/proc` scan).
4. **Pins:** the binary sha, the install manifest's `binaries.base` and the snapshot manifest sha all match; the files are root-owned, with no group/other write and no symlink.
5. **Capacity and policy:** the **pinned preflight** admits read-only capacity. Exactly **18** archives are selected (any other count = policy drift). Its command == the unit's `ExecStart` argv.
6. **Memory:** guest `MemAvailable` ≥ **16 GiB floor + 4 GiB** unit `MemoryMax`. The VM's fixed 64 GiB is unchanged; the host floor is the queue's.
7. **Not already done:** `retention-complete` is absent.

**`status`** is read-only: the unit states, missing archives, **partial extraction** (selected outputs present with a wrong size), **leftovers** (manifest archive file names or `*.part`/`*.tmp`/`*.download` in `data/` and `data/static_files/`) and datadir users.

**`post`** runs as the unit's root `ExecStartPost`. Only if **every** selected output is present at its manifest size (and the manifest is still pinned) does it write the **distinct** marker `/srv/enclave-base-holder/retention-complete` (JSON: manifest/binary shas, policy, 18 archives, argv, time). The write is atomic: tmp + fsync + rename + directory fsync. It never overwrites, and never touches `snapshot-complete`.

## Unit (`enclave-base-retention.service`)
- **Not auto-started:** **no `[Install]`** (never enabled) and `Restart=no`.
- **Conditions:** `ConditionPathExists=/srv/enclave-base-holder/snapshot-complete` and `ConditionPathExists=!…/retention-complete`.
- **Steps:** `ExecStartPre=+guard pre`, then `ExecStart` = the exact preflight command (`--download-concurrency 8`, as in the first unit, inside 4 GiB), then `sync`, then `+guard post`.
- **Holder exclusion:** `Conflicts=enclave-base-holder.service`. Systemd never runs both: if anything pulls the holder in, **this download is stopped** (resumable). It is **not** in conflict with the first download, so it can never stop or restart it.
  - **Why not a runtime mask:** I rejected `systemctl mask --runtime` because `/run` has lower precedence than the installed `/etc` holder unit, so the mask could silently not apply. The holder's unit files are untouched.
- **Properties as requested and identical to the first unit:**
  - `User/Group=rpcbase`, `HOME=…/data`, `TMPDIR=…/tmp`;
  - `MemoryMax=4G`, `MemorySwapMax=0`, `TasksMax=1024`, `Nice=10`;
  - `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, `UMask=0027`;
  - `ReadWritePaths=` data + tmp;
  - `TimeoutStopSec=120`, `KillMode=control-group`.

## Root procedure (inside the guest; run only once the first download is terminal)
```
# copy base-retention-stage/activation to the guest (root), then:
bash retention_activate.sh install     # sha-checked against SHA256SUMS; an existing DIFFERENT file refuses; daemon-reload
bash retention_activate.sh check       # read-only guard: must print "admitted": true
bash retention_activate.sh start       # guard again; one-time copy of data/reth.toml to retention-backup/ (+sha); start --no-block
bash retention_activate.sh status      # progress: missing/partial archives, markers, units
```
**Completion:** the unit ends `inactive`/`success` **and** `retention-complete` exists (`status` shows `retentionComplete: true`, `missingArchives: 0`). The holder stays **disabled**; starting it, and the coverage gate (PLAN P3), are separate root steps.

## Stop and rollback (exact)
- **Stop:** `retention_activate.sh stop` → `systemctl stop` (SIGTERM, SIGKILL after 120 s, whole cgroup), then `status`. **Nothing is deleted.**
  - **Left behind:** already-extracted archives (reused by reth `--resumable` after its own hash check) and at most the in-flight archive's leftovers or partial outputs, which `status` reports.
  - **Resume:** `retention_activate.sh start` (the guard re-admits; capacity is recomputed for the still-missing archives).
- **Failure:** `Restart=no`, so it stays failed with no marker. Inspect with `status`, then resume with `start`. Nothing auto-resets or deletes unknown state.
- **Rollback:** no automatic data rollback exists. The first snapshot's data and `snapshot-complete` are never deleted by this path (no `--force`/`--prune-unlisted`).
  - **reth.toml:** the pre-start copy is in `/srv/enclave-base-holder/retention-backup/reth.toml` (+ `.sha256`) for a manual restore if the download changed it.
  - **Removing the unit:** a manual root step (`systemctl stop`, remove `/etc/systemd/system/enclave-base-retention.service`, `daemon-reload`).
  - **Holder protection:** if the retention data is incomplete, the holder wrapper's history coverage checks (`history_files_present`/`segment_files_present` in the r12-final+ wrapper) refuse to start, which fails closed.

## Actual tests (offline, shared queue 512 MiB, `unshare -Urn`, `env -i`)
1. **`claude-retention-activation-tests`: FAIL 2/13** (rc 1; receipt `logs/claude-retention-activation-tests.out` `11162a1d…`, kept). Both were **test defects**:
   - the datadir-user loop planted a fake process in a stale temp tree (the guard correctly admitted);
   - `assertNotIn('[Install]')` matched my own comment.
   I fixed only the tests and re-froze the stage (new `SHA256SUMS` above).
2. **`claude-retention-activation-tests-2`: PASS.** `Ran 13 tests`, `OK`, `[queue] EXIT 0`, rc 0 (`logs/claude-retention-activation-tests-2.out` `573b05ad…`).

**Covered:**
- admission;
- the first download running, failed, restarting or not loaded, and the marker missing or a symlink;
- the holder active/enabled vs disabled/masked;
- each datadir-user kind (cwd/fd/exe/root);
- each pin;
- a capacity refusal and policy drift (20 archives);
- the memory floor boundary;
- never re-running or overwriting a completed marker;
- partial and leftover reporting without deletion;
- `post` writing the marker only when complete (wrong sizes refuse; atomic, no tmp left);
- the unit's exact shape and `ExecStart` == the preflight argv;
- the shipped pins == their sources (and the preflight copy == `v2`);
- the activation script never runs `rm`/`--force`/`mask`/`enable`/restart or starts the holder or the first download.

## Limits (state honestly)
- **Live unit identity:** the live guest unit names, marker path and `systemctl show` values were not read; they come from the in-tree source units. Root must confirm the live first-download unit is `enclave-rpc-base-snapshot.service` with the same marker. If root's captured original differs, `FIRST_UNIT` must be changed (and the change reviewed).
- **reth behaviour:** reth's on-disk temp names and whether `snapshot download --with-*-since` rewrites `reth.toml` were not source-verified here; hence the leftover heuristics and the `reth.toml` backup.
- **Marker meaning:** the marker means selected outputs are present at manifest sizes (reth hash-checks during download). It is **not** authenticated coverage; that is the separate coverage gate.
- **Network:** the download needs guest network access (the unit wants `network-online.target`).
