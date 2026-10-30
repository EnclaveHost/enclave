# Cold subtree relocation r7: nvme-cold-relocation-stage/r7 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, hashes, copies, mounts, network or live actions, and edited no production config.
- **Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse, `sha256sum -c`.
- **Frozen and unchanged:** the original stage, r2, r3, r4, r5 and r6. Sums re-verified; the r7 job re-checks every one.
- **Input:** root 1523 (r6: 37/37 PASS) and its source review.

## Stage
`nvme-cold-relocation-stage/r7/`, `SHA256SUMS` = **`0ee124ad3a239173f177b19be489cae23270bd740dd79205c7c4d34a1da9c701`** (read-only)

| file | sha256 | note |
|---|---|---|
| `relocate.py` | `2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0` | = r5 = r6: the USB-image mode is untouched |
| `subtree.py` | `2de3a738a25d442e4f9697c123b5935e352d58222cfa9bef419940ca559d75eb` | r6 + 62 changed lines |
| `tests/test_relocate.py` | `dc597306da188b97f341c016f0b3f20f6f611be157aa0dbcc3e9001bd9c7d051` | r5 suite, unchanged (22) |
| `tests/test_subtree.py` | `40cbcf9d740149367b43a6cfc0ead9fe6807734542814c882429c6c8d9d7ecdb` | 19 (r6's 15 adapted + 4 new classes of regression) |
| `jobs/tests.sh` | `fc8df07b0491c2027120b451c99f49a9547c8eb6d823749cf0e3911b0416fc2b` | |
| `config.subtree.production.template.json` | `93e516199000b342d4d70bf48c361696a848b7b773879985bed62390f0b9c535` | `guard` removed; journal `…/nvme-cold-subtree-r7` |
| `README.md` | `d591d51d12a5eaa6bd32c686e01d5a7ab9e0f08548f7bf805775375f314e95bb` | |

## Root 1523's findings, and the change
1. **The stopped VM's guard file.**
   - `~/.local/state/enclave-rpc-production/guard-status.json` is `{state: stopped, free: {nvme: 544182374400}, manifestSha: fd71831c…}`: **no thresholds**, and a stale `free`.
   - r6's `plan`/`copy` called r5's `guard_status`, which raises on the missing thresholds. Production relief could not even start.
   - **r7 never reads it.** `guard` is no longer a config key; a config containing one is refused by the exact key set.
   - **Source free space** comes from `statvfs(archive_root)` and is reported as `sourceFreeInformational`.
2. **`copy` refused a low `/vm`** (`guard free <= shutdown`), which deadlocks the very relief it exists for.
   - **Why removing that check is safe:** this mode **only reads** `/vm` until cut-over. It writes the destination tree, the journal (including hash caches and the writer-check result) and rsync's temp files to `/`. rsync creates its temp files inside the destination directory; no `--temp-dir`.
   - **Not relaxed:** the production RPC VM's prepare/controller/guard thresholds, and qualvm's admission. Those live in their own tools and are untouched; this mode simply doesn't use them as its gate.
   - **The only `/vm` writes** remain cut-over's rename to `.retire-<name>` and the symlink. Both are metadata-only, after the privileged writer-check.

## What r7 adds to keep the relief safe
**Writes pinned to the destination** (`writes_on_dest`, called in `main` **before** the journal is created or opened for writing, and again in `plan` and `copy`):
- `st_dev(dest_root ancestor) != st_dev(archive_root)`, otherwise "the destination is on the SOURCE filesystem: refused";
- `st_dev(journal_dir ancestor) == st_dev(dest_root ancestor)`, otherwise "journal not on the destination filesystem";
- the production `check_mounts` now also pins the **journal's** mount to `dest_mount` (`/`, ext4, `/dev/mapper/cryptroot`) via mountinfo, besides source and destination.

**Floor over all remaining copies:**
- `copy` refuses until **every** subtree is inventoried;
- then `/` avail − (this + every other not-yet-copied subtree) must be ≥ `dest_floor_bytes` (≥ 300 GB pinned).

**Bandwidth:** `bwlimit_kib` must be ≤ **204800** (200 MiB/s); any config above that refuses.

**Unchanged from r6:**
- the exact subtree, mount, manifest and 1381 pins;
- 0700 owner-only destination parents and no symlinks;
- exact cgroup lane + MemAvailable ≥ 16 GiB at start (the queue's memory guard enforces the floor continuously);
- source identity unchanged since inventory and since verify;
- 1381 hash reuse only on a complete exact identity match, otherwise `--fresh-hash`;
- a fresh destination sha256, and the manifest sha/bytes check;
- inbound manifest links resolve before and after cut-over;
- the privileged, sha-pinned, complete, zero-hit writer-check before any cut-over;
- automatic rollback; rollback refuses after writes through the symlink;
- **no deletion/reclamation phase.**

## Regressions (19 subtree tests + 22 r5; not run)
- **The real stopped guard** (`R7.test_real_stopped_guard_is_never_read_and_low_source_free_still_copies`):
  - the fixture writes the exact stopped shape, no thresholds, free 544182374400;
  - r5/r6's `guard_status` on it **refuses** (documenting 1523);
  - with `guard_status` patched to fail the test if called at all, `plan` → inventory ×3 → copy → verify → `plan` succeed while `/vm` free is **1 GB**.
  - Every fixture now defaults to `/vm` free = 1 GB.
- **Destination or journal on the source filesystem** (`R7.test_journal_or_destination…`):
  - a journal under `/vm` is refused **and not created**;
  - a destination device equal to the source's is refused, and no journal is created;
  - on the correct device, the same inventory succeeds.
- **No source mutation** (`R7.test_no_source_mutation…`): every entry on the fixture source filesystem (type, mode, size, mtime, inode) is identical before and after inventory ×3, copy ×2 and verify ×2.
- **Bandwidth and guard key** (`R7.test_bandwidth_cap_and_guard_key_refused`): 204801 refused; a `guard` key refused.
- **Copy refusals** (adapted), each creating nothing:
  - only one subtree inventoried ("inventory every subtree first");
  - wrong lane; MemAvailable 16 GiB − 1; `/` exactly at the floor;
  - `/` that fits this subtree but not all remaining ones;
  - destination on the source filesystem; wrong mounts; source changed after inventory.
- **Pins** (adapted): the production template shape (no guard, bwlimit 204800) loads; deviations refuse (including bwlimit 204801 and a `guard` key).
- **`plan`:** reports `sourceFreeInformational` = 1 GB, the padbank and reclamation notes, and refuses when `/` would fall below the floor.
- **Retained:** every other r6 test (1381 reuse/tamper, privacy, metadata-exact copy and verify, writer-check gates, cutover/rollback, post-check auto-rollback, no deletion, r5-journal refusal), with the journal now on the fixture destination filesystem.

**Root command:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cold-r7 512 unshare -Urn bash nvme-cold-relocation-stage/r7/jobs/tests.sh
```
PASS = `test_relocate` 22 OK + `test_subtree` 19 OK, nothing skipped, the original stage and r2-r6 frozen, r7 sums intact.

## Capacity (unchanged facts, restated)
- **After reclamation:** about 328 GB freed, putting `/vm` at about 407.8 GB, a margin of about 21.9 GB over the qualification threshold (385,899,345,920).
- **The live Qwen padbank can still grow by about 64 GB. If it resumes, that margin is lost.**
- **`/`** must keep ≥ 300 GB after all three copies; that is now checked at every copy.
- **Nothing is freed before** a separately reviewed reclamation of `.retire-*`.

## Not done / for root
- **No running guard was invented.** The production config and the guard file are unchanged.
- **Template:** fill its three REQUIRED values (bwlimit ≤ 204800, the exact queue-lane `memory.max`, the writer-check age), and confirm `inventory_1381.journal_dir`.
- **Real mounts:** the actual mountinfo sources must equal `/dev/mapper/cryptvm` and `/dev/mapper/cryptroot`, including for the journal path under `/home/steven/.local/state`. If `/home` is a separate mount, `plan` refuses.
- **The cold-proof checks** from `logs/claude-capacity-nextstep-1510.md` (no changes since 1381, no writers or readers, Qwen maps) are still required before any cut-over.
