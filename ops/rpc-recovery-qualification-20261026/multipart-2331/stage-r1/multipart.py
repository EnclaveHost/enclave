#!/usr/bin/env python3
"""recovery-multipart-stage/r1 multipart.py (PREPARED by Claude 1746; NOT run by Claude). Standard library only.

Resumable, independently verified MULTIPART PRESERVATION COPY of the reconstructed read-only recovery target (the r9 overlay view of
the deleted /data/db/mdbx.dat). Sequential, one part at a time, bounded buffers, os.pread / os.pwrite. NOT a recovery acceptance, NOT
a data-integrity claim (the data blocks are not authenticated), NOT a RAID-reset or production-ready statement.

  plan     -> a strictly validated, versioned manifest (recovery-multipart-manifest/v1): source pins (original qcow2 identity, map,
              overlay plan + all 30 patch identities, journal), exhaustive ordered non-overlapping logical coverage in parts, the exact
              hole map from the extent map, per-target filesystem binding (st_dev + UUID), floors. Written NEW (O_EXCL), never replaced.
  copy     -> per part: checkpointed temp (fsync + atomic checkpoint), map holes must read as zeros and are left sparse, data written
              with pwrite, temp re-read and re-hashed, linked to its final name WITHOUT replace, then an atomic commit record.
              Resume never trusts an existing file: committed parts are fully re-hashed against their record; a partial temp is
              re-hashed against its checkpoint prefix; any mismatch REFUSES and keeps every file (evidence is never deleted).
  verify   -> INDEPENDENT of copy-time hashes: re-reads the SOURCE and the DESTINATION, compares every byte, recomputes both hashes;
              a PASS also requires equality with the copy record. Never accepts a record alone (no source -> refused).
  status   -> copyComplete and verificationComplete, separately.
  serve    -> the ONLY code meant to run inside the r9 overlay session as --exec: opens RECOVERY_TARGET O_RDONLY and serves byte
              ranges over a unix socket owned by the copier. It never creates or writes a file, so the session's RLIMIT_FSIZE
              (= the 64 MiB overlay cap, applied to every child) is neither relaxed nor hit: RLIMIT_FSIZE limits regular-file writes,
              and only the copier - a separate, unlimited process outside the session - writes the 4 GiB parts.
Exit: 0 ok; 3 refused (precondition, nothing changed); 4 failed (mismatch, I/O, capacity/memory floor at runtime; state kept);
      5 stopped cleanly (signal or --max-bytes budget; resumable); 2 usage."""
import argparse, contextlib, fcntl, hashlib, json, os, re, signal, socket, stat, struct, subprocess, sys, time

BS = 4096
MAX_REQ = 8 << 20
FMT = {"manifest": "recovery-multipart-manifest/v1", "part": "recovery-multipart-part/v1", "ckpt": "recovery-multipart-checkpoint/v1",
       "verify": "recovery-multipart-verify/v1", "marker": "recovery-multipart-target/v1", "proto": "recovery-multipart-source/v1"}
MARKER = ".recovery-multipart-target.json"
_W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
PROD = {   # pinned production constants (the manifest kind "production" must match ALL of them exactly)
    "originalPath": "/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly/enclave-rpc-production/base-origin.qcow2",
    "mapPath": _W + "/ext4-recovery-checksum-stage/r2/runs/real-20261026T203730Z-2323458/ext4-candidate-checksums.json",
    "mapSha256": "70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200",
    "planPath": _W + "/recovery-overlay-stage/r7/runs/plan-real-20261026T212534Z-2371806/plan.json",
    "planSha256": "c4e38213847793d5c0868825fe454c5702b4499a6b25315078037b073a4f35a9",
    "journalPath": _W + "/logs/base-journal-copy-1626/journal-8.bin",
    "journalSha256": "d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073",
    "logicalSize": 1138166333440, "mappedBytes": 1134426345472, "extents": 9001, "patches": 30, "patchBytes": 119040,
    "partSize": 4 << 30, "parts": 265, "assign": {"root": [0, 119], "vm": [120, 264]},
    "targets": {"root": {"majmin": "253:0", "uuid": "1c7c5336-9d52-4858-828a-823c31189c59"},     # findmnt -T / (1746, read-only)
                "vm": {"majmin": "253:1", "uuid": "aaae081c-f829-4484-a50f-a9bbb87d31f9"}},     # r7 pin (1735)
    "floorBytes": 40 << 30, "hostMemFloorBytes": 16 << 30, "chunkBytes": 8 << 20, "checkpointBytes": 256 << 20,
}


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


# ---- signals: a cancel request raises Cancelled, except inside a critical section (state writes), where it is deferred ----------
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


