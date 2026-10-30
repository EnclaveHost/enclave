# 1745: retire the old cut-over plan by deleting ONLY the three root (`/`) duplicate copies. Read-only audit; NO deletion

**Scope:** read-only.
- **Executed by me:** `stat`/`lstat` of the exact six trees; reading the journal files, the two logs and the r10/reclaim sources; an own-uid `/proc` look.
- **Not done:** hashing, content reads, broad scans, sudo, signals, mutation, or edits to any tool or journal.

## Exact paths
| subtree | ORIGINAL, to be KEPT (`/vm` = `cryptvm`, st_dev 64769) | DUPLICATE, proposed for deletion (`/` = `cryptroot`, st_dev 64768) | bytes | entries |
|---|---|---|---|---|
| gguf-e2b | `/vm/enclave-volumes/codex-archive/2026-10-24/home/gguf-e2b` (top ino 147980347) | `/home/steven/.cold-archive/codex-archive/2026-10-24/home/gguf-e2b` (top ino 188130023) | 43,957,352,504 | 99 |
| gvs5h | `…/codex-archive/2026-10-24/home/gvs5h` (147587074) | `…/.cold-archive/codex-archive/2026-10-24/home/gvs5h` (188131076) | 125,195,719,424 | 8 |
| hf-convert | `…/codex-archive/2026-10-24/home/hf-convert` (147849217) | `…/.cold-archive/codex-archive/2026-10-24/home/hf-convert` (188129960) | 158,749,500,752 | 28 |

The total is 327,902,572,680 bytes, equal to `cold-copies-verified-1597.json` (sha `ad1e1337…`). The config is `cold-subtree-production-1530.json` (`bae6021b…`).

## State of the old plan (journal `/home/steven/.local/state/nvme-cold-subtree-r7/`)
- **What `state.json` records** (format `nvme-cold-relocation-journal/v1`, mode `subtree-r6`):
  - all three trees have `copy: done` plus `verified` (`source_identity`/`dest_identity`/`logical`, verify times 1793038421.5 / 1793040790.8 / 1793043462.5);
  - **no `cutover` key, and no `writer-check.json`**;
  - `dest_top` is recorded for gvs5h and hf-convert only (gguf-e2b was copied by the older r7 path).
- **`events.jsonl`:** only inventory-source, then copy (rsync `-aHAX --one-file-system`, rc 0), then verify ok, for each tree.
- **On disk:** **no `/vm/…/home/.retire-*`**, and the originals are real directories, not symlinks. **No cut-over ever started.** So nothing points to the duplicates through r10's symlink, and reclaim r4 (whose scope is only `.retire-*`, after a complete cut-over) has nothing to act on.

## Metadata-only evidence (NOT content verification)
**Every entry of all six trees was lstat-compared with its saved per-entry meta** (`{source,dest}-<t>.meta.json`, fields `p,t,m,u,g,id=[dev,ino],mt,s,nl`):
- **counts:** 99/8/28 on both sides, with **no missing and no extra entries**;
- **per entry:** type, mode, uid/gid, **dev+ino**, mtime_ns, size and nlink all **equal**;
- no hardlinks and no symlinks in any of the six trees.

**ctime:** the maximum ctime of every duplicate tree is **≤ its verify time** (…369.8 ≤ …421.5; …692.2 ≤ …790.8; …336.6 ≤ …462.5). Nothing in the duplicates was written, chmodded or renamed after verification.

**What this does NOT prove:** that content bytes are unchanged. That is extremely unlikely without an mtime or ctime change, but metadata cannot exclude it, and xattrs (`x`) were not compared. Content proof means a **fresh full re-hash**, i.e. re-running r10's verify comparing `logical`, which reads 327.9 GB from each side.

**Do we need content proof to delete the DUPLICATES?** Only to rule out unique data written into them after the copy, and ctime ≤ verify-time already rules out any write, rename or chmod since verification. The originals are retained either way.

