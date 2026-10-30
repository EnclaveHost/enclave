# Read-only review: `resumable-state-recovery-stage/r3/srr3_fetch.py` (host archive fetch; EARLY; the stage is still mutable)

## Reviewed bytes (snapshot taken before reading, 2026-10-26T16:14:24Z; re-checked unchanged afterwards)
| file | sha256 | status |
|---|---|---|
| `r3/srr3_fetch.py` (462 lines) | `b9dc0862622c1836e85afb5e39de47e06a3d977f04272817087819b31de73ba5` | **reviewed in full** |
| `r3/jobs/host-state-fetch-r3.sh` | `e44344d73dd36a3a479d75111fe30bd55fefc929635f5c0dcffb9eaad3931068` | read in full |
| `r3/manifest/base-1792886410-manifest.json` | `1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2` | only `base_url` + `components.state` read |
| `r3/test/test_srr3.py` | `c2106f59…365e` | **not reviewed** (only the kill-point grep) |
| `r3/jobs/root-srr3-tests.sh` | `998d7527…44de` | **not reviewed** |

Also read: `jobs/q-exit-status.sh`; `../claude-test-queue.py:125-140`; `enclave/test/helpers/memory-guard.mjs` (grep only); `logs/state-headers-1441.txt` read privately, with **Set-Cookie excluded** and not copied.

**Not done:** no edit, test, build, queue job, network access or live action. **Nothing here is a test result or a qualification.**

**Reconciliation (read from local files only):**
- the manifest's `base_url` + `components.state.file` resolve to `https://mainnet-v2-snapshots.base.org/1792886410/state.tar.zst` = the runner's `URL`;
- `state.size` = **761228785915** = the runner's `TOTAL` = HEAD `Content-Length` (1441).

**HEAD 1441 values root should pin:**
- strong `ETag: "7a7daba60739fc6601662f58f69d6e1b-5672"`
- `Last-Modified: Sun, 25 Oct 2026 00:33:37 GMT`
- `Accept-Ranges: bytes`
- served via Cloudflare, `cf-cache-status: DYNAMIC`

These are HEAD values. **The 206 behaviour is not yet observed** (see P2).

## Verdict
**The fetch core is correct by source reading** for:
- **crash and persistence:** a crash loses at most one chunk, and committed bytes are never discarded;
- **ownership:** a dedicated 0700 work dir, no foreign files, O_NOFOLLOW;
- **old partials:** never adopted or overwritten;
- **response validation:** range, ETag, Last-Modified and errors.

**Blocking before a live fetch:**
- **P1 – an ntfs3 semantics probe.** Directory fsync, rename-replace, O_NOFOLLOW, flock and persisted owner/mode are unverified on this mount.
- **P2 – one real preflight in the 256 MiB lane:** a bounded 206 probe, a short fetch, SIGTERM, then resume.
- **P3 – the stage `SHA256SUMS`, which the runner requires.**

**Small code fixes before live:** C1 and C2.

Everything else is low priority or optional. Extraction, BLAKE3 and the guest import stay separate and **NOT qualified**.

## Blockers (no feature expansion)
**P1. ntfs3 semantics are unproven. Root runs the tiny probe below once on the same mount.**
- **Why it blocks:** every commit depends on `os.fsync(file)`, `os.replace`, and `fsync` of a directory fd (`:138-150`).
- **Failure modes are all refusals:**
  - if ntfs3 rejects directory fsync (e.g. EINVAL), every commit fails with rc 5, so there is no progress but nothing is unsafe;
  - if owner/mode do not read back as uid 1000/0700, rc 3.
- **What the probe can and cannot show:**
  - **It can show:** return codes, plus whether mode/uid/data read back after a cache drop or remount.
  - **It cannot prove:** durability across power loss or a USB unplug. Only a pull-the-plug test proves that; I do not ask for one.

