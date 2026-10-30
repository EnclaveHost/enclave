# Cold subtree relocation r8: nvme-cold-relocation-stage/r8 (PREPARED and FROZEN; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, copies, mounts, VM, network or live actions, and edited no production config.
- **Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse, `sha256sum -c`, and one stdlib introspection (`hasattr` on `importlib` helpers under the host's Python 3.14.8, for the W2 test).
- **Frozen and unchanged:** the original stage and r2-r7, sums re-verified. The r8 job re-checks every one; r7's pin is `0ee124ad…`.
- **Inputs:**
  - root 1528 (r7: 41/41 PASS);
  - 1530 plan and 1531 inventories (1381 hashes reused for all 108 files, about 328 GB, `/` about 498 GB after the copies);
  - `logs/claude-cold-subtree-r7-review.md` (C1-C3, W1-W3).

## Stage
`nvme-cold-relocation-stage/r8/`, `SHA256SUMS` = **`433fd1314c96c48b5f1abbf0cd5e740efa50a9498ad63ac71f1107d0436bb0c2`** (all stage files `a-w`)

| file | sha256 | note |
|---|---|---|
| `relocate.py` | `2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0` | = r5 = r6 = r7 |
| `subtree.py` | `4509e043e51746fa60b873c2e6e824ff8834232bae8a04a73ad2135975585073` | r7 with 87 lines added and 40 removed |
| `tests/test_relocate.py` | `dc597306da188b97f341c016f0b3f20f6f611be157aa0dbcc3e9001bd9c7d051` | r5 suite, unchanged (22) |
| `tests/test_subtree.py` | `cfb86a2157b41a4ed0af2d650988ff08c810b8d51693348711f9e3728f8a1754` | 27: r7's 19 adapted + 8 new in class `R8` |
| `jobs/tests.sh` | `25cf6359b03ce482f3f3762d47bbae2e913075411f5fc10b60e1989d3ff91760` | |
| `jobs/root-writer-check.sh` | `d206a6a6adfdb6459da6540f6a5f3999fb6541797b241a561e126368baf4ae54` | **new**: the frozen root handoff |
| `config.subtree.production.template.json` | `93e516199000b342d4d70bf48c361696a848b7b773879985bed62390f0b9c535` | **byte-identical to r7**, journal `…/nvme-cold-subtree-r7` included |
| `README.md` | `b3d52d60d84560ad6d67492c1c663afac84d14d075c531bbceed8700c0d32e9a` | |

**Journal compatibility:**
- `JMODE` stays `subtree-r6`, and the state keys are a superset of r7's (`dest_top`, `checksum`).
- An r6/r7 journal, including one left by root's single r7 first copy, continues under r8 unchanged.
- An r5 image journal is still refused.

## C1: the `/` floor is checked on every copy attempt
- **r7's defect:** it checked the floor only when `copy` was absent (`ts.get("copy") is None`), so a resume of a `running`/`failed` copy skipped it.
- **r8:** every attempt computes `/` avail − `remaining_need`, the FULL need of every inventoried subtree not yet `done`, this one included. That is conservative: a partial copy's bytes are counted again.
- If the result is below `dest_floor_bytes` (≥ 300 GB pinned), `copy` refuses with "(insufficient capacity; nothing run)". The refusal comes before the destination is created and before rsync runs.
- **C4 (diagnostics):** the last 4 KiB of rsync's stderr is stored in the `copy` event (`stderr_tail`). `Env.run_tail` replaces `Env.run`.
- **Regression:** `R8.test_c1_floor_checked_on_every_attempt_incl_resume_and_stderr_kept`.
  - A stub rsync that prints "boom" and exits 23 leaves the copy `failed` and `dest_top` recorded, and its stderr is in the journal.
  - With `/` = floor + remaining need − 1, the RESUME is refused and no rsync argv is run.
  - With room again, the resume runs with `--checksum` and verify passes.

## C2: a failed verify is recoverable
- **r8:** a logical mismatch, or a manifest sha/bytes mismatch, sets `copy = failed` and `checksum = true` and saves before refusing. The message says to copy again (`rsync --checksum` repair).
- **`--checksum`** is used whenever the copy is a resume (running/failed) or `checksum` is set, so a same-size, same-mtime difference that quick-check would skip is repaired.
- `checksum` is cleared only by a successful rsync.
- **Regression:** `R8.test_c2_failed_verify_is_recoverable_by_checksum_recopy`.
  - The destination README is tampered at the same size with the source's mtime restored.
  - Verify refuses and the state becomes `failed`/`checksum`.
  - The next copy's argv contains `--checksum`; verify passes and the bytes equal the source.

## C3: re-inventory keeps the journal's own destination and never adopts an unknown one
- **`inventory-source`** no longer clears a tree whose destination exists and whose copy state is running/failed/done.
  - It keeps `copy` and `dest_top`, installs the new inventory, and sets `copy = failed` and `checksum = true`.
  - The next copy therefore repairs with `--checksum` against the new source.
- **Ownership is proven, not assumed:**
  - When the destination top does not exist, `copy` creates it 0700 (rsync `-a` then applies the source's mode) and records its `[st_dev, st_ino]` as `dest_top` **before** rsync runs.
  - An existing destination is accepted only if the copy state is running/failed AND, when `dest_top` is recorded, its dev/inode matches.
  - Otherwise it refuses with "an unknown pre-existing directory is never adopted" or "is not the directory this journal's copy created".
- **r6/r7 journals** have no `dest_top`. Their existing running/failed copy is accepted once, and `dest_top` is recorded then.
- **Regressions:**
  - `R8.test_c3_reinventory_keeps_own_destination_never_adopts_unknown`:
    - after a copy, the source changes;
    - 1381 reuse is refused ("no reuse");
    - `--fresh-hash` keeps `dest_top`, marks the copy `failed`/`checksum`, and the copy + verify then pass;
    - an unknown pre-existing destination is refused both before and after a re-inventory;
    - a destination directory renamed away and replaced by a new one is refused.
  - `R8.test_r7_journal_without_dest_top_stays_compatible`: a journal with `dest_top` removed (the r6/r7 shape) recovers with copy + verify, and `dest_top` is then recorded.

## W1-W3: the root writer-check is a read-only scanner (the preferred design, implemented)
**W1: root writes nothing.**
- `writer-check` is the only phase root may run; with `production`, every other phase refuses root.
- It runs before any journal open, takes no lock, does no `write_atomic` and no chown.
- It returns the complete `/proc` scan (`scan_proc`, unchanged r5) plus `format` (`nvme-cold-subtree-writer-check/r8`), `t`, `prefixes`, `euid` and `tools` (the sha256 of the `subtree.py` and `relocate.py` it ran), and `main` prints it to **stdout**.
- The **owner's** shell redirect creates the result file. Root never opens a user path for writing.

**Owner-side record:**
- `record-writer-check --result FILE` requires:
  - a regular file owned by the owner, not group/world-writable;
  - exactly the 9 keys;
  - `format` = r8 and `euid` = 0;
  - `tools` = the sha256 of THESE `subtree.py`/`relocate.py`, and `relocate.py` = the r5 pin.
- It then writes `writer-check.json` (0600, atomic, `O_NOFOLLOW` temp + rename) and an event.
- `cutover` keeps r7's requirement unchanged: fresh (≤ `writer_check_max_age_seconds`), complete, zero hits, prefix covers this subtree.

**W2: verified bytes only.**
- `_load_relocate` reads `relocate.py`, checks the r5 sha256, then `compile` + `exec` of **those bytes** into a fresh module.
- The import system is not used for it, so a `__pycache__/relocate.*.pyc` is never consulted.
- **The root handoff** also copies both files with `install -m 0400 -o root -g root` into a new `mktemp -d /run/nvme-cold-wc.XXXXXXXX`, verifies the pinned shas **on those root-owned copies** (no check-then-use window on uid-1000 paths), and runs `python3 -I -B` from there after `cd /`. The trap removes only that `/run` dir.

**W3: frozen handoff.**
- `emit-writer-check` (emission-time script generation) is removed and is now an argparse invalid choice.
- `jobs/root-writer-check.sh` is a static file in SHA256SUMS with `SUBTREE_SHA=4509e043…` and `RELOCATE_SHA=2a037dae…` as constants.
- It prints `fs.protected_symlinks`/`protected_hardlinks` to stderr for the record.

**Regressions:**
- `R8.test_w1_root_scanner_writes_and_chowns_nothing`: with `writer-check.json` planted as a symlink to a victim file and `os.chown`/`fchown`/`lchown` trapped, the root scan makes zero chown calls, leaves the victim and every journal entry's mtime unchanged, and prints `euid` 0, the r8 format and the r5 tool sha.
- `R8.test_record_writer_check_validates_then_enables_cutover`:
  - each of a wrong format, euid 1000, another `subtree.py` sha, a 0666 file and a missing `--result` is refused;
  - the genuine scan output is recorded, and `cutover` then succeeds.
- `R8.test_w2_planted_pyc_is_never_executed`:
  - in a temp copy of the stage, a malicious timestamp pyc (valid mtime/size header) is planted for `relocate.py`;
  - the precondition passes: the import-system load (r7's way) **executes** it;
  - r8's `subtree.py` loaded from that directory does **not**, and still gets the real `relocate` (`walk_meta`).
- `R8.test_w3_root_handoff_pins_the_frozen_bytes`:
  - both constants equal the files' current sha256;
  - `-I -B`, `mktemp -d /run/`, `install -m 0400 -o root -g root` and `sha256sum -c` are present;
  - no non-comment line has chown/chmod/journal;
  - the last line is the bare scanner with no redirect;
  - `emit-writer-check` is rejected.
- **Adapted r7 tests:** `Cutover.test_writer_check_gates` (non-root `writer-check` refused; `emit` rejected) and `Safety` (now spies on `run_tail`).

**Bytecode in the job:**
- **Finding:** root's 1528 run left `r7/__pycache__/relocate.cpython-314.pyc` (steven, 0644, 11:02:53). `python3 -I` ignores `PYTHONDONTWRITEBYTECODE`, so `test_relocate`'s import wrote it.
- **r8 `jobs/tests.sh`:** runs `python3 -I -B`, and fails if any `__pycache__`/`*.pyc` exists in r8 (outside `runs/`) before or after the run.

## Preserved (unchanged code paths)
- **No source writes in COPY:**
  - `writes_on_dest` runs before journal creation and in `copy`;
  - the `st_dev` and mountinfo pins cover source, destination and journal;
  - rsync has no `--temp-dir` or delete options (`safe_rsync_argv`);
  - the new 0700 `mkdir` of the destination top is under the pinned `/` destination, after the floor check.
- **Limits:** `dest_floor_bytes` ≥ 300 GB; exact queue lane plus MemAvailable ≥ 16 GiB, enforced continuously by the queue guard; `bwlimit_kib` ≤ 204800.
- **Pins:** the exact subtree/mount/manifest/1381 pins; 0700 owner-only destination; inbound links checked before and after cut-over.
- **Cut-over and deletion:** identity checks and automatic rollback are unchanged. There is **no deletion or reclamation phase**.

## Root commands
**Tests:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cold-r8 512 unshare -Urn bash nvme-cold-relocation-stage/r8/jobs/tests.sh
```
PASS =
- `test_relocate` 22 OK and `test_subtree` 27 OK, nothing skipped;
- the original stage and r2-r7 frozen, r8 sums intact;
- no bytecode in r8.

**Single r7 first fresh copy (as authorised; no r7 resume, no r7 verify-repair, no r7 cut-over):**
- **Safe on r7 for a FIRST copy:** r7 checks the full-remaining-need floor when `copy` is absent, and refuses an existing destination.
- Run it exactly once, for one subtree, as the owner in the queue lane. To keep the stale r7 pyc out of the import path without deleting it, add `-X pycache_prefix=<new empty dir>` (works under `-I`; `-B` writes nothing):
  ```
  bash jobs/q-exit-status.sh <name> <lane MiB> python3 -I -B -X pycache_prefix=<new empty dir> \
      nvme-cold-relocation-stage/r7/subtree.py copy --config <config> --subtree <one subtree>
  ```
- **If that copy fails or is killed:** do NOT re-run r7. The r8 `copy` resumes it with the floor check and `--checksum` (r7 journal, no `dest_top`, accepted once).
- **Everything after the first copy** uses r8:
  1. `verify`
  2. the remaining copies + `verify`
  3. `plan`
  4. `sudo bash nvme-cold-relocation-stage/r8/jobs/root-writer-check.sh <config> > <result.json>` (redirect by the owner's shell)
  5. `python3 -I -B nvme-cold-relocation-stage/r8/subtree.py record-writer-check --config <config> --result <result.json>`
  6. `cutover --apps-stopped-attestation …` within the writer-check age
- **Before any cut-over:** the cold-proof checks from `logs/claude-capacity-nextstep-1510.md` still apply.

## Limitations (stated, not fixed)
- **rsync temp files:** a SIGKILLed rsync can leave `.name.XXXXXX` temp files in the destination.
  - Verify reports them as dest-only and marks the copy `failed`.
  - `--checksum` re-copies do not remove them (no `--delete`, by design), so verify keeps failing until **manual review** removes them.
  - The diff is in `verify-diff-<name>.json`. There is no automatic deletion.
- **Legacy acceptance:** an r6/r7 journal's existing running/failed destination is accepted once without a dev/inode proof. The same applies if r8 is killed between its `mkdir` and the `dest_top` save, a window of one `fsync`.
- **Result-file trust:** the owner's result file could be forged by uid 1000. `record-writer-check` checks its shape and tool shas, not its provenance; this is the same operator-trust level as before. Root-side signing would be a separate design.
- **Unbounded work:**
  - rsync has no wall-clock timeout; it is bounded by `--bwlimit`, the lane and the memory guard.
  - `--fresh-hash` reads `/vm` unthrottled.
- **Private Python hook:** the W2 regression uses `importlib._bootstrap_external._code_to_timestamp_pyc` (present in 3.14.8). If a future Python removes it, that test errors and does not silently pass.

## Capacity (unchanged facts)
- **After reclamation:** about 328 GB freed puts `/vm` at about 407.8 GB, about 21.9 GB above the qualification threshold (385,899,345,920). **The Qwen padbank can still grow by about 64 GB; if it resumes, that margin is lost.**
- **`/` after all three copies:** about 498 GB per 1530/1531, ≥ 300 GB enforced on every attempt.
- **Nothing is freed before** a separately reviewed reclamation of `.retire-*`.
