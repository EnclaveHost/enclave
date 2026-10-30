#!/usr/bin/env python3
"""recovery-sequential-probe-stage/r2 seqprobe.py (prepared by Claude 1738/1741; NOT run by Claude). Standard library + ONE pinned module.

r2 (root review 1740): the child lifecycle is NOT re-invented: every qemu-io read runs through the EXACT qualified
mdbx-recovery-validator-stage/r4/src/mdbx_check.py (sha256 f0d27e40..., loaded from its sha-checked bytes) bounded_run + signal
deferral: own process group, waitid(WNOWAIT) exit detection (the leader stays an UNREAPED zombie while its group may be signalled),
SIGKILL of the group on deadline / output cap / stdout held after exit / a deferred SIGTERM-SIGHUP-SIGINT, always before the single
bounded reap; a cancellation is raised only after that reap (exit 128+N). Stats come from `read -C` (bytes parsed and required
== requested); success is per sample with an explicit complete count - any incomplete sample makes the run INCONCLUSIVE (rc 5).
Rates are under CONCURRENT load (e.g. the peer L1 comparison reads the same USB array): never isolated-disk or ETA figures.
(r1 text follows; its run_bounded is replaced.)

A SMALL, BOUNDED, READ-ONLY sequential-read timing of the ORIGINAL qcow2. Not a recovery tool, not an integrity check, not a copy ETA.
  - ranges: 4 deterministic, well-separated 64 MiB ranges wholly inside written (not unwritten) extents of root's AUTHENTICATED map
    (ext4-candidate-checksums.json map.extentList [logical, blocks, physical, unwritten], 4096-byte fs blocks, fs at disk offset 0;
    sha-pinned, 9001 non-overlapping extents, 276,959,557 blocks - the same checks as qcow-allocation-nbd-stage/r4)
  - reads: ONE pinned `qemu-io -r --image-opts ...,read-only=on,file.locking=off -c "read OFF LEN"` per range (no NBD server, no
    mount, no -v: no data is ever printed; qemu-io prints only "read N/N bytes at offset X" and its own rate line); concurrency 1; each process in its own group, 45 s then TERM, +5 s then KILL, reaped;
    total budget 240 s (a range that cannot finish inside it is skipped, not started); aggregate <= 256 MiB
  - the original: a regular file on an ST_RDONLY mount, not writable; identity (dev, ino, size, mtime_ns, ctime_ns) before == after;
    REFUSED if any other process names it before the run (a VM, a peer server, anything); re-checked and reported after
  - output: timings and rates ONLY (bytes, seconds, MiB/s, qemu rc, a bounded stdout/stderr tail) - never data bytes
  - page cache: NOT controlled (no cache drop; no O_DIRECT through ntfs-3g): a range already cached by an earlier read times as cached.
    Each rate includes qemu-io's process start and image open. One sample of 4 ranges is NOT a whole-copy ETA.

    seqprobe.py real --out-dir NEW_DIR      (all inputs pinned below)
Exit 0 result written (whatever the rates); 3 refused (nothing read); 4 identity/cleanup problem (stop and inspect).
"""
import argparse, hashlib, json, os, signal, stat, subprocess, sys, time

BLOCK = 4096
RANGE_BYTES = 64 << 20
N_RANGES = 4
AGG_MAX = 256 << 20
PER_TIMEOUT, KILL_GRACE, TOTAL_BUDGET = 45, 5, 240
MIN_SEPARATION = 1 << 30
ALIGN_BLOCKS = 256                                                        # 1 MiB
TAIL = 4096
FS_BYTES = 976562500 * BLOCK
IMAGE = "/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2"
COVERAGE = ("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/ext4-recovery-checksum-stage/r2/runs/"
            "real-20261026T203730Z-2323458/ext4-candidate-checksums.json")
COVERAGE_SHA = "70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200"
EXTENTS, DATA_BLOCKS = 9001, 276959557
MANIFEST = "/home/steven/.local/state/enclave-rpc-production/manifest.json"              # = qcow-allocation-nbd-stage/r4 preflight
MANIFEST_SHA = "a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441"
STATE = {"readStarted": False}
QEMU_IO, QEMU_IO_SHA = "/usr/sbin/qemu-io", "085e254e8a64b25c70051b123eed1ff56cf0a70acc2d064e50377220bca53f55"
NOT_A_CLAIM = ("TIMING ONLY: 4 x 64 MiB sequential reads of the original through qemu-io; page cache NOT controlled; includes process "
               "start/open; NOT an integrity check, NOT a whole-copy or validation ETA")


class Refused(Exception):
    pass


