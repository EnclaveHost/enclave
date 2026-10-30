#!/usr/bin/env python3
"""recovery-multipart-stage/r2 multipart.py (PREPARED by Claude 1748; NOT run by Claude). Standard library only.

Resumable, independently verified MULTIPART PRESERVATION COPY of the reconstructed read-only recovery target. Sequential, one part
at a time, bounded buffers, os.pread / os.pwrite. NOT a recovery acceptance, NOT a data-integrity claim, NOT a RAID-reset or
production-ready statement. r2 = r1 (frozen e248ee99...) + the fixes of review 1747 and root's r1 re-check:
  P1  a checkpoint first extends the temp SPARSELY to the checkpointed position (ftruncate) BEFORE fsync + checkpoint, so a
      checkpoint right after (or inside) a map hole resumes
  P3  every commit and verify record binds the destination identity (dev, ino, size, mtime_ns, ctime_ns, nlink) and the full source
      binding; `status` reports RECORDED state only (never "fresh"), marks stale / unconfirmed / invalid records and never counts a
      malformed or identity-mismatched historical record; only a `verify` run's own output is freshly measured evidence
  P4  the committed-part re-hash pre-pass runs BEFORE the source is opened; the server socket has no idle timeout (the overlay
      session's exec deadline bounds it)
  P5  part files must have nlink == 1; an own `.partial` leftover of the SAME inode (crash between link and unlink) is removed,
      a different inode is refused and kept; a cancelled SocketSource accept removes its own socket
  P7  link, unlink(.partial), the commit record and the checkpoint removal are ONE critical section (signals deferred)
      memory floor enforced on verify too; capacity re-checked against the ACTUAL target binding at every checkpoint
  production: `copy`/`verify` of a production manifest are REFUSED here - they run only through orchestrate.py, which binds the
      exact r9 overlay session (owned child process, pidfd/starttime-pinned exec peer, exact RECOVERY_TARGET, ST_RDONLY, identity,
      mount, the session receipt). The fixture FileSource is labelled `fixture-file` and never satisfies a production manifest.
  serve: `--session-run-dir RUN` (the only mode orchestrate.py accepts): RECOVERY_TARGET must be exactly RUN/work/mnt/data/db/mdbx.dat
      on an ST_RDONLY mount; `--source` is refused in that mode. It never creates or writes a file (RLIMIT_FSIZE is irrelevant to it).
Exit: 0 ok; 3 refused (nothing changed); 4 failed (state kept); 5 stopped cleanly (resumable); 2 usage."""
import argparse, contextlib, fcntl, hashlib, json, os, re, signal, socket, stat, struct, subprocess, sys, time

BS = 4096
MAX_REQ = 8 << 20
FMT = {"manifest": "recovery-multipart-manifest/v1", "part": "recovery-multipart-part/v2", "ckpt": "recovery-multipart-checkpoint/v2",
       "verify": "recovery-multipart-verify/v2", "marker": "recovery-multipart-target/v2", "proto": "recovery-multipart-source/v2",
       "session": "recovery-multipart-session/v2"}
MARKER = ".recovery-multipart-target.json"
TARGET_PATH = "/data/db/mdbx.dat"                                   # the reconstructed file inside the r9 view (plan target.path)
_W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
PROD = {   # pinned production constants (manifest kind "production" must match ALL of them exactly)
    "originalPath": "/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2",
    "mapPath": _W + "/ext4-recovery-checksum-stage/r2/runs/real-20261026T203730Z-2323458/ext4-candidate-checksums.json",
    "mapSha256": "70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200",
    "planPath": _W + "/recovery-overlay-stage/r7/runs/plan-real-20261026T212534Z-2371806/plan.json",
    "planSha256": "c4e38213847793d5c0868825fe454c5702b4499a6b25315078037b073a4f35a9",
    "journalPath": _W + "/logs/base-journal-copy-1626/journal-8.bin",
    "journalSha256": "d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073",
    "logicalSize": 1138166333440, "mappedBytes": 1134426345472, "extents": 9001, "patches": 30, "patchBytes": 119040,
    "partSize": 4 << 30, "parts": 265, "assign": {"root": [0, 119], "vm": [120, 264]},
    "targets": {"root": {"majmin": "253:0", "uuid": "1c7c5336-9d52-4858-828a-823c31189c59"},
                "vm": {"majmin": "253:1", "uuid": "aaae081c-f829-4484-a50f-a9bbb87d31f9"}},
    "floorBytes": 40 << 30, "hostMemFloorBytes": 16 << 30, "chunkBytes": 8 << 20, "checkpointBytes": 256 << 20,
}
HEX64 = re.compile(r"[0-9a-f]{64}")
RUN_ID = re.compile(r"\d{8}T\d{6}Z-\d{1,10}")


class Refuse(Exception):
    rc = 3


class Fail(Exception):
    rc = 4


class Cancelled(BaseException):
    rc = 5


def refuse(m):
    raise Refuse(m)


def fail(m):
    raise Fail(m)


# ---- signals: a cancel request raises Cancelled, except inside a critical section, where it is deferred -------------------------
_SIG = {"armed": True, "pending": False}


def _on_signal(_s, _f):
    if _SIG["armed"]:
        raise Cancelled("signal")
    _SIG["pending"] = True


@contextlib.contextmanager
def critical():
    prev = _SIG["armed"]; _SIG["armed"] = False
    try:
        yield
    finally:
        _SIG["armed"] = prev
        if prev and _SIG["pending"]:
            _SIG["pending"] = False
            raise Cancelled("signal (deferred)")


def install_signals():
    return {sg: signal.signal(sg, _on_signal) for sg in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}


# ---- filesystem safety ------------------------------------------------------------------------------------------------------------
def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def run_id():
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"


def no_symlink_ancestors(path, what):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path or path == "/":
        refuse(f"{what}: must be an absolute normalized path")
    cur = "/"
    for comp in path.strip("/").split("/")[:-1]:
        cur = os.path.join(cur, comp)
        try:
            st = os.lstat(cur)
        except OSError as e:
            refuse(f"{what}: {cur}: {e.strerror}")
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            refuse(f"{what}: ancestor {cur} is a symlink or not a directory")


def open_dir(path, what, owned=True):
    no_symlink_ancestors(path, what)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        refuse(f"{what}: {path}: cannot open as a real directory ({e.strerror})")
    st = os.fstat(fd)
    if owned and (st.st_uid != os.getuid() or st.st_mode & 0o022):
        os.close(fd); refuse(f"{what}: {path} must be owned by the caller and not group/world-writable")
    return fd


def open_file(path, what):
    """read-only, no symlink anywhere in the path, a regular file"""
    no_symlink_ancestors(path, what)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as e:
        refuse(f"{what}: {path}: {e.strerror}")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd); refuse(f"{what}: {path} is not a regular file")
    return fd


def hash_fd(fd, length=None, chunk=8 << 20):
    h, pos = hashlib.sha256(), 0
    while length is None or pos < length:
        n = chunk if length is None else min(chunk, length - pos)
        b = os.pread(fd, n, pos)
        if not b:
            break
        h.update(b); pos += len(b)
    return h, pos


def file_sha(path, what):
    fd = open_file(path, what)
    try:
        return hash_fd(fd)[0].hexdigest()
    finally:
        os.close(fd)


def read_small(path, what, cap=64 << 20):
    fd = open_file(path, what)
    try:
        if os.fstat(fd).st_size > cap:
            refuse(f"{what}: larger than {cap} bytes")
        out = b""
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                return out
            out += b
    finally:
        os.close(fd)


def ident(st):
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}


def dident(st):
    return {**ident(st), "nlink": st.st_nlink}


