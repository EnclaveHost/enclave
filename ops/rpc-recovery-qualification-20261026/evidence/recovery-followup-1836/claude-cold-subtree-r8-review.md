# Independent read-only review: `nvme-cold-relocation-stage/r8` against the r7 review (2026-10-26 18:28-18:30Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` `433fd131…0bc2`; `sha256sum -c` OK; all files 0444, owner `steven`.
  - `subtree.py` `4509e043…`
  - `relocate.py` `2a037dae…` (= r5)
  - `jobs/root-writer-check.sh` `d206a6a6…`
  - `config.subtree.production.template.json` `93e51619…` (= r7)
- **Also read:**
  - the full `diff r7/subtree.py r8/subtree.py`;
  - r5 `relocate.py` helpers (`read_json`, `read_bytes`, `scan_proc`, `Journal`);
  - `logs/claude-cold-subtree-r8.md`.
- **Root results quoted, not re-run:**
  - root 1537: 49/49 PASS, no skips (`root-cold-subtree-r8-1537.out`, rc 0);
  - root 1534: gguf-e2b copy rc 0 and verify OK (`source_identity 8dea59bb…`, `logical 7f993d7c…`, `dest_identity 88452a0d…`).
- **Not done:** no tests, builds, copies or mutations. No edits except this file.

## r7 findings: status in r8 source
| r7 | r8 | verdict |
|---|---|---|
| **C1** floor skipped on resume | the floor is checked on **every** attempt with the FULL remaining need, before the `mkdir` and before rsync (`subtree.py:390-392`) | fixed (conservative) |
| **C2** verify dead end | a logical or manifest mismatch sets `copy=failed` and `checksum=true`, then saves; a resume or `checksum` adds `--checksum` (`:394-397`, `:427`, `:434-435`) | fixed |
| **C3** re-inventory orphaned the destination | re-inventory keeps `copy`/`dest_top` when the destination exists (`:315-320`). An existing destination is accepted only if the copy is running/failed **and** the top dev/inode equals `dest_top`. A new top is created 0700 and recorded before rsync (`:383-401`). | fixed. The legacy (no `dest_top`) acceptance is once only, as stated. |
| **C4** stderr lost | the last 4 KiB of stderr is kept in the `copy` event (`run_tail`) | fixed |
| **W1** root `chown` follows a symlink | root `writer-check` now runs **before** any journal open, with no lock, no write and no chown, and prints to stdout (`:448-455`, `:574-575`). `record-writer-check` runs as the owner. | fixed |
| **W2** pyc bypasses the sha pin | `relocate.py` is compiled and executed from its sha-verified bytes (`:47-57`). The handoff runs root-owned 0400 copies in `/run`, with `python3 -I -B`. | fixed |
| **W3** emission-time hashes | `emit-writer-check` is removed. `jobs/root-writer-check.sh` is frozen with constants equal to the current file shas. | fixed, **but see R1** |

## Production COPY / RESUME (owner, queue lane): acceptable now
**Unchanged guarantees, re-checked in source:**
- the source is only read; `safe_rsync_argv` refuses every delete/in-place/move option;
- `writes_on_dest` plus the mountinfo pins on source, destination and journal run before any journal write;
- the destination chain is 0700, owner-owned, with no symlinks;
- the exact lane and MemAvailable ≥ 16 GiB at start;
- `bwlimit` ≤ 200 MiB/s;
- verify uses a fresh destination sha256 against the inventoried logical digest plus the manifest sha/bytes.

**The remaining copies (hf-convert, gvs5h; fresh, no destination):**
- `copy` checks the floor against hf + gvs (gguf-e2b is `done`);
- it creates the 0700 top, records `dest_top`, and runs rsync **without** `--checksum` (first attempt);
- a failed or killed run resumes with `--checksum`, with the floor re-checked.
- **Capacity:** `/` is about 498 GB after all copies (1530/1531), so the floor holds.

**Acceptable operations now:**
1. `plan` and `status` (read-only).
2. `copy` then `verify`, one subtree at a time, for `2026-10-24/home/hf-convert` and `2026-10-24/home/gvs5h`, as the owner, in root's lane (`queue_lane_bytes` = the lane's exact `memory.max`).
3. A re-`verify` of gguf-e2b (read-only on `/vm`; it writes only journal hash caches on `/`).

**Not now:**
- `cutover`, `rollback`, or any deletion;
- running r7 again for anything.

**Accepted limitation, stated:** rsync temp leftovers after a SIGKILL show up as dest-only differences. They need manual review because there is no `--delete`. Leaving them fails closed; it never certifies.

## Privileged root writer-check
### What holds
- The scanner writes nothing and chowns nothing.
- Its prefixes come from production-pinned paths (`load_config` refuses deviations), plus `realpath(src)`.
- `scan_proc` reads only `/proc` and `/sys/block`.
- The result reaches the journal only through the owner's `record-writer-check`, which checks exact keys, format, euid 0 and both tool shas.
- `cutover` still requires that result complete, with zero hits, ≤ `writer_check_max_age_seconds`, and with the prefix present (`require_writer_check`).

