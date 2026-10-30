# Retention job (root 1394, guest PID 110490): why the state MDBX is being re-downloaded, and what it means for data and capacity

**Scope: read-only.**
- **Pinned reth source:** `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3/crates/cli/commands/src/download/`.
- **Pinned manifest:** `logs/base-manifest.body`.
- **Guest reads** over the `enclave-rpc` alias, between 15:19 and 15:21 UTC: `systemctl show`, `ps`, `/proc/110490/{cmdline,io}`, `ls`/`df`/`du` of the datadir, and a bounded `journalctl` since 15:15.

**Not done:** no hashing, no DB open, no writes, no stop or signal, no tests or commits.

## EARLY FINDINGS

1. **The old MDBX is already gone (irreversible).**
   - On the guest, `/srv/enclave-base-holder/data/db/` is **empty**, with directory mtime **15:15:39**.
   - Free space rose from 2,696,017,272,832 (14:58) to 3,825,729,290,240 bytes (15:20). That is about 1.13 TB, which is `mdbx.dat` (1,138,166,333,440 bytes) being deleted.
   - `static_files/` (136 GB) and `reth.toml` remain.
2. **Cause, by design in reth 7134be3:**
   - `State` is a required component (`manifest.rs:194,255`). With `--with-*` flags it is added as `All` **whenever the manifest declares it** (`mod.rs:753-756`). No CLI flag skips it.
   - A single archive is reused only if **every** declared output matches **exact size and full blake3** (`verify.rs`, `OutputVerifier::verify_with_progress`). The `state` outputs are `db/database.version`, `db/lock`, `db/mdbx.dat` (with blake3 `8de35ff5…`) and `db/mdbx.lck`.
   - **The first run itself made reuse impossible.** After all archives completed, `finalize` ran `init_db(db_path, …)` read-write and wrote prune/index checkpoints (`mod.rs:647-674`). That changed `mdbx.dat`, `lock` and `mdbx.lck`.
   - Every later run over a finalized datadir will therefore find the state "not verified" and plan it as pending. That is why reusable is 115 and needs_download is 23 (= the 22 history archives + `state`).
3. **Ordering is destructive.**
   - Each pending archive's state machine starts with `RunAttempt → cleanup_outputs()` (`archive.rs:150-152` → `verify.rs::cleanup`), which **deletes the declared outputs before fetching**.
   - `State` has scheduling priority 0 (`planning.rs:181-186`), so it is scheduled first.
   - The sequence is:
     1. delete `db/*`;
     2. segmented download into `.download-cache/state.tar.zst.part` (preallocated, sparse, 761,228,785,915 bytes);
     3. rename;
     4. extract with `tar` directly into `db/` (`extract.rs:120-127`);
     5. delete the cached archive;
     6. full blake3 verification;
     7. on mismatch, retry from scratch (cleanup, then re-download), up to `MAX_DOWNLOAD_RETRIES` = 10 (`mod.rs:1134`).
   - **Until this completes, the datadir has no state DB.**
4. **Capacity is sufficient** (exact bytes from the pinned manifest, against guest `avail` at 15:20).

   | item | compressed | extracted |
   |---|---|---|
   | state | 761,228,785,915 (708.95 GiB) | 1,138,167,361,549 |
   | 22 history archives (tx 95–104, receipts 95–104, account/storage changesets 104) | 256,149,630,611 | 490,033,101,074 |

   - **Worst-case simultaneous new allocation:** every archive's cache and extraction held at once = **2,645,578,879,149** bytes. Available is 3,825,729,290,240, so **1,180,150,411,091** (≈ 1.18 TB) remains even then.
   - That still covers the preflight's 161.0 GB index reserve plus the 250.5 GB 30-day growth reserve, with about 769 GB to spare.
   - Steady state after completion: about 1,628 GB new (state 1,138 GB + history 490 GB); caches are deleted.
   - **Compared with the original plan** (before the old MDBX was freed): the state re-download costs a net **+761.2 GB** transient peak, because the old 1,138 GB was freed first. 2,696.0 GB − (1,157.7 GB plan + 761.2 GB) still leaves ≈ 777 GB.
   - **Memory:** guest MemAvailable is 51.5 GiB. The host had MemAvailable 20.75 GiB at the time of this read (over the 16 GiB floor by about 4.75 GiB; the host load is not from this job).