def identity(path, what):
    no_symlink_ancestors(path, what)
    try:
        st = os.lstat(path)
    except OSError as e:
        refuse(f"{what}: {e.strerror}")
    if not stat.S_ISREG(st.st_mode):
        refuse(f"{what}: not a regular file")
    return ident(st)


def exists_in(dfd, name):
    try:
        os.lstat(name, dir_fd=dfd); return True
    except FileNotFoundError:
        return False


def open_in(dfd, name, what):
    """an existing regular file of ours, read-only, no symlink"""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
    except OSError as e:
        fail(f"{what} {name}: {e.strerror}")
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        os.close(fd); fail(f"{what} {name}: not a regular file owned by the caller")
    return fd


def read_json_in(dfd, name, what, cap=1 << 20):
    fd = open_in(dfd, name, what)
    try:
        if os.fstat(fd).st_size > cap:
            fail(f"{what} {name}: too large")
        raw = os.pread(fd, cap + 1, 0)
    finally:
        os.close(fd)
    try:
        return json.loads(raw.decode())
    except (UnicodeDecodeError, ValueError):
        fail(f"{what} {name}: not JSON")


def write_state(dfd, name, obj, replace=False):
    """atomic: NEW temp (O_EXCL) + fsync + link (no replace) or replace (own checkpoint only) + directory fsync; signals deferred"""
    tmp = name + ".tmp"
    with critical():
        if exists_in(dfd, tmp):                                    # our own interrupted state write (never data, never a record)
            st = os.lstat(tmp, dir_fd=dfd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
                fail(f"{tmp}: unexpected file")
            os.unlink(tmp, dir_fd=dfd)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            os.write(fd, (json.dumps(obj, indent=1, sort_keys=True) + "\n").encode()); os.fsync(fd)
        finally:
            os.close(fd)
        if replace:
            os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        else:
            try:
                os.link(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
            except FileExistsError:
                os.unlink(tmp, dir_fd=dfd); fail(f"{name} already exists: never overwritten")
            os.unlink(tmp, dir_fd=dfd)
        os.fsync(dfd)


# ---- device identity ----------------------------------------------------------------------------------------------------------------
def majmin(dev):
    return f"{os.major(dev)}:{os.minor(dev)}"


def findmnt_uuid(path):
    try:
        p = subprocess.run(["findmnt", "-n", "-o", "UUID,MAJ:MIN", "-T", path], capture_output=True, text=True, timeout=10,
                           env={"PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        refuse(f"findmnt failed: {e}")
    if p.returncode != 0:
        refuse(f"findmnt rc {p.returncode}")
    return parse_uuid_majmin(p.stdout)


def parse_uuid_majmin(text):
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) != 1 or len(lines[0].split()) != 2:
        refuse(f"findmnt output not exactly one line of 2 fields: {text!r}")
    u, mm = lines[0].split()
    if not re.fullmatch(r"[0-9a-f-]{8,64}", u) or not re.fullmatch(r"\d+:\d+", mm):
        refuse(f"findmnt fields malformed: {text!r}")
    return u, mm


def is_usb(mm, sysfs="/sys", _seen=None):
    seen = set() if _seen is None else _seen
    p = os.path.join(sysfs, "dev", "block", mm)
    if not os.path.lexists(p):
        refuse(f"block device {mm} not found in {sysfs}")
    real = os.path.realpath(p)
    if "/usb" in real:
        return True
    sl = os.path.join(real, "slaves")
    if os.path.isdir(sl):
        for s in sorted(os.listdir(sl)):
            with open(os.path.join(sl, s, "dev")) as f:
                d = f.read().strip()
            if d not in seen:
                seen.add(d)
                if is_usb(d, sysfs, seen):
                    return True
    return False


def mem_available():
    with open("/proc/meminfo") as f:
        for l in f:
            if l.startswith("MemAvailable:"):
                return int(l.split()[1]) * 1024
    refuse("MemAvailable missing in /proc/meminfo")


# ---- inputs -------------------------------------------------------------------------------------------------------------------------
def parse_map(raw, logical):
    try:
        d = json.loads(raw.decode())
        el = d["map"]["extentList"]
    except (UnicodeDecodeError, ValueError, KeyError, TypeError):
        refuse("map: not an ext4-recovery-checksum map (map.extentList)")
    if not isinstance(el, list) or not el:
        refuse("map: empty extent list")
    runs, prev, blocks = [], 0, 0
    for e in el:
        if not (isinstance(e, list) and len(e) == 4 and all(isinstance(x, int) and not isinstance(x, bool) for x in e[:3])
                and isinstance(e[3], bool)):
            refuse(f"map: malformed extent {e!r}")
        lb, n, _pb, unwritten = e
        if unwritten or n <= 0 or lb < prev:
            refuse(f"map: unwritten, empty, unordered or overlapping extent {e!r}")
        s, t = lb * BS, (lb + n) * BS
        if t > logical:
            refuse(f"map: extent {e!r} beyond the logical size")
        if runs and runs[-1][1] == s:
            runs[-1][1] = t
        else:
            runs.append([s, t])
        prev, blocks = lb + n, blocks + n
    if isinstance(d["map"].get("extents"), int) and d["map"]["extents"] != len(el):
        refuse("map: extents count != extentList length")
    holes, pos = [], 0
    for s, t in runs:
        if s > pos:
            holes.append([pos, s - pos])
        pos = t
    if pos < logical:
        holes.append([pos, logical - pos])
    return {"extents": len(el), "mappedBytes": blocks * BS, "holes": holes}


def parse_overlay_plan(raw, map_sha, journal_sha, logical, extents, production):
    """production: the plan's inputs must name this map (candidatesSha256) and journal; fixture plans (overlay_plan.py fixture mode)
    carry a capture sha instead and are bound by their own sha256, size, extent count and patch identities"""
    try:
        d = json.loads(raw.decode())
        ok = d["format"] == "recovery-overlay-plan/v1" and d["target"]["size"] == logical and d["map"]["extents"] == extents \
            and d["target"]["path"] == TARGET_PATH
        if production:
            ok = ok and d["mode"] == "real" and d["inputs"]["candidatesSha256"] == map_sha and d["inputs"]["journalSha256"] == journal_sha
        patches = d["patches"]
    except (UnicodeDecodeError, ValueError, KeyError, TypeError):
        refuse("overlay plan: not a recovery-overlay-plan/v1")
    if not ok:
        refuse("overlay plan: not bound to this map / journal / logical size / extent count / target path")
    keys = {"kind", "fsBlock", "byteOffset", "length", "sha256", "source"}
    if not isinstance(patches, list) or not patches or any(not isinstance(p, dict) or not keys <= set(p) for p in patches):
        refuse("overlay plan: patch list malformed")
    out = [{k: p[k] for k in sorted(set(p) & (keys | {"provenance"}))} for p in patches]
    return out, sum(p["length"] for p in patches)


def holes_in(holes, off, length):
    out = []
    for s, n in holes:
        a, b = max(s, off), min(s + n, off + length)
        if a < b:
            out.append([a - off, b - a])
    return out


# ---- plan ---------------------------------------------------------------------------------------------------------------------------
def cmd_plan(a):
    prod = a.production
    if prod:
        for k, v in (("original", PROD["originalPath"]), ("map", PROD["mapPath"]), ("overlay_plan", PROD["planPath"]), ("journal", PROD["journalPath"])):
            if getattr(a, k) != v:
                refuse(f"production: --{k.replace('_', '-')} must be the pinned {v}")
        part_size, floor, memfloor, chunk, ck = PROD["partSize"], PROD["floorBytes"], PROD["hostMemFloorBytes"], PROD["chunkBytes"], PROD["checkpointBytes"]
    else:
        part_size, floor, memfloor, chunk, ck = a.part_size, a.floor_bytes, a.host_mem_floor, a.chunk_bytes, a.checkpoint_bytes
        if not (part_size > 0 and part_size % BS == 0 and 0 < chunk <= MAX_REQ and chunk % BS == 0 and ck >= chunk and floor >= 0 and memfloor >= 0):
            refuse("fixture sizes invalid (part/chunk multiples of 4096, chunk <= 8 MiB, checkpoint >= chunk)")
    map_raw, plan_raw = read_small(a.map, "map"), read_small(a.overlay_plan, "overlay plan")
    map_sha, plan_sha, journal_sha = sha(map_raw), sha(plan_raw), file_sha(a.journal, "journal")
    orig = identity(a.original, "original")
    logical = PROD["logicalSize"] if prod else a.logical_size
    if prod and (map_sha, plan_sha, journal_sha) != (PROD["mapSha256"], PROD["planSha256"], PROD["journalSha256"]):
        refuse("production: map / overlay plan / journal sha256 differ from the pins")
    m = parse_map(map_raw, logical)
    patches, patch_bytes = parse_overlay_plan(plan_raw, map_sha, journal_sha, logical, m["extents"], prod)
    if prod and (m["extents"], m["mappedBytes"], len(patches), patch_bytes) != (PROD["extents"], PROD["mappedBytes"], PROD["patches"], PROD["patchBytes"]):
        refuse("production: extent count / mapped bytes / patch identities differ from the pins")
    nparts = -(-logical // part_size)
    targets, assign = {}, {}
    for t in a.target:
        name, _, path = t.partition("=")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,15}", name) or name in targets:
            refuse(f"--target {t!r}: NAME=ABS_DIR with a unique lowercase name")
        fd = open_dir(path, f"target {name}")
        try:
            mm = majmin(os.fstat(fd).st_dev)
            if prod:
                uuid, fmm = findmnt_uuid(path)
                if fmm != mm:
                    refuse(f"target {name}: findmnt MAJ:MIN {fmm} != st_dev {mm}")
                if is_usb(mm):
                    refuse(f"target {name}: on a USB device")
            else:
                uuid = "fixture"
        finally:
            os.close(fd)
        targets[name] = {"dir": path, "majmin": mm, "uuid": uuid, "floorBytes": floor}
    for s in a.assign:
        name, _, rng = s.partition(":")
        lo, _, hi = rng.partition("-")
        if name not in targets or not lo.isdigit() or not hi.isdigit() or int(lo) > int(hi):
            refuse(f"--assign {s!r}: NAME:FIRST-LAST for a declared target")
        for i in range(int(lo), int(hi) + 1):
            if i in assign or i >= nparts:
                refuse(f"--assign: part {i} assigned twice or beyond {nparts} parts")
            assign[i] = name
    if sorted(assign) != list(range(nparts)):
        refuse("--assign must cover every part exactly once")
    parts = []
    for i in range(nparts):
        off = i * part_size; ln = min(part_size, logical - off); hs = holes_in(m["holes"], off, ln)
        parts.append({"index": i, "offset": off, "length": ln, "target": assign[i], "file": f"part-{i:04d}.bin",
                      "holes": hs, "dataBytes": ln - sum(n for _, n in hs)})
    doc = {"format": FMT["manifest"], "kind": "production" if prod else "fixture",
           "source": {"originalPath": a.original, "originalIdentity": orig, "mapPath": a.map, "mapSha256": map_sha,
                      "planPath": a.overlay_plan, "planSha256": plan_sha, "journalPath": a.journal, "journalSha256": journal_sha,
                      "patches": patches, "patchBytes": patch_bytes, "logicalSize": logical, "mappedBytes": m["mappedBytes"],
                      "extents": m["extents"], "blockSize": BS, "holes": m["holes"], "holeMapSha256": sha(canon(m["holes"]).encode())},
           "partSize": part_size, "chunkBytes": chunk, "checkpointBytes": ck, "hostMemFloorBytes": memfloor,
           "targets": targets, "parts": parts}
    validate_manifest(doc)
    no_symlink_ancestors(a.out, "--out")
    raw = (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode()
    try:
        fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as e:
        refuse(f"--out must be a NEW file ({e.strerror})")
    with os.fdopen(fd, "wb") as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())
    print(json.dumps({"manifest": a.out, "manifestSha256": sha(raw), "parts": nparts, "kind": doc["kind"]}))
    return 0


# ---- manifest validation ------------------------------------------------------------------------------------------------------------
def _int(v, lo=0):
    return isinstance(v, int) and not isinstance(v, bool) and v >= lo


def validate_manifest(d):
    top = {"format", "kind", "source", "partSize", "chunkBytes", "checkpointBytes", "hostMemFloorBytes", "targets", "parts"}
    src_keys = {"originalPath", "originalIdentity", "mapPath", "mapSha256", "planPath", "planSha256", "journalPath", "journalSha256",
                "patches", "patchBytes", "logicalSize", "mappedBytes", "extents", "blockSize", "holes", "holeMapSha256"}
    if not isinstance(d, dict) or set(d) != top or d["format"] != FMT["manifest"] or d["kind"] not in ("fixture", "production"):
        refuse("manifest: not exactly a recovery-multipart-manifest/v1")
    s = d["source"]
    if not isinstance(s, dict) or set(s) != src_keys or s["blockSize"] != BS:
        refuse("manifest: source keys")
    if not isinstance(s["originalIdentity"], dict) or set(s["originalIdentity"]) != {"dev", "ino", "size", "mtimeNs", "ctimeNs"}:
        refuse("manifest: original identity keys")
    for k in ("mapSha256", "planSha256", "journalSha256", "holeMapSha256"):
        if not (isinstance(s[k], str) and HEX64.fullmatch(s[k])):
            refuse(f"manifest: {k}")
    L = s["logicalSize"]
    if not (_int(L, 1) and _int(s["mappedBytes"]) and _int(s["extents"], 1) and _int(d["partSize"], BS) and d["partSize"] % BS == 0
            and _int(d["chunkBytes"], BS) and d["chunkBytes"] <= MAX_REQ and _int(d["checkpointBytes"], d["chunkBytes"]) and _int(d["hostMemFloorBytes"])):
        refuse("manifest: sizes")
    hs, pos = s["holes"], 0
    for h in hs:
        if not (isinstance(h, list) and len(h) == 2 and _int(h[0]) and _int(h[1], 1) and h[0] >= pos and h[0] + h[1] <= L):
            refuse("manifest: global holes not ordered / non-overlapping / inside the logical size")
        pos = h[0] + h[1]
    if sum(n for _, n in hs) != L - s["mappedBytes"] or sha(canon(hs).encode()) != s["holeMapSha256"]:
        refuse("manifest: hole map inconsistent with mapped bytes / its sha")
    t = d["targets"]
    if not isinstance(t, dict) or not t:
        refuse("manifest: targets")
    for name, v in t.items():
        if not (isinstance(v, dict) and set(v) == {"dir", "majmin", "uuid", "floorBytes"} and isinstance(v["dir"], str)
                and os.path.isabs(v["dir"]) and re.fullmatch(r"\d+:\d+", str(v["majmin"])) and isinstance(v["uuid"], str) and _int(v["floorBytes"])):
            refuse(f"manifest: target {name}")
    if len({v["dir"] for v in t.values()}) != len(t):
        refuse("manifest: two targets share a directory")
    ps = d["parts"]
    if not isinstance(ps, list) or not ps:
        refuse("manifest: parts")
    pos, files = 0, set()
    pkeys = {"index", "offset", "length", "target", "file", "holes", "dataBytes"}
    for i, p in enumerate(ps):
        if not (isinstance(p, dict) and set(p) == pkeys and p["index"] == i and p["offset"] == pos and _int(p["length"], 1)
                and p["length"] <= d["partSize"] and p["target"] in t and p["file"] == f"part-{i:04d}.bin" and p["file"] not in files):
            refuse(f"manifest: part {i}: not the next contiguous, non-overlapping, uniquely named part")
        if i < len(ps) - 1 and p["length"] != d["partSize"]:
            refuse(f"manifest: part {i}: only the last part may be short")
        if p["holes"] != holes_in(hs, p["offset"], p["length"]) or p["dataBytes"] != p["length"] - sum(n for _, n in p["holes"]):
            refuse(f"manifest: part {i}: holes / dataBytes differ from the global hole map")
        files.add(p["file"]); pos += p["length"]
    if pos != L:
        refuse(f"manifest: parts cover {pos} bytes, logical size {L}")
    if d["kind"] == "production":
        check_production(d)
    return d


def check_production(d):
    s = d["source"]
    want = {"originalPath": PROD["originalPath"], "mapPath": PROD["mapPath"], "mapSha256": PROD["mapSha256"], "planPath": PROD["planPath"],
            "planSha256": PROD["planSha256"], "journalPath": PROD["journalPath"], "journalSha256": PROD["journalSha256"],
            "logicalSize": PROD["logicalSize"], "mappedBytes": PROD["mappedBytes"], "extents": PROD["extents"], "patchBytes": PROD["patchBytes"]}
    if any(s.get(k) != v for k, v in want.items()) or len(s.get("patches", [])) != PROD["patches"]:
        refuse("production manifest: source differs from the pinned constants")
    if (d["partSize"], d["chunkBytes"], d["checkpointBytes"], d["hostMemFloorBytes"], len(d["parts"])) != \
            (PROD["partSize"], PROD["chunkBytes"], PROD["checkpointBytes"], PROD["hostMemFloorBytes"], PROD["parts"]):
        refuse("production manifest: part/chunk/checkpoint size, memory floor or part count differ from the pins")
    if set(d["targets"]) != set(PROD["targets"]):
        refuse("production manifest: targets must be exactly root and vm")
    for name, pin in PROD["targets"].items():
        v = d["targets"][name]
        if (v["majmin"], v["uuid"], v["floorBytes"]) != (pin["majmin"], pin["uuid"], PROD["floorBytes"]):
            refuse(f"production manifest: target {name} device / UUID / floor differ from the pins")
        lo, hi = PROD["assign"][name]
        if [p["index"] for p in d["parts"] if p["target"] == name] != list(range(lo, hi + 1)):
            refuse(f"production manifest: target {name} must hold parts {lo}..{hi}")
    if d["targets"]["root"]["majmin"] == d["targets"]["vm"]["majmin"] or s["originalIdentity"]["dev"] in \
            [os.makedev(*map(int, v["majmin"].split(":"))) for v in d["targets"].values()]:
        refuse("production manifest: targets must be on different filesystems, and neither on the source's")


def load_manifest(path, want_sha):
    raw = read_small(path, "manifest")
    if not HEX64.fullmatch(want_sha or "") or sha(raw) != want_sha:
        refuse("manifest sha256 differs from --manifest-sha256")
    try:
        d = json.loads(raw.decode())
    except (UnicodeDecodeError, ValueError):
        refuse("manifest is not JSON")
    return validate_manifest(d), want_sha


def bind_inputs(d):
    """re-hash and re-derive EVERY source binding from the files (never trusted from the manifest alone)"""
    s = d["source"]
    if identity(s["originalPath"], "original") != s["originalIdentity"]:
        refuse("the original's identity changed (dev/ino/size/mtime/ctime)")
    map_raw, plan_raw = read_small(s["mapPath"], "map"), read_small(s["planPath"], "overlay plan")
    if sha(map_raw) != s["mapSha256"] or sha(plan_raw) != s["planSha256"] or file_sha(s["journalPath"], "journal") != s["journalSha256"]:
        refuse("map / overlay plan / journal changed")
    m = parse_map(map_raw, s["logicalSize"])
    patches, pb = parse_overlay_plan(plan_raw, s["mapSha256"], s["journalSha256"], s["logicalSize"], m["extents"], d["kind"] == "production")
    if m["holes"] != s["holes"] or m["mappedBytes"] != s["mappedBytes"] or patches != s["patches"] or pb != s["patchBytes"]:
        refuse("the hole map or the patch identities derived from the inputs differ from the manifest")


def check_original(d):
    if identity(d["source"]["originalPath"], "original") != d["source"]["originalIdentity"]:
        fail("the original's identity changed during the run: stopped")


# ---- sources ------------------------------------------------------------------------------------------------------------------------
class FileSource:
    """a plain read-only file: FIXTURES ONLY (binding kind 'fixture-file'; never satisfies a production manifest)"""
    def __init__(self, path, size):
        self.fd = open_file(path, "source")
        got = os.fstat(self.fd).st_size
        if got != size:
            os.close(self.fd); refuse(f"source size {got} != logical size {size}")
        self.size, self.binding = size, {"kind": "fixture-file", "path": path}

    def read(self, off, n):
        out, pos = bytearray(), off
        while len(out) < n:
            b = os.pread(self.fd, n - len(out), pos)
            if not b:
                fail(f"source: short read at {pos}")
            out += b; pos += len(b)
        if os.fstat(self.fd).st_size != self.size:
            fail("source size changed")
        return bytes(out)

    def check(self):
        pass

    def close(self):
        os.close(self.fd)


def peer_cred(sock):
    return struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))


class SocketSource:
    """the copier side of `serve`: a private 0700 directory of ours; listen() first (socket visible only once listening), then
    accept() with a liveness callback; the accepted peer is handed to `provenance(conn, pid, hello)` (orchestrate.py: the exact r9
    session exec) which returns the source binding or refuses. Any exception during construction or accept removes our socket."""
    def __init__(self, sock_dir, size, provenance=None, expect_kind=None):
        self.size, self.provenance, self.expect_kind = size, provenance, expect_kind
        self.c = self.f = None; self.created = False; self.dfd = None
        self.dfd = open_dir(sock_dir, "socket dir")
        self.ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            if os.fstat(self.dfd).st_mode & 0o077:
                refuse("socket dir must be 0700")
            if exists_in(self.dfd, "mp.sock") or exists_in(self.dfd, "mp.sock.new"):
                refuse("socket dir already has mp.sock")
            cwd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fchdir(self.dfd)
                self.ls.bind("mp.sock.new"); self.created = True    # relative: no 108-byte AF_UNIX path limit
                self.ls.listen(1)
                os.rename("mp.sock.new", "mp.sock", src_dir_fd=self.dfd, dst_dir_fd=self.dfd)
            finally:
                os.fchdir(cwd); os.close(cwd)
        except BaseException:
            self.close(); raise

    def accept(self, timeout, alive=lambda: True):
        try:
            self.ls.settimeout(1.0)
            end = time.monotonic() + timeout
            while True:
                try:
                    self.c, _ = self.ls.accept(); break
                except socket.timeout:
                    if time.monotonic() > end:
                        refuse("no source server connected in time")
                    if not alive():
                        refuse("the source producer ended before connecting")
            self.c.settimeout(600)
            pid, uid, _gid = peer_cred(self.c)
            if uid != os.getuid():
                refuse("source server peer uid differs")
            self.f = self.c.makefile("rb")
            try:
                hello = json.loads(self.f.readline(4096).decode())
            except (UnicodeDecodeError, ValueError):
                refuse("source server hello malformed")
            if not isinstance(hello, dict) or hello.get("proto") != FMT["proto"] or hello.get("size") != self.size \
                    or (self.expect_kind and hello.get("sourceKind") != self.expect_kind):
                refuse(f"source server: protocol / size / source kind differ ({hello})")
            self.hello = hello
            self.binding = self.provenance(self.c, pid, hello) if self.provenance else {"kind": "unbound-socket", "peerPid": pid}
            self._unlink()                                           # one connection only: nobody else can connect afterwards
        except BaseException:
            self.close(); raise

    def read(self, off, n):
        self.c.sendall(f"R {off} {n}\n".encode())
        h = self.f.readline(128).decode().split()
        if h != ["D", str(off), str(n)]:
            fail(f"source server: unexpected reply {h!r}")
        b = self.f.read(n)
        if len(b) != n:
            fail("source server: short data")
        return b

    def check(self):
        if self.provenance and hasattr(self.provenance, "recheck"):
            self.provenance.recheck()

    def _unlink(self):
        if not self.created:                                         # never a socket we did not create
            return
        for n in ("mp.sock", "mp.sock.new"):
            with contextlib.suppress(OSError):
                os.unlink(n, dir_fd=self.dfd)
        self.created = False

    def close(self):
        if self.c is not None:
            with contextlib.suppress(OSError):
                self.c.sendall(b"Q\n")
        for x in (self.f, self.c, self.ls):
            with contextlib.suppress(OSError, AttributeError):
                x.close()
        if self.dfd is not None:
            self._unlink()
            os.close(self.dfd); self.dfd = None


# ---- targets ------------------------------------------------------------------------------------------------------------------------
class Targets:
    """every check (filesystem binding, ownership, emptiness, marker, the caller's admission) runs for ALL targets BEFORE any marker
    is written, so a refusal leaves every directory untouched"""
    def __init__(self, d, msha, names, create, admit=None):
        self.d, self.fd, self.lock = d, {}, []
        try:
            self._open(msha, names, create, admit)
        except BaseException:
            self.close(); raise

    def _open(self, msha, names, create, admit):
        d = self.d
        want = lambda name: {"format": FMT["marker"], "manifestSha256": msha, "target": name}
        new = []
        for name in names:
            v = d["targets"][name]
            self.fd[name] = open_dir(v["dir"], f"target {name}")
            self.binding_ok(name)
            fd = self.fd[name]
            if exists_in(fd, MARKER):
                try:
                    ok = read_json_in(fd, MARKER, "marker") == want(name)
                except Fail:
                    ok = False
                if not ok:
                    refuse(f"target {name}: marker belongs to another manifest/target")
            elif not create:
                refuse(f"target {name}: no marker (never copied into)")
            elif os.listdir(fd):
                refuse(f"target {name}: directory not empty and not ours: nothing is touched")
            else:
                new.append(name)
        if admit:
            admit(self)
        for name in new:
            write_state(self.fd[name], MARKER, want(name))
        for name in names:
            lfd = open_in(self.fd[name], MARKER, "marker")
            try:
                fcntl.flock(lfd, fcntl.LOCK_EX | fcntl.LOCK_NB)        # concurrency 1 per target
            except OSError:
                os.close(lfd); refuse(f"target {name}: another copy/verify holds it")
            self.lock.append(lfd)

    def binding_ok(self, name):
        """the ACTUAL filesystem of the open target dir must still be the pinned one (re-checked at every checkpoint)"""
        v = self.d["targets"][name]
        if majmin(os.fstat(self.fd[name]).st_dev) != v["majmin"]:
            refuse(f"target {name}: filesystem {majmin(os.fstat(self.fd[name]).st_dev)} != pinned {v['majmin']}")
        if self.d["kind"] == "production":
            u, mm = findmnt_uuid(v["dir"])
            if (u, mm) != (v["uuid"], v["majmin"]) or is_usb(mm):
                refuse(f"target {name}: UUID/device differ or USB")

    def close(self):
        for x in self.lock + list(self.fd.values()):
            with contextlib.suppress(OSError):
                os.close(x)
        self.lock, self.fd = [], {}


def free_bytes(fd):
    v = os.statvfs(fd)
    return v.f_bavail * v.f_frsize


# ---- records ------------------------------------------------------------------------------------------------------------------------
def rec_name(p):
    return p["file"][:-4] + ".json"


def ck_name(p):
    return p["file"][:-4] + ".ckpt.json"


def tmp_name(p):
    return p["file"] + ".partial"


REC_KEYS = {"format", "manifestSha256", "index", "offset", "length", "file", "logicalSha256", "fileSize", "originalIdentity",
            "destIdentity", "source", "committedAtNs"}
VER_KEYS = {"format", "manifestSha256", "index", "status", "reason", "sourceSha256", "destinationSha256", "recordSha256", "run",
            "destIdentity", "source", "measuredAtNs", "method"}
DID_KEYS = {"dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"}


def valid_binding(b):
    return isinstance(b, dict) and b.get("kind") in ("fixture-file", "unbound-socket", "session") and \
        (b["kind"] != "session" or (isinstance(b.get("sessionId"), str) and RUN_ID.fullmatch(b["sessionId"])))


def load_record(dfd, p, msha):
    r = read_json_in(dfd, rec_name(p), "record")
    if not (isinstance(r, dict) and set(r) == REC_KEYS and r["format"] == FMT["part"] and r["manifestSha256"] == msha and r["index"] == p["index"]
            and r["offset"] == p["offset"] and r["length"] == p["length"] and r["file"] == p["file"] and r["fileSize"] == p["length"]
            and isinstance(r["logicalSha256"], str) and HEX64.fullmatch(r["logicalSha256"]) and isinstance(r["destIdentity"], dict)
            and set(r["destIdentity"]) == DID_KEYS and valid_binding(r["source"]) and _int(r["committedAtNs"])):
        fail(f"record {rec_name(p)} invalid for this manifest/part")
    return r


def part_stat(dfd, p):
    st = os.lstat(p["file"], dir_fd=dfd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        fail(f"{p['file']}: not a regular file owned by the caller (kept)")
    if st.st_nlink != 1:
        fail(f"{p['file']}: {st.st_nlink} hard links (an external link is never accepted; kept)")
    return st


def check_committed(dfd, p, r):
    """full re-hash of a committed part against its record (and its recorded identity)"""
    fd = open_in(dfd, p["file"], "part")
    try:
        st = os.fstat(fd)
        if st.st_nlink != 1:
            fail(f"{p['file']}: {st.st_nlink} hard links (kept)")
        if st.st_size != p["length"]:
            fail(f"{p['file']}: size {st.st_size} != {p['length']} (kept, not touched)")
        if dident(st) != r["destIdentity"]:
            fail(f"{p['file']}: identity differs from its commit record (replaced or modified; kept)")
        if hash_fd(fd, p["length"])[0].hexdigest() != r["logicalSha256"]:
            fail(f"{p['file']}: content differs from its commit record (kept, not touched)")
    finally:
        os.close(fd)


def drop_own_partial(dfd, p):
    """crash window between link(.partial -> part) and unlink(.partial): the leftover must be the SAME inode; else keep and fail"""
    if not exists_in(dfd, tmp_name(p)):
        return
    a, b = os.lstat(tmp_name(p), dir_fd=dfd), os.lstat(p["file"], dir_fd=dfd)
    if not (stat.S_ISREG(a.st_mode) and (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino) and a.st_uid == os.getuid()):
        fail(f"{tmp_name(p)} exists next to {p['file']} and is NOT the same inode: both kept")
    with critical():
        os.unlink(tmp_name(p), dir_fd=dfd); os.fsync(dfd)


def segments(p, pos, n):
    """[(rel_start, rel_end, is_hole)] covering [pos, pos+n) of part p"""
    out, cur = [], pos
    for s, ln in p["holes"]:
        a, b = max(s, pos), min(s + ln, pos + n)
        if a < b:
            if cur < a:
                out.append((cur, a, False))
            out.append((a, b, True)); cur = b
    if cur < pos + n:
        out.append((cur, pos + n, False))
    return out


# ---- copy ---------------------------------------------------------------------------------------------------------------------------
def floors(d, tg, name, need):
    tg.binding_ok(name)                                             # the ACTUAL target filesystem, every time
    v = d["targets"][name]
    if free_bytes(tg.fd[name]) - need < v["floorBytes"]:
        fail(f"target {name}: free space would fall below the {v['floorBytes']} byte floor (need {need} more)")
    if mem_available() < d["hostMemFloorBytes"]:
        fail(f"host MemAvailable below the {d['hostMemFloorBytes']} byte floor")


def remaining(d, tg, name, after_index):
    return sum(p["length"] for p in d["parts"] if p["target"] == name and p["index"] > after_index and not exists_in(tg.fd[name], rec_name(p)))


def write_ckpt(dfd, msha, p, committed, prefix):
    write_state(dfd, ck_name(p), {"format": FMT["ckpt"], "manifestSha256": msha, "index": p["index"], "partial": tmp_name(p),
                                  "committedBytes": committed, "prefixSha256": prefix}, replace=True)


def commit(d, msha, dfd, p, logical_sha, binding, link):
    """ONE critical section: [link .partial -> part, unlink .partial,] the commit record, the checkpoint removal (P7)"""
    with critical():
        if link:
            try:
                os.link(tmp_name(p), p["file"], src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
            except FileExistsError:
                fail(f"{p['file']} appeared during the copy: never overwritten")
            os.unlink(tmp_name(p), dir_fd=dfd); os.fsync(dfd)
        st = part_stat(dfd, p)
        write_state(dfd, rec_name(p), {"format": FMT["part"], "manifestSha256": msha, "index": p["index"], "offset": p["offset"],
                                       "length": p["length"], "file": p["file"], "logicalSha256": logical_sha, "fileSize": p["length"],
                                       "originalIdentity": d["source"]["originalIdentity"], "destIdentity": dident(st),
                                       "source": binding, "committedAtNs": time.time_ns()})
        if exists_in(dfd, ck_name(p)):
            os.unlink(ck_name(p), dir_fd=dfd); os.fsync(dfd)


def prepass(d, msha, tg, parts):
    """BEFORE any source is opened (P4): every selected part that has a record is fully re-hashed (never trusted); a same-inode
    .partial leftover is dropped. -> the indices proven present"""
    present = set()
    for p in parts:
        dfd = tg.fd[p["target"]]
        if exists_in(dfd, rec_name(p)):
            r = load_record(dfd, p, msha)
            drop_own_partial(dfd, p)
            check_committed(dfd, p, r)
            present.add(p["index"])
    return present


def copy_part(d, msha, tg, src, p, budget, present):
    dfd, name = tg.fd[p["target"]], p["target"]
    if p["index"] in present:
        r = load_record(dfd, p, msha)
        if dident(part_stat(dfd, p)) != r["destIdentity"]:
            fail(f"{p['file']} changed after the pre-pass (kept)")
        return "present", 0
    if exists_in(dfd, rec_name(p)):
        fail(f"{rec_name(p)} appeared after the pre-pass")
    if exists_in(dfd, p["file"]):                                   # data linked, record not written (crash in between): adopt
        drop_own_partial(dfd, p)
        st = part_stat(dfd, p)
        if st.st_size != p["length"]:
            fail(f"{p['file']} without a record and of the wrong size (kept)")
        fd = open_in(dfd, p["file"], "part")
        try:
            hf = hash_fd(fd, p["length"])[0].hexdigest()
        finally:
            os.close(fd)
        hs, pos = hashlib.sha256(), 0
        while pos < p["length"]:
            n = min(d["chunkBytes"], p["length"] - pos); hs.update(src.read(p["offset"] + pos, n)); pos += n
        if hs.hexdigest() != hf:
            fail(f"{p['file']} without a record differs from the source (kept)")
        commit(d, msha, dfd, p, hf, src.binding, link=False)
        return "adopted", 0
    if exists_in(dfd, ck_name(p)):
        ck = read_json_in(dfd, ck_name(p), "checkpoint")
        if not (isinstance(ck, dict) and set(ck) == {"format", "manifestSha256", "index", "partial", "committedBytes", "prefixSha256"}
                and ck["format"] == FMT["ckpt"] and ck["manifestSha256"] == msha and ck["index"] == p["index"] and ck["partial"] == tmp_name(p)
                and _int(ck["committedBytes"]) and ck["committedBytes"] <= p["length"]):
            fail(f"checkpoint {ck_name(p)} invalid (kept)")
        committed = ck["committedBytes"]
        if not exists_in(dfd, tmp_name(p)):
            if committed:
                fail(f"{tmp_name(p)} missing for a checkpoint of {committed} bytes")
            tfd = os.open(tmp_name(p), os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        else:
            tfd = os.open(tmp_name(p), os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
            st = os.fstat(tfd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1 or st.st_size < committed:
                os.close(tfd); fail(f"{tmp_name(p)}: not ours, linked elsewhere, or shorter than its checkpoint (kept)")
        h, got = hash_fd(tfd, committed)
        if got != committed or h.hexdigest() != ck["prefixSha256"]:
            os.close(tfd); fail(f"{tmp_name(p)}: prefix differs from its checkpoint (kept, not touched)")
        os.ftruncate(tfd, committed)                                 # drop only bytes written after the last checkpoint (ours)
    else:
        if exists_in(dfd, tmp_name(p)):
            fail(f"{tmp_name(p)} exists without a checkpoint: not ours to reuse (kept)")
        write_ckpt(dfd, msha, p, 0, hashlib.sha256().hexdigest())   # the checkpoint FIRST, then the NEW temp
        tfd = os.open(tmp_name(p), os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        h, committed = hashlib.sha256(), 0
    try:
        pos, last, wrote = committed, committed, 0
        floors(d, tg, name, (p["length"] - pos) + remaining(d, tg, name, p["index"]))
        while pos < p["length"]:
            n = min(d["chunkBytes"], p["length"] - pos)
            data = src.read(p["offset"] + pos, n)
            for a0, b0, hole in segments(p, pos, n):
                seg = data[a0 - pos:b0 - pos]
                if hole:
                    if seg.count(0) != len(seg):
                        fail(f"part {p['index']}: the SOURCE has non-zero bytes inside a map hole at {p['offset'] + a0}: map/source disagree")
                    continue                                         # left sparse; zeros by the file semantics
                mv, at = memoryview(seg), a0
                while mv:
                    k = os.pwrite(tfd, mv, at); mv, at = mv[k:], at + k
            h.update(data); pos += n; wrote += n
            if pos - last >= d["checkpointBytes"] or pos == p["length"] or (budget is not None and wrote >= budget):
                if os.fstat(tfd).st_size < pos:                      # P1: a trailing hole is extended SPARSELY before fsync+checkpoint
                    os.ftruncate(tfd, pos)
                os.fsync(tfd); write_ckpt(dfd, msha, p, pos, h.copy().hexdigest()); last = pos
                check_original(d); src.check()
                floors(d, tg, name, (p["length"] - pos) + remaining(d, tg, name, p["index"]))
                if budget is not None and wrote >= budget and pos < p["length"]:
                    raise Cancelled("budget")
        if os.fstat(tfd).st_size != p["length"]:
            os.ftruncate(tfd, p["length"])
        os.fsync(tfd)
        h2, got = hash_fd(tfd, p["length"])
        if got != p["length"] or h2.hexdigest() != h.hexdigest():
            fail(f"part {p['index']}: the temp re-read differs from what was written (kept)")
    finally:
        os.close(tfd)
    check_original(d); src.check()
    commit(d, msha, dfd, p, h.hexdigest(), src.binding, link=True)
    return "copied", wrote


def select(d, spec):
    if not spec:
        return d["parts"]
    lo, _, hi = spec.partition("-")
    if not lo.isdigit() or not (hi or lo).isdigit():
        refuse("--parts FIRST-LAST")
    lo, hi = int(lo), int(hi or lo)
    if not 0 <= lo <= hi < len(d["parts"]):
        refuse("--parts out of range")
    return d["parts"][lo:hi + 1]


def copy_run(d, msha, parts, open_src, budget=None):
    """admission -> targets -> the re-hash pre-pass -> ONLY THEN the source (open_src()) -> parts in order"""
    names = sorted({p["target"] for p in parts})

    def admit(tg):                                                   # the FULL remaining reservation per target, before any write
        for name in names:
            need = sum(p["length"] for p in d["parts"] if p["target"] == name and not exists_in(tg.fd[name], rec_name(p)))
            if free_bytes(tg.fd[name]) - need < d["targets"][name]["floorBytes"]:
                refuse(f"target {name}: free {free_bytes(tg.fd[name])} - reservation {need} < floor {d['targets'][name]['floorBytes']}")
        if mem_available() < d["hostMemFloorBytes"]:
            refuse("host MemAvailable below the floor")
    tg = Targets(d, msha, names, create=True, admit=admit)
    try:
        present = prepass(d, msha, tg, parts)
        if all(p["index"] in present for p in parts):                # nothing to read: no source (no session) is opened at all
            return [{"index": p["index"], "state": "present"} for p in parts]
        src = open_src()
        out = []
        try:
            for p in parts:
                st, wrote = copy_part(d, msha, tg, src, p, budget, present)
                out.append({"index": p["index"], "state": st})
                if budget is not None:
                    budget -= wrote
                    if budget <= 0 and p is not parts[-1]:
                        raise Cancelled("budget")
        finally:
            src.close()
        return out
    finally:
        tg.close()


# ---- verify -------------------------------------------------------------------------------------------------------------------------
def verify_run(d, msha, parts, open_src):
    """INDEPENDENT of copy-time hashes: fresh reads of the source AND the destination; -> per-part results (freshly measured)"""
    if mem_available() < d["hostMemFloorBytes"]:                    # the read path honours the host floor too
        refuse("host MemAvailable below the floor")
    tg = Targets(d, msha, sorted({p["target"] for p in parts}), create=False)
    run = run_id()
    try:
        src = open_src()                                             # verification ALWAYS re-reads the source: no source, no verify
        res = []
        try:
            for p in parts:
                dfd = tg.fd[p["target"]]
                r = load_record(dfd, p, msha)
                check_original(d); src.check()
                fd = open_in(dfd, p["file"], "part")
                try:
                    st0 = os.fstat(fd)
                    ok, why, hs, hd, pos, last = True, None, hashlib.sha256(), hashlib.sha256(), 0, 0
                    if st0.st_size != p["length"] or st0.st_nlink != 1 or dident(st0) != r["destIdentity"]:
                        ok, why = False, f"destination size/links/identity differ from its commit record ({dident(st0)})"
                    while ok and pos < p["length"]:
                        n = min(d["chunkBytes"], p["length"] - pos)
                        s_ = src.read(p["offset"] + pos, n); t_ = os.pread(fd, n, pos)
                        for a0, b0, hole in segments(p, pos, n):
                            if hole and s_[a0 - pos:b0 - pos].count(0) != b0 - a0:
                                ok, why = False, f"source non-zero inside a map hole at {p['offset'] + a0}"
                        if ok and s_ != t_:
                            m = min(len(s_), len(t_))
                            i = next((k for k in range(m) if s_[k] != t_[k]), m)
                            ok, why = False, f"source and destination differ at part offset {pos + i}"
                        hs.update(s_); hd.update(t_); pos += n
                        if pos - last >= d["checkpointBytes"]:
                            last = pos; check_original(d); src.check()
                            if mem_available() < d["hostMemFloorBytes"]:
                                fail("host MemAvailable below the floor during verify")
                    if ok and not (hs.hexdigest() == hd.hexdigest() == r["logicalSha256"]):
                        ok, why = False, "fresh source/destination hashes differ from the copy record"
                    st1 = os.fstat(fd)
                    if ok and dident(st1) != dident(st0):
                        ok, why = False, "the destination changed during verification"
                finally:
                    os.close(fd)
                check_original(d); src.check()
                vr = {"format": FMT["verify"], "manifestSha256": msha, "index": p["index"], "status": "PASS" if ok else "FAIL",
                      "reason": why, "sourceSha256": hs.hexdigest() if ok else None, "destinationSha256": hd.hexdigest() if ok else None,
                      "recordSha256": r["logicalSha256"], "run": run, "destIdentity": dident(st0), "source": src.binding,
                      "measuredAtNs": time.time_ns(), "method": "independent re-read of source AND destination, bytewise compare"}
                write_state(dfd, p["file"][:-4] + f".verify-{run}.json", vr)
                res.append({"index": p["index"], "status": vr["status"], "reason": why, "freshlyMeasured": True})
                if not ok:
                    fail(f"part {p['index']}: {why} (all files kept)")
        finally:
            src.close()
        return res, run
    finally:
        tg.close()


# ---- sessions (written by orchestrate.py after the r9 session receipt is checked) ----------------------------------------------
def session_name(sid):
    return f"session-{sid}.json"


def session_confirmed(dfd, binding, cache):
    """a 'session' binding counts only if THIS target holds a valid CONFIRMED session record for exactly that session"""
    if binding.get("kind") != "session":
        return False
    sid = binding["sessionId"]
    if (dfd, sid) not in cache:
        ok = False
        if exists_in(dfd, session_name(sid)):
            try:
                s = read_json_in(dfd, session_name(sid), "session")
                ok = isinstance(s, dict) and s.get("format") == FMT["session"] and s.get("sessionId") == sid and s.get("status") == "CONFIRMED" \
                    and s.get("binding") == binding
            except Fail:
                ok = False
        cache[(dfd, sid)] = ok
    return cache[(dfd, sid)]


def binding_counts(d, binding, dfd, cache):
    if d["kind"] == "production":
        return session_confirmed(dfd, binding, cache)
    return binding.get("kind") in ("fixture-file", "unbound-socket") or session_confirmed(dfd, binding, cache)


# ---- status (RECORDED state only; never fresh evidence) -----------------------------------------------------------------------------
def status(d, msha):
    committed, verified = [], []
    stale, unconfirmed, invalid, failed = [], [], [], []
    dfds, cache = {}, {}
    try:
        for name, v in d["targets"].items():
            try:
                dfds[name] = open_dir(v["dir"], "target")
            except Refuse:
                dfds[name] = None
        for p in d["parts"]:
            dfd = dfds[p["target"]]
            if dfd is None or not exists_in(dfd, rec_name(p)):
                continue
            try:
                r = load_record(dfd, p, msha)
            except Fail:
                invalid.append(p["index"]); continue
            try:
                st = os.lstat(p["file"], dir_fd=dfd)
            except FileNotFoundError:
                stale.append(p["index"]); continue
            if not stat.S_ISREG(st.st_mode) or dident(st) != r["destIdentity"] or st.st_nlink != 1:
                stale.append(p["index"]); continue
            commit_ok = binding_counts(d, r["source"], dfd, cache)
            pref = p["file"][:-4] + ".verify-"
            passed = False
            for n in sorted(os.listdir(dfd)):
                if not (n.startswith(pref) and n.endswith(".json")):
                    continue
                try:
                    x = read_json_in(dfd, n, "verify")
                except Fail:
                    invalid.append(p["index"]); continue
                good = isinstance(x, dict) and set(x) == VER_KEYS and x["format"] == FMT["verify"] and x["manifestSha256"] == msha \
                    and x["index"] == p["index"] and x["status"] in ("PASS", "FAIL") and isinstance(x["run"], str) and RUN_ID.fullmatch(x["run"]) \
                    and n == pref + x["run"] + ".json" and isinstance(x["destIdentity"], dict) and set(x["destIdentity"]) == DID_KEYS \
                    and valid_binding(x["source"]) and _int(x["measuredAtNs"])
                if not good:
                    invalid.append(p["index"]); continue
                if x["status"] == "FAIL":
                    failed.append(p["index"]); continue
                if x["destIdentity"] == r["destIdentity"] == dident(st) and x["recordSha256"] == r["logicalSha256"] \
                        and x["sourceSha256"] == x["destinationSha256"] == r["logicalSha256"] and x["measuredAtNs"] > r["committedAtNs"] \
                        and binding_counts(d, x["source"], dfd, cache):
                    passed = True
            # a part committed in a session later found UNCONFIRMED counts again only through a fresh PASS in a CONFIRMED session
            if commit_ok or passed:
                committed.append(p["index"])
            else:
                unconfirmed.append(p["index"])
            if passed:
                verified.append(p["index"])
    finally:
        for fd in dfds.values():
            if fd is not None:
                os.close(fd)
    n = len(d["parts"])
    return {"parts": n, "partsCommitted": len(committed), "partsVerifiedRecorded": len(verified),
            "stale": stale[:64], "unconfirmed": unconfirmed[:64], "invalidRecords": sorted(set(invalid))[:64], "failedVerification": sorted(set(failed))[:64],
            "copyComplete": len(committed) == n,
            "verificationCompleteRecorded": len(verified) == n and not failed and not invalid and not stale and not unconfirmed,
            "freshlyMeasured": False,
            "note": "RECORDED state checked against the current file identities; not freshly measured (only a verify run measures). "
                    "Neither flag is a RAID-reset, recovery or production-ready statement"}


# ---- serve (inside the r9 overlay session as --exec; never writes a file) ---------------------------------------------------------
def mnt_id(fd):
    with open(f"/proc/self/fdinfo/{fd}") as f:
        for l in f:
            if l.startswith("mnt_id:"):
                return int(l.split()[1])
    refuse("serve: no mnt_id in fdinfo")


def cmd_serve(a):
    env_t = os.environ.get("RECOVERY_TARGET")
    if a.session_run_dir:
        if a.source:
            refuse("serve: --source is not allowed with --session-run-dir (the reconstructed RECOVERY_TARGET only)")
        want = os.path.join(a.session_run_dir, "work", "mnt") + TARGET_PATH
        if env_t != want:
            refuse(f"serve: RECOVERY_TARGET {env_t!r} is not exactly {want!r}")
        target, kind = env_t, "recovery-target"
    else:
        target, kind = (env_t, "recovery-target") if env_t else (a.source, "fixture-file")
        if not target:
            refuse("serve: RECOVERY_TARGET unset")
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    st = os.fstat(fd)
    rdonly = bool(os.fstatvfs(fd).f_flag & os.ST_RDONLY)
    if not stat.S_ISREG(st.st_mode) or st.st_size != a.expect_size:
        refuse(f"serve: target not a regular file of {a.expect_size} bytes")
    if a.session_run_dir and not rdonly:
        refuse("serve: the target is not on an ST_RDONLY mount")
    dfd = os.open(a.socket_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    os.fchdir(dfd)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect("mp.sock")
    s.settimeout(None)                                               # P4: no idle death; the session's exec deadline bounds us
    _pid, uid, _gid = peer_cred(s)
    if uid != os.getuid():
        refuse("serve: peer uid differs")
    s.sendall((json.dumps({"proto": FMT["proto"], "size": st.st_size, "sourceKind": kind, "target": target, "identity": ident(st),
                           "mntId": mnt_id(fd), "readOnly": rdonly}) + "\n").encode())
    f = s.makefile("rb")
    while True:
        line = f.readline(128)
        if not line or line == b"Q\n":
            return 0
        m = re.fullmatch(rb"R (\d{1,15}) (\d{1,9})\n", line)
        if not m:
            refuse("serve: malformed request")
        off, n = int(m[1]), int(m[2])
        if not (0 < n <= MAX_REQ and off + n <= st.st_size):
            refuse("serve: request out of range")
        out, pos = bytearray(), off
        while len(out) < n:
            b = os.pread(fd, n - len(out), pos)
            if not b:
                refuse("serve: short read")
            out += b; pos += len(b)
        if ident(os.fstat(fd)) != ident(st):
            refuse("serve: target identity changed")
        s.sendall(f"D {off} {n}\n".encode() + bytes(out))


# ---- CLI ----------------------------------------------------------------------------------------------------------------------------
def fixture_source(d, a):
    if d["kind"] == "production":
        refuse("production manifests are copied and verified ONLY through orchestrate.py (the bound r9 session)")
    if a.source_socket_dir:
        return lambda: _accepted(SocketSource(a.source_socket_dir, d["source"]["logicalSize"]), a.accept_timeout)
    return lambda: FileSource(a.source_file, d["source"]["logicalSize"])


def _accepted(s, timeout):
    s.accept(timeout)
    return s


def cmd_copy(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    open_src = fixture_source(d, a)
    bind_inputs(d)
    out = copy_run(d, msha, select(d, a.parts), open_src, a.max_bytes)
    print(json.dumps({"copied": out, **status(d, msha)}))
    return 0


def cmd_verify(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    open_src = fixture_source(d, a)
    bind_inputs(d)
    res, run = verify_run(d, msha, select(d, a.parts), open_src)
    print(json.dumps({"verified": res, "run": run, "freshlyMeasured": True}))
    return 0


def cmd_status(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    print(json.dumps(status(d, msha))); return 0


def cmd_validate(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    print(json.dumps({"valid": True, "kind": d["kind"], "parts": len(d["parts"]), "manifestSha256": msha})); return 0


def parser():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    for k in ("--original", "--map", "--overlay-plan", "--journal", "--out"):
        p.add_argument(k, required=True)
    p.add_argument("--target", action="append", required=True); p.add_argument("--assign", action="append", required=True)
    p.add_argument("--production", action="store_true")
    p.add_argument("--logical-size", type=int); p.add_argument("--part-size", type=int); p.add_argument("--floor-bytes", type=int, default=0)
    p.add_argument("--host-mem-floor", type=int, default=0); p.add_argument("--chunk-bytes", type=int, default=1 << 20)
    p.add_argument("--checkpoint-bytes", type=int, default=4 << 20)
    for c in ("validate", "status", "copy", "verify"):
        q = sub.add_parser(c); q.add_argument("--manifest", required=True); q.add_argument("--manifest-sha256", required=True)
        if c in ("copy", "verify"):
            g = q.add_mutually_exclusive_group(required=True)
            g.add_argument("--source-file"); g.add_argument("--source-socket-dir")
            q.add_argument("--accept-timeout", type=int, default=600); q.add_argument("--parts")
        if c == "copy":
            q.add_argument("--max-bytes", type=int)
    s = sub.add_parser("serve"); s.add_argument("--socket-dir", required=True); s.add_argument("--expect-size", type=int, required=True)
    s.add_argument("--session-run-dir"); s.add_argument("--source")
    return ap


def main(argv=None):
    ap = parser()
    a = ap.parse_args(argv)
    if a.cmd == "plan" and not a.production and (a.logical_size is None or a.part_size is None):
        ap.error("fixture plans need --logical-size and --part-size")
    old = install_signals()
    try:
        return {"plan": cmd_plan, "validate": cmd_validate, "status": cmd_status, "copy": cmd_copy, "verify": cmd_verify, "serve": cmd_serve}[a.cmd](a)
    except (Refuse, Fail, Cancelled) as e:
        kind = {3: "REFUSED", 4: "FAILED", 5: "STOPPED"}[e.rc]
        print(f"{kind}: {e}", file=sys.stderr)
        return e.rc
    except OSError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 4
    finally:
        for sg, h in old.items():
            signal.signal(sg, h)


if __name__ == "__main__":
    sys.exit(main())