# ---- filesystem safety ------------------------------------------------------------------------------------------------------------
def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def sha(b):
    return hashlib.sha256(b).hexdigest()


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


def identity(path, what):
    no_symlink_ancestors(path, what)
    try:
        st = os.lstat(path)
    except OSError as e:
        refuse(f"{what}: {e.strerror}")
    if not stat.S_ISREG(st.st_mode):
        refuse(f"{what}: not a regular file")
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}


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
    """atomic: NEW temp (O_EXCL) + fsync + link (no replace) or replace (own checkpoint only) + directory fsync"""
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
    """production only: findmnt -n -o UUID,MAJ:MIN -T path -> exactly 1 line, exactly 2 fields (fail closed; r7 lesson)"""
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
    """True if block device mm (or any device it is stacked on, via slaves/) sits on a USB bus. Unknown device -> refused"""
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


def parse_overlay_plan(raw, map_sha, journal_sha, logical, extents):
    try:
        d = json.loads(raw.decode())
        ok = d["format"] == "recovery-overlay-plan/v1" and d["inputs"]["candidatesSha256"] == map_sha \
            and d["inputs"]["journalSha256"] == journal_sha and d["target"]["size"] == logical and d["map"]["extents"] == extents
        patches = d["patches"]
    except (UnicodeDecodeError, ValueError, KeyError, TypeError):
        refuse("overlay plan: not a recovery-overlay-plan/v1")
    if not ok:
        refuse("overlay plan: not bound to this map / journal / logical size / extent count")
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
    patches, patch_bytes = parse_overlay_plan(plan_raw, map_sha, journal_sha, logical, m["extents"])
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
            st = os.fstat(fd); mm = majmin(st.st_dev)
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
    if prod:
        check_production(doc)
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
    """strict structure + exhaustive, ordered, non-overlapping logical coverage + holes consistent with the global hole map"""
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
        if not (isinstance(s[k], str) and re.fullmatch(r"[0-9a-f]{64}", s[k])):
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
    if not re.fullmatch(r"[0-9a-f]{64}", want_sha or "") or sha(raw) != want_sha:
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
    patches, pb = parse_overlay_plan(plan_raw, s["mapSha256"], s["journalSha256"], s["logicalSize"], m["extents"])
    if m["holes"] != s["holes"] or m["mappedBytes"] != s["mappedBytes"] or patches != s["patches"] or pb != s["patchBytes"]:
        refuse("the hole map or the patch identities derived from the inputs differ from the manifest")


def check_original(d):
    if identity(d["source"]["originalPath"], "original") != d["source"]["originalIdentity"]:
        fail("the original's identity changed during the run: stopped")


# ---- sources ------------------------------------------------------------------------------------------------------------------------
class FileSource:
    """a plain read-only file (fixtures; never a production manifest)"""
    def __init__(self, path, size):
        self.fd = open_file(path, "source")
        got = os.fstat(self.fd).st_size
        if got != size:
            os.close(self.fd); refuse(f"source size {got} != logical size {size}")
        self.size = size

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

    def close(self):
        os.close(self.fd)