```python
#!/usr/bin/env python3
# ntfs3-probe.py <new dir on the SAME mount, sibling of the work dir, must not exist>. Run as uid 1000. Touches only that dir; removes it.
import errno, fcntl, json, os, stat, sys, time
d = sys.argv[1]; r = {}
def t(k, f):
    try: r[k] = ['ok', f()]
    except OSError as e: r[k] = ['errno', errno.errorcode.get(e.errno, e.errno)]
os.mkdir(d, 0o700); os.chmod(d, 0o700); s = os.lstat(d); r['dir_uid_mode'] = [s.st_uid, oct(stat.S_IMODE(s.st_mode))]
P = lambda n: os.path.join(d, n)
fd = os.open(P('a'), os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
s = os.fstat(fd); r['file_uid_mode_nlink'] = [s.st_uid, oct(stat.S_IMODE(s.st_mode)), s.st_nlink]
b = os.urandom(1 << 20); t0 = time.monotonic()
for i in range(64): os.pwrite(fd, b, i << 20)
t('fsync_file_64MiB_s', lambda: (os.fsync(fd), round(time.monotonic() - t0, 3))[1])
t('ftruncate_shrink', lambda: (os.ftruncate(fd, 32 << 20), os.fsync(fd), os.fstat(fd).st_size)[2])
t('pwrite_read_back', lambda: os.pread(fd, 1 << 20, 31 << 20) == b)
def dsync():
    x = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(x)
    finally: os.close(x)
t('fsync_dir', dsync)
open(P('c'), 'w').write('old'); open(P('c.tmp'), 'w').write('new')
t('replace_over_existing', lambda: (os.replace(P('c.tmp'), P('c')), open(P('c')).read(), os.path.lexists(P('c.tmp')))[1:])
t('o_excl_existing', lambda: os.open(P('c'), os.O_WRONLY | os.O_CREAT | os.O_EXCL))          # expect errno EEXIST
t('symlink_create', lambda: os.symlink('a', P('l')))
t('o_nofollow_on_symlink', lambda: os.open(P('l'), os.O_RDONLY | os.O_NOFOLLOW))             # expect errno ELOOP
l1 = os.open(P('a'), os.O_RDWR); l2 = os.open(P('a'), os.O_RDWR); fcntl.flock(l1, fcntl.LOCK_EX | fcntl.LOCK_NB)
try: fcntl.flock(l2, fcntl.LOCK_EX | fcntl.LOCK_NB); r['flock_conflict'] = 'NOT DETECTED'
except BlockingIOError: r['flock_conflict'] = 'detected'
v = os.statvfs(d); r['statvfs_free_bytes'] = v.f_bavail * v.f_frsize
for x in (l1, l2, fd): os.close(x)
if '--keep' not in sys.argv:
    for n in os.listdir(d): os.unlink(P(n))
    os.rmdir(d)
print(json.dumps(r, indent=1))
```

**Pass criteria:**
- `dir_uid_mode` = `[1000, '0o700']`;
- `file_uid_mode_nlink` = `[1000, '0o600', 1]`;
- `fsync_file`, `ftruncate_shrink`, `pwrite_read_back` and `fsync_dir` all `ok`;
- `replace_over_existing` = `['new', False]`;
- `o_excl_existing` → `EEXIST`;
- `o_nofollow_on_symlink` → `ELOOP` (or `symlink_create` itself refused);
- `flock_conflict` = `detected`;
- `statvfs_free_bytes` ≈ `df -B1`.

**Root also records (read-only):**
- `findmnt -no SOURCE,FSTYPE,OPTIONS /mnt/usb`, to confirm there are no `uid=`/`umask=` overrides (they would make the owner/mode checks vacuous);
- `/sys/block/<disk>/queue/{write_cache,fua}` for the USB disk.

**Optional:** to show that owner/mode really persist on disk rather than only in the inode cache, run with `--keep` and re-`stat` after the next planned remount (root decides). Then remove the dir.

**P2. Preflight: one real bounded 206 and a real commit, resume and stop, through the actual runner in the 256 MiB lane.** Root runs it; I have not.
1. **`host-state-fetch-r3.sh probe --max-hours=1`** sends one `Range: bytes=0-0`.
   - `probe.json` must show `status` 206 and `contentRange` `bytes 0-0/761228785915`.
   - `etag` and `lastModified` must be **byte-equal to HEAD 1441** (above), with `contentEncoding` absent or identity.
   - `probe-headers.txt` may contain Set-Cookie: review it in place and do not copy it.