## Visibility limits (no production "unreferenced" claim)
- **Own uid only:** `/proc` of **uid-1000** processes (cwd, root, fds, maps, cmdline) shows **no holder** of the duplicate paths. The only match was the coordinator shell, whose command line merely contains this task's text (cwd = the work dir; not a holder).
- **Not checked** (root required): other uids, other mount namespaces and bind mounts/aliases of `/home/steven/.cold-archive`, fanotify/inotify watchers, and **inbound symlinks** anywhere in `/home` or `/vm`. A broad scan was not allowed.
  - **Mitigating:** r10 never created a symlink (no cut-over), and the 1510 audit's 2,102 symlinks resolve into **`/vm/…/codex-archive`** (the originals), not into `.cold-archive`, which was created later by r10's copy. **This is not proof** for files created since.

## Pending root scan: still relevant, but its PURPOSE changes
- **What the r10 writer-check (local sudo; handoff 1595) was for:** proving **no writers on the SOURCE** before replacing it with a symlink. **That is retired** together with the cut-over, and reclaim r4 becomes moot.
- **What is still needed:** the same r10 scan also reports the **`dest` class** (hits by inode and path under the dest prefixes, plus `destAliases`). That is exactly the root-level "nothing holds or aliases the duplicates" evidence a deletion needs. Requirements:

  | field | required value |
  |---|---|
  | `complete` | `true` |
  | dest-class hits | 0 |
  | `destAliases` | none |
  | `fsWatchers` on `/` | none |

  Root should treat that as the gate (per 1588: `destAliases`/`fsWatchers` are a manual check; the code does not enforce them).

## Narrow retirement design (after the user's explicit authorization; root runs it; no new framework)
1. **Freeze the evidence:** re-run the metadata comparison above (or r10's `inventory` against the saved meta) **immediately before** deletion. Require: all six trees equal to their meta, duplicate ctime ≤ verify time, and the originals unchanged with no `.retire-*`. **Optional:** a fresh full re-hash of the **originals** only, if root wants their content re-proved (deleting the duplicates does not need it).
2. **Root scan:** the r10 writer-check with the dest-class, `destAliases` and `fsWatchers` gate above, plus a narrow inbound-symlink check restricted to `/home/steven` and `/vm/enclave-volumes` (root's choice of tool and bounds).
3. **Delete as the owner** (uid 1000; no sudo), only the three exact duplicate directories, and only if:
   - each top's (dev, ino) equals the `dest_top`/meta `id`: `64768:188130023`, `64768:188131076`, `64768:188129960`;
   - each top is on st_dev 64768;
   - none of them is a symlink.

   Use no-follow, one-filesystem removal of exactly those paths (e.g. `rm -r --one-file-system -- <exact path>` after the identity check). Never `.cold-archive` itself; never the originals.
4. **Retire the plan without enabling a stale cut-over. Do NOT edit or delete the r7 journal** (it is the audit record). Afterwards:
   - **cut-over refuses automatically:** `phase_cutover` (r10 `subtree.py:1042-1067`) needs a fresh writer-check and then `identity_now(dst) == verified.dest_identity`, which cannot hold once the duplicate is gone ("destination changed after verify");
   - **re-enabling would take deliberate re-copy, re-verify, a new root scan and an attestation** (operator acts, not stale state);
   - **write a separate retirement note** (e.g. `logs/cold-copies-retired-<id>.json`) recording: the deletion, the evidence hashes, the `cold-copies-verified-1597.json` and `state.json` hashes, `reclaimedBytes` on `/`, `cutover: "retired, never started"`, and that **reclaim r4 must not be run** for these subtrees;
   - **optionally,** with user approval, move the **config** `cold-subtree-production-1530.json` out of any job's path, so no r10 phase can be started on it by accident.
5. **Space effect:** this frees about **327.9 GB on `/` (T500)**, **not on `/vm` (T710)**. It does not help the 1.16 TB `/vm` need (1723).
