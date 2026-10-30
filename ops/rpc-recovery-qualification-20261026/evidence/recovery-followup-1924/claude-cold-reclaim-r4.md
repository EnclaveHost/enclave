# nvme-cold-reclaim-stage/r4: reclaim r3 adapted to the FROZEN r10 scanner API. FROZEN 2026-10-26 19:24Z, NOT RUN

**Status:**
- `SHA256SUMS` sha256 **`06cf9fd24c19039710304a2d9d03a07bf2030168d179b49cb5ea0242d7e06a80`**; `sha256sum -c` OK; all files 0444; no bytecode.
- **Re-verified unchanged:** reclaim r1 `faa561cb…`, r2 `4b0cd38d…`, r3 `4cbe34c3…`; relocation r8 `433fd131…`, r9 `cc4d7cd3…`, r10 `2342e677…` (r10 has no bytecode).
- **What I read:** `logs/claude-cold-reclaim-r3.md`, r3 `reclaim.py` (loader, scan gate, binding, reclaim/confirm), and r3's test fixtures (`scan`, `cut_over`, `fake_pid`, `own_mount_id`, A7, RealScanner, Stage).
- **What I did:** text edits, `ast.parse`, `bash -n`, `json` parse, sha256 only.
- **What I did not do:** no tests, builds, live actions, sudo or USB. **Nothing claims a pass or any actual root/global scan.** 50's independent r10 review (task 1580) is separate; r4 inherits its outcome.

## Files
| file | sha256 |
|---|---|
| `reclaim.py` (618 lines) | `ba194c74630a828c4a2101024bb5a1da699ea95d784c1cf1654b5702363ee6e4` |
| `tests/test_reclaim.py` (11 tests) | `97b2f58c0bfb428b03da49186ab08c6e61eb81ac6eeed292ad2f2367aacecd9e` |
| `jobs/tests.sh` | `4680ca8ec3501841512b01e01653e3ccda38032545b87dcffe42e33eda358f88` |
| `config.reclaim.production.template.json` | `a7bab267984844eb6c9887cce596a9a870bbd4f50f173527e9777821181620f9` |
| `README.md` | `8779f321fd034622e92f8ccb881856bdd2001732a0e8003ed8ad347e05b23213` |

## Changes vs r3 (API integration only; every r3 gate kept)
1. **Loader and pins:** frozen r10 is loaded by sha-pinned compile+exec from `nvme-cold-relocation-stage/r10`:
   - `R10_SUBTREE_SHA256 = 90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3`
   - `R5_RELOCATE_SHA256 = 2a037dae…`
   - `R10_JOB_SHA256 = 7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635`
   - `R10_SUMS_SHA256 = 2342e677…`
   - It refuses to load unless r10's `WC_FORMAT == "nvme-cold-subtree-writer-check/r10"`, the 18 `WC_KEYS` equal the pinned list, and the 3 `TOOLS` equal the pinned keys.
2. **Scan gate:** `format` must be r10; r8 and r9 are refused. The keys must be exactly the 18. `tools` must equal the pinned 3-key dict **and** r10's `tool_shas()`, with euid 0.
3. **Top-inode binding:** `bound(target, (dev, ino), entries)` additionally requires r10's `ino`.
   - **Retired:** the top `(dev, ino)` = the plan's first record (`walk_meta` top), at the start and on every resume. The top is never renamed, so its inode is stable.
   - **Destination:** the receipt gains `dest_top = drecs[0]["id"][:2]` (`dest_dev` kept), used in `reclaim` and in `confirm`'s `scan_dest_bound`.
4. **Namespaces:** `nvme-cold-reclaim-config/r4`, journal mode `reclaim-r4`, receipt `…/r4`, journal `~/.local/state/nvme-cold-reclaim-r4`, temp names `.reclaim-r4-<i>`. r3 never ran in production, so a fresh namespace avoids mixing.
5. **Wording:** messages and docstrings say r10. The two test names that said `r9` now say `r10`.

**Unchanged, with nothing weakened:**
- the `complete`/`incomplete` and truncation (`hitsTotal == len(hits)`) blocks;
- this subtree's hits by inode (retire **and** dest) or by path under src/`.retire`/dest (` (deleted)` stripped);
- `aliases` + `destAliases` for this subtree (or unscoped);
- any `fsWatchers`;
- the source must be the cut-over symlink;
- `t`/`tEnd` order, age ≤ `writer_check_max_age_seconds`, after the receipt/deletion, single use;
- bounded no-follow reads;
- R4 `.retire` identity == the verified source identity;
- fd-anchored per-entry deletion (rename → O_PATH re-check → unlink → `nlink 0`);
- **the top never renamed** (A7);
- `confirm` = scan B + `.retire` ENOENT (here and in the scan) + a **fresh full re-hash** of the retained copy == the receipt;
- crash states never green.

## Tests (11, prepared, NOT run)
These are r3's 11, now driving the REAL frozen **r10** phases (inventory, copy, verify, record, cut-over) and r10's real `phase_writer_check` over owned fixture `/proc` trees and one real owned child. Synthetic JSON appears only as mutations of real r10 results.
- **Kept as is** (assertions unchanged):
  - EndToEnd: 6 tool renames, **top never renamed**, `rmdir`'d last by its `.retire` name, then `complete`;
  - **A7 actual deleted-fd case:** the real r10 scan of a real child's `/proc` reports `how: path` under `.retire-gguf-e2b`, ending ` (deleted)`; `confirm` refuses; the `/proc/<pid>/fd/<n>` rescue works; then `complete`;
  - RealScanner inode users (dest + retire) and the alias/watcher/incomplete blocks;
  - Crash, swap, top-`rmdir`, destination change, Bindings.