2. **`host-state-fetch-r3.sh fetch`** with those reviewed pins. After a few `chunk-committed` events (a few minutes), SIGTERM the job.
   - Expect rc 143 (or 124), `committed.json.offset` == the archive size == a multiple of 67108864, and no `chunk.tmp`/`chunk.hdr` left.
   - **Rerun:** it must resume at that offset; a `truncated-uncommitted-tail` event is acceptable.
   - **Optional consistency check (not integrity):** `curl -r 0-1048575 <URL> | cmp - <(head -c 1048576 state.tar.zst)`.
3. **Record from that run:**
   - the guard's `peakTreeRssMiB`;
   - the scope cgroup's `memory.peak` and `memory.events` (`max`, `oom`, `oom_kill`);
   - per-chunk timestamps, giving MB/s and an ETA.
   - **Why:** the scope is `MemoryMax=256M`, `MemorySwapMax=0` (`claude-test-queue.py:134-136`), and cgroup v2 charges **page cache, including dirty pages**, to it. Each chunk dirties ≈2×64 MiB before its fsync: `chunk.tmp`, then the copy into the archive (`:371-409`). That is on top of node, bash, python and curl. Whether this stays clear of `memory.max` pressure or OOM on this USB disk must be measured, not assumed.
   - **If `oom_kill` > 0:** the run is still safe (it loses at most one chunk) but it does not progress. Rerun with `--chunk-bytes 16777216` (a runner change only) or in the 512 lane.

**P3. The runner refuses without `r3/SHA256SUMS`** (`host-state-fetch-r3.sh:32`). The file is absent in this snapshot; 6d adds it when freezing. Expected, but required.

**Capacity (root confirms before P2; not a code issue):** the tool and runner require USB free ≥ the remaining archive + reserve ≥ 500 GB (`:24`, `:188-191`; runner `:26`). So the first start needs **≥ 1.26 TB free on `/mnt/usb`**; otherwise rc 4, which is fail-safe. The rationale for a 500 GB reserve on a dedicated archive disk is not stated. Lowering it would be a code and runner change, root's decision.

## Small code fixes (before live; a few lines each)
**C1. Do not delete `committed.json.tmp` when `committed.json` is missing** (`:337-338`, then `:345-348`).
- **Normal case:** with an atomic rename there is always a `committed.json`. A leftover `.tmp` is then only a newer, uncommitted record, and deleting it costs at most one chunk. Fine.
- **Problem case:** if rename crash-atomicity on ntfs3 fails (not established; see P1), a crash can leave **only** the `.tmp`. Today the tool deletes it and then refuses with "archive exists without committed.json". The only progress record is destroyed and root faces a restart from 0.
- **Fix:** if `committed.json` is absent while `committed.json.tmp` exists, refuse with rc 5 **before** any unlink, leaving both for root.

**C2. `--allow-http-loopback` is not tied to the loopback URL.**
- **The issue:** `test_kill` (`:48-52`) and `--proto =http,https` (`:265`) key on the flag alone. With the real https URL, `--allow-http-loopback` plus `SRR3_TEST_KILL` would honour kill hooks, contradicting the docstring at `:49`.
- **Fix:** in `load_manifest` or `main`, refuse the flag unless the resolved URL is `http://127.0.0.1…`.
- **Risk today:** low (the runner never passes the flag), but the docstring's claim is currently false.

## Low priority (fix if convenient; none blocks)
- **L1. Schema:** `int(com['offset'])` (`:356`) accepts `"123"`, `true` or negatives (a negative ends in an `ftruncate` EINVAL, rc 5). Require `type(offset) is int` and `0 <= offset <= total`, and a non-empty `lastModified` (`:331` maps `''` to `None`, which then only fails closed on every chunk).
- **L2. DNS errors stop the run:** curl rc 6 (DNS resolve) is not in `TRANSIENT_CURL` (`:26`), so a DNS hiccup stops the whole run (rc 6, root rerun). Add 6.
- **L3. Delayed exit on SIGTERM:** SIGTERM during the backoff `time.sleep` (`:393`) delays the exit by ≤ `backoff_cap` (120 s), because the sleep resumes after the handler. Harmless: the guard's or `timeout`'s SIGKILL is also crash-safe.
- **L4. Double writes:** every byte is written twice to the USB disk (`chunk.tmp`, then the archive).
  - **Optional, only if P2 shows memory or throughput trouble:** pwrite the body directly at `S+got` past the committed offset and validate, then fsync + commit. On rejection, `ftruncate(off)`; the start-up tail truncation already covers crashes.
  - That is a design change; reducing `--chunk-bytes` is the zero-code alternative.
