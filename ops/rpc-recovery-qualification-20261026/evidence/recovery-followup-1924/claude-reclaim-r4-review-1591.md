# Review 1591: nvme-cold-reclaim-stage/r4 (independent, SOURCE ONLY)

**Bytes:**
- **r4:** `SHA256SUMS` **`06cf9fd24c19039710304a2d9d03a07bf2030168d179b49cb5ea0242d7e06a80`** (`sha256sum -c` OK):

  | file | sha256 |
  |---|---|
  | `reclaim.py` | `ba194c74…` (618 lines) |
  | `tests/test_reclaim.py` | `97b2f58c…` (11 tests) |
  | `jobs/tests.sh` | `4680ca8e…` |
  | `config.reclaim.production.template.json` | `a7bab267…` |

- **Frozen r10:** `SHA256SUMS` `2342e677…` (verified, no bytecode):

  | file | sha256 |
  |---|---|
  | `subtree.py` | `90cd8968…` |
  | `relocate.py` | `2a037dae…` |
  | `jobs/root-writer-check.sh` | `7bcd4fbf…` |

  These equal r4's pins (`reclaim.py:38-42`).

**Also read:**
- `logs/claude-cold-reclaim-r4.md`;
- root clarification `logs/root-cold-r10-review-clarification-1588.md`;
- r10 `walk_ids` (`subtree.py:665-721`) and the scan-result shape;
- the production subtree config `logs/cold-subtree-production-1530.json` (sha `bae6021b…`, = the r4 template's observed pin; `writer_check_max_age_seconds` = 120, `dest_floor_bytes` = 300 GB).

**Not done:** no tests, builds, live actions, sudo, USB or edits to stages.

**Test status:** root 1582 (r10, 61) and 1587 (r4, 11) show only "NOT STARTED: test allocation held". **Neither has passed.**

## Early verdict
**No blocking data-preservation defect found in the r4 source.** The trust baseline is a trusted root operator; no malicious-root features are assumed.

**Before any actual reclaim:**
1. both suites must actually pass (C1 below);
2. the operational conditions (C2–C9) must hold;
3. the crash-at-top recovery procedure (M1) must be accepted.

One MEDIUM operability gap (M1, no data at risk) and three LOW notes follow.

## Verified correct (with line references)
- **Exact r10 API binding:**
  - the loader execs only the sha-pinned r10 `subtree.py` (`:48-59`), which in turn loads `relocate.py` by its own sha pin;
  - it refuses unless `WC_FORMAT` is `…/r10`, `WC_KEYS` equals the 18 pinned keys, and `TOOLS` has exactly the 3 pinned names;
  - the scan gate (`:243-257`) requires format r10, exactly the 18 keys, `euid` 0, `tools ==` the pinned 3 shas **and** r10's `tool_shas()` of the files on disk, and well-typed lists and times.
- **dev+ino binding:**
  - `bound()` (`:236-240`) checks `state == dir`, `dev`, **`ino`** (r10 emits it: `subtree.py:687`), `majmin` and `entries`;
  - both counts include the top (r10 `n = 1`; `walk_meta` has the `""` record);
  - **retired:** the plan's top `(dev, ino)` and the full plan count at the start (`:505`), and the **remaining** count on every resume (`:513-515`, after pass 1 at `:384`);
  - **destination:** the receipt's `dest_top` and `dest_entries` at reclaim (`:496`) and at confirm (`:540`).
- **Holders of source AND destination:**
  - any hit of this subtree by inode (r10 attributes the retire **and** dest classes), or any path hit under src, `.retire` or dest, with ` (deleted)` stripped (`:270-274`);
  - other subtrees' hits do not block (scoped, as intended);
  - truncation refuses (`hitsTotal != len(hits)`, `:268`);
  - `aliases` **and** `destAliases` for this subtree or unscoped (`:275-277`), and **any** `fsWatchers` (`:278`), refuse;
  - this is the stricter gate root 1588 requires of reclaim, enforced in code, unlike r10's cut-over `require_writer_check`;
  - incomplete refuses (`:258`); the source must be the cut-over symlink to dest (`:280-282`).
- **Freshness and single use:** `after_t < t ≤ tEnd ≤ now+1`, age ≤ the config's 120 s (`:261`), `t` greater than every accepted scan (`:263`). The verify receipt age is ≤ `verify_max_age_seconds` (≤ 6 h, `:500`).
- **Before deletion:**
  - `verify` (`:414-458`) requires:
    - the cut-over complete and consistent;
    - the original as the symlink;
    - `.retire` identity == the verified source identity (ctimes included);
    - check_plan: regular files and directories only, owner-owned, `nlink` 1, no tool names;
    - the destination identity == `dest_identity_at_cutover`;
    - a **fresh full** destination hash (no reuse) == the verified logical and the manifest entries;
    - the home links resolving.
  - `reclaim` re-walks `.retire` == the plan exactly (`:502-504`) and requires the destination identity unchanged since the receipt (`:492-494`).
  - The content equality of the source and the destination is transitive and sound: inventory hash → verify logical; the ctime-sensitive identity rules out writes since.
- **After deletion:** `confirm` (`:528-566`) requires:
  - scan B after the deletion with the same gates (including ` (deleted)` path holders, the canonical A7 case);
  - `.retire` ENOENT both locally (EACCES is never absence, `:87-95`) **and** in the scan;
  - the destination identity unchanged and a **fresh full re-hash** == the receipt.

  Otherwise it is `post-check-failed`, never green.
- **Deletion mechanics:**
  - **two passes:** children first; unknown names refuse;
  - **per entry:** identity (ctime on planned names) → same-directory rename to `.reclaim-r4-<i>` → O_PATH re-check → `unlink`/`rmdir` → `nlink == 0` (`:341-366`);
  - **a hardlink added after A:** it fails `nlink == 1`, or after the unlink the `nlink != 0` refusal keeps the data reachable;
  - **the top is never renamed;** it is fd-checked, emptied, name-to-fd re-checked, then `rmdir` (`:388-396`);
  - **no recursion or wildcards.**
- **Crash and resume:**
  - `deleting` / `rmdir-top` resume with a fresh scan; moved names are recognized by index and directory (`:303-317`);
  - a swap between check and unlink is never deleted (renamed back when possible);
  - a destination change is never green.
- **Canonical deleted-fd test:** `A7` (`test_reclaim.py:267-296`) uses a real child holding a real retired file across the deletion. The real r10 scan reports a `how: path` hit under `.retire-…` ending ` (deleted)`. `confirm` refuses, and the data is recovered via `/proc/<pid>/fd/<n>`, then `complete`.
- **Loader bounded and pinned:** see L2 for the minor remainder.

## Findings
**M1 (MEDIUM, operability; no data at risk): a crash after the top `rmdir` succeeds leaves the subtree stuck in `rmdir-top`.**
- **The window:** `os.rmdir(name)` (`:396`) → event → return → `rs["reclaim"] = "deleted-unconfirmed"` + save (`:522-523`).
- **What happens after a kill or power loss in that window:**
  - `reclaim` refuses with "vanished while reclaim was 'rmdir-top': manual review" (`:378-379`);
  - `confirm` refuses with "nothing to confirm" (`:533-534`).
- **Not tested:** `test_crash_at_the_top` covers only a **failed** `rmdir`.
- **The data is safe:** every child was already removed and verified one by one, and the destination is the retained copy.
- **Recovery** (operator, owner, exactly this case only, i.e. state `rmdir-top` **and** `.retire-<name>` ENOENT):
  ```
  umask 077; python3 -I -c 'import json,sys,time;p=sys.argv[1];s=json.load(open(p));t=s["trees"][sys.argv[2]];assert t["reclaim"]=="rmdir-top";t["reclaim"]="deleted-unconfirmed";t["deleted_t"]=time.time();json.dump(s,open(p+".tmp","w"),indent=1,sort_keys=True)' \
    /home/steven/.local/state/nvme-cold-reclaim-r4/state.json 2026-10-24/home/<N> && mv /home/steven/.local/state/nvme-cold-reclaim-r4/state.json.tmp /home/steven/.local/state/nvme-cold-reclaim-r4/state.json
  ```
  Keep the file 0600. Then take a fresh scan B and run `confirm`; only `complete` counts.
- **Code fix for a later revision:** `reclaim` in state `rmdir-top` with local ENOENT and the scan's `retire` target `absent` moves to `deleted-unconfirmed`.

**L1 (LOW): the scan age is not capped by reclaim itself.** It uses the subtree config's `writer_check_max_age_seconds`, which is 120 s in the pinned production config (sha `bae6021b…`, bound by `subtree_config_sha256`). That is acceptable as is. An explicit cap (≤ 300 s) in a later revision would make it independent of the config.

**L2 (LOW):**
- `R10_SUMS_SHA256` (`:38`) is not used at run time.
- `_load_r10` reads `r10/subtree.py` with a plain unbounded `open` (`:51-52`). That runs as the owner on the owner's own stage, so there is no privilege boundary, and the sha pin decides.
- Optional hardening: `O_NOFOLLOW` plus a size cap.

**L3 (LOW, informational):** `journal_balances` uses `≤` (`:551`). That is correct for crash tolerance (an unlink can precede its event), but it is not an exact count. `.retire` ENOENT plus the full re-hash are the real proof.

## Residuals (real data-loss cases if violated; accepted under the trusted-operator baseline)
- **G2:** a holder of a retired inode that opens it **through a mount alias or another namespace's path created after scan A** is invisible to scan B once `.retire` is gone.
  - Creating such an alias needs a root mount action during the about 120 s window.
  - Plain paths, symlinks into `.retire` and hardlinks are covered (path hits, `nlink` checks).
  - Scan A must show zero aliases.
- **r10 snapshot limits:** the window, `SCM_RIGHTS` in flight, `io_uring` by path, kernel holders beyond loop and swap.
- **The cost of being conservative:**
  - `destAliases` from sandboxes binding `$HOME`, any fanotify filesystem/mount mark on `/` or `/vm`, and recursive inotify watchers on `~` (hits on the destination inodes) all **block** until they are stopped;
  - nothing is lost by this.

## Conditions before an actual reclaim (per subtree, in order)
1. **C1:** root's **actual** runs PASS: `cold-r10` 61 (22 + 39) and `cold-reclaim-r4` 11, with no skips. Not yet started (1582/1587 queued).
2. **C2:** the subtree's copy has been verified (`verified` in the r7 journal) and its r10 **cut-over is `complete`**.
   - **The cut-over itself:** taken only on a fresh, complete root scan with zero hits, aliases, `destAliases` and `fsWatchers` (root's stricter gate, 1588).
   - **The attestation:** names the actual stopped users or the evidence that the cold tree is unused (never "all apps stopped").
3. **C3:** the reclaim config is filled exactly:
   - `subtree_config` = `logs/cold-subtree-production-1530.json`;
   - its sha is `bae6021b…`;
   - `verify_max_age_seconds` ≤ 21600;
   - the file is owned by the owner, 0600, written under `umask 077`.
4. **C4:** watchers and holders are stopped (IDE/indexers on `~` and `/vm`, sandboxes binding `$HOME`). Record `losetup -l -O NAME,BACK-MAJ:MIN,BACK-INO,BACK-FILE` and `swapon --show`: no loop or swap backed under `/vm/enclave-volumes/codex-archive`.
5. **C5:** `/` free ≥ 300 GB (checked by `gates`) and the queue lane is available. **One subtree at a time.**
6. **C6:** `verify` (fresh full destination hash), then **scan A** with the r10 README wrapper verbatim (the owner redirects stdout).
7. **C7:** `reclaim` within 120 s of A, with `--reclaim-retired` set to the exact `.retire` path.
8. **C8:** **scan B** immediately, then `confirm` within 120 s of B. **Only `"state": "complete"` (rc 0) counts.**
9. **C9:** for the record, compare `/vm` free before and after (`source_free_before`/`after`).

## Recovery
- **Any refusal before the `reclaim` intent** (verify, scan or binding): nothing has been deleted. Fix the cause and take fresh scans. The r10 `rollback` of the cut-over is still possible.
- **Interrupted while `deleting`:** run `reclaim` again with a **fresh** scan A′ (≤ 120 s). Every remaining entry is re-checked; tool names are recognized.
- **Stuck in `rmdir-top` with `.retire` ENOENT:** M1 procedure above.
- **`confirm` refuses "users of … (deleted)":** before that process exits, copy the data out (`cp /proc/<pid>/fd/<n> <new file on />`). Then stop the process, take a fresh scan B and confirm.
- **`post-check-failed`:** the destination is the **only** copy. Do not modify it. Run `check-retained` and review manually.
- **After `complete`:** rollback is impossible. Run `check-retained` periodically. A move back to `/vm` would be a separately reviewed reverse copy.
