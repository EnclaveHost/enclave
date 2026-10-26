# Independent read-only review: retention continuation decision B and root's resumable-state note (EARLY; the stage is not yet present)

**Inputs:**
- `logs/retention-continuation-decision.md` (decision B);
- `logs/resumable-state-security-root-note.txt`;
- the pinned reth 7134be3 source (`~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3/crates/cli/commands/src/download/`).

**`resumable-state-recovery-stage/` does not exist yet** (6d is preparing it). This section reviews the design. A stage review follows when it appears.

**Not done:** no test, build, network access, live action, queue job, commit or owner-file edit. Controller 1394 and its unit are untouched; they must stay live until a tested transition is ready, as the decision already says. Admin controls are unchanged.

## A. The two decisive source facts (they change B's phase 3; most important for avoiding a redownload loop)

### A1. A pending `state` archive deletes the extracted DB IMMEDIATELY, not after a human can react
- **The sequence:** after `partition_reusable` (`mod.rs:560`, `planning.rs:131-157`, which deletes nothing itself), a real run goes straight into `run_modular_downloads` (`archive.rs:25-55`).
- **The first action** of every pending archive's job is `ArchiveAttemptState::RunAttempt` → **`self.cleanup_outputs()`** (`archive.rs:151-152`, `:229-230`), which removes that archive's declared outputs.
- **The consequence:** if phase 3's startup check classifies `state` as pending (any BLAKE3 mismatch, a missing file, or a wrong size), the 1.1 TB extracted `db/*` is **deleted within seconds of start**, and a 761 GB segmented download begins.
- **B's "the owner stops at once if the startup summary shows state pending" cannot save the extraction** (decision line 32).

**Required fix:** phase 3 must never be started unless the state outputs are already known to pass the **same** BLAKE3/size check:
- run an **independent pre-verification** of exactly the manifest's declared `state` output files (paths, sizes, BLAKE3) after phase 2 and before phase 3;
- use a **pinned** BLAKE3 tool. `b3sum` and Python `blake3` are absent on the guest (decision line 9), so build a static `b3sum` offline from the `blake3` crate version reth pins (`blake3 = "1.8"`, `Cargo.toml:491`, at the exact `Cargo.lock` version), record its sha256, and install it read-only;
- on any mismatch, **do not start phase 3**. Re-extract from the kept archive (bounded, with a counter). If the archive itself is wrong, stop for root.
- Pure-Python BLAKE3 over 1.1 TB is not a realistic substitute.

### A2. Finalization changes `db/mdbx.dat`, so a run interrupted after finalize deletes the state on the next start
- **What finalize does:** `finalize_modular_download` (`mod.rs:648-675`) writes `reth.toml`, opens the DB with `init_db`, and (with the retention selection) writes prune checkpoints and/or resets index stage checkpoints in MDBX. After it, `db/mdbx.dat` no longer matches its manifest BLAKE3.
- **The window:** the guard's `retention-complete` marker is written later, by `ExecStartPost=+retention_guard.py post` (unit line 30). A stop in between leaves a finalized DB with no marker: the controller deadline, the 16 GiB floor watchdog, a SIGTERM/HUP trap, a host event, or a `post` failure.
- **The next start:** `pre` admits (no marker) → reth → the BLAKE3 mismatch makes `state` pending → `cleanup_outputs` → **full re-download**.
- **This is root's "finalization race", now concrete in the source.** Root's note ("state already extracted can be safely reused ONLY before finalization") is correct, and B line 50 ("deadline harmless") is not.

**Required fix:**
1. Phase 2 records the verified state outputs as `state-extracted.json` in the holder root, root-owned, 0444: `{path, size, blake3, mtimeNs, ino}` for each declared `db/*` file, plus the archive digest record.
2. Before **any** reth start (in the phase-3 wrapper, and proposed for `retention_guard.py pre`, whose owner must agree), refuse when `retention-complete` is absent **and** any recorded `db/*` file has a different size, mtime or inode than recorded.
   - That is the signature of an `init_db`/finalize after extraction.
   - Hand it to root/manual review (verify the other archives, then write the marker through the reviewed `post`). **Never start an automatic rerun.**
3. Keep the compressed archive until the marker is validated **and** the reader proof is safe (root note), so a mistaken deletion is recoverable without the network.

## B. Phase 1: bounded, crash-safe HTTP Range resume (root's critical point)
**The problem.** B appends the curl body straight to the archive and validates headers only after curl ends. A SIGKILL or crash in between leaves unvalidated bytes (a 200 full body, a wrong range, a changed ETag) that the next resume trusts by length. Root's note is correct.

