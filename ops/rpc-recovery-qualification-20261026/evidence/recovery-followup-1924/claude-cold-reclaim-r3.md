# Cold reclaim r3: frozen-r9 integration (early gaps first, then the FROZEN stage; nothing run) - 2026-10-26

**Status:**
- **Earlier stages:** r1 `faa561cb…` and r2 `4b0cd38d…` are preserved and verify. r2 is NOT for production (see D1).
- **r9:** `SHA256SUMS` `cc4d7cd3…` verifies. Pins: `subtree.py` `ba716ac4…1086`, `relocate.py` `2a037dae…`, `jobs/root-writer-check.sh` `316f4e8e…0218`. Root 1566 passed 56/56.
- **What I read:** `logs/claude-cold-r9-scanner.md` in full; the frozen `scan_users`/`walk_ids`/`phase_writer_check`/`Env`; r9's own fixtures (`fake_pid`, `real_proc`, the actual child mount namespace).
- **What I did not do:** no tests, root, live or build actions. **I claim no actual root/global scan.**

## D1. Defect in r2 that r3 fixes: r2 would have broken A7 itself
- **The cause:** r2 renames the top `.retire-<name>` to `.reclaim-r2-top-<name>` just before its final `rmdir`. The kernel's `d_path` for a still-open deleted file is built from its ancestors' **current** dentry names.
- **The effect:** after that rename, a surviving holder's fd reads `…/home/.reclaim-r2-top-<name>/… (deleted)`. That is **outside** r9's prefixes (`.retire-<name>`, src, dest), so scan B would **not** report the very holder it exists to find.
- **r3:**
  - The top is never renamed. It is `rmdir`'d under its `.retire-<name>` name, after a dev/ino check through an fd and an empty listing.
  - Inner entries are still renamed to tool names, which stay under the `.retire-<name>` prefix, so deleted-fd paths keep it.
  - **Actual-kernel regression:** a real child process opens a retired file after scan A. After reclaim, the REAL r9 `scan_users` over real `/proc` for that child must report a `how: "path"` hit whose target is under `.retire-<name>` and ends ` (deleted)`. `confirm` must refuse, and the data must be readable through `/proc/<pid>/fd/<n>` (the rescue path).

## What frozen r9 can and cannot represent (exact gaps; none is assumed away)
| proof r3 needs | frozen r9 | r3 handling |
|---|---|---|
| this subtree's retired AND destination inodes have zero users (scan A) | **yes**: inode hits carry `class`, `subtree` (cwd/root/exe, fd via fdinfo mnt_id+ino, maps dev:ino, inotify/fanotify inode marks, loop, swap) | block on any hit with `subtree == rel`, or path-only under its src/`.retire`/dest |
| no alias of the retired tree (scan A) | **yes**: `aliases` with `class: retire` while `.retire` is a dir | block `aliases`/`destAliases` for `rel` (destAliases are informational in r9; r3 blocks them conservatively) |
| filesystem/mount-wide watchers on the source or destination device | **yes**: `fsWatchers` (emitted only for target devices; raw mark, no dev field) | block if non-empty, in both scans |
| missed visibility | **yes**: `complete == (incomplete == [])`, `hitsTotal` | block on `complete` false or truncation, in both scans |
| scan bound to this exact tree | **partly**: `entries`, `dev`, `majmin`; **no `idsDigest`** (A5 declined) | bind on those three; the exact-tree proof is reclaim's own full identity walk of `.retire` against the receipt (incl. ctimes) immediately before deletion |
| holders of DELETED retired inodes (scan B) | **path string only** (A7). Inode match is impossible: the inode is no longer in any walked tree. | **G1:** scan B finds a holder only if its fd/cwd/maps path reads under the canonical `.retire-<name>`. D1 is fixed so the canonical prefix survives. |
| holders of deleted inodes reached through another path (alias, another namespace's view, io_uring registered file) | **not representable**: once `.retire` is absent r9 computes **no aliases for it** (`state != dir`), and their readlink strings are not under any prefix | **G2, residual:** such a holder must have opened the file in the window between scan A (zero users, zero aliases of `.retire`, complete) and the unlink, and through an alias created in that window. This is not prevented: those writes would be **lost** when the holder closes. It rests on the explicit trusted-operator / cold-tree assumption: hidden `.retire-*` names that nothing references; `reclaim` starts ≤ 120 s after scan A; and scan B follows at once. Closing it needs an r9 change (e.g. report every mount of the source filesystem whose root covers the retired tree's **parent**, or a pre-deletion seal by root). Not done here. |
| fds in flight (`SCM_RIGHTS`), nfsd/BPF kernel holders | not enumerated (r9 limitations 2-3) | **G3, residual**, stated; same assumption |
| destination users through any path (scan B) | **yes, by inode**: destination inodes persist, so fd/cwd/maps through aliases are inode-matched | block |
| tools/keys/format | `format …/r9`; exactly 18 keys; `tools` = **3 keys** (r2 assumed 2) | taken from frozen r9 (`WC_FORMAT`, `WC_KEYS`, `tool_shas()`) and checked against pinned constants |

