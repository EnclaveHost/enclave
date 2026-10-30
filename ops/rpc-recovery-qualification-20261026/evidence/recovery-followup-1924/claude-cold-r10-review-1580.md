# Independent review 1580: nvme-cold-relocation-stage/r10 (SOURCE-ONLY)

**Scope:** source reading only. I did no edits, tests, builds, sudo, live actions or USB work. Nothing was run except `sha256sum`.
- **Inputs:**
  - `logs/claude-cold-r10.md`;
  - the r9 review (`logs/claude-cold-r9-review.md`, 1565);
  - the stage files.
- **Threat model**, as asked: preserve the **trusted operator baseline**. This is not a general malicious-root audit.

## Integrity and pins (verified)
- **The stage:** `SHA256SUMS` sha256 = **`2342e677be1e000df07928238b74fe9e0688cd69ffa6bab0c79d0250ac094991`**, as expected, and `sha256sum -c` passes.
- **The tool files:**
  - `subtree.py` `90cd8968…a3`;
  - `relocate.py` `2a037dae…d0` (the r5 bytes, unchanged);
  - `jobs/root-writer-check.sh` `7bcd4fbf…35`.
- **Where the pins appear:**
  - The README `<!-- r10-root-wrapper -->` block pins **all three**.
  - The job re-pins the two Python files.
  - `test_r1_…` asserts that both sets of pins equal the actual shas.
  - The `tools` result field has the same three keys.
- **The API is unchanged from r9 apart from the format string:**
  - exactly 18 result keys;
  - the format is `nvme-cold-subtree-writer-check/r10`;
  - `targets[]` adds `ino` for `state: "dir"`.
- **Old results are refused:**
  - `record-writer-check` refuses r8 and r9 results (r9 with the reason "walk could skip a changed directory silently").
  - Cut-over accepts only r10.

## B1: root staging (the r9 blocker). **RESOLVED**
**The staging line:** `timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none` copies into a new root `mktemp -d /run/nvme-cold-wc10.XXXXXXXX`. The `sha256sum -c` against the inline pins then runs before `bash "$W/jobs/root-writer-check.sh"`.
- **A symlinked final component:** `O_NOFOLLOW` gives ELOOP, and the file is never opened. This includes the byte-identical symlink that r9's `head` accepted.
- **A FIFO:** `O_NONBLOCK` opens and reads 0 bytes, so the sha check fails. There is no hang.
- **Size:** more than 1 MiB is truncated, so the sha check fails. A blocked FUSE read is bounded by `timeout 20`.
- **What the job checks:** the staged directory must be root-owned 0700 under `/run/nvme-cold-wc10.????????`, with root-owned regular files. It re-verifies the Python pins and runs `env -i … python3 -I -B` from `cd /`.
- **What root never does:** chmod, chown or touch a journal.
- **Test:** `test_b1_…` runs **the README's own `for` line**, extracted from the block:
  - a clean copy matches;
  - a symlink fails with "symbolic links";
  - a FIFO finishes in under 15 s without matching bytes.
- **Residual (not a blocker under the baseline):**
  - `nofollow` covers only the final component. A uid-1000 symlink at `$S/jobs` or at a parent directory would still be traversed.
  - The opened names are fixed (`subtree.py`, `relocate.py`, `root-writer-check.sh`), and a user cannot create device nodes. `fs.protected_hardlinks` (which the job prints) prevents hardlinking root's device nodes.
  - So such a traversal can at worst feed wrong bytes, which the sha check then refuses. It cannot open `/dev/watchdog`-like nodes.
  - This is consistent with the "nofollow opens" memory rule.

