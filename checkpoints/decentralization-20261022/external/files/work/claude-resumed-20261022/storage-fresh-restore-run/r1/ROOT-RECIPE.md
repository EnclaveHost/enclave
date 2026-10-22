# One actual fresh-restore rehearsal on backup 20261022T075011Z-bee519f1 — ROOT RECIPE (nothing here ran a database)

**Provenance.**
- Root captured this backup itself: coupled, quiesced (the writer was stopped for 1.424 s), source resumed, encrypted and integrity-verified. No schema migration was done.
- No "user hold" applies. The effective requirements' 2026-10-22 provenance correction records no human storage hold, so this rehearsal needs only root's own review.

**What runs.**
- The unchanged storage-enclave-rehearsal module: all 20 phases (setup, S0–S10, L0–L6), every assertion, its pins, its rhfx/c2fx ownership cleanup and its refusals.
- `fresh_rehearsal.py` only rebinds five module globals: `INP`, `SNAP`, `LIVE`, the source of `indexd-original` (same `ORIG_SHA` 2d7a637e), and `RUNS` (this package's `runs/`).
- Before the module runs, it validates the fresh receipt chain.
- The other worker's package is read, never written.

All commands below run from `/home/steven/Documents/Codex/2026-10-18/wo`, with `P=work/claude-resumed-20261022/storage-fresh-restore-run`.

## 0. Pins (`$P/PINS.sha256`)

| item | sha256 |
|---|---|
| fresh_rehearsal.py | see `PINS.sha256` (the manifest covers it) |
| run.sh | see `PINS.sha256`. It is base run.sh 54185b5c, except for the work path depth and the entry point. |
| base module `storage-enclave-rehearsal/rehearse/rehearse-c2.py` | b12b9fde91f56494e5e2e8a0d5d68df11bd0fd1ef611a9a31cf46d4174c4a31b (refused otherwise) |
| base `rehearse/rhfx.py` | b3c2c62b53e5162e8f3c191b7a87139af06a4772bebcca75725c40be9c29ac4e (refused otherwise, checked before and after import) |
| c2fx.py (checked by rhfx) | ff1b092c54135df64b506b1683fb48679f678f21e6ec5d28ef6fb54a66534ad6 |
| tool pins (`storage-enclave-rehearsal/tools/pins.json`, d36ab0e0 at plan time) | rehearsaltool-v27 138605ff…, c2tool e5d15737…, c2rclient aa500372… |
| backup receipt `outputs/storage-fresh-backup-20261022T075011Z-bee519f1.json` | 3a04c1d5979d3897a545bdacf59026f8cd87cbca713ed93bedf24248f136b0e8 |
| integrity `outputs/storage-fresh-backup-20261022T075011Z-bee519f1-integrity.json` | 9e017242b7db905e6b2c0cb26d75d3927f9cbdf0ceb79e0e9ae550aa84e6ab01 |
| archive `work/private/indexd-recovery/indexd-minipc-fresh-20261022T075011Z-bee519f1.tar.gpg` | fc17cf6c60d08e9dce3b012b415f89bd7db9e8ce68532d3a7e10cad5dcde804e (hashed, never decrypted here) |
| input receipts (extraction / live dump) | 136cb491… / 32c9742d… |
| input bytes | indexd.pgdump 668cbe90… (= live dump, coupled), consensus.db 4864bd26…, indexd 2d7a637e…, GeoLite2 18bf1695… |

## 1. Fresh-input gate (both `--plan` and `--execute`, before any module action)

1. The backup and integrity receipts match the pinned hashes.
2. `runId` is the same in all receipts.
3. The VM outcome is `complete`, `coupled` and `sourceResumed`.
4. The snapshot is `quiesced`, `coupled`, `sourceResumed`, `writerWasActive`, `dbVersion` 26, binary 2d7a637e.
5. No replicas, and no replicated key.
6. Every integrity check passed, and the integrity result names the same archive.
7. The archive bytes match the receipt.
8. In the input dir:
   - the extraction receipt names this run's authenticated archive, `configAndOperationsSecretsExtracted:false`, and exactly the four persisted files;
   - their hashes equal **the archive manifest's** hashes, and the counts and `capturedAt` equal the manifest;
   - the live dump is `coupled-quiesced` and equals the archive's `indexd.pgdump`;
   - the directory is 0700, the files 0600, and nothing else is present (no `indexd.yml`);
   - every input byte matches its receipt.
9. The **old captures are refused**. `work/indexd-production-rehearsal` has no run id and no coupled-quiesced receipt; a test checks this. A run can therefore never present an old capture as fresh.
10. The module's results gain `inputProvenance`: the validated facts above, the wrapper sha and the manifest. setup()'s own literal `freshQuiescedCutoverBackup: false` is the base module's unchanged return value, and is labelled as such.

## 2. Plan (no side effects; queue 256)

```
python3 work/claude-test-queue.py --mib 256 --log $P/logs/plan-root-<unique>.guard.log -- python3 -B -u $P/fresh_rehearsal.py --plan
```

- It must exit 0, with `freshProblems: []` and `baseProblems: []`.
- Worker plan at 2026-10-22T08:01:30Z (`logs/plan1.out`): exit 0, manifest `e0cbbba52ceb594e1450211a57c0a0ffd37a1c9f87b4b7341627ab4ab5a697ab` (base manifest `615511657d1dea34…`).
- The manifest changes if any pin changes (tool pins.json, base files, receipts, wrapper). Re-plan after any change.

## 3. Execute: ONE job (root; docker; PostgreSQL; the approved envelope queue 512 + PG 256 + tool 256)

```
$P/run.sh <manifest from step 2> $P/logs/rehearsal-<unique>.guard.log
```

This is exactly the base `run.sh` shape:
- one shared-queue job of 512 MiB, `RH_UID`/`RH_GID`, `taskset -c 0-1`;
- a fresh `unshare --user --map-root-user --net`, then `ip link set lo up`;
- the module re-checks every pin, the isolation and the queue scope (≤ 512 MiB), and refuses otherwise;
- docker sits outside the queue: one PostgreSQL at 256m (network none, socket only), and one tool container at a time at 256m.

Exit 98 is "not started", so re-invoke deliberately with a new log. 99 means killed. Neither is a pass.

Read `$P/runs/<id>.results.json`:
- `passed` requires all 20 phases plus a certain cleanup;
- exit 1 means a phase failed (cleanup certain); 2 means refused; 3 means cleanup uncertain.
- On 3, keep everything, then run `python3 work/claude-test-queue.py --mib 256 --log <unique> -- python3 -B -u $P/fresh_rehearsal.py --recover <id>`. That is the module's identity-checked recovery on this package's `runs/`.

## 4. Coverage, and whether the old captures are needed

- **This run covers every phase of the old-capture rehearsal on the fresh, coupled production state:**
  - S0 checks counts against the fresh receipt (objects 1491, slabs 562, contracts 78, accounts 1);
  - then the full v26→27→28 controller path, fixture ops, admin block/unblock, SIGKILL restart, the C2 rollbacks, and 27→26 back to the deployed binary;
  - the L track does the same on the live dump.
- **Difference from the old captures:** the backup is coupled, so the L track's "live dump" is **the same quiesced dump** as the S snapshot (`liveDumpIsSnapshotDump: true`). L0's schema equality is then by construction. L1–L6 still exercise the tool-driven migrations on their own restored copy.
- **The old captures are optional, not required:**
  - they add only a second, older and different dataset (the historical retirement snapshot plus a separately captured live dump);
  - run2 already passed 20/20 on them with the old binaries;
  - run them with the new binaries only if root wants that extra dataset; they are not needed for the fresh-state evidence.
- **Not covered:**
  - production execution;
  - the real wallet: `wallet_hash` is NULLed, and the fixture seed comes from `indexd seed`;
  - real Sia hosts and contracts (`slabs.migrations:false`, no peers);
  - DO/replica independence;
  - Phase C itself;
  - the controller's own `cmd_upgrade` verify gap. The rehearsal's S2 runs `verify-backup` explicitly, inside the disposable PostgreSQL, never the shared production one.

## 5. Exclusions

- No change to the frozen storage-enclave-rehearsal package (its files are pinned and only read; no runs land there), to its manifests, or to the backup and its archive.
- No config, key or passphrase read, and no decryption.
- No duplicate heavy test: the worker ran only static tests (`logs/t1.out`, 8/8, queue 256) and one `--plan` (queue 256).