5. **Health and throughput:**
   - The journal since 15:15:41 has 0 fail/error/retry lines.
   - The cache grew 4.30 → 4.71 GB in about 26 s (≈ 16 MB/s, while 16 downloads ran concurrently).
   - **If that rate held** for about 1.02 TB compressed, the datadir would have no state DB for roughly **18 h**. This is an estimate from one short sample.

## Does the active job jeopardize data or capacity?

- **Capacity:** no. The worst case stays about 1.18 TB under the available space.
- **Data:** the damage has already happened. The previous MDBX was deleted at 15:15:39 and cannot be brought back by stopping.
  - The deleted DB was the snapshot's own state as of 14:51 (manifest block 53048526, then finalized). No unique data is lost **unless** a node ran on it between 14:51 and 14:58. That should be confirmed from root's controller logs; I did not see a node service, and `reth.toml` is from 14:51:50.
  - **Remaining risk:** the datadir is not usable until the state archive downloads, extracts and verifies. If the job fails after 10 retries, or if `https://mainnet-v2-snapshots.base.org` stops serving `1792886410/state.tar.zst`, there is no state DB.
- **Not verified:** whether segmented `.part` progress survives a process restart. Do not assume a stop/restart is cheap.

## Exact safe correction

**Now (active job):**
- **Do not stop it.** Stopping cannot restore the MDBX, and a restart re-plans `state` anyway, because `db/` is empty.
- Let it complete. Root should monitor through the existing owned controller only:
  - `Archive extracted, but output verification failed` and `Retrying archive from scratch` lines;
  - guest `df` avail staying above the reserves (worst case ≈ 1.18 TB);
  - the host 16 GiB floor.
- Do not mutate the command or source.
- Completed archives are preserved: reused archives are never cleaned up, only pending ones. The 115 verified archives, including all headers and present chunks 105–106, are untouched.

**After it completes:**
- The newly extracted state is verified against the manifest blake3.
- `finalize` then re-opens it and re-writes checkpoints. As the first run did, this records prune `Before(48,000,000)` for tx/receipts and `Before(52,500,000)` for changesets (`config_gen.rs:263`).
- Readiness must claim the declared floor, not the extra predecessor chunks (see `logs/claude-retention-selection-audit.md`).

**For every future backfill on a finalized datadir** (prevents a recurrence; do not apply to the running job):
1. Never run `snapshot download` with a manifest that declares `state` over an existing `db/mdbx.dat`. It deletes the DB by design.
2. Use a **reviewed derived manifest**: the pinned manifest (`1f0c4e6c…`) with only the `components.state` entry removed, and its own sha256 pinned and reviewed. Pass it via the already-used `--manifest-path`.
   - reth then never plans `State` (`available(State)` is false), so `cleanup_outputs` never touches `db/`.
   - Only the missing history archives are fetched. `finalize` re-opens the existing MDBX and writes the prune checkpoints for the new floor. That is what the backfill wants, provided no node has advanced the DB past the manifest block; confirm that first.
3. Add a preflight guard: refuse to start if the manifest declares `state` **and** `db/mdbx.dat` exists.
   - Count `state` explicitly in the expected needs_download. The installed preflight's 22 omitted it, which is why the CLI reported 23.
   - Keep the off-by-one chunk correction from the selection audit.
4. There is no CLI flag to skip state in 7134be3. `--prune-unlisted` and `--force` are not alternatives: both delete more.