- **L5. Optional, given USB + ntfs3:** append and fsync a per-chunk `sha256` record at commit time.
  - **Why:** if a write cache or the FS loses fsynced bytes, the tool detects only length loss (size < offset → rc 5, `:357-358`), not content loss. Content loss surfaces only at the later BLAKE3 as a full 761 GB re-fetch.
  - With the record, a verify pass could localise the damage. Not required for the minimal fetch.

## Verified correct (source reading only)
**Commit ordering:**
- `pwrite` at S (no holes, since S == the file size after truncation);
- `fsync(archive)`;
- `committed.json` via tmp `O_EXCL`, `fsync`, `os.replace`, `fsync(dir)` (`:395-412`);
- `offset` is the only progress truth.

**Crash cases:**
- a crash before the commit is truncated back to the committed offset at the next start (`:359-360`);
- a crash after the replace but before the dir fsync, where the record reverts, means at most one chunk is re-fetched;
- size < offset is refused (`:357-358`).

**Ownership and old partials:**
- the parent must be a real directory, owned, with no g/o write; the work dir must be uid 1000, exactly 0700, and hold **only** its own file names (`:99-117`);
- every file is opened `O_NOFOLLOW` + `fstat` (regular, owner, no g/o write, `nlink == 1`);
- flock (`:159-165`);
- `/proc` busy check (`:168-185`; it sees only processes visible to uid 1000);
- an existing non-empty archive without `committed.json` is **refused, never adopted** (`:346-348`);
- nothing outside the work dir is touched, and the old reth `.part` in the guest is never touched;
- `--owner-uid` must equal the running uid, with no test-mode ownership bypass (`:443-444`).

**Provenance:**
- the manifest sha256 is pinned (`:79-95`);
- the resolved URL must equal `--expect-url` and the size `--expect-total`;
- https only;
- fetch requires the root-reviewed `--expect-etag` and `--expect-last-modified`, never first-come pins (`:327-330`);
- pins must equal those the committed bytes were fetched under (`:353-354`).

**Response validation (`:212-253`):**
- 3xx anywhere stops, and 1xx blocks are skipped;
- 408/429/5xx are transient; 200 stops (Range ignored or the If-Range object changed); anything else that is not 206 stops;
- duplicated critical headers stop;
- identity encoding;
- a strong quoted ETag and Last-Modified, **byte-equal to the pins**;
- an exact `bytes S-E/N`, with N = the pinned total;
- `Content-Length` matches `[0-9]{1,20}` and equals `E-S+1`, which also closes r2's `int()` crash;
- `rc == 0 && got == E-S+1`, else transient;
- an over-long body is killed and stops (`:280-281`, `:381-382`).

**curl (`:263-273`):**
- `-q` (no curlrc); clean env;
- `--http1.1`, `--proto =https`, `--max-redirs 0`, `--noproxy '*'`;
- `If-Range` with the strong pin;
- `--max-filesize`; connect, total and stall timeouts;
- `PR_SET_PDEATHSIG`, so there is no orphan curl after a parent SIGKILL.

**Signals and resources:**
- TERM/INT/HUP terminate curl and exit 143, keeping committed progress;
- RSS is bounded (1 MiB reads, 4 MiB copies);
- capacity is checked before the first chunk and every 16 chunks, and nothing is deleted to make room.

## Out of scope / still open
- Extraction, BLAKE3, the finalize guard and the guest import are a separate later phase. My r2 findings B2/B3 still apply there, and that phase is **NOT qualified**.
- No live DB access.
- `test_srr3.py` and `root-srr3-tests.sh` are not reviewed. The kill points used there (`after-pwrite` at counts 1-3, plus the parametrised points at `:173`) exist; their pass/fail is root's result, not mine.
