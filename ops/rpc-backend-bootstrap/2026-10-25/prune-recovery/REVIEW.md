# Prune profile defect: cause, launcher fix and one-time recovery

**Status: the source fix and recovery tool are verified offline. NOT installed, NOT live, not committed.** Root does the live install and restart after review. No SSH, no live access, no keys, no image build.

Touched paths:
- `source/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py` and `test_chain_service.py` (ops worktree at `ccc8b5fdc`, uncommitted).
- New `prune-recovery-stage/`.
- This report.

The readiness sampler is untouched.

Report path: `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/claude-prune-recovery-result.md`.

## 1. Cause

The cause is established from the pinned source and reproduced with BOTH pinned binaries.

**Source.** base/reth `7134be3`, the exact rev base v1.5.1 pins (`~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3`):

1. **The whole prune section is replaced and saved.** At launch, `crates/node/builder/src/launch/common.rs:161-212` runs `load_toml_config` → `save_pruning_config`:
   ```rust
   if let Some(prune_config) = config.prune_config() {        // any --prune.* flag given
       if reth_config.prune != prune_config {
           reth_config.set_prune_config(prune_config);         // config.rs:44  self.prune = prune_config  (REPLACE)
           should_save = true; } }
   ... reth_config.save(config_path)
   ```
2. **The CLI config starts from defaults.** `PruningArgs::prune_config` (`crates/node/core/src/args/pruning.rs`, same in reth v2.8.0's local `pruning.rs`) starts from `PruneConfig::default()`:
   - `block_interval` 5 (`DEFAULT_BLOCK_INTERVAL`)
   - `minimum_pruning_distance` 10064 (`MINIMUM_UNWIND_SAFE_DISTANCE = 32*2+10_000`)
   - every segment `None`

   It then sets only the flags given. The old launcher passed only `--prune.transaction-lookup.distance 140000`.
3. **What the live client did.** On the first start it replaced the snapshot profile with `{block_interval 5, minimum 10064, segments {transaction_lookup: distance 140000}}` and saved it. That is exactly the live file root observed.

   The runtime merge (`common.rs:426-438`, `cli.merge(toml)`) runs after the replacement. So the RUNNING EL now runs with sender_recovery, receipts, account/storage history and bodies **unpruned (None)**. It deletes nothing, but it accumulates beyond the 140000-block bound until it is restarted with the fixed launcher.

   The launcher comment "the explicit CLI distance below is persisted after first start" was wrong: it persists AND erases everything else.

**Offline confirmation with the pinned binaries.** Both runs used `unshare -rn`, throwaway `/tmp` datadirs, and a seeded synthetic snapshot profile (`prune-recovery-stage/snapshot-profile.toml`). The binaries were reth `8cdd1f35…d250` (v2.8.0) and base `9c44836d…e53f` (v1.5.1).
- **Logs.** `prune-recovery-stage/logs/offline2.out` (guard peak 303 MiB, 1024 cap, floor kept). The earlier `offline1.out` is kept; its reth leg failed on a harness flag conflict, while its base leg had already reproduced the defect.
- **Old argv** (lookup flag only):
  - Both binaries rewrote reth.toml to exactly `[prune] block_interval = 5 / minimum_pruning_distance = 10064 / [prune.segments.transaction_lookup] distance = 140000`.
  - All other segments are gone; `[static_files.blocks_per_file]` is preserved.
  - The files are byte-identical across the two binaries (`f905165e…8f76`).
- **New argv** (the launcher's complete flags):
  - Every segment is retained; lookup becomes `{distance = 140000}`.
  - The canonical file (`80c28b89…58d7`) is identical for both binaries.
  - A **second launch left reth.toml byte-identical** for both: no further rewrite, stable across restarts.
- **Repair, then new-argv launch:**
  - The repaired defect file equals the canonical bytes `80c28b89…`.
  - The client left it **byte-identical**: it is already exactly what the client would write.
  - Non-prune content was preserved, checked by parse comparison.
- **Help output.** Both binaries list the same `--prune.*` flags, including `--prune.block-interval`, `--prune.minimum-distance`, `--prune.sender-recovery.full`, `--prune.{transaction-lookup,receipts,account-history,storage-history}.distance` and `--prune.bodies.distance` (`offline1.out`).
- **Limits.** These are fresh datadirs (a genesis-only DB) with a synthetic seeded profile. The live DB and the live file's other sections were not touched or seen. reth's exit 124 is just my 25 s timeout. base exited by itself, with L1 unreachable, after the toml step.

## 2. Launcher fix (`chain_service.py`, Ethereum EL and Base)

Hashes:
- before `6d93c8b7…4b9e` (copy in `prune-recovery-stage/logs/chain_service.py.before`)
- after **`a7adf5e6ba228bc7532f6ceb2591b4c28acd92df5bd021a2e510972c71795e40`**

**`prune_args(profile)`** derives the COMPLETE prune CLI from the validated persisted profile:
- **The mapping is lossless.**
  - `block_interval` and `minimum_pruning_distance` come from the toml, or the client defaults 5/10064 if absent.
  - `sender_recovery` must be `"full"`.
  - receipts, account_history, storage_history and bodies_history must each be `{distance ≥ 140000}`. The value is passed through, never reduced.
  - Snapshot `transaction_lookup = "full"` (no index) → `--prune.transaction-lookup.distance 140000`. This is intentional: the lookups for the retained range are kept or rebuilt. An existing `{distance ≥ 140000}` is passed through.
- **Settings the CLI can't reproduce are refused, not dropped:** unknown prune keys or segments, a non-empty `receipts_log_filter`, `before` modes, short distances, and sender_recovery other than full.
- **Same flags for both clients.** Both `el` and `base` pass the same `*prune` flags in place of the old single lookup flag. There is no `--full` or `--minimal`.
- **Missing-profile checks are not waived.** An already-rewritten file is still REFUSED by the launcher (`snapshot prune profile missing`). The only way back is the explicit repair in §3.

Exact flags for the snapshot profile (asserted by a test, and used verbatim in the offline job):

```
--prune.block-interval 5 --prune.minimum-distance 10064 --prune.sender-recovery.full
--prune.receipts.distance 140000 --prune.account-history.distance 140000
--prune.storage-history.distance 140000 --prune.bodies.distance 140000 --prune.transaction-lookup.distance 140000
```

**Semantics of `sender_recovery = full`.** `PruneMode::Full` prunes the segment for all blocks (`crates/prune/types/src/mode.rs:13`; segments with `min_blocks > 0` treat Full as `Distance(min_blocks)`, `mode.rs:58-59`). Sender data is not retained.
- reth's pruning docs (`docs/.../storage/pruning.mdx:52-58`, RPC tables `:228-260`) show sender-recovery pruning as compatible with every listed eth/debug RPC. reth's own `--full` preset uses it too.
- This was the snapshot's own setting. The fix keeps it; it does not add it.
- The live node currently stores senders for new blocks (None). Restoring Full lets the pruner drop those.

Exact diff (`prune-recovery-stage/logs/chain_service.diff`):

```diff
diff --git a/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py b/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py
index c7e647f8b..27a6c9c2e 100644
--- a/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py
+++ b/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py
@@ -98,6 +98,50 @@ def forwarding_args():
     # Submission only. This endpoint never supplies state, headers, proofs or fees.
     return ['--rpc.forwarding-endpoint', endpoint]
 
+RETAINED_BLOCKS = 140000
+DEFAULT_BLOCK_INTERVAL = 5          # reth/base-reth crates/config DEFAULT_BLOCK_INTERVAL
+DEFAULT_MINIMUM_DISTANCE = 10064    # MINIMUM_UNWIND_SAFE_DISTANCE = 32 * 2 + 10_000
+HISTORY_FLAGS = (('receipts', 'receipts'), ('account_history', 'account-history'),
+                 ('storage_history', 'storage-history'), ('bodies_history', 'bodies'))
+
+def _uint(v):
+    return isinstance(v, int) and not isinstance(v, bool) and v >= 0
+
+def prune_args(profile):
+    """Complete prune CLI equal to the persisted snapshot profile (lookup kept for the retained range).
+
+    Pinned reth/base-reth (launch/common.rs save_pruning_config) REPLACES the whole [prune] section of reth.toml
+    with the CLI-only PruneConfig whenever any --prune.* flag is given; a partial flag set therefore erases every
+    other segment. So every setting is passed explicitly, taken from the validated profile and never reduced.
+    Settings the CLI cannot reproduce losslessly are refused instead of being silently dropped.
+    """
+    prune = profile.get('prune', {})
+    segments = prune.get('segments', {})
+    assert isinstance(prune, dict) and isinstance(segments, dict), 'snapshot prune profile missing'
+    assert set(prune) <= {'block_interval', 'minimum_pruning_distance', 'segments'}, 'unsupported prune setting'
+    assert set(segments) <= {'sender_recovery', 'transaction_lookup', 'receipts_log_filter'} | {n for n, _ in HISTORY_FLAGS}, 'unsupported prune segment'
+    assert not segments.get('receipts_log_filter'), 'receipt log filter pruning unsupported'
+    assert segments.get('sender_recovery') == 'full', 'snapshot prune profile missing'
+    interval = prune.get('block_interval', DEFAULT_BLOCK_INTERVAL)
+    minimum = prune.get('minimum_pruning_distance', DEFAULT_MINIMUM_DISTANCE)
+    assert _uint(interval) and interval >= 1 and _uint(minimum), 'invalid prune interval/minimum distance'
+    args = ['--prune.block-interval', str(interval), '--prune.minimum-distance', str(minimum),
+            '--prune.sender-recovery.full']
+    for name, flag in HISTORY_FLAGS:
+        mode = segments.get(name)
+        assert isinstance(mode, dict) and set(mode) == {'distance'} and _uint(mode['distance']) \
+            and mode['distance'] >= RETAINED_BLOCKS, 'bounded history retention too short'
+        args += [f'--prune.{flag}.distance', str(mode['distance'])]
+    lookup = segments.get('transaction_lookup')
+    # Downloads omit the lookup index ('full' = none kept); the client rebuilds the retained range.
+    if lookup == 'full':
+        distance = RETAINED_BLOCKS
+    else:
+        assert isinstance(lookup, dict) and set(lookup) == {'distance'} and _uint(lookup['distance']) \
+            and lookup['distance'] >= RETAINED_BLOCKS, 'transaction lookup retention missing'
+        distance = lookup['distance']
+    return args + ['--prune.transaction-lookup.distance', str(distance)]
+
 def run(side):
     role = 'base' if side == 'base' else 'l1'
     base = mount(role, side)
@@ -106,24 +150,16 @@ def run(side):
     datadir = base + ('/cl' if side == 'cl' else '/data')
     if side in ('el', 'base'):
         profile = tomllib.loads(pathlib.Path(datadir, 'reth.toml').read_text())
-        segments = profile.get('prune', {}).get('segments', {})
-        assert segments.get('sender_recovery') == 'full', 'snapshot prune profile missing'
         assert profile.get('static_files', {}).get('blocks_per_file'), 'snapshot segment sizes missing'
-        for name in ('receipts', 'account_history', 'storage_history', 'bodies_history'):
-            mode = segments.get(name)
-            assert isinstance(mode, dict) and mode.get('distance', 0) >= 140000, 'bounded history retention too short'
-        lookup = segments.get('transaction_lookup')
-        # Downloads omit RocksDB lookup indices; the client rebuilds the retained
-        # range. The explicit CLI distance below is persisted after first start.
-        assert lookup == 'full' or (isinstance(lookup, dict) and lookup.get('distance', 0) >= 140000), 'transaction lookup retention missing'
+        prune = prune_args(profile)
     env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': datadir, 'TMPDIR': base + ('/tmp-cl' if side == 'cl' else '/tmp')}
     jwt = '/etc/enclave-rpc/jwt.hex'
     if side == 'el':
-        # The snapshot wrote the exact 140000-block prune profile to reth.toml.
-        # Do not override it with --full (which applies a different preset).
+        # The snapshot wrote the exact 140000-block prune profile to reth.toml. Pass all of it (never --full,
+        # a different preset): any partial --prune.* set would replace the persisted profile.
         a = [binary('reth'), 'node', '--chain', 'mainnet', '--datadir', datadir,
              '--http', '--http.addr', '127.0.0.1', '--http.port', '18645', '--http.api', 'eth,net,web3',
-             '--prune.transaction-lookup.distance', '140000',
+             *prune,
              '--rpc.max-connections', '64', '--authrpc.addr', '127.0.0.1', '--authrpc.port', '18651',
              '--authrpc.jwtsecret', jwt, '--ipcdisable', '--addr', '0.0.0.0', '--port', '30313',
              '--discovery.addr', '0.0.0.0', '--discovery.port', '30313', '--discovery.v5.addr', '0.0.0.0',
@@ -157,7 +193,7 @@ def run(side):
         a = [binary('base'), '--chain', 'mainnet', 'rpc', '--datadir', datadir,
              '--http', '--http.addr', '127.0.0.1', '--http.port', '18545', '--http.api', 'eth,net,web3',
              '--txpool.disable-transactions-backup',
-             '--prune.transaction-lookup.distance', '140000',
+             *prune,
              '--rpc.max-connections', '64', '--rpc.eth-proof-window', '1800', '--ipcdisable',
              '--addr', '0.0.0.0', '--port', '30303', '--discovery.addr', '0.0.0.0', '--discovery.port', '30303',
              '--discovery.v5.addr', '0.0.0.0', '--discovery.v5.port', '9200',
```

## 3. One-time repair for the already-rewritten live reth.toml

Tool: `prune-recovery-stage/prune_profile_repair.py`, sha256 `ceff9584c95f8d0a7e734fa30f3b27c67f4354203cb981bc81767950660004cb`. It is stdlib only.

**It is not a generic auto-heal.** It acts only if ALL of the following hold:
- The client binary sha256 equals the pin: reth `8cdd1f35…`, or base `9c44836d…`.
- reth.toml is a regular, non-symlink file under 1 MiB.
- The parsed `[prune]` equals EXACTLY the defect signature `{block_interval 5, minimum_pruning_distance 10064, segments {transaction_lookup {distance 140000}}}`.
- The prune table headers are exactly `[prune]` and `[prune.segments.transaction_lookup]`, in the client's serialization shape.
- `static_files.blocks_per_file` is present.
- No previous `.pre-prune-repair` backup exists.

**What it changes.**
- It inserts only the five missing entries, in the client's own order and format: `sender_recovery = "full"`, then receipts, account_history, storage_history and bodies_history `{distance = 140000}`.
- Every existing byte is preserved. Internal checks confirm that the parse equals the original plus exactly those entries, and that the prefix and length are as expected.
- The output equals the client's canonical bytes (test plus offline launch).

**How it writes.**
- The default is a dry run.
- `--apply` also requires `--expect-sha256` of the observed file.
- It writes an O_EXCL backup `reth.toml.pre-prune-repair` and an O_EXCL temp file with the same mode (and owner when run as root).
- It fsyncs, re-checks that the file was not changed concurrently, then does an atomic `os.replace` and an fsync of the directory.

**What it refuses.** Everything else exits 2 and writes nothing. That includes an already-complete profile, other interval/minimum/lookup values, extra segments, missing static_files, an archive (no prune section), invalid TOML and symlinks.

It never touches the DB, indices, static files or snapshot markers. There is no redownload, no `--force` and no reset.

**Values not recovered.** If the ORIGINAL snapshot reth.toml had non-default `block_interval` or `minimum_pruning_distance`, those were already overwritten by the defect, and this tool restores the defaults (5/10064). Root should compare against any preserved pre-start copy of the snapshot's reth.toml, if one exists. The five segment values are the ones root reported.

## 4. Tests (all through `work/claude-test-queue.py`, 16 GiB floor; none bypassed, no 98/99)

| Job | Cap | Result |
|---|---|---|
| `jobs/unit.sh` → `logs/unit1.out` | 256 | 3 errors from a test-helper bug (`render()` used `p` before binding it); kept |
| `jobs/unit.sh` → `logs/unit2.out` | 256 | **launcher 20/20 OK** (14 original + 6 new); **repair 9/9 OK** |
| `jobs/offline-reth.sh` → `logs/offline1.out` | 1024 | base leg reproduced; reth leg harness flag conflict; kept |
| `jobs/offline-reth.sh` → `logs/offline2.out` | 1024 | **both pinned binaries: defect reproduced, new argv stable, repair canonical**; peak 303 MiB |

**New launcher tests** (`PruneProfileTests`). These use a model of the pinned replace-on-save rule (`client_persists_prune`), which the offline binary runs validate.
- The snapshot profile maps to the exact complete flags.
- **First launch, then persisted client rewrite, then second launch, then rewrite**, for both `el` and `base`. The profile stays intended at a fixed point, and there is no `--full`/`--minimal`.
- The old lookup-only argv reproduces the exact defect file and the next launch REFUSES.
- The already-rewritten file is refused, not waived, for both sides.
- Larger retention or interval values are passed through, never reduced.
- Unreproducible settings are refused: `before` mode, a short distance, a log filter, an unknown key, a sender distance, a short lookup.

**Repair tests.** The fixtures are the real files the pinned base binary wrote:
- plan == canonical bytes
- a dry run writes nothing
- apply bound to the sha keeps the backup and the mode, and then reports already-complete
- apply requires the sha
- a second repair is refused
- an unpinned binary, symlink, and 7 non-defect variants are refused
- the real pinned base binary is accepted

## 5. Live recovery, rollback and restart-evidence plan (root executes; nothing done here)

**Ethereum EL now:**
1. **Record state.**
   - The live reth.toml sha256 (bind it as `--expect-sha256`).
   - Current argv.
   - Stage and checkpoint journal lines, including the `IndexStorageHistory 0→26263563` progress.
   - `/srv/enclave-l1-pair` usage and the static_files section (root is checking).
2. **Stop cleanly.** Stop `enclave-l1-el.path` first, then `enclave-l1-el.service`, and wait for a clean MDBX exit. Never kill.
3. **Install the launcher.** Install `chain_service.py` sha `a7adf5e6…` and verify the installed sha.
4. **Repair.** As root:
   ```sh
   python3 prune_profile_repair.py --reth-toml <l1 data>/reth.toml --client reth --binary /opt/enclave-rpc/bin/reth
   ```
   Check the dry run. Then repeat with `--apply --expect-sha256 <recorded>`. Keep `reth.toml.pre-prune-repair`. Confirm the parsed prune equals the intended profile, and that the owner and mode are unchanged.
5. **Start and check.** Start the unit via its .path.
   - Verify the argv has the 8 prune flags and no `--full`.
   - Verify reth.toml is **byte-identical** to the post-repair sha after startup (proof of no client rewrite).
   - Watch pruner and stage logs for errors or unwinds. EL/CL pairing should continue.
6. **Prove stability.** Do one more clean stop/start. The launcher must pass validation and reth.toml must stay byte-identical.

**Base.** It is not started yet. The first start with the fixed launcher keeps its snapshot profile; the only change is lookup `"full"` → `{distance 140000}`, as intended. Before the first start, confirm the Base reth.toml still holds the full snapshot profile (it was never launched by the old launcher).

**Rollback.**
- Do NOT roll back to the old launcher: its partial flag would erase the profile again.
- If the repaired file or startup misbehaves, stop the unit and restore `reth.toml.pre-prune-repair` (the exact defect bytes) for diagnosis. Leave the unit stopped until fixed.
- The repair changes only reth.toml text. No data is deleted by the repair itself.

**Open points for root:**
- **More pruning after restart.** Restoring the profile makes the pruner remove receipts, history, bodies and senders that accumulated beyond 140000 while running unpruned. That only reduces back to the intended bound.
- **The index stage.** Whether the current `IndexStorageHistory` run from checkpoint 0 is caused by the None history mode, or is the expected rebuild of indices the download omitted, is NOT established here.
- **Restart on the live DB.** Effects of a restart mid-stage on the live DB are not tested offline.

## 6. Files (sha256)

All under `work/rpc-production-final-20261025/`:
- `source/ops/rpc-backend-bootstrap/2026-10-25/chain_service.py` `a7adf5e6ba228bc7532f6ceb2591b4c28acd92df5bd021a2e510972c71795e40`
- `source/ops/rpc-backend-bootstrap/2026-10-25/test_chain_service.py` `a501f1d0a62c3c64ad48826d568ede77a36f56faa9853e4c2f10ed6dfb8c9691` (before `416cc394…`)
- `prune-recovery-stage/prune_profile_repair.py` `ceff9584c95f8d0a7e734fa30f3b27c67f4354203cb981bc81767950660004cb`
- `prune-recovery-stage/test_prune_profile_repair.py` `3e66820b458d9ffbd8d11e87aac2bc0aa16e835eddb5b23895c49c88d440619e`
- `prune-recovery-stage/fixtures/base-defect-reth.toml` `f905165e…` and `base-canonical-reth.toml` `80c28b89…` (real pinned-binary output)
- `prune-recovery-stage/jobs/offline-reth.sh` `879b0b60…`, `jobs/unit.sh` `562af1ec…`, `prune_section.py` `d87fb972…`, `snapshot-profile.toml` `33e7b18f…`