**Operational note on `destAliases`:** a sandbox that binds `$HOME` exposes the destination at another path and blocks reclaim while it runs. r9 treats this as informational. r3 keeps it blocking, because the destination is the sole copy. Relaxing it is a reviewed decision; I do not make it silently.

## r3 plan (no features beyond r9 integration)
- **Loader:** load frozen r9 `subtree.py` (`ba716ac4…`, compile+exec; it loads `relocate.py` the same way). Use r9's bounded no-follow `load_config`, `read_bounded`/`parse_json`, `WC_FORMAT`, `WC_KEYS` and `tool_shas`, and pin the three r9 shas plus the format/keys.
- **Scan handling** (A and B): `format`, exact keys, `euid 0`, all three tools, `complete`, no truncation, the `t`/`tEnd` order and age, single use, per-subtree hits, aliases/destAliases, `fsWatchers`, source symlink, and the binding (`entries`/`dev`/`majmin`; `.retire` absent in B).
- **Deletion:**
  - inner entries: identity check → rename to `.reclaim-r3-<i>` → O_PATH re-check → unlink/rmdir → `nlink == 0`;
  - **the top: no rename**, dev/ino check via an fd, empty listing, `rmdir`;
  - unknown entries refuse.
- **`confirm`** = scan B **and** a fresh full re-hash of the retained copy against the receipt. Only then is the state `complete`. A crash or post-check failure is never green.
- **Integration tests** call the REAL r9 functions:
  - the r9 cut-over is produced by r9's own phases, with its real `phase_writer_check` over owned fixture `/proc` trees;
  - scans A/B use the real `phase_writer_check` / `scan_users`;
  - fixture processes, plus one real owned child process for A7;
  - synthetic JSON is used only for mutations of real results.
- **Report:** the final hashes, counts and a minimal production handoff follow in this file, then the freeze.

## r3 stage: FROZEN (source only; not run)
`nvme-cold-reclaim-stage/r3/`, `SHA256SUMS` = **`4cbe34c35b91721fd59e965b1bbebc34235f7cdc4a496a65cd668f98edfba29b`** (all files `a-w`)

**Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse, `sha256sum -c`. Reclaim r1 `faa561cb…` and r2 `4b0cd38d…`, and relocation r8 `433fd131…` and r9 `cc4d7cd3…`, re-verified unchanged; r9 has no bytecode.

| file | sha256 |
|---|---|
| `reclaim.py` (614 lines) | `6f7f9a863b9e20a8d58ab1db7a1e0a669e48b5194a4a84110025ddf41d743c08` |
| `tests/test_reclaim.py` (11 tests) | `6d8123997ec55a0fd898054a799fc4a62745bc1d8c900d2836f5cf8ff6b90a38` |
| `jobs/tests.sh` | `284bc68ec08466f583e73634a8fdfae9824113eb32ab9d3f6c3bad24394996ab` |
| `config.reclaim.production.template.json` | `ae942637afd5a8dc16aee99f868262bd47f62e4d3f8b0cd6d01055ebcbd22fd1` |
| `README.md` | `e8e9ea984f2c3589e3370a23697c33056c738cf281896c9861c6af494eebb164` |

