# Retention activation r2: root's 18-vs-26 bug fixed; offline PASS 15/15 incl. the REAL pinned manifest; NOT run live

**Stage:** `base-retention-stage/activation-r2/` (read-only).
- **Kept unchanged** (verified): r1 `base-retention-stage/activation/` (`bc9cfdbc…`) and its receipts (FAIL `logs/claude-retention-activation-tests.out` 2/13; PASS `…-tests-2.out` 13/13 on the wrong synthetic model).
- **Not done:** no live operation, no SSH, no commits. Production is unchanged.

| File | sha |
|---|---|
| `SHA256SUMS` | `409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92` |
| `retention_guard.py` | `3eff725f00e728eeb851429b0b078dd6a17b75274fe62476808209e076d35897` |
| `enclave-base-retention.service` | `f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee` |
| `retention_activate.sh` | `605ba3740923545bda47425f6c8a1ccb51c98378e7fd8b0b8fdf6f349d405063` |
| `cached_download_preflight.py` | `af70424c…` (v2 copy) |
| `test_retention_guard.py` | `112f9730…` |

## The bug (root's review, confirmed)
r1's `EXPECTED_ARCHIVES = 18` was compared with the **total selected** archives. The real pinned manifest (`outputs/…/base-download-tuning/snapshot-manifest-observed.json`, sha `1f0c4e6c…` = the pin) under the v2 plan (48000000 / 52500000) selects **26**:

| Component | Chunks |
|---|---|
| transactions | 96..106 (11) |
| receipts | 96..106 (11) |
| account_changesets | 105..106 (2) |
| storage_changesets | 105..106 (2) |

Only **18** are **missing** after the first download: 221,616,054,366 B compressed and 409,990,674,216 B extracted, which I recomputed from the real manifest. So r1's `pre`/`post` would have refused forever. My r1 tests used a synthetic manifest shaped to select 18 and therefore could not see it.

## r2 fix
- **Exact selection:** `EXPECTED_SELECTION` pins the exact components and chunk ranges (26 total). Any other plan is `policy drift`, in both `pre` and `post`.
- **First batch:** `pre` requires the **8 first-download archives** (chunks 105..106 of all four components) to be present. Absent ones refuse (wrong datadir or damage). The missing count may be anything (18 initially, fewer on each resume); it is never required to be 18.
- **Completion:** `post` writes the marker only when **all 26** are present at their exact manifest sizes, and the selection is the pinned one.
- **Concurrency:** `--download-concurrency 16` (root's actual live override; the same `MemoryMax=4G`). The guard's expected argv and the unit's `ExecStart` both use 16; a test asserts they are equal.
- **Busy check:** `retention_activate.sh start` now uses `systemctl show --property=ActiveState --value`. It allows only `inactive` or `failed`, and refuses `activating` (a running oneshot), `deactivating`, `active` and anything else. r1 used `is-active --quiet`, which is false for `activating`.
- **Marker:** the completion marker is created 0444 (`fchmod`, independent of the umask), root-owned, atomic and never overwritten.
- **Kept from r1:**
  - no `--force`/`--prune-unlisted`;
  - no restart of a healthy first download (the guard requires it finished, and the script never names it);
  - `Conflicts=` and `After=enclave-base-holder.service`;
  - no `[Install]`, `Restart=no`;
  - the first unit's `snapshot-complete` precondition;
  - partial-archive and leftover reporting without deletion.

## Namespace review (`+` steps, `systemd.service(5)`)
- **`ExecStartPre=+…guard pre` and `ExecStartPost=+…guard post`** run as root with full privileges. `User=`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` and `ReadWritePaths` are **not** applied to `+` commands, and no `PrivatePIDs`/`ProtectProc` is set. Therefore:
  - the `/proc` scan sees every guest process;
  - `systemctl show` works;
  - `post` can create `/srv/enclave-base-holder/retention-complete`, which lies outside `ReadWritePaths`.
- **The download and the non-`+` `sync`** run as `rpcbase` under the full sandbox.
- **Residual (documented):** a direct `systemctl start enclave-base-retention.service` that bypasses the script would, through `Conflicts=`, stop an already-running holder **before** `+pre` runs, and `+pre` would then see it inactive. The holder-*enabled* check still applies. `retention_activate.sh start` checks the guard **before** starting, so this cannot happen on the supported path. Root should use only the script.

## Actual tests (offline, shared queue 512 MiB, `unshare -Urn`, `env -i`)
`bash jobs/q-exit-status.sh claude-retention-activation-r2-tests 512 unshare -Urn /usr/bin/env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I base-retention-stage/activation-r2/test_retention_guard.py`

**Receipt:** `logs/claude-retention-activation-r2-tests.out` (`2fc150d6…`), `.rc` = 0: **`Ran 15 tests` `OK`**, `[queue] EXIT 0`, peak 42 MiB.

**RealManifest (2), on the REAL sha-verified manifest with sparse files at the exact manifest sizes:**
- the exact 26 selection is pinned, and 8 are first-batch;
- the lifecycle:
  1. first batch present → admitted, `missingArchives` 18, and the preflight's missing bytes are exactly 221,616,054,366 / 409,990,674,216;
  2. resume (5 more archives, receipts 96 partial) → admitted, 13 missing, the partial reported, `post` refuses with no marker;
  3. all 26 → `post` writes the marker (26 archives);
  4. `pre` then refuses (`already exists`).

**Synthetic (13; fixtures mirror the real shape: 107 chunks × 500000):**
- admission with 18 missing;
- the first unit `activating`/`auto-restart`/failed/not-found, and a missing marker;
- the holder active/activating/enabled;
- each datadir-user kind;
- pins;
- a capacity refusal and policy drift (30 selected);
- **a first-download archive absent**;
- the memory floor;
- partial/leftover reporting without deletion;
- `post` needs all 26 and writes a 0444 marker once;
- the unit shape (concurrency 16, conflicts and ordering);
- pins == sources;
- the script's busy check and conservatism.

## Root procedure (unchanged apart from the files)
`retention_activate.sh install | check | start | status | stop`, inside the guest, only once `enclave-rpc-base-snapshot.service` has finished successfully. Root reports it currently `activating`/extracting, so this is not yet the time. Stop and rollback are as in the r1 report: nothing is deleted, resume with `start`, `reth.toml` is backed up, and the holder stays disabled.

## Limits
- **Live:** the guard has not been run against the live guest.
- **reth internals:** reth temp names and any `reth.toml` rewrite are not source-verified (hence the leftover heuristics and the backup).
- **Marker meaning:** the marker means presence at the right sizes, not authenticated coverage (that is the separate coverage gate).