class SocketSource:
    """the copier side of `serve`: a private 0700 directory of ours, one connection, peer uid == ours"""
    def __init__(self, sock_dir, size, timeout):
        self.dfd = open_dir(sock_dir, "socket dir")
        if os.fstat(self.dfd).st_mode & 0o077:
            refuse("socket dir must be 0700")
        self.size, self.dir = size, sock_dir
        cwd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.fchdir(self.dfd)
            if exists_in(self.dfd, "mp.sock") or exists_in(self.dfd, "mp.sock.new"):
                refuse("socket dir already has mp.sock")
            self.ls.bind("mp.sock.new")                              # relative: no 108-byte AF_UNIX path limit
            self.ls.listen(1)
            os.rename("mp.sock.new", "mp.sock", src_dir_fd=self.dfd, dst_dir_fd=self.dfd)   # visible only once listening
        finally:
            os.fchdir(cwd); os.close(cwd)
        self.ls.settimeout(timeout)
        try:
            self.c, _ = self.ls.accept()
        except socket.timeout:
            self._unlink(); refuse("no source server connected in time")
        self.c.settimeout(600)
        _pid, uid, _gid = struct.unpack("3i", self.c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if uid != os.getuid():
            self.close(); refuse("source server peer uid differs")
        self.f = self.c.makefile("rb")
        try:
            hello = json.loads(self.f.readline(4096).decode())
        except (UnicodeDecodeError, ValueError):
            self.close(); refuse("source server hello malformed")
        if hello.get("proto") != FMT["proto"] or hello.get("size") != size:
            self.close(); refuse(f"source server: protocol or size differ ({hello})")
        self.hello = hello

    def read(self, off, n):
        self.c.sendall(f"R {off} {n}\n".encode())
        h = self.f.readline(128).decode().split()
        if h != ["D", str(off), str(n)]:
            fail(f"source server: unexpected reply {h!r}")
        b = self.f.read(n)
        if len(b) != n:
            fail("source server: short data")
        return b

    def _unlink(self):
        with contextlib.suppress(OSError):
            os.unlink("mp.sock", dir_fd=self.dfd)

    def close(self):
        with contextlib.suppress(OSError):
            self.c.sendall(b"Q\n")
        for x in (getattr(self, "f", None), getattr(self, "c", None), self.ls):
            with contextlib.suppress(OSError, AttributeError):
                x.close()
        self._unlink(); os.close(self.dfd)


def open_source(d, a):
    size = d["source"]["logicalSize"]
    if a.source_socket_dir:
        return SocketSource(a.source_socket_dir, size, a.accept_timeout)
    if d["kind"] == "production":
        refuse("production manifests read ONLY through `serve` inside the reviewed overlay session (--source-socket-dir)")
    return FileSource(a.source_file, size)


# ---- targets ------------------------------------------------------------------------------------------------------------------------
class Targets:
    """every check (filesystem binding, ownership, emptiness, marker, the caller's admission) runs for ALL targets BEFORE any marker
    is written, so a refusal leaves every directory untouched"""
    def __init__(self, d, msha, names, create, admit=None):
        self.fd, self.lock = {}, []
        try:
            self._open(d, msha, names, create, admit)
        except BaseException:
            self.close(); raise

    def _open(self, d, msha, names, create, admit):
        want = lambda name: {"format": FMT["marker"], "manifestSha256": msha, "target": name}
        new = []
        for name in names:
            v = d["targets"][name]
            fd = open_dir(v["dir"], f"target {name}")
            self.fd[name] = fd
            st = os.fstat(fd)
            if majmin(st.st_dev) != v["majmin"]:
                refuse(f"target {name}: filesystem {majmin(st.st_dev)} != pinned {v['majmin']}")
            if d["kind"] == "production":
                u, mm = findmnt_uuid(v["dir"])
                if (u, mm) != (v["uuid"], v["majmin"]) or is_usb(mm):
                    refuse(f"target {name}: UUID/device differ or USB")
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


def load_record(dfd, p, msha):
    r = read_json_in(dfd, rec_name(p), "record")
    keys = {"format", "manifestSha256", "index", "offset", "length", "file", "logicalSha256", "fileSize", "originalIdentity"}
    if not (isinstance(r, dict) and set(r) == keys and r["format"] == FMT["part"] and r["manifestSha256"] == msha and r["index"] == p["index"]
            and r["offset"] == p["offset"] and r["length"] == p["length"] and r["file"] == p["file"] and r["fileSize"] == p["length"]
            and isinstance(r["logicalSha256"], str) and re.fullmatch(r"[0-9a-f]{64}", r["logicalSha256"])):
        fail(f"record {rec_name(p)} invalid for this manifest/part")
    return r


def check_committed(dfd, p, r):
    fd = open_in(dfd, p["file"], "part")
    try:
        if os.fstat(fd).st_size != p["length"]:
            fail(f"{p['file']}: size {os.fstat(fd).st_size} != {p['length']} (kept, not touched)")
        if hash_fd(fd, p["length"])[0].hexdigest() != r["logicalSha256"]:
            fail(f"{p['file']}: content differs from its commit record (kept, not touched)")
    finally:
        os.close(fd)


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
    v = d["targets"][name]
    if free_bytes(tg.fd[name]) - need < v["floorBytes"]:
        fail(f"target {name}: free space would fall below the {v['floorBytes']} byte floor (need {need} more)")
    if mem_available() < d["hostMemFloorBytes"]:
        fail(f"host MemAvailable below the {d['hostMemFloorBytes']} byte floor")


def remaining(d, tg, msha, name, after_index):
    return sum(p["length"] for p in d["parts"] if p["target"] == name and p["index"] > after_index and not exists_in(tg.fd[name], rec_name(p)))


def copy_part(d, msha, tg, src, p, budget):
    dfd, name = tg.fd[p["target"]], p["target"]
    if exists_in(dfd, rec_name(p)):
        r = load_record(dfd, p, msha); check_committed(dfd, p, r)
        return "present", 0
    if exists_in(dfd, p["file"]):                                   # data linked, record not yet written (crash in between)
        fd = open_in(dfd, p["file"], "part")
        try:
            if os.fstat(fd).st_size != p["length"]:
                fail(f"{p['file']} without a record and of the wrong size (kept)")
            hf = hash_fd(fd, p["length"])[0].hexdigest()
        finally:
            os.close(fd)
        hs = hashlib.sha256(); pos = 0
        while pos < p["length"]:
            n = min(d["chunkBytes"], p["length"] - pos); hs.update(src.read(p["offset"] + pos, n)); pos += n
        if hs.hexdigest() != hf:
            fail(f"{p['file']} without a record differs from the source (kept)")
        commit_record(d, msha, dfd, p, hf)
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
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size < committed:
                os.close(tfd); fail(f"{tmp_name(p)}: not ours or shorter than its checkpoint (kept)")
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
        floors(d, tg, name, (p["length"] - pos) + remaining(d, tg, msha, name, p["index"]))
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
                os.fsync(tfd); write_ckpt(dfd, msha, p, pos, h.copy().hexdigest()); last = pos
                check_original(d)
                floors(d, tg, name, (p["length"] - pos) + remaining(d, tg, msha, name, p["index"]))
                if budget is not None and wrote >= budget and pos < p["length"]:
                    raise Cancelled("budget")
        os.ftruncate(tfd, p["length"]); os.fsync(tfd)                # sparse tail / trailing holes
        h2, got = hash_fd(tfd, p["length"])
        if got != p["length"] or h2.hexdigest() != h.hexdigest():
            fail(f"part {p['index']}: the temp re-read differs from what was written (kept)")
    finally:
        os.close(tfd)
    check_original(d)
    with critical():
        try:
            os.link(tmp_name(p), p["file"], src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        except FileExistsError:
            fail(f"{p['file']} appeared during the copy: never overwritten")
        os.unlink(tmp_name(p), dir_fd=dfd); os.fsync(dfd)
    commit_record(d, msha, dfd, p, h.hexdigest())
    return "copied", wrote


def write_ckpt(dfd, msha, p, committed, prefix):
    write_state(dfd, ck_name(p), {"format": FMT["ckpt"], "manifestSha256": msha, "index": p["index"], "partial": tmp_name(p),
                                  "committedBytes": committed, "prefixSha256": prefix}, replace=True)


def commit_record(d, msha, dfd, p, logical_sha):
    write_state(dfd, rec_name(p), {"format": FMT["part"], "manifestSha256": msha, "index": p["index"], "offset": p["offset"],
                                   "length": p["length"], "file": p["file"], "logicalSha256": logical_sha, "fileSize": p["length"],
                                   "originalIdentity": d["source"]["originalIdentity"]})
    with critical():
        if exists_in(dfd, ck_name(p)):
            os.unlink(ck_name(p), dir_fd=dfd); os.fsync(dfd)


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


def cmd_copy(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    bind_inputs(d)
    parts = select(d, a.parts)
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
        src = open_source(d, a)
        out, budget = [], a.max_bytes
        try:
            for p in parts:
                st, wrote = copy_part(d, msha, tg, src, p, budget)
                out.append({"index": p["index"], "state": st})
                if budget is not None:
                    budget -= wrote
                    if budget <= 0 and p is not parts[-1]:
                        raise Cancelled("budget")
        finally:
            src.close()
        print(json.dumps({"copied": out, "copyComplete": status(d, msha)["copyComplete"]}))
        return 0
    finally:
        tg.close()


# ---- verify -------------------------------------------------------------------------------------------------------------------------
def cmd_verify(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    bind_inputs(d)
    parts = select(d, a.parts)
    tg = Targets(d, msha, sorted({p["target"] for p in parts}), create=False)
    run = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    try:
        src = open_source(d, a)                                      # verification ALWAYS re-reads the source: no source, no verify
        res = []
        try:
            for p in parts:
                dfd = tg.fd[p["target"]]
                r = load_record(dfd, p, msha)
                check_original(d)
                fd = open_in(dfd, p["file"], "part")
                try:
                    ok, why, hs, hd, pos = True, None, hashlib.sha256(), hashlib.sha256(), 0
                    if os.fstat(fd).st_size != p["length"]:
                        ok, why = False, f"destination size {os.fstat(fd).st_size} != {p['length']}"
                    while ok and pos < p["length"]:
                        n = min(d["chunkBytes"], p["length"] - pos)
                        s_ = src.read(p["offset"] + pos, n); t_ = os.pread(fd, n, pos)
                        for a0, b0, hole in segments(p, pos, n):
                            if hole and s_[a0 - pos:b0 - pos].count(0) != b0 - a0:
                                ok, why = False, f"source non-zero inside a map hole at {p['offset'] + a0}"
                        if ok and s_ != t_:
                            i = next(k for k in range(min(len(s_), len(t_)) + 1) if k == min(len(s_), len(t_)) or s_[k] != t_[k])
                            ok, why = False, f"source and destination differ at part offset {pos + i}"
                        hs.update(s_); hd.update(t_); pos += n
                    if ok and not (hs.hexdigest() == hd.hexdigest() == r["logicalSha256"]):
                        ok, why = False, "fresh source/destination hashes differ from the copy record"
                finally:
                    os.close(fd)
                check_original(d)
                vr = {"format": FMT["verify"], "manifestSha256": msha, "index": p["index"], "status": "PASS" if ok else "FAIL",
                      "reason": why, "sourceSha256": hs.hexdigest() if ok else None, "destinationSha256": hd.hexdigest() if ok else None,
                      "recordSha256": r["logicalSha256"], "run": run, "method": "independent re-read of source AND destination, bytewise compare"}
                write_state(dfd, p["file"][:-4] + f".verify-{run}.json", vr)
                res.append({"index": p["index"], "status": vr["status"], "reason": why})
                if not ok:
                    print(json.dumps({"verified": res}))
                    fail(f"part {p['index']}: {why} (all files kept)")
        finally:
            src.close()
        print(json.dumps({"verified": res, **status(d, msha)}))
        return 0
    finally:
        tg.close()


# ---- status -------------------------------------------------------------------------------------------------------------------------
def status(d, msha):
    committed = verified = failed = 0
    for p in d["parts"]:
        v = d["targets"][p["target"]]
        try:
            dfd = open_dir(v["dir"], "target")
        except Refuse:
            continue
        try:
            if not exists_in(dfd, rec_name(p)):
                continue
            r = load_record(dfd, p, msha)
            st = os.lstat(p["file"], dir_fd=dfd)
            if not stat.S_ISREG(st.st_mode) or st.st_size != p["length"]:
                continue
            committed += 1
            vs = [read_json_in(dfd, n, "verify") for n in os.listdir(dfd) if n.startswith(p["file"][:-4] + ".verify-") and n.endswith(".json")]
            vs = [x for x in vs if isinstance(x, dict) and x.get("format") == FMT["verify"] and x.get("manifestSha256") == msha and x.get("index") == p["index"]]
            if any(x.get("status") != "PASS" for x in vs):
                failed += 1
            elif any(x.get("sourceSha256") == x.get("destinationSha256") == r["logicalSha256"] for x in vs):
                verified += 1
        except Fail:
            continue
        finally:
            os.close(dfd)
    n = len(d["parts"])
    return {"parts": n, "partsCommitted": committed, "partsVerified": verified, "partsWithFailedVerification": failed,
            "copyComplete": committed == n, "verificationComplete": verified == n and failed == 0,
            "note": "copyComplete and verificationComplete are separate; neither is a RAID-reset, recovery or production-ready statement"}


def cmd_status(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    print(json.dumps(status(d, msha))); return 0


def cmd_validate(a):
    d, msha = load_manifest(a.manifest, a.manifest_sha256)
    print(json.dumps({"valid": True, "kind": d["kind"], "parts": len(d["parts"]), "manifestSha256": msha})); return 0


# ---- serve (inside the overlay session; never writes a file) -----------------------------------------------------------------------
def cmd_serve(a):
    target = os.environ.get("RECOVERY_TARGET") or a.source
    if not target:
        refuse("serve: RECOVERY_TARGET unset")
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_size != a.expect_size:
        refuse(f"serve: target not a regular file of {a.expect_size} bytes")
    dfd = os.open(a.socket_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    os.fchdir(dfd)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(600)
    s.connect("mp.sock")
    _pid, uid, _gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    if uid != os.getuid():
        refuse("serve: peer uid differs")
    s.sendall((json.dumps({"proto": FMT["proto"], "size": st.st_size, "st": [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]}) + "\n").encode())
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
        if os.fstat(fd).st_size != st.st_size:
            refuse("serve: target size changed")
        s.sendall(f"D {off} {n}\n".encode() + bytes(out))


# ---- CLI ----------------------------------------------------------------------------------------------------------------------------
def main(argv=None):
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
    s.add_argument("--source")
    a = ap.parse_args(argv)
    if a.cmd == "plan" and not a.production and (a.logical_size is None or a.part_size is None):
        ap.error("fixture plans need --logical-size and --part-size")
    old = {sg: signal.signal(sg, _on_signal) for sg in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
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