**Changes vs r2 (only r9 integration and D1):**
- **Loader:** frozen r9 replaces r8 (pins `ba716ac4`/`2a037dae`/`316f4e8e`; it refuses to load if r9's `WC_FORMAT`, the 18 `WC_KEYS` or the 3 `TOOLS` differ from the pinned ones).
- **Reads:** the result and both configs are read with r9's `read_bounded`/`parse_json` (no-follow, owner, ≤ 32 MiB / 64 KiB).
- **Scan checks:**
  - `tools == R9_TOOLS == tool_shas()` (3 keys);
  - list/int type checks;
  - all of src/dest/`.retire` in `prefixes`;
  - binding by `entries` + `dev` + `majmin` (no `idsDigest`);
  - a path-only hit under any of this subtree's paths, ` (deleted)` stripped, blocks.
- **D1:** the top is never renamed.
- **`confirm`:** includes the fresh full re-hash of the retained copy; only then is the state `complete`.
- **Journal:** the new journal dir is `~/.local/state/nvme-cold-reclaim-r3`.

## r3 tests (11, not run)
**Root runs:** the r1 baseline 10 first (done: PASS, not production), then `cold-reclaim-r3`. **No actual root/global scan is claimed.**
- **The scanner is real:** every scan comes from r9's real `phase_writer_check` (through r9 `main writer-check`, euid faked 0) over **owned** fixtures. Only mutations of those real results are synthetic.
- **The cut-overs are real:** r9's own inventory/copy/verify/record/cutover.

1. **EndToEnd:** real scan A → reclaim.
   - 6 tool-name renames (3 files + 3 inner dirs), **the top never renamed** and last `rmdir`'d by its `.retire` name, 3 unlinks, 4 rmdirs, no rmtree;
   - the state is `deleted-unconfirmed` with no receipt;
   - real scan B → `confirm`: `complete`, `hashed_fresh` 3, the journal balances;
   - `check-retained`; the manifest link resolves; r9 rollback fails closed; other subtrees unchanged.
2. **A7 (actual kernel):**
   - an owned child opens `.retire-gguf-e2b/README` after scan A, and reclaim deletes it;
   - the **real r9 scan of the real `/proc` of that child** must report a `how: path` hit whose target is under `.retire-gguf-e2b` and ends ` (deleted)`;
   - `confirm` refuses and the state stays `deleted-unconfirmed`;
   - the data reads back through `/proc/<pid>/fd/<n>` (rescue);
   - after the child exits, a clean scan → `complete`.
3. **RealScanner, inode users:** a fixture pid with an fd via fdinfo `mnt_id`+`ino` on a gguf-e2b **destination** file (foreign path string) and a `maps` dev:inode of a gguf-e2b **retired** file gives real `inode` hits for `dest`/`retire` and a complete scan. gguf-e2b is refused and untouched; gvs5h reclaims from the same scan.
4. **RealScanner, aliases, watchers and missed visibility:** each of these is refused, nothing is deleted, and a clean scan then reclaims:
   - a fixture mount namespace exposing the fs at `/elsewhere` gives a real `aliases` entry for `retire`/gguf-e2b → refused;
   - a fixture fanotify filesystem mark on the target device gives a real `fsWatchers` entry → refused;
   - a nested `NSpid` gives real `complete: false` → refused.
5. **RealScanner, binding and authenticity** (mutations of real results), each refused:
   - retired `entries`/`majmin`, destination `entries`/`dev`, source not a symlink, missing retire target;
   - `t` too old, `tEnd < t`, from the future, stale > 300 s, older than a re-verify;
   - truncated hits, missing prefixes, a wrong job sha, euid 1000, the r8 format, an extra or missing key;
   - a destAlias for this subtree, and a 0666 result file.
6. **Crash after rename, before unlink:** `.reclaim-r3-1` remains; the used scan is refused; bogus tool names refuse and are kept; the resume with a real scan of the remaining tree completes, then `confirm`.
7. **Swap race:** README is replaced between check and rename. The unplanned inode is moved back and never deleted.
8. **Crash at the top `rmdir`:** the top keeps its `.retire` name and is empty, with state `rmdir-top`. `confirm` refuses; a late file refuses and stays; the resume finishes. EACCES on `lstat` makes `confirm` refuse with the state unchanged. Then `complete`.
9. **Destination written during reclaim:** `post-check-failed` (terminal, receipt says so); `confirm` and `reclaim` refuse after.
10. **Bindings:** an R4 late write refuses at verify and at reclaim. An edited subtree-journal entry, an edited reclaim config, or an edited dest-logical file each refuse. Nothing is deleted.
11. **Stage:** r9 `SHA256SUMS` sha = the pin, the listed shas = `R9_TOOLS` = `tool_shas()`, the format and keys equal r9's; no rmtree/system/subprocess/glob/`os.walk(`/`sudo` in `reclaim.py`.

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cold-reclaim-r3 512 unshare -Urn bash nvme-cold-reclaim-stage/r3/jobs/tests.sh     # expects Ran 11, OK
```
**Test-environment assumptions:** the same as r9's. `TEST_TMP` (`r3/runs/…` on `/`) must have mountinfo maj:min == `st_dev`, and the A7 child must be able to read its own `/proc`. If the kernel showed a different deleted-fd path, test 2 **fails** visibly; it is not skipped.

## Minimal production handoff (per subtree; only after the copy is verified, r9 + r3 are independently reviewed and PASS, and the r9 cut-over is complete)
**Prerequisites:**
- da 1565's review of r9 is accepted, and an independent review of r3 is done;
- `cold-reclaim-r3` passes;
- a reclaim config is filled from the template (`subtree_config` = the exact r9 config, its sha256, `verify_max_age_seconds`), owner 0600;
- `umask 077`.

Here `W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025`, `RC=<reclaim config>`, `C9=<r9 config>`, `S=2026-10-24/home/<name>`, `N=<name>`.
1. **Verify** (owner, queue):
   ```
   bash jobs/q-exit-status.sh reclaim3-verify-$N 512 python3 -I -B nvme-cold-reclaim-stage/r3/reclaim.py verify --config $RC --subtree $S
   ```
2. **Scan A** (root): the **r9 README staged wrapper, verbatim**, with `$C9`, redirected by the owner's shell to `$W/logs/reclaim3-A-$N.json`.
3. **Reclaim** (owner, queue; start within 120 s of A, or take a new A):
   ```
   bash jobs/q-exit-status.sh reclaim3-$N 512 python3 -I -B nvme-cold-reclaim-stage/r3/reclaim.py reclaim --config $RC --subtree $S \
        --result $W/logs/reclaim3-A-$N.json --reclaim-retired /vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-$N
   ```
4. **Scan B** (root): immediately, the same wrapper, to `$W/logs/reclaim3-B-$N.json`.
5. **Confirm** (owner, queue; within 120 s of B); this includes the full re-hash of the retained copy:
   ```
   bash jobs/q-exit-status.sh reclaim3-confirm-$N 512 python3 -I -B nvme-cold-reclaim-stage/r3/reclaim.py confirm --config $RC --subtree $S --result $W/logs/reclaim3-B-$N.json
   ```
   Only `"state": "complete"` (rc 0) counts.
   - **`users of … (deleted)`:** copy the data out via `/proc/<pid>/fd/<n>` before that process exits, then re-scan.
   - **`post-check-failed`:** manual review; the destination is the only copy.
- **Freshness:** both scans must be fresh. If the queue delays a step past 120 s, it refuses "stale"; take a new scan. Nothing is lost by refusing.
- **Scope:** another subtree's users never block this one. Unrelated apps need not stop. Sandboxes binding `$HOME` produce `destAliases` and block (see the operational note above).

## Explicit assumption and residual risks (not dismissed)
**Trusted operator / cold trees:** nobody deliberately opens hidden `.retire-*` files, or mounts aliases of them, during the reclaim window.

If that is violated, the following are **data-loss** cases. r3 cannot prevent them with the frozen r9 output:
- **G2:** a holder of a deleted retired inode through an alias or another namespace's path, created after scan A. It is invisible to scan B because r9 has no `.retire` aliases once the tree is absent, and its path string is not under any prefix.
- **G3:** `SCM_RIGHTS` in-flight fds and nfsd/BPF holders, which are not enumerated.

**Narrowing in place:**
- scan A has zero users, aliases and watchers, and is complete;
- reclaim starts ≤ 120 s after scan A;
- scan B and A7 cover canonical-path holders, with the rescue path.

**Closing them** needs an r9 change: aliases of the retired tree's parent, or every mount of the source filesystem, in the post-deletion scan; or a root pre-deletion seal. Not done; it is a separate review. **No other gap is assumed away.**