## B2: the target walk. **RESOLVED**
**What `walk_ids` does:** it is an explicit fd-relative stack.
- Each subdirectory is opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` with `dir_fd` set to the parent fd.
- `O_DIRECTORY` makes the kernel refuse a non-directory **before** any device `open` method runs.
- `fstat` (dev, ino) must equal the lstat'd identity.
- Listing, lstat and open errors and replacements all become problems, so the scan is **incomplete**.
- Entries on another st_dev become a problem.
- Fds are closed on pop and in `finally`, with no double close. The chained `todo = stack[-1][2] = []` is one list object.

**Test:** `test_b2_…` swaps `model` between its lstat and its open, for three cases:
- **a symlink to outside** gives ELOOP and "changed";
- **a new directory** gives "replaced";
- **a FIFO** gives ENOTDIR, under a SIGALRM guard against blocking.

The test also asserts:
- every open used `O_NOFOLLOW|O_DIRECTORY`;
- outside inodes never enter `ids`;
- a full `scan()` with a swap is `complete: false` and cut-over refuses it;
- every `dir` target has an int `ino`.

**Minor points (fail closed or pre-existing; none blocks):**
- **(a) Memory before the budget:** `os.listdir` loads one whole directory's names before the entry budget is checked. This is the same as r9's `fwalk`, and the 1 GiB scope bounds it.
- **(b) Deep nesting:** it holds O(depth) fds, so EMFILE is possible. That is a problem, so the scan is incomplete.
- **(c) Same-fs bind mounts inside a tree:** these re-enter and are bounded by the budget, which fails closed.
- **(d) Untested branch:** "directory not listable" has no test. It is a one-line branch, read as correct.

## G1: overlay layers. **IMPLEMENTED as the r9 review asked**
**What is checked:** `overlay_problems` checks the layer keys `lowerdir` (split on `:`), `lowerdir+`, `datadir+`, `upperdir` and `workdir`, in every overlay of every visible view, after the process scan. A layer makes the scan incomplete when:
- it is at, under or above any prefix (`R._under` in both directions);
- it is relative;
- it is `/proc/…`;
- it contains `\`.

**The escape rule is sound:** `seq_show_option` escapes `,= \t\n\\`, and a user-escaped `\:` shows as a backslash. Any odd layer string is therefore flagged rather than mis-split.

**Test:** `test_g1_…` uses six overlays. Lower, upper/work, ancestor, relative and escaped are flagged; the `/var/lib` overlay is not. The test also asserts the refusal. Not covered by a test: `lowerdir+`/`datadir+` and `/proc/` (read as correct).

**Residual limitation (not a blocker under the baseline):**
- **What can be missed:** layer strings are the mounter's **mount-time** path strings. An overlay built through an alias that was later lazily unmounted (e.g. a rootless userns bind followed by `umount -l`) shows a path outside every prefix, and is not flagged.
- **Why it is not a blocker:** this needs deliberate evasion by the owner's own processes, which is outside the trusted baseline.
- **Possible hardening (later):** resolve each layer through `/proc/PID/root` and compare dev/ino, with ENOENT treated as incomplete.

## G2: per-thread mount namespaces. **RESOLVED**
**The code:** in the tid loop, a `task/TID/ns/mnt` not yet in `views` adds `task/TID/mountinfo` through `add_view`. This happens before that thread's links and fds.

**Test:** `test_g2_…`:
- a `mnt:[55]` thread view exposing the target dev at `/thread-alias`;
- the alias is reported with the right ns and pid;
- `namespaces == 3`;
- cut-over refuses "mount alias".

## G3: unknown fanotify mount marks. **RESOLVED**
**The code:** a fanotify mount mark whose `mnt_id` is in no `mnt_dev` gives "a fanotify mount mark on a mount in no visible mount namespace", so the scan is incomplete. A known mount on a target dev is still listed in `fsWatchers`.

**Test:** `test_g3_…` covers both a known mark (still `complete`, listed) and an unknown `7ffffff0` (incomplete, refused).

**Order dependence (fail closed only):** `mnt_dev` grows as views are added. A mark or a regular fd whose mount id first appears in a **later** process's namespace is handled conservatively:
- **G3:** a false incomplete.
- **A regular fd:** the existing `stat_link` fallback, i.e. a magic-link stat that gives the true dev/ino.

Neither path is a silent omission.

## No new unbounded loaders and no silent omissions
- **Inputs:** the new inputs are per-thread `ns/mnt` readlinks and `mountinfo` through the existing `safe`/`read_proc` path, plus overlay option strings from already parsed views.
- **Bounds:** the number of views is bounded by the visible threads. The memory is under the wrapper's `MemoryMax=1G`, and OOM means no result, i.e. fail closed.
- **No new skip:** I found no `continue`/`return` that drops visibility without `inc()`/`probs`, with one exception, and it is unchanged from r9: a regular fd whose fdinfo or `stat_link` disappears is counted as raced/`safe`-handled.
- **G4 (loop/swap backing by `d_path` string):** unchanged and documented. The operator procedure records `losetup -l` and `swapon`.
- **G5 (`maps` without the helper bound):** unchanged and documented. A hang means no result.

## VERDICTS (separate)
### (1) Offering the actual read-only root scanner (README wrapper → `writer-check`): **YES, conditional on root's PASS**
**Grounds:** B1 and B2 (the r9 blockers) are fixed as asked, with tests. Under the trusted operator baseline, the root path:
- opens no uid-1000 final-component symlink, FIFO or device;
- writes and chowns nothing outside its own `/run` directory;
- executes only sha-pinned staged bytes.

**Conditions:**
- root's offline suite must PASS: **61 = 39 `test_subtree` + 22 `test_relocate`**, via `jobs/tests.sh`, which also re-verifies r1–r9 frozen and r10 SUMS;
- the host `MemAvailable` floor the job enforces;
- run only via the README block, unchanged.

**I make no claim about runtime or practicality on the live host:** that is unmeasured.

### (2) Cut-over: **NO-GO until a live gate; no source blocker remains**
**The source gate is sound:** cut-over consumes only a recorded r10 result. It refuses on any of `complete: false`, `hitsTotal > 0`, `aliases`/`destAliases` or watchers, plus the existing freshness and attestation rules (per `claude-cold-r10.md`).

**Go requires all of:**
1. root's 61/61 PASS;
2. a live root scan with `complete: true`, `hitsTotal` 0, no aliases, destAliases or fsWatchers, recorded by the owner with `record-writer-check`, and used within its freshness window;
3. the apps-stopped attestation;
4. the G4 operator record (`losetup -l` and `swapon --show`, showing nothing under the targets) taken alongside the scan;
5. root/operator acceptance of the G1 historical-string and G5 residuals as limitations.

**Reclaim/deletion is out of scope here and stays blocked.** r10 deletes nothing, per `test_no_deletion…`. Under the rule "missed visibility = data loss", any future reclaim needs its own gate. The G1 historical-layer residual and G4/G5 must be closed or blocked there, not just accepted as limitations.

## Non-blocking suggestions (for a later stage only; do not reopen r10)
- **Tests:**
  - G1 for `lowerdir+`, `datadir+` and `/proc/` layers;
  - B2 for the unlistable directory;
  - a G3 order-dependence case (a mark resolvable only via a later view: incomplete, not silent).
- **G1 hardening:** check layers by dev/ino through `/proc/PID/root`.

---
## ERRATUM (after root clarification 1588)
The cut-over verdict above wrongly says the code refuses on `destAliases`/watchers. The actual `require_writer_check` (r10 `subtree.py` ~1017-1030) enforces `complete`, no hits/`hitsTotal`, no source/retire aliases, freshness/prefix and the source target. It does **not** enforce `destAliases` or `fsWatchers`. Those are a manual gate for root before any cut-over, and must be enforced in code by reclaim r4. The apps-stopped attestation is an operator statement only (>= 8 characters), not an automated freeze.
