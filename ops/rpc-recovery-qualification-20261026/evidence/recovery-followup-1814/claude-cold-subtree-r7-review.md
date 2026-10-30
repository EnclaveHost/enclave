# Independent read-only review: `nvme-cold-relocation-stage/r7` (cold subtree COPY to cryptroot) (2026-10-26 18:03-18:05Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` `0ee124ad…c701`; `sha256sum -c` OK.
  - `subtree.py` `2de3a738…`
  - `relocate.py` `2a037dae…` (= frozen r5)
  - `tests/test_subtree.py` `40cbcf9d…`
  - `config.subtree.production.template.json` `93e51619…`
- **Also read:** `logs/claude-cold-subtree-r7.md` and `logs/cold-subtree-preflight-1514.json`.
- **The 1514 preflight:**
  - hf-convert 158,749,500,752 B; gvs5h 125,195,719,424 B; gguf-e2b 43,957,352,504 B. **Total 327,902,572,680 B.**
  - all owners 1000, types `d`/`f` only, `matchesPriorMetadata` true;
  - `/` available 826,278,383,616; `/vm` available 79,900,258,304;
  - same-uid scan **incomplete** (41 unreadable); destination absent.
- **Not done:** no tests, commands or mutations by me. Root 1528 is running.

## Verdict
**COPY / INVENTORY / VERIFY now:** source safety, the 1381 reuse rule, pinning writes to `/`, privacy and independence from the guard JSON hold in source.

**Bugs found:**
- **C1 bypasses the 300 GB floor** on a resumed copy.
- **C2 and C3 leave dead ends:** fail-closed, no data loss, but they block relief after a verify failure or a re-inventory.

**CUTOVER later:** blocked by three concrete privilege-boundary bugs in the root writer-check path (W1-W3), on top of the still-required complete privileged writer-check.

## Verified in source (COPY / INVENTORY / VERIFY)
**The source is never modified:**
- the source is only read: `walk_meta` uses lstat; hashing opens `O_RDONLY|O_NOFOLLOW`;
- rsync goes **from** the source with `--one-file-system`, and `safe_rsync_argv` refuses `--del*`, `--remove-source-files`, `--inplace`, `--append*` and `--force`;
- `restore_dir_mtimes` writes only destination dirs (`utime`, `follow_symlinks=False`);
- `identity_now(src)` is re-checked at copy, verify and cut-over;
- **the only `/vm` writes are cut-over's rename and symlink.**

**1381 hash reuse (`reuse_1381`, `:252-274`):**
- the 1381 journal must reproduce **both** pinned digests: identity `d3f4775f…` and logical `fb369205…`;
- the path set must be equal;
- every record must be equal (type, mode, uid, gid, xattr digests, size, mtime, link, nlink, and `[dev, ino, ctime]`; the top dir by dev+ino);
- hardlinks are refused;
- otherwise it refuses, and only `--fresh-hash` (in the queue lane) re-hashes.
- **Why ctime equality suffices:** it means no write since 1381, so the reused sha256 is exact.

**Writes cannot land on `/vm`:**
- `writes_on_dest` (`:203-211`) checks `st_dev(dest) ≠ st_dev(source)` and `st_dev(journal) == st_dev(dest)`;
- the mountinfo pins cover source, destination **and** journal (`:71-74`);
- both run in `main` **before** the journal is created (`:533`), and again in `plan`/`copy`;
- the destination chain is real 0700 owner dirs with no symlink components;
- journal files use `O_NOFOLLOW`;
- rsync has no `--temp-dir` (temp files stay in the destination dir).

**Metadata and privacy:**
- `-aHAX --numeric-ids`;
- verify uses a fresh sha256 of the destination; logical (mode, uid, gid, xattrs incl. ACL xattrs, size, mtime, link, hardlink group, sha256) must equal the source inventory; manifest sha and bytes must match;
- dir mtimes are re-applied from the live source and then compared strictly;
- the destination parents are 0700, so inner modes stay unexposed.

**Mounts and devices pinned:** `/vm` ext4 on `/dev/mapper/cryptvm`; `/` ext4 on `/dev/mapper/cryptroot`, including the journal path (a separate `/home` mount refuses).

**Guard independence:**
- no guard JSON is read, and a `guard` key refuses;
- `/vm` free is informational only;
- no production threshold is touched.
- **Correct, because** COPY writes only to `/`.

**Memory and queue:**
- copy, verify and fresh-hash require the exact cgroup `memory.max` of root's lane and MemAvailable ≥ 16 GiB at start;
- rsync runs inside that scope, so the queue guard's continuous floor covers it.

**Capacity at start:** `/` 826.28 GB − 327.90 GB ≈ **498.4 GB after all three copies**, about 198 GB above the 300 GB floor. Copy refuses until all three are inventoried.

## COPY / VERIFY bugs (fix before relying on resume or recovery)
**C1. The 300 GB floor is skipped on every resumed copy.**
- **The bug:** `if ts.get("copy") is None and avail - need < floor` (`:366`) checks the floor only on the first attempt. A copy left `running` (crash) or `failed` (rsync rc) resumes with **no** capacity check, even though `/` may have shrunk meanwhile.
- **Fix:** always check, using the remaining need: `avail − (need − allocated(dst)) ≥ floor`, where `allocated(dst)` = Σ `st_blocks·512` of the partial destination tree (lstat walk, no following); or conservatively `avail − need ≥ floor`.
- **Test:** fail one copy, shrink the fixture `/` free, resume, and expect a refusal with nothing run.