def sha256_file(path, limit):
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        while (b := f.read(1 << 20)):
            n += len(b)
            if n > limit:
                raise Refused(f"{path} exceeds {limit} bytes")
            h.update(b)
    return h.hexdigest()


# ---- sample selection (pure; fixture-tested) ---------------------------------------------------------------------------------------
def check_extents(extents, fs_bytes=FS_BYTES):
    for e in extents:
        if (not isinstance(e, list) or len(e) != 4 or not all(isinstance(x, int) and not isinstance(x, bool) for x in e[:3])
                or not isinstance(e[3], bool) or e[1] <= 0 or e[0] < 0 or e[2] <= 0 or (e[2] + e[1]) * BLOCK > fs_bytes):
            raise Refused(f"malformed extent {e!r}")
    r = sorted((e[2], e[2] + e[1]) for e in extents)
    if any(r[i][0] < r[i - 1][1] for i in range(1, len(r))):
        raise Refused("extents overlap")


def select(extents, *, n=N_RANGES, length=RANGE_BYTES, min_sep=MIN_SEPARATION, fs_bytes=FS_BYTES):
    """n deterministic ranges of `length` bytes, each WHOLLY inside one WRITTEN extent, at the 1/2n, 3/2n, ... points of the eligible
    physical span, 1 MiB aligned where the extent allows, pairwise >= min_sep apart. Refuses rather than shrink, split or reuse."""
    check_extents(extents, fs_bytes)
    if length <= 0 or length % BLOCK or n * length > AGG_MAX:
        raise Refused("range length must be a positive multiple of 4096 and n * length <= 256 MiB")
    blocks = length // BLOCK
    elig = sorted((e for e in extents if not e[3] and e[1] >= blocks), key=lambda e: e[2])
    if len(elig) < n:
        raise Refused(f"only {len(elig)} written extents hold {length} bytes (need {n}); unwritten and short extents are never sampled")
    lo, hi = elig[0][2], elig[-1][2] + elig[-1][1]
    picks, used = [], set()
    for k in range(n):
        target = lo + (hi - lo) * (2 * k + 1) // (2 * n)
        e = min((x for x in elig if x[2] not in used), key=lambda x: (0 if x[2] <= target < x[2] + x[1] else 1, abs(x[2] - target), x[2]))
        used.add(e[2])
        start = max(e[2], min(target - blocks // 2, e[2] + e[1] - blocks))
        down = start - start % ALIGN_BLOCKS
        up = down + ALIGN_BLOCKS if start % ALIGN_BLOCKS else start
        if down >= e[2]:
            start = down
        elif up + blocks <= e[2] + e[1]:
            start = up
        if not (e[2] <= start and start + blocks <= e[2] + e[1]) or e[3]:
            raise Refused("internal: a range is not wholly inside a written extent")
        picks.append({"virtualOffset": start * BLOCK, "length": length, "extent": list(e), "logicalOffset": (e[0] + start - e[2]) * BLOCK})
    picks.sort(key=lambda p: p["virtualOffset"])
    for a, b in zip(picks, picks[1:]):
        if b["virtualOffset"] - (a["virtualOffset"] + a["length"]) < min_sep:
            raise Refused(f"ranges are not {min_sep} bytes apart")
    return picks


# ---- the original: identity, read-only, nobody else naming it -----------------------------------------------------------------------
def identity(path):
    st = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(st.st_mode):
        raise Refused(f"{path} is not a regular file")
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}


def namers(name, exclude=()):
    """pids (other than ours / excluded) whose command line names `name`"""
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit() and int(d) != os.getpid() and int(d) not in exclude:
            try:
                with open(f"/proc/{d}/cmdline", "rb") as f:
                    if name.encode() in f.read(1 << 20):
                        out.append(int(d))
            except OSError:
                pass
    return out


def require_read_only(path):
    if os.path.islink(path) or not os.statvfs(path).f_flag & os.ST_RDONLY or os.access(path, os.W_OK):
        raise Refused("the original must be a non-symlink on a READ-ONLY (ST_RDONLY) mount and not writable")


# ---- one bounded, owned child --------------------------------------------------------------------------------------------------------
LIFECYCLE = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/mdbx-recovery-validator-stage/r4/src/mdbx_check.py"
LIFECYCLE_SHA = "f0d27e40c29271b94d2b48b9d4ab70a84de1f946709db4e9361cdfba00bac131"
OUT_CAP = 64 << 10
CONCURRENT = ("rates are measured under whatever else reads the same USB array (root 1740: the peer L1 comparison was reading it); "
              "NOT isolated disk throughput, NOT a copy or validation ETA")
_M = {}


def lifecycle():
    """the qualified MDBX r4 wrapper, executed from the exact bytes whose sha256 was checked (no re-open between check and use)"""
    if "m" not in _M:
        import types
        fd = os.open(LIFECYCLE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            src = os.read(fd, 1 << 20)
        finally:
            os.close(fd)
        if hashlib.sha256(src).hexdigest() != LIFECYCLE_SHA:
            raise Refused("the lifecycle module is not the qualified mdbx_check.py (f0d27e40...)")
        m = types.ModuleType("mdbx_check_r4_pinned")
        exec(compile(src, LIFECYCLE, "exec"), m.__dict__)
        _M["m"] = m
    return _M["m"]


def qemu_io_argv(qemu_io, image, off, length, pattern=None):
    """read -C: machine-parsable statistics, never data (no -v). `pattern` (-P) is for the FIXTURE only: the real run never assumes content"""
    if "," in image or not os.path.isabs(image):
        raise Refused("image path must be absolute without commas")
    pat = "" if pattern is None else f"-P 0x{pattern:02x} "
    return [qemu_io, "-r", "--image-opts", f"driver=qcow2,file.driver=file,file.filename={image},file.locking=off,read-only=on",
            "-c", f"read -C {pat}{off} {length}"]


def parse_stats(text, length):
    """qemu-io read -C report `bytes,ops,time,bytes/sec,ops/sec` (qemu-io-cmds.c print_report, Cflag): -> dict or None. The bytes field
    must equal the requested length exactly; anything else (a different format, a short read) is None (the fixture verifies the format)."""
    for line in text.splitlines():
        f = line.strip().split(",")
        if len(f) == 5 and f[0].isdigit() and f[1].isdigit():
            try:
                bps = float(f[3])
            except ValueError:
                continue
            if int(f[0]) == length and int(f[1]) >= 1:
                return {"bytes": int(f[0]), "ops": int(f[1]), "qemuTime": f[2], "qemuBytesPerSec": bps}
    return None


def sample(r, length):
    M = lifecycle()
    stats = parse_stats(r["text"], length)
    failed = any(w in r["text"].lower() for w in ("failed", "error", "cannot"))
    ok = M.run_clean(r) and stats is not None and not failed
    return {"rc": r["rc"], "timedOut": r["timedOut"], "cut": r["cut"], "heldOpen": r["heldOpen"], "escaped": r["escaped"],
            "cancelled": r.get("cancelled", False), "stats": stats, "complete": ok, "outputTail": r["text"][-TAIL:]}


def run_ranges(picks, image, qemu_io, *, budget=TOTAL_BUDGET, timeout=PER_TIMEOUT, cap=OUT_CAP, pattern_for=None, argv_for=None):
    """concurrency 1; each read through the qualified bounded_run (worst case timeout + EOF_GRACE + KILL_GRACE); a read whose worst case
    cannot fit the remaining budget is skipped (never started). A cancellation (deferred signal) propagates as the module's Cancelled
    AFTER the owned group was killed and reaped, carrying the rows so far."""
    M = lifecycle()
    if sum(p["length"] for p in picks) > AGG_MAX:
        raise Refused("aggregate read exceeds 256 MiB")
    worst = timeout + M.EOF_GRACE + M.KILL_GRACE
    t0, rows = time.monotonic(), []
    try:
        for i, p in enumerate(picks):
            if time.monotonic() - t0 + worst > budget:
                rows.append({"index": i, **p, "complete": False, "skipped": "not started: the total budget cannot cover its worst case"})
                continue
            argv = (argv_for or qemu_io_argv)(qemu_io, image, p["virtualOffset"], p["length"],
                                              None if pattern_for is None else pattern_for(p))
            t1 = time.monotonic()
            r = M.bounded_run(argv, timeout, cap=cap)
            secs = time.monotonic() - t1
            row = {"index": i, **p, "seconds": round(secs, 3), **sample(r, p["length"])}
            row["MiBps"] = round(p["length"] / (1 << 20) / secs, 2) if row["complete"] and secs > 0 else None
            rows.append(row)
    except M.Cancelled as c:
        c.rows = rows
        raise
    return rows, round(time.monotonic() - t0, 3)


def summarize(rows, requested_bytes):
    done = [r for r in rows if r.get("complete")]
    return {"requested": len(rows), "completeCount": len(done), "requestedBytes": requested_bytes,
            "measuredBytes": sum(r["length"] for r in done),
            "status": "complete" if rows and len(done) == len(rows) else "INCONCLUSIVE (incomplete samples)"}


def real(out_dir):
    if os.path.lexists(out_dir) or not os.path.isabs(out_dir):
        raise Refused("--out-dir must be a new absolute path")
    lifecycle()
    if sha256_file(QEMU_IO, 64 << 20) != QEMU_IO_SHA:
        raise Refused("qemu-io is not the pinned binary")
    with open(MANIFEST, "rb") as f:
        man = f.read(1 << 20)
    md = json.loads(man)
    if hashlib.sha256(man).hexdigest() != MANIFEST_SHA or md["backings"][md["disks"]["base"]["backing"]]["discard"] != "ignore":
        raise Refused("the production manifest is not the pinned one (base backing discard=ignore)")
    with open(COVERAGE, "rb") as f:
        cov = f.read(16 << 20)
    if hashlib.sha256(cov).hexdigest() != COVERAGE_SHA:
        raise Refused("the coverage map is not the pinned one")
    ext = json.loads(cov)["map"]["extentList"]
    if len(ext) != EXTENTS or sum(e[1] for e in ext) != DATA_BLOCKS:
        raise Refused("the coverage map is not 9001 extents / 276,959,557 blocks")
    require_read_only(IMAGE)
    who = namers(os.path.basename(IMAGE))
    if who:
        raise Refused(f"processes {who} name the original (a VM, a peer server, ...): refusing, nothing read")
    pre = identity(IMAGE)
    picks = select(ext)
    os.mkdir(out_dir, 0o700)
    with open("/proc/loadavg") as f:
        load_pre = f.read().strip()
    STATE["readStarted"] = True
    cancelled, rows, total = None, [], None
    try:
        rows, total = run_ranges(picks, IMAGE, QEMU_IO)
    except lifecycle().Cancelled as c:
        cancelled, rows = c.signum, getattr(c, "rows", [])
    post, after = identity(IMAGE), namers(os.path.basename(IMAGE))
    with open("/proc/loadavg") as f:
        load_post = f.read().strip()
    summ = summarize(rows, sum(p["length"] for p in picks))
    res = {"format": "recovery-sequential-probe/r2", "meaning": NOT_A_CLAIM, "concurrentLoad": CONCURRENT, "loadavgPre": load_pre,
           "loadavgPost": load_post, "image": IMAGE, "identityPre": pre, "identityPost": post, "imageUnchanged": pre == post,
           "readOnlyMount": True, "namersAfter": after, "pageCacheControlled": False, "qemuIoSha256": QEMU_IO_SHA,
           "lifecycleSha256": LIFECYCLE_SHA, "coverageSha256": COVERAGE_SHA, "summary": summ, "cancelledBySignal": cancelled,
           "ranges": rows, "totalSeconds": total,
           "limits": {"perReadSec": PER_TIMEOUT, "eofGraceSec": lifecycle().EOF_GRACE, "killGraceSec": lifecycle().KILL_GRACE,
                      "totalBudgetSec": TOTAL_BUDGET, "aggregateMax": AGG_MAX, "outputCap": OUT_CAP, "concurrency": 1}}
    with lifecycle().signals_deferred():                  # a started report is always completed
        fd = os.open(os.path.join(out_dir, "result.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(res, f, indent=1)
    print(json.dumps({"summary": summ, "ranges": [{k: r.get(k) for k in ("index", "seconds", "MiBps", "complete", "timedOut", "skipped")}
                                                  for r in rows], "imageUnchanged": pre == post, "namersAfter": after,
                      "cancelledBySignal": cancelled, "pageCacheControlled": False, "concurrentLoad": CONCURRENT}, indent=1))
    if pre != post or any(r.get("escaped") for r in rows):
        return 4
    if cancelled:
        return 128 + cancelled
    return 0 if summ["status"] == "complete" else 5


def main(argv=None):
    import argparse as _a
    ap = _a.ArgumentParser()
    ap.add_argument("mode", choices=["real"]); ap.add_argument("--out-dir", required=True)
    a = ap.parse_args(argv)
    try:
        M = lifecycle()
    except (Refused, OSError) as e:
        print(json.dumps({"refused": f"{type(e).__name__}: {e}", "nothingRead": True})); return 3
    M._CANCEL["armed"], M._CANCEL["pending"] = True, None          # the qualified r3 cancellation, exactly as mdbx_check.main
    old = {s: signal.signal(s, M._on_signal) for s in M.CANCEL_SIGNALS}
    try:
        return real(a.out_dir)
    except M.Cancelled as c:                                       # a signal outside any owned child (no read in flight)
        print(json.dumps({"cancelledBySignal": c.signum, "nothingRead": not STATE["readStarted"]}))
        return 128 + c.signum
    except (Refused, OSError, ValueError, KeyError) as e:
        print(json.dumps({"refused": f"{type(e).__name__}: {e}", "nothingRead": not STATE["readStarted"]}))
        return 3 if not STATE["readStarted"] else 4
    finally:
        for s, h in old.items():
            signal.signal(s, h)


if __name__ == "__main__":
    sys.exit(main())