- **Added to the real-result mutation test:**
  - retired `ino` + 1 → refused ("retired walk"); retired `ino` missing → refused; destination `ino` + 1 → refused ("destination walk");
  - format `…/r9` → refused ("not an r10").
- **Stage:** r10's `SHA256SUMS` sha = the pin; the listed shas = `R10_TOOLS` = `tool_shas()`; the format and keys equal r10's; the banned-operations scan is unchanged.

**Root (main queue, 512):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cold-reclaim-r4 512 unshare -Urn bash nvme-cold-reclaim-stage/r4/jobs/tests.sh     # expects Ran 11, OK, ## cold-reclaim-r4 rc=0
```
- **Before running,** the job checks that reclaim r1-r3 and relocation r8-r10 are frozen and unchanged, and that r4 and r10 contain no bytecode.
- **Expected counts:** relocation r10 is 61 (22 + 39, `cold-r10`); reclaim r4 is **11**.
- **Test-environment assumptions:** the same as r3 and r10 (TEST_TMP on ext4 `/` with maj:min == st_dev; nested userns).
  - The fixture views include the host's real mountinfo, which on this host has containerd overlays with absolute `/var/lib/containerd/…` layers. r10's G1 check does not flag those, because they are not at, under or above the fixture prefixes.

## Production handoff (per subtree; only after ALL of these)
**Prerequisites:**
- `cold-r10` PASS 61 and `cold-reclaim-r4` PASS 11;
- 50's r10 review (1580) accepted, and an independent review of r4;
- the copy verified and the r10 cut-over of that subtree `complete`;
- the reclaim config filled from the template (`subtree_config` = the exact production config, its sha256, `verify_max_age_seconds` ≤ 21600), owner 0600; `umask 077`.

**Steps.** Here `W=/home/steven/…/rpc-production-final-20261025`, `RC=<reclaim config>`, `C=<subtree config>`, `S=2026-10-24/home/<N>`.
1. **Verify** (owner, queue):
   ```
   bash jobs/q-exit-status.sh reclaim4-verify-$N 512 python3 -I -B nvme-cold-reclaim-stage/r4/reclaim.py verify --config $RC --subtree $S
   ```
2. **Scan A** (root): the **r10 README `<!-- r10-root-wrapper -->` block, verbatim** (dd no-follow staging, pins `7bcd4fbf…`/`90cd8968…`/`2a037dae…`) with `$C`, redirected by the owner's shell to `$W/logs/reclaim4-A-$N.json`.
   - Stop IDE/indexer watchers of `~` and `/vm` first.
   - Record `losetup -l -O NAME,BACK-MAJ:MIN,BACK-INO,BACK-FILE` and `swapon --show` alongside.
3. **Reclaim** (owner, queue; within 120 s of A):
   ```
   bash jobs/q-exit-status.sh reclaim4-$N 512 python3 -I -B nvme-cold-reclaim-stage/r4/reclaim.py reclaim --config $RC --subtree $S --result $W/logs/reclaim4-A-$N.json --reclaim-retired /vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-$N
   ```
4. **Scan B** (root): immediately, the same wrapper, to `$W/logs/reclaim4-B-$N.json`.
5. **Confirm** (owner, queue; within 120 s of B; includes the full re-hash of the retained copy):
   ```
   bash jobs/q-exit-status.sh reclaim4-confirm-$N 512 python3 -I -B nvme-cold-reclaim-stage/r4/reclaim.py confirm --config $RC --subtree $S --result $W/logs/reclaim4-B-$N.json
   ```
   - Only `"state": "complete"` (rc 0) counts.
   - **`users of … (deleted)`:** copy the data out via `/proc/<pid>/fd/<n>` before that process exits, then re-scan.
   - **`post-check-failed`:** manual review; the destination is the only copy.
6. **`check-retained`** later.

**Freshness:** a stale scan refuses and nothing is lost; take a new one.
**Constraints:** no USB touch (all USB writes are paused); nothing here writes to USB.

## Real residuals (not dismissed; each is a DATA-LOSS case if violated)
1. **G2 (from r3; r10 does not change it):** a holder of a deleted retired inode reached through an alias or another namespace's path created **after** scan A is invisible to scan B. Once `.retire` is absent, r10 has no alias for it, and the path string is not under a prefix.
   - **Narrowed by:** scan A being complete with zero users, aliases and watchers; reclaim starting ≤ 120 s after A; scan B at once; the trusted-operator / cold-tree assumption (hidden `.retire-*` names).
   - **Closing it** needs a scanner change (aliases of the retired tree's parent, or a root pre-deletion seal). Not done.
2. **r10's stated limitations:**
   - the snapshot window, and SCM_RIGHTS fds in flight;
   - `io_uring` registered files by path only;
   - kernel holders beyond loop and swap, with loop and swap matched by path string (recorded `losetup`/`swapon` as above);
   - a detached overlay held only by an fd;
   - a `maps` read can hang the scan, which fails closed.
3. **Operational:** `destAliases` (sandboxes binding `$HOME`) block reclaim while they run. This is conservative and kept: the destination is the only copy.
4. **No live practicality data:** the scan runtime and counters are unmeasured, and nothing has run.