**Minimal design: chunked temp + committed offset.**
1. **State files**, in a root-owned 0700 directory on the holder filesystem:
   - the archive `state.tar.zst`;
   - `committed.json` (`{offset, etag, lastModified, total}`), changed only by an atomic write-tmp + fsync + rename + directory fsync;
   - a lock file.
   - **The committed offset is the only progress truth.** On every start, the archive is truncated to `committed.offset`. That is the tool's own uncommitted tail only, and it never truncates below the committed offset.
2. **Ownership:**
   - `flock` an exclusive lock for the whole process;
   - open everything with `O_NOFOLLOW`;
   - refuse if the archive, its directory or the chunk file is a symlink, not a regular file, not root-owned, or group/other-writable;
   - refuse if another process holds the archive open (`fuser`);
   - refuse while the retention unit or the holder is active, or any reth/base process uses the datadir. This is the **phase exclusion**; re-check it before each chunk.
3. **Each attempt fetches ONE bounded chunk** (e.g. 64 MiB, so a lost attempt costs at most 64 MiB) into `chunk.tmp` (`O_EXCL`, truncated first):
   ```
   curl --proto =https --proto-redir =https --max-redirs 0 --http1.1 -sS --fail
        -r S-E -H 'If-Range: <pinned ETag>' -H 'Accept-Encoding: identity' --max-filesize <E-S+1>
        --connect-timeout 20 --max-time <bound> --speed-limit 1 --speed-time 60
        -D chunk.hdr -o chunk.tmp <pinned URL>
   ```
   - No `-L`. No `--compressed`. **Never `-C -`** (curl's own resume trusts the local length).
   - With `If-Range`, a changed object answers 200 full; `--max-filesize` aborts it early.
4. **Validate before append** (the last header block only; names case-insensitive):
   - curl exited 0;
   - status exactly 206;
   - `Content-Range` exactly `bytes S-E/N` with N = 761,228,785,915;
   - `Content-Length` = E−S+1 = the size of `chunk.tmp`;
   - **no** `Content-Encoding` (or exactly `identity`);
   - `ETag` byte-equal to the pinned value (a weak `W/` ETag is refused, not normalised), and `Last-Modified` equal to the pinned value.
   - The pins are recorded from the first 206 response and written into `committed.json` before any byte is committed. If they differ from a value reviewed in advance, refuse.
5. **Commit:**
   1. `pwrite` the chunk at exactly S into the archive (never `O_APPEND`);
   2. `fsync` the archive;
   3. then atomically write `committed.json` with offset E+1;
   4. `fsync` the directory.
6. **Failure handling:** any validation failure, curl error, crash or kill discards `chunk.tmp`. The committed offset is unchanged, so progress is never lost beyond one chunk.
   - **Curl errors:** 18 (partial), 28 (timeout), 56 (recv), 92 (HTTP/2 stream), 63 (max filesize) are all "retry with backoff, bounded per window".
   - **Mismatch stops:** a changed ETag, Last-Modified or total N is a **stop for root**, never an auto-restart from 0.
7. **Capacity:** before the first chunk and every N chunks, require free space ≥ (N − S) + the extracted state size (sum of the manifest's declared state output sizes) + the remaining history estimate + the reserve floors. Stop on insufficiency; never delete anything to make room.
8. **Completion:** the offset equals N **and** the last response's `Content-Range` ended at N−1.
   - There is still **no** trust in the archive bytes: the manifest has no compressed digest.
   - **Integrity comes only from the BLAKE3 of the extracted outputs (A1).**

## C. Phase 2: confined extraction of an untrusted tar
- **The source:** `--url file://` → `extract_from_file` → `extract_archive` → with no static-files dir and no progress, `archive.unpack(target_dir)` (`extract.rs:126-128`, `335-360`; tar 0.4.46).
- **What tar's unpack does:** it rejects `..`/absolute paths and validates parents, but it **overwrites any existing path the archive names inside the datadir**. That includes `reth.toml`, already verified `static_files/*` and anything else. It also creates symlink and hardlink entries.
- **Why that is not acceptable:** the compressed bytes are unauthenticated.
- **Fix:**
  1. Extract into an **empty staging datadir on the same filesystem** (`…/tmp/state-1792886410/stage/`), with the pinned binary and `--datadir <stage>`, or a reviewed streaming extractor.
  2. Before moving anything, require that the staging tree is **exactly** the manifest's declared `state` outputs (the 4 `db/*` paths): regular files, the declared sizes, no symlinks, hardlinks, devices or extra files.
  3. Verify BLAKE3 (A1).
  4. Only then `rename(2)` each file into `data/db/`, after checking those target paths are absent or are exactly the record of our own prior partial attempt.
- **Interrupted extraction:** remove only the staging tree and retry from the kept archive. Never touch `data/`.

## D. Smaller points
- **Controller 1394:** there is no deadline API, its EXIT trap stops the unit, and adopting a foreign run or disabling the watchdog is excluded. B's step 1 ("leave 1394 running until B is tested") is right. reth's segmented `.part` cannot seed curl (sparse, no piece record), so phase 1 starts from byte 0 either way.
- **Phase 3 deadline:** after A1 and A2 it is still **not** harmless. Use a window long enough for the remaining history plus finalize, and only with the A2 refusal in place. History archives in flight are discarded on a stop (root's note).
- **Wrong success:** success must stay what it is today:
  - the real reth run exits 0;
  - the guard's `post` marker;
  - the controller's terminal validation (`retention-live-controller-stage/r2`).

  Never treat "curl finished" or "extraction finished" as success; both are phase transitions.
- **Archive deletion:** only after the marker is validated **and** root confirms the reader proof is safe. No automatic deletion keyed on the 26-archive subset marker (root's note).

## E. Tests the stage needs (actual curl against a real local HTTP server; counts as they come)
- **Server:** a local `http.server`/socket server on 127.0.0.1 with a TLS cert pinned in the test, or plain HTTP with an explicit test-only `--proto` override.
- **Kill-safety cases:**
  - 200 full instead of 206;
  - a wrong `Content-Range` start or end;
  - a different total;
  - a changed ETag mid-run;
  - a weak ETag;
  - `Content-Encoding: gzip`;
  - a 3xx redirect;
  - a truncated body (curl 18);
  - a stall (28);
  - a body larger than the range (`--max-filesize`);
  - **SIGKILL of the tool mid-chunk and after the append but before the offset commit**: the restart must truncate to the committed offset and the final file must be byte-identical to the source.
- **Ownership/symlink cases:** a symlinked archive or directory, a non-root owner, a held lock, a busy archive (`fuser`), a unit or holder active (phase exclusion).
- **Capacity:** a refusal before any byte when space is insufficient.
- **Extraction:** a tar with `../x`, an absolute path, a symlink then a write through it, a hardlink, a device node, an extra file, a missing declared file, a wrong size, a wrong BLAKE3. Each must leave `data/` untouched.
- **A1/A2 guards:** a pre-verification mismatch never starts phase 3. A modified `db/mdbx.dat` (size/mtime/inode changed) with no marker refuses every reth start.
- **Counts:** report exactly what ran, with no fudged expected counts.

## F. Summary of minimal necessary fixes to B (for owner 6d; I implement nothing)
1. **Chunked** Range resume: temp chunk, validate, `pwrite`+`fsync`, then an atomic committed offset. Truncate only the own uncommitted tail. Bounded loss per attempt.
2. **Independent pinned BLAKE3 pre-verification** of the extracted `state` outputs before phase 3 (A1). Phase 3 never starts on a mismatch.
3. **Finalized-but-unmarked refusal** before any reth start, via the phase-2 record (A2).
4. **Staging extraction** with an exact output-set check before a rename into `data/` (C).
5. **Phase exclusion, ownership, capacity** and `O_NOFOLLOW`/`flock` throughout.
6. **Keep the archive** until the marker is validated and the reader proof is safe.

## G. Stage review: `resumable-state-recovery-stage/state_recovery.py` (owner 6d's draft, 395 lines; the only file present when read)
**What was read:** the draft at sha256 `71b0cf45ded87813…`. No tests, instructions or unit exist yet. Line references are to that file.

**Verdict:** the design direction is right (phases, a pinned manifest, the URL equal to the expected one, no `--force`, a kept archive, exit codes), but the draft does **not yet** meet root's interruption requirement, and it starts phase 3 in a way that can still cause the full-redownload loop. Concrete findings, most important first:

1. **The redownload loop is not prevented (A1).** `check-reuse` (`:344-352`) reads the journal **after** the retention unit has started. By the time "Startup integrity summary" is logged, a pending `state` job has already run `cleanup_outputs()` (`archive.rs:151-152`), so exit 10 "stop phase 3 now" arrives after the extracted `db/*` is gone.
   - `precheck-phase3` (`:329-341`) checks sizes only.
   - **Fix:** a pinned-BLAKE3 pre-verification of every declared state output (path, size, BLAKE3 from the manifest) inside `precheck-phase3`; phase 3 never starts unless it passes.
   - `check-reuse` may stay as a second confirmation only.
2. **An unvalidated tail is trusted after a kill (root's critical point).**
   - **The bug:** `fetch` runs curl with `-C S -o state.tar.zst` (`:218-222`), so the body is appended **directly** to the archive. Validation happens only after curl exits (`:232-241`), and truncation back to S happens only in that Python path. A SIGKILL of the wrapper, an OOM kill, a power loss or a host crash during or after curl leaves the appended bytes. The next start takes `S = arch.stat().st_size` (`:207`) and trusts them by length. `fetch-state.json` holds no committed offset.
   - **Second effect:** the first-attempt validator is persisted only **after** the bytes are kept (`:250-251`). After a kill in that window, the next request sends `If-Range: None` (`:223-224`), which leads to a 200 and a permanent `die(6)`.
   - **Fix (§B):**
     - a bounded chunk (`-r S-E`, e.g. 64 MiB) into `chunk.tmp`, never `-C`/append to the archive;
     - validate status, `Content-Range` (S–E/N), `Content-Length`, no `Content-Encoding`, ETag/Last-Modified;
     - then `pwrite` at S, `fsync`, then an atomic `committedOffset` in `fetch-state.json` (pins written before any byte is committed);
     - on every start, truncate the archive to `committedOffset` (own tail only).
   - **Today an attempt is bounded only by time** (`--attempt-seconds` 1800, about 34 GB at 19 MB/s), and a rejected attempt loses all of it.
3. **Output file and directory are not protected against symlinks or ownership changes.**
   - `arch.touch`, curl `-o`, `truncate_to` and the `release` unlinks all follow symlinks, as root (`:202-203`, `:179-181`, `:361-364`). `owner_lock` creates `.owner.lock` 0640 and checks nothing (`:83-90`).
   - **Fix:**
     - the out dir must be a real directory, root-owned, 0700, not a symlink, and on the holder filesystem;
     - every file opened `O_NOFOLLOW`, checked to be a regular root-owned file with no group/other write;
     - `fuser`-style refusal if the archive or the datadir is open elsewhere.
4. **Phase exclusion is optional.** `units_inactive` does nothing unless `--require-units-inactive` is passed (`:93-101`). It also does not catch a manual `base`/reth process on the datadir.
   - **Fix:** make it mandatory, with a test-only override that is accepted only for tmp paths. Add a datadir process check, and re-check before every attempt and before extraction.
5. **Extraction writes an untrusted tar into the LIVE datadir** (`:313-316`): reth legacy `--url file://` → `archive.unpack(datadir)` (`extract.rs:126-128`), which overwrites any path the tar names (`reth.toml`, verified `static_files/*`, …).
   - The post-check (`:319-321`) inspects only `db/` names and sizes, so an overwrite outside `db/` would go unnoticed.
   - **Fix (§C):** extract into an empty **staging datadir** on the same filesystem, require exactly the declared outputs (regular files, no links/devices/extras), verify BLAKE3, then `rename` them into `data/db/`.
6. **The finalized-but-unmarked state is not detected (A2).**
   - **Fix:** after extraction, record size/mtime/inode (and BLAKE3) of each declared output in `extract-complete.json`. Have `precheck-phase3`, and every later reth start, refuse when `retention-complete` is absent and any output differs. A finalize/`init_db` has then happened, and a rerun would delete the state.
7. **Smaller fixes:**
   - **ETag/encoding:** refuse a weak (`W/`) ETag at the first response (`If-Range` cannot use it, so every resume would 200). Refuse any `Content-Encoding` other than identity.
   - **Bounded 200 body:** add `--max-filesize <E−S+1>` so a 200 full body is aborted early instead of appended for up to 30 min (`:218-220`).
   - **`release`** (`:355-365`): require the marker's validated content (format, 26 archives, pinned manifest) and an explicit root acknowledgement that the reader proof is safe. Keeping the archive until then is root's rule.
   - **Capacity** (`:109-119`): the remaining history download size and the floors belong in phase 1's budget too.

**Tests:** none are present yet. §E lists the minimum actual-curl + local-HTTP-server cases. The kill points (wrapper SIGKILL mid-chunk; after the `pwrite`, before the offset commit) are the ones that prove finding 2 is fixed.

**Unchanged recommendation:**
- leave controller 1394 and its unit running until a tested transition is ready;
- root owns every stop/start/download;
- no adoption of the foreign run, no watchdog or deadline manipulation;
- admin controls untouched.