**C2. A failed verify is a dead end.**
- **The bug:** `phase_verify` refuses on a mismatch but leaves `copy == "done"` (`:392-396`). `phase_copy` then refuses: "exists but is not this journal's copy" (`:362-363`). The tool has no deletion, so relief stops.
- **There is also a hidden trap:** a plain re-copy would skip a corrupted file, because rsync's quick-check (same size and mtime) passes.
- **Fix:** on a verify mismatch set `copy = "failed"` (keeping the diff), and resume that subtree with `--checksum` added to the argv (non-destructive; already allowed by `safe_rsync_argv`).
- **Test:** the existing tamper test (`test_subtree.py:225-237`) continues `copy` → `verify` and expects OK, with the tampered file restored.

**C3. Re-inventory after a partial or complete copy orphans the destination.**
- **The bug:** `phase_inventory` does `ts.clear()` (`:299`), dropping `copy`. Any later `copy` then refuses on the existing destination (`:362`). This is the documented path for a source changed since inventory ("inventory-source again").
- **Fix:** preserve `copy` across re-inventory (set it to `"failed"` when a destination exists), so the next copy resumes with `--checksum`.
- **Test:** inventory, copy, change the source, re-inventory, copy, verify: expect OK.

**C4 (minor).**
- `env.run` captures and discards rsync's stderr; the journal records only `rc`. Store the last ~4 KiB of stderr in the copy event.
- There is no time bound on rsync. Local copy, bounded by `bwlimit`, so acceptable; state it.
- `--fresh-hash` reads `/vm` unthrottled, unlike rsync's `--bwlimit`. It only runs if the 1381 reuse refuses; note the padbank IO impact.

## CUTOVER-phase blockers (privileged writer-check path; not needed for COPY)
**W1. Root follows a symlink in a uid-1000 directory.**
- **The bug:** `phase_writer_check` runs as root, writes `writer-check.json` into the owner's 0700 journal, then calls `os.chown(journal.path("writer-check.json"), …)`, which **follows symlinks** (`:425-427`). The journal is uid-1000-writable and not sticky, so `fs.protected_symlinks` does not apply.
- **The attack:** a uid-1000 process can swap in a symlink between the rename and the `chown`. Root then chowns an arbitrary file to uid 1000.
- **Fix:** `fchown` the temp file's fd **before** the rename (or `os.chown(..., follow_symlinks=False)`). Apply the same review to root's `Journal.locked()` `fchown` on `lock` (`O_NOFOLLOW` blocks symlinks; a hardlink to a root-owned file is blocked only if `fs.protected_hardlinks=1`, so **root must record that sysctl**).

**W2. Root executes uid-1000-controlled bytecode despite the sha pin.**
- **The bug:** `_load_relocate` checks `relocate.py`'s sha256, then calls `spec.loader.exec_module` (`:42-48`). That uses `__pycache__/relocate.cpython-314.pyc` whenever its header's source mtime and size match; `-I` does not disable reading pyc files.
- **The exposure:** `r7/__pycache__/relocate.cpython-314.pyc` already exists, owned by `steven`, 0644 in a 0755 `steven` dir. The writer-check runs **as root** through this loader, so a planted pyc would run as root unverified.
- **Fix:** execute the verified bytes directly: `code = compile(bytes, p, "exec"); exec(code, module.__dict__)`. Also make the emitted script fail if a `__pycache__` exists beside the pinned files.

**W3. The emitted writer-check script pins emission-time hashes, not the frozen ones.**
- **The bug:** `writer-check.sh` contains the shas computed **at emit time** by uid 1000 (`tool_shas`, `:407-418`). A modified `subtree.py` at emit would be pinned as-is.
- **Fix:** embed the frozen r7 SUMS values (`2de3a738…`, `2a037dae…`) as constants, or have the operator compare them against `nvme-cold-relocation-stage/r7/SHA256SUMS` before `sudo bash`.

**Still required before any cut-over (unchanged, root-owned):**
- **The writer-check:** a complete privileged `/proc` writer-check by an operator able to sudo (root here cannot `sudo -n`).
  - The 1514 same-uid scan was incomplete and does not replace it.
  - It must be fresh within `writer_check_max_age_seconds` and have **zero hits**, after W1-W3.
- **The cold-proof checks** of `logs/claude-capacity-nextstep-1510.md`: no changes since 1381, no writers or readers, Qwen maps.
- **The attestation** of what was stopped or held.

## Reclamation (not in this tool; must be separately reviewed before any `/vm` space is freed)
- **COPY and CUTOVER free nothing.** `/vm` stays at 79.9 GB until the `.retire-*` trees are removed, and only then reaches ≈ 407.8 GB (about 21.9 GB over 385,899,345,920).
- **The padbank:** live Qwen padbank growth of about 64 GB would erase that margin. Coordinate it before reclamation.
- **Minimum for a reclamation review:**
  - cut-over complete with post-checks for all three;
  - a soak period;
  - a fresh privileged writer-check on the `.retire-*` and destination prefixes;
  - destination identity unchanged since cut-over **and** a fresh destination sha256 against the inventoried logical digest immediately before deletion;
  - inbound manifest links still resolving;
  - a deletion limited to the three exact `.retire-<name>` dirs (no globs), with a journalled per-tree intent;
  - no production threshold changed.

## Not claimed
- That root 1528's tests pass.
- Real mountinfo source strings.
- The rsync 3.4.1 behaviour on the real trees.

Nothing here changes production thresholds or admin controls.