### Blockers before offering or using it for a cut-over
**R1. Root executes a uid-1000-replaceable script.**
- **The cause:** `sudo bash <stage>/r8/jobs/root-writer-check.sh` reads the script from a `steven`-owned directory. The pinned constants protect `subtree.py`/`relocate.py` only if the **script** is authentic, and nothing verifies it before root runs it: a check-then-`sudo bash` still has a swap window.
- **The design forces this path:** the script derives `SRC` from `$0`, so it can't simply be copied elsewhere.
- **Minimal correction, procedure only (no stage change):** as root, stage a root-owned tree and verify **all three** frozen shas on those copies before executing:
  ```
  sudo bash -c 'set -eu; S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r8
    C=/ABS/PATH/TO/CONFIG.json
    W=$(mktemp -d /run/nvme-cold-stage.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir "$W/jobs"
    install -m 0400 -o root -g root -- "$S/subtree.py" "$S/relocate.py" "$W/"
    install -m 0500 -o root -g root -- "$S/jobs/root-writer-check.sh" "$W/jobs/"
    printf "%s  %s\n" d206a6a6adfdb6459da6540f6a5f3999fb6541797b241a561e126368baf4ae54 "$W/jobs/root-writer-check.sh" \
      4509e043e51746fa60b873c2e6e824ff8834232bae8a04a73ad2135975585073 "$W/subtree.py" \
      2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 "$W/relocate.py" | sha256sum -c --quiet
    [ -f "$C" ] && [ ! -L "$C" ]; head -c 65537 -- "$C" > "$W/config.json"; [ "$(stat -c %s "$W/config.json")" -le 65536 ]
    bash "$W/jobs/root-writer-check.sh" "$W/config.json"' > RESULT.json
  ```
  - **Check the shas against `r8/SHA256SUMS` before use.**
  - **How the pieces fit:**
    - with `SRC=$W`, the script re-copies root-owned, verified bytes;
    - `head -c` bounds the config read even if it is swapped for a link (R2);
    - the staged config passes `load_config`, since a root-owned file is allowed. Its production pins must still match.
  - **The owner's shell does the redirect.**
  - **For `record-writer-check`:** the result's `prefixes` come from the pinned paths, so they are the same whichever config copy was used.
- **Code correction (r9):** take the stage dir as an argument and document running a root-staged copy.

**R2. Root parses the config by path, following symlinks, unbounded.**
- **The cause:** `load_config` does `os.path.islink` + `lstat`, then `R.read_json(path)` with a plain `open()` (`relocate.py:132-134`).
- **The race:** uid 1000 can swap the config for a symlink between the check and the open. Root then reads an arbitrary file into memory: `/dev/zero` or a huge file is a root-side hang or memory exhaustion. JSON errors escape as a traceback.
- **No disclosure:** key and pin checks refuse before any use, and the messages carry no content. **No write.**
- **Minimal correction (r9):** open the config `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, require `fstat` regular, owner-owned and ≤ 64 KiB, then parse from that fd.
- **Interim procedure:** root copies the config into the staged `$W` (above) and runs with `--config $W/config.json`.

**R3. Scan completeness is path-string based.**
- **The cause:** `scan_proc` matches `readlink` targets of cwd/root/exe/fd and the `maps` path column against the prefixes (`relocate.py:555-610`).
- **The blind spot:** a process in **another mount namespace** (container, sandbox, systemd `BindPaths`/`ProtectSystem` view) or using a **second bind mount** of `/vm` shows the same inode under a different path, and is missed. `complete` stays true because nothing was unreadable.
- **Minimal correction (r9):**
  - build the `(st_dev, st_ino)` set of every entry in the three source trees (`walk_meta` ids), `.retire-*` and the destinations;
  - flag any `os.stat('/proc/PID/fd/N')`, cwd, root or exe whose `(dev, ino)` is in the set;
  - flag any `maps` line whose dev:inode columns match;
  - mark the scan incomplete if `/proc/*/mountinfo` shows the source device (`/dev/mapper/cryptvm`) mounted anywhere other than `/vm`.
- **Until then:** root records `findmnt -A -o TARGET,SOURCE -S /dev/mapper/cryptvm` (single `/vm`) and the container/namespace inventory as part of the cold-proof checks (1510).

**R4. Writes through fds opened before the rename are lost.**
- **The cause:** `cutover` re-checks the source identity just before the rename (`:474-475` in r7, unchanged). A process that already holds an fd, or opens one inside the writer-check age window, keeps writing into `.retire-<name>` after the rename, while readers follow the symlink to the destination.
- **The effect:** this does not block cut-over (the scan is the control). **Reclamation must prove `.retire-<name>`'s identity still equals the verified source identity** before deleting; otherwise such writes are lost silently.

### Not a blocker, stated
`record-writer-check` validates shape and tool shas, not provenance. uid 1000 can forge a result; the protection is the operator running the root scan, as documented in r8.

### Is the root handoff safe to offer?
- **Not as written** (`sudo bash <uid-1000 path>`): see R1.
- **Yes**, as a read-only scan **with the root-staging procedure above** (R1, plus the R2 interim of a staged config). It writes nothing, chowns nothing and reads only `/proc`, `/sys/block` and the staged config.
- **For an actual cut-over decision**, R3's namespace and bind-mount check must also be done (code or recorded procedure), along with the 1510 cold-proof checks and the attestation.

## Remaining root checks and reclamation (unchanged scope; no deletion requested)
**Before any cut-over:**
- R1-R3 handled;
- a fresh complete zero-hit scan within the age bound;
- the cold-proof checks (no changes since 1381, no readers or writers, Qwen maps);
- the attestation.

**Reclamation, a separate review:**
- cut-over complete with post-checks;
- a soak period;
- a fresh privileged scan on the `.retire-*` and destination prefixes;
- **`.retire-<name>` identity == the verified source identity** (R4);
- destination identity unchanged since cut-over, plus a fresh destination sha256 against the inventoried logical digest;
- inbound links resolving;
- deletion of exactly three named dirs, with a journalled intent;
- Qwen padbank coordination: about 21.9 GB of margin over 385,899,345,920 after about 328 GB is freed.

Nothing here changes production thresholds, admin controls or permissions.
