#!/usr/bin/env python3
"""compact-header-extraction-stage/r2 extract.py (PREPARED by Claude 1881/1892; NOT run by Claude). Standard library only.
r2 = r1 (bd333afa...) + review 1885: the backup is bound to its FRESH read-only identity (the RAID owner's chmod-0444 receipt, pinned;
dev/ino/size/mode 0444/mtime_ns/ctime_ns after the chmod - never the pre-chmod ctime); the 1024 MiB main lane + 16 GiB host floor +
lane + 256 MiB headroom; fixture mode can never name the production backup, must use a /vm E2E workspace and the pinned floors; hold
900 s; a receipt that cannot be written is never rc 0; `state-pins` = the ONLY mapping of a CLEAN extraction receipt to the state
runner's staticFilesDir + six header files. No new lifecycle (r9 unchanged), no new kill path.

Bounded READ-ONLY extraction of an exact allowlist of files from the preserved compact qcow2 backup of the Base filesystem
(production: data/reth.toml + the 52500000/53000000 headers static files with .conf/.off = 7 files, 362,900,885 bytes) into a NEW
/vm directory. NOT a recovery, canonical-state, structural or reset acceptance; the extracted bytes are only "as stored in the backup".

Lifecycle: NO new mount/process lifecycle. The frozen, reviewed r9 overlay_session.py (sha-pinned, run as a private copy, as OUR
unreaped child; r9 SUMS verified) is reused unchanged with a generated zero-patch plan:
  - r9 opens the backup only as the read-only qcow2 backing of a NEW <=64 MiB overlay; it REFUSES a backup that is writable by this
    user, not qcow2, has its own backing file, or is smaller than the filesystem; it exposes qemu-nbd --read-only -> nbdfuse -r ->
    pinned fuse2fs ro,norecovery; checks write refusals and that target.path (data/reth.toml) is a regular file of its size; then runs
    --exec; cleanup (exec group first, then unmounts, reaping, overlay deletion, leftover scan, parent identity) always runs.
  - the --exec is `extract.py waiter` (a private copy): it writes READY (its pid / start time / the view identity) and waits for
    RELEASE. It never writes data (r9's RLIMIT_FSIZE = 64 MiB applies to it and to nothing else). The COPY is done by this parent
    process, outside the session and not RLIMIT-bound, and only after READY - i.e. after every r9 check passed.
  - READY is accepted only from the exec child of OUR session: pidfd_open, /proc ppid == our session child, exact cmdline, exact r9
    environment (PATH, LC_ALL, RECOVERY_TARGET), start time stable, pidfd alive; plus our own observation of the view: exactly one
    mountinfo entry at RUN/session/work/mnt, fuse*, ro, source RUN/session/work/view/nbd, statvfs ST_RDONLY; ext4 magic 0xEF53 at
    1080 and the pinned UUID at 1128 read from the raw read-only nbd view.
Per file: a path walk with O_NOFOLLOW on EVERY component from the mount root (no symlink anywhere), the final file a regular file
with nlink == the allowlist's (1: no hard links), size/mode/uid/gid/mtime_ns exactly the allowlist's; copied to DEST/<path>.partial
(O_EXCL, 0600; dirs 0700), fsync, then BOTH a second independent read of the source and a re-read of the copy must hash equal, and
the source's identity must be unchanged; only then link(.partial -> final) (never replace) + directory fsync. Totals exact.
Before / after: the backup's identity (dev, ino, size, mtime_ns, ctime_ns) and writability, `qemu-img info -U` (qcow2, no backing,
virtual size), the r9 receipt (only receipt, rc 0, cleanupComplete, parentUnchanged, plan sha, exec rc 0 with our argv and the READY
pid, all checks ok, overlay deleted, no leftover) and no mount left under RUN. A saved 120 GB SHA (a3b00e5f...) is provenance only:
no full-image hash is read. Exit: 0 CLEAN; 3 refused (nothing extracted); 4 failed (files/receipts kept); 5 stopped."""
import argparse, contextlib, hashlib, json, os, re, select, signal, stat, subprocess, sys, time
from pathlib import Path

W = Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025")
R9 = W / "recovery-overlay-stage/r9"
R9_PINS = {"sums": "17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3",
           "overlaySession": "65d45ab79da8e134772374ec7298cd3a53fc54d68ecb3b3fd407eec4874a8153",
           "fuse2fs": "/home/steven/Documents/Codex/2026-10-26/my/work/tr004/fuse2fs-package/usr/bin/fuse2fs",
           "fuse2fsSha256": "6e3b5404898c2e55cb97b75c79f7bf067d1fa3381647b458fb7904b43bc4927b"}
PY3 = "/usr/bin/python3"
CHUNK, MAX_TOTAL, BLOCK = 8 << 20, 400 << 20, 4096
EXT4_MAGIC_OFF, UUID_OFF = 1080, 1128
SESSION_END_WAIT, KILL_WAIT, READY_WAIT = 900, 120, 900
HOLD_DEFAULT = 900                                                 # r2 (1885 H3): the waiter's hold; r9 --exec-timeout = hold + 300
LANE_MIB, HEADROOM_MIB = 1024, 256                                 # r2 (1885 M2): the 1024 MiB main lane; MemAvailable >= floor+lane+headroom
# r2 (B2 resolved by the RAID owner): chmod 0444 ONLY; this receipt is pinned and the FRESH post-chmod identity is bound below
BACKUP_RECEIPT = ("/home/steven/Documents/Codex/2026-10-26/my/outputs/tr004-compact-backup-readonly-receipt.json",
                  "928d09babefb4083ae9be8fcb5c2dc7edbff083183060e570fc78c839d16a1ca")
E2E_PARENT = "/vm/enclave-volumes/tr004-base-recovery-20261026"
E2E_DEST_RE = re.compile(re.escape(E2E_PARENT) + r"/compact-header-e2e-\d{8}T\d{6}Z-\d+(/[A-Za-z0-9_-]+){0,2}")
# production allowlist: canonical-state-input-inventory-1859/compact-backup-reconciliation.json (sha256 8db4b41b...) selectedFiles
PROD_ALLOWLIST = [
    {"path": "data/reth.toml", "mode": 33184, "uid": 994, "gid": 985, "size": 2590, "mtime_ns": 1793026310098139981, "nlink": 1},
    {"path": "data/static_files/static_file_headers_52500000_52999999", "mode": 33188, "uid": 994, "gid": 985, "size": 318751407, "mtime_ns": 1000000000, "nlink": 1},
    {"path": "data/static_files/static_file_headers_52500000_52999999.conf", "mode": 33188, "uid": 994, "gid": 985, "size": 75, "mtime_ns": 1000000000, "nlink": 1},
    {"path": "data/static_files/static_file_headers_52500000_52999999.off", "mode": 33188, "uid": 994, "gid": 985, "size": 12000009, "mtime_ns": 1000000000, "nlink": 1},
    {"path": "data/static_files/static_file_headers_53000000_53499999", "mode": 33188, "uid": 994, "gid": 985, "size": 30982072, "mtime_ns": 1000000000, "nlink": 1},
    {"path": "data/static_files/static_file_headers_53000000_53499999.conf", "mode": 33188, "uid": 994, "gid": 985, "size": 75, "mtime_ns": 1000000000, "nlink": 1},
    {"path": "data/static_files/static_file_headers_53000000_53499999.off", "mode": 33188, "uid": 994, "gid": 985, "size": 1164657, "mtime_ns": 1000000000, "nlink": 1},
]
PROD = {"backup": "/home/steven/Documents/Codex/2026-10-26/my/work/tr004/preserved-images/base-origin.compact.qcow2",
        "backupSize": 120867323904, "backupSha256Provenance": "a3b00e5f0b4af372bdd479bd5bdaad48ce3a95438aa1879790d637641c95df9e",
        "uuid": "11c6bbac-f823-4052-a87a-066eed6ad590", "fsBlocks": 976562500, "total": 362900885,
        "reconciliationSha256": "8db4b41bd25b7b1153299154ef277bdd790ca4ff908d2ff2d2f8d7b6339580bb",
        "destParent": "/vm/enclave-volumes/tr004-base-recovery-20261026", "destMajmin": "253:1",
        "destUuid": "aaae081c-f829-4484-a50f-a9bbb87d31f9", "vmFloor": 40 << 30, "rootFloor": 40 << 30, "rootExtra": 8 << 30,
        "hostMemFloor": 16 << 30, "plannedTarget": "data/reth.toml",
        # r2: the FRESH identity after the owner's chmod 0444 (receipt BACKUP_RECEIPT "after"); the pre-chmod ctime is NOT used
        "backupDev": 64768, "backupIno": 4856848, "backupMode": 0o444, "backupMtimeNs": 1793046916167070631,
        "backupCtimeNs": 1793097367170099837}
STATIC_DIR = "data/static_files"                                   # r2: the state runner's --static-files under <run>/files
ENTRY_KEYS = {"path", "size", "nlink"}                              # mode, uid, gid, mtime_ns, sha256 optional (checked when present)
REQ_FORMAT, PURPOSE = "compact-header-extraction-request/v1", "compact-header-extraction"


class Refuse(Exception):
    rc = 3


class Fail(Exception):
    rc = 4


class Stopped(BaseException):
    rc = 5


def refuse(m):
    raise Refuse(m)


def fail(m):
    raise Fail(m)


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ---- allowlist -----------------------------------------------------------------------------------------------------------------------
def validate_allowlist(entries, total=None):
    """exact, safe relative paths; unique; positive bounded totals; -> the canonical sha256 of the list"""
    if not isinstance(entries, list) or not entries:
        refuse("allowlist: a non-empty list is required")
    seen, tot = set(), 0
    for e in entries:
        if not (isinstance(e, dict) and ENTRY_KEYS <= set(e) <= ENTRY_KEYS | {"mode", "uid", "gid", "mtime_ns", "sha256"}):
            refuse(f"allowlist entry keys: {e}")
        p = e["path"]
        comps = p.split("/") if isinstance(p, str) else []
        if not comps or any(c in ("", ".", "..") or "\0" in c for c in comps) or p.startswith("/") or p in seen:
            refuse(f"allowlist path unsafe or duplicate: {p!r}")
        for k in ("size", "nlink", "mode", "uid", "gid", "mtime_ns"):
            if k in e and not (isinstance(e[k], int) and not isinstance(e[k], bool) and e[k] >= 0):
                refuse(f"allowlist {p}: {k} must be a non-negative int")
        if e["nlink"] != 1:
            refuse(f"allowlist {p}: only nlink 1 files (no hard links) are extracted")
        seen.add(p); tot += e["size"]
    if tot > MAX_TOTAL or (total is not None and tot != total):
        refuse(f"allowlist total {tot} bytes (max {MAX_TOTAL}, expected {total})")
    return sha_bytes(canon(entries).encode()), tot


# ---- the waiter (runs INSIDE the r9 session as --exec; writes only READY) --------------------------------------------------------
def starttime(pid):
    s = Path(f"/proc/{pid}/stat").read_text()
    rest = s[s.rindex(")") + 2:].split()
    return int(rest[1]), int(rest[19])                               # (ppid, starttime)


def cmd_waiter(a):
    t = os.environ.get("RECOVERY_TARGET", "")
    st = os.lstat(t)
    if not stat.S_ISREG(st.st_mode) or not os.statvfs(t).f_flag & os.ST_RDONLY:
        print("waiter: target not a regular file on an ST_RDONLY mount", file=sys.stderr); return 3
    rd = os.open(a.ready_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = os.open("READY", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=rd)
    os.write(fd, json.dumps({"pid": os.getpid(), "startTime": starttime(os.getpid())[1], "target": t,
                             "targetIdentity": [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]}).encode()); os.fsync(fd); os.close(fd)
    end = time.monotonic() + a.max_wait
    while time.monotonic() < end:
        try:
            os.lstat("RELEASE", dir_fd=rd); return 0
        except FileNotFoundError:
            time.sleep(0.5)
    print("waiter: no RELEASE within the bound", file=sys.stderr); return 6


# ---- process / mount observation ---------------------------------------------------------------------------------------------------
def proc_list(pid, name):
    raw = Path(f"/proc/{pid}/{name}").read_bytes()
    if not raw.endswith(b"\0"):
        refuse(f"/proc/{pid}/{name} malformed")
    return [x.decode(errors="replace") for x in raw.split(b"\0")[:-1]]


def alive(pidfd):
    p = select.poll(); p.register(pidfd, select.POLLIN)
    return not p.poll(0)


def child_running(pid):
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None
    except ChildProcessError:
        return False


def unescape(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def mount_entry(mountpoint, mountinfo=None):
    out = []
    for line in (mountinfo if mountinfo is not None else Path("/proc/self/mountinfo").read_text()).splitlines():
        pre, _, post = line.partition(" - ")
        a, b = pre.split(), post.split()
        if len(a) >= 6 and len(b) >= 2 and unescape(a[4]) == mountpoint:
            out.append({"mntId": int(a[0]), "fstype": b[0], "source": unescape(b[1]), "opts": a[5].split(",")})
    if len(out) != 1:
        refuse(f"{mountpoint}: {len(out)} mountinfo entries (need exactly 1)")
    return out[0]


def check_view(mnt, nbd, uuid, mountinfo=None):
    m = mount_entry(mnt, mountinfo)
    if not (m["fstype"].startswith("fuse") and "ro" in m["opts"] and m["source"] == nbd):
        refuse(f"the view at {mnt} is not the session's read-only fuse2fs view of {nbd}: {m}")
    return m


def check_fs_header(nbd, uuid):
    fd = os.open(nbd, os.O_RDONLY | os.O_CLOEXEC)
    try:
        if os.pread(fd, 2, EXT4_MAGIC_OFF) != b"\x53\xef":
            refuse("no ext4 magic 0xEF53 at raw offset 1080 of the view")
        got = os.pread(fd, 16, UUID_OFF).hex()
        if got != uuid.replace("-", ""):
            refuse(f"filesystem UUID {got} is not the pinned {uuid}")
    finally:
        os.close(fd)


def verify_ready(ready, sess_pid, waiter_argv, target):
    """READY must come from the exec child of OUR session (pidfd-pinned) -> the pidfd"""
    pid = ready.get("pid")
    if not isinstance(pid, int):
        refuse("READY malformed")
    try:
        pfd = os.pidfd_open(pid)
    except OSError as e:
        refuse(f"READY pid {pid}: {e.strerror}")
    try:
        ppid, st = starttime(pid)
        if ppid != sess_pid:
            refuse(f"READY pid {pid} is not a child of our session (ppid {ppid})")
        try:
            cmd, env = proc_list(pid, "cmdline"), proc_list(pid, "environ")
        except OSError as e:
            refuse(f"READY pid {pid}: {e.strerror}")
        ok = st == ready.get("startTime") and cmd == waiter_argv and \
            sorted(env) == sorted(["PATH=/usr/bin:/bin", "LC_ALL=C", f"RECOVERY_TARGET={target}"]) and ready.get("target") == target
        if not ok or starttime(pid) != (ppid, st) or not alive(pfd):
            refuse(f"READY pid {pid} is not the exec child of our session (ppid {ppid}, cmd {cmd[:6]})")
        return pfd
    except BaseException:
        os.close(pfd); raise


# ---- the walk and the copy ------------------------------------------------------------------------------------------------------
def open_nofollow(root_fd, rel):
    """every component O_NOFOLLOW from root_fd; -> (fd, fstat) of a regular file"""
    comps = rel.split("/")
    fd = os.dup(root_fd)
    try:
        for c in comps[:-1]:
            nfd = os.open(c, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd); fd = nfd
        f = os.open(comps[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
    except OSError as e:
        os.close(fd); refuse(f"{rel}: cannot open without following a link ({e.strerror})")
    os.close(fd)
    st = os.fstat(f)
    if not stat.S_ISREG(st.st_mode):
        os.close(f); refuse(f"{rel}: not a regular file")
    return f, st


def check_entry(e, st):
    want = {"size": st.st_size, "nlink": st.st_nlink, "mode": st.st_mode, "uid": st.st_uid, "gid": st.st_gid, "mtime_ns": st.st_mtime_ns}
    bad = {k: [e[k], v] for k, v in want.items() if k in e and e[k] != v}
    if bad:
        refuse(f"{e['path']}: differs from the allowlist {bad}")


def hash_fd(fd, size, stop):
    h, pos = hashlib.sha256(), 0
    while pos < size:
        if stop():
            raise Stopped("stopped while reading")
        b = os.pread(fd, min(CHUNK, size - pos), pos)
        if not b:
            fail("short read")
        h.update(b); pos += len(b)
    return h.hexdigest()


def dest_dirs(dest_fd, rel):
    fd = os.dup(dest_fd)
    for c in rel.split("/")[:-1]:
        with contextlib.suppress(FileExistsError):
            os.mkdir(c, 0o700, dir_fd=fd)
        nfd = os.open(c, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        os.close(fd); fd = nfd
    return fd


def copy_one(root_fd, dest_fd, e, stop):
    src, st0 = open_nofollow(root_fd, e["path"])
    try:
        check_entry(e, st0)
        dfd = dest_dirs(dest_fd, e["path"])
        name = e["path"].split("/")[-1]
        try:
            out = os.open(name + ".partial", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
            h, pos = hashlib.sha256(), 0
            try:
                while pos < st0.st_size:
                    if stop():
                        raise Stopped(f"stopped while copying {e['path']}")
                    b = os.pread(src, min(CHUNK, st0.st_size - pos), pos)
                    if not b:
                        fail(f"{e['path']}: short read")
                    mv = memoryview(b)
                    while mv:
                        k = os.write(out, mv); mv = mv[k:]
                    h.update(b); pos += len(b)
                os.fsync(out)
            finally:
                os.close(out)
            first = h.hexdigest()
            second = hash_fd(src, st0.st_size, stop)                 # an independent second read of the source
            st1 = os.fstat(src)
            if (st1.st_ino, st1.st_size, st1.st_mtime_ns, st1.st_ctime_ns) != (st0.st_ino, st0.st_size, st0.st_mtime_ns, st0.st_ctime_ns):
                fail(f"{e['path']}: the source changed during the copy")
            rfd = os.open(name + ".partial", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
            try:
                back = hash_fd(rfd, st0.st_size, stop)
            finally:
                os.close(rfd)
            if not first == second == back or ("sha256" in e and e["sha256"] != first):
                fail(f"{e['path']}: hashes disagree (read1 {first[:12]} read2 {second[:12]} copy {back[:12]}; kept as .partial)")
            os.link(name + ".partial", name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)   # never replace
            os.unlink(name + ".partial", dir_fd=dfd); os.fsync(dfd)
        finally:
            os.close(dfd)
        return {"path": e["path"], "size": st0.st_size, "sha256": first, "mode": st0.st_mode, "uid": st0.st_uid, "gid": st0.st_gid,
                "mtimeNs": st0.st_mtime_ns, "nlink": st0.st_nlink, "reads": 2, "copyReread": True}
    finally:
        os.close(src)


# ---- source identity / qemu-img ---------------------------------------------------------------------------------------------------
def no_symlink_path(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse(f"{path}: must be absolute and normalized")
    cur = "/"
    for c in path.strip("/").split("/"):
        cur = os.path.join(cur, c)
        if stat.S_ISLNK(os.lstat(cur).st_mode):
            refuse(f"{cur} is a symlink")


def source_identity(path, want_size=None):
    no_symlink_path(path)
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or (want_size is not None and st.st_size != want_size):
        refuse(f"{path}: not a regular file of the pinned size")
    if os.access(path, os.W_OK):
        refuse(f"{path} is WRITABLE by this user: the backup must be read-only (0444 or a read-only mount) - not changed here")
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns,
            "mode": stat.S_IMODE(st.st_mode), "readOnlyMount": bool(os.statvfs(path).f_flag & os.ST_RDONLY)}


def backup_binding_errors(ident, receipt_raw):
    """r2: [] iff the pinned owner receipt (sha) records exactly the chmod-0444 of THIS backup and the FRESH identity equals its
    post-chmod state (dev, ino, size, mode 0444, mtime_ns, ctime_ns). Any later metadata change (a new ctime) refuses."""
    e = []
    if type(receipt_raw) is not bytes or sha_bytes(receipt_raw) != BACKUP_RECEIPT[1]:
        return ["the RAID owner's read-only receipt is not the pinned file"]
    try:
        r = json.loads(receipt_raw)
        after = r["after"]
    except (ValueError, KeyError, TypeError):
        return ["the RAID owner's read-only receipt is malformed"]
    want = {"dev": PROD["backupDev"], "ino": PROD["backupIno"], "size": PROD["backupSize"], "mode": PROD["backupMode"],
            "mtimeNs": PROD["backupMtimeNs"], "ctimeNs": PROD["backupCtimeNs"]}
    rec = {"dev": after.get("device"), "ino": after.get("inode"), "size": after.get("size"), "mode": after.get("mode"),
           "mtimeNs": after.get("mtime_ns"), "ctimeNs": after.get("ctime_ns")}
    if r.get("path") != PROD["backup"] or r.get("operation") != "chmod0444 only" or rec != {**want, "mode": "0o444"}:
        e.append("the receipt does not record exactly the pinned chmod-0444 state of the backup")
    if type(ident) is not dict or {k: ident.get(k) for k in want} != want:
        e.append(f"the backup's FRESH identity differs from its pinned post-chmod identity: {ident}")
    return e


def lane_errors(memory_max_text, avail_bytes, host_floor):
    """r2 (1885 M2): our cgroup is the 1024 MiB main lane and MemAvailable >= host floor + lane + 256 MiB headroom"""
    e = []
    if type(memory_max_text) is not str or memory_max_text.strip() != str(LANE_MIB << 20):
        e.append(f"memory.max {memory_max_text!r} is not the {LANE_MIB} MiB main lane")
    if type(avail_bytes) is not int or avail_bytes < host_floor + ((LANE_MIB + HEADROOM_MIB) << 20):
        e.append(f"MemAvailable {avail_bytes} < host floor {host_floor} + {LANE_MIB} + {HEADROOM_MIB} MiB")
    return e


def own_memory_max():
    lines = [l for l in Path("/proc/self/cgroup").read_text().splitlines() if l.startswith("0::")]
    if len(lines) != 1:
        refuse("not a single cgroup v2 entry")
    return Path("/sys/fs/cgroup" + lines[0][3:] + "/memory.max").read_text()


def final_rc(rc, receipt_written):
    """r2 (1885 H1): a run whose EXTRACTION-RECEIPT.json could not be written is never 0 (and never STOPPED-only): 4"""
    return rc if receipt_written else (4 if rc in (0, 5) else rc)


def state_pins(receipt, run_dir):
    """r2: the ONLY mapping from a CLEAN extraction to the state runner's static-file pins. Refuses unless the receipt is a CLEAN
    production extraction of exactly the pinned allowlist (rc 0, outcome CLEAN, no error, session reasons [], no authority) located
    at run_dir; -> {format, staticFilesDir = <run_dir>/files/data/static_files, staticFiles = the SIX header files {name,size,sha256}
    in allowlist order (data/reth.toml excluded), allowlistSha256, extractionReceiptSha256 (filled by the CLI)}"""
    if not (type(receipt) is dict and receipt.get("rc") == 0 and type(receipt.get("rc")) is int and receipt.get("outcome") == "CLEAN"
            and "error" not in receipt and "finalizationErrors" not in receipt and receipt.get("runDir") == run_dir
            and isinstance(receipt.get("session"), dict) and receipt["session"].get("reasons") == [] and receipt["session"].get("rc") == 0
            and receipt.get("canonicalAuthority") is False and receipt.get("resetAuthority") is False):
        refuse("not a CLEAN extraction receipt of this run dir")
    files = receipt.get("files")
    want = [e["path"] for e in PROD_ALLOWLIST]
    if type(files) is not list or [f.get("path") if type(f) is dict else None for f in files] != want:
        refuse("the receipt's files are not exactly the pinned allowlist in order")
    for f, e in zip(files, PROD_ALLOWLIST):
        if not (type(f.get("size")) is int and f["size"] == e["size"] and type(f.get("sha256")) is str
                and re.fullmatch(r"[0-9a-f]{64}", f["sha256"])):
            refuse(f"{f.get('path')}: size/sha256 malformed")
    if receipt.get("totalBytes") != PROD["total"]:
        refuse("totalBytes is not the pinned total")
    hdr = [f for f in files if f["path"].startswith(STATIC_DIR + "/")]
    if len(hdr) != 6 or any("/" in f["path"][len(STATIC_DIR) + 1:] for f in hdr):
        refuse("not exactly six header files directly in data/static_files")
    return {"format": "compact-header-static-files/v1", "staticFilesDir": run_dir + "/files/" + STATIC_DIR,
            "staticFiles": [{"name": f["path"][len(STATIC_DIR) + 1:], "size": f["size"], "sha256": f["sha256"]} for f in hdr],
            "allowlistSha256": validate_allowlist(PROD_ALLOWLIST, PROD["total"])[0]}


def qemu_info(path, fs_bytes):
    p = subprocess.run(["qemu-img", "info", "-U", "--output=json", path], capture_output=True, text=True, timeout=120,
                       stdin=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin"})
    if p.returncode:
        refuse(f"qemu-img info failed: {p.stderr.strip()[:200]}")
    return check_qemu_info(json.loads(p.stdout), fs_bytes)


def check_qemu_info(info, fs_bytes):
    if info.get("format") != "qcow2" or any(k in info for k in ("backing-filename", "full-backing-filename", "backing-filename-format")) \
            or not isinstance(info.get("virtual-size"), int) or info["virtual-size"] < fs_bytes:
        refuse(f"the backup must be a qcow2 WITHOUT a backing chain holding the whole filesystem: {info}")
    return {k: info.get(k) for k in ("format", "virtual-size", "actual-size", "cluster-size")}


def check_receipt(r, plan_sha, waiter_argv, ready_pid):
    checks = [(r.get("rc") == 0, f"receipt rc {r.get('rc')}"), (r.get("cleanupComplete") is True, "cleanupComplete not true"),
              (r.get("parentUnchanged") is True, "parentUnchanged not true"), (r.get("planSha256") == plan_sha, "plan sha differs"),
              (isinstance(r.get("exec"), dict) and r["exec"].get("rc") == 0 and r["exec"].get("cmd") == waiter_argv and not r["exec"].get("timedOut")
               and not r["exec"].get("groupLeftovers") and r["exec"].get("escapedKilled") == 0, "exec not clean with exactly our argv"),
              (r.get("children", {}).get("exec", {}).get("pid") == ready_pid, "exec pid is not the READY pid"),
              (bool(r.get("checks")) and all(isinstance(v, dict) and v.get("ok") is True for v in r["checks"].values()), "a session check failed"),
              (not r.get("leftoverProcesses"), "leftover processes"), (r.get("overlayDeleted") is True, "overlay not deleted")]
    return [why for ok, why in checks if not ok]


def zero_patch_plan(fs_blocks, uuid, target, expected_sha=None):
    t = {"path": "/" + target["path"], "size": target["size"]}
    if expected_sha:
        t["expectedSha256"] = expected_sha                            # fixture only: r9 then reads the whole target
    return {"format": "recovery-overlay-plan/v1", "mode": "extraction-view", "patches": [], "samples": [],
            "fs": {"blockSize": BLOCK, "fsBlocks": fs_blocks, "fsOffset": 0, "uuid": uuid.replace("-", "")}, "target": t,
            "acceptance": "READ-ONLY EXTRACTION VIEW: zero patches; not a recovery or acceptance plan"}


def private_copy(src, dst, want):
    b = Path(src).read_bytes()
    if sha_bytes(b) != want:
        refuse(f"{src} is not the pinned code")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
    with os.fdopen(fd, "wb") as f:
        f.write(b); f.flush(); os.fsync(f.fileno())


def verify_r9():
    raw = (R9 / "SHA256SUMS").read_bytes()
    if sha_bytes(raw) != R9_PINS["sums"]:
        refuse("frozen r9 SHA256SUMS changed")
    for line in raw.decode().splitlines():
        h, _, n = line.partition("  ")
        if sha_file(os.path.normpath(R9 / n)) != h:
            refuse(f"frozen r9 file {n} changed")


def mem_available():
    for l in Path("/proc/meminfo").read_text().splitlines():
        if l.startswith("MemAvailable:"):
            return int(l.split()[1]) * 1024
    refuse("MemAvailable missing")


def write_json(dir_fd, name, obj):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dir_fd)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True, default=str) + "\n"); f.flush(); os.fsync(f.fileno())


def request_for(stage_sums):
    return {"format": REQ_FORMAT, "purpose": PURPOSE, "backupPath": PROD["backup"], "backupSha256Provenance": PROD["backupSha256Provenance"],
            "allowlistSha256": validate_allowlist(PROD_ALLOWLIST, PROD["total"])[0], "reconciliationSha256": PROD["reconciliationSha256"],
            "destParent": PROD["destParent"], "stageSums": stage_sums,
            "recoveryAccepted": False, "canonicalAuthority": False, "resetAuthority": False}


# ---- the run ----------------------------------------------------------------------------------------------------------------------
def cmd_run(a):
    stopflag = {"v": False}
    old = {sg: signal.signal(sg, lambda *_: stopflag.__setitem__("v", True)) for sg in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    stop = lambda: stopflag["v"]
    out = {"format": "compact-header-extraction-receipt/v1", "acceptance": "NOT a recovery, canonical-state, structural or reset acceptance",
           "canonicalAuthority": False, "resetAuthority": False, "outcome": "REFUSED", "files": []}
    sess, pfd, rc, run_fd = None, None, 3, None
    try:
        prod = not a.fixture
        entries = PROD_ALLOWLIST if prod else json.loads(Path(a.allowlist).read_text())
        allow_sha, total = validate_allowlist(entries, PROD["total"] if prod else None)
        backup, uuid, fs_blocks = (PROD["backup"], PROD["uuid"], PROD["fsBlocks"]) if prod else (a.backup, a.uuid, a.fs_blocks)
        fuse2fs, fuse2fs_sha = (R9_PINS["fuse2fs"], R9_PINS["fuse2fsSha256"]) if prod else (a.fuse2fs, a.fuse2fs_sha256)
        if prod:
            req = Path(a.request).read_bytes()
            if sha_bytes(req) != a.request_sha256:
                refuse("request sha256 differs")
            r, want = json.loads(req), request_for(a.stage_sums)
            if r != want:
                refuse(f"request is not exactly the purpose-bound preparation request (differs in {sorted(k for k in set(r) | set(want) if r.get(k) != want.get(k))})")
            if a.dest_parent != PROD["destParent"]:
                refuse("production destination parent is pinned")
        verify_r9()
        # destination: a NEW dir under the parent; capacity / memory (the job adds the multipart reservations)
        no_symlink_path(a.dest_parent)
        pst = os.stat(a.dest_parent)
        if prod and f"{os.major(pst.st_dev)}:{os.minor(pst.st_dev)}" != PROD["destMajmin"]:
            refuse("destination parent is not on the pinned /vm filesystem")
        v = os.statvfs(a.dest_parent); free = v.f_bavail * v.f_frsize
        need = total + (64 << 20) + (1 << 30) + a.reserve_bytes + a.floor_bytes   # files + overlay cap + r9 work slack + reservations
        out["capacity"] = {"freeBytes": free, "neededBytes": need, "filesBytes": total, "reserveBytes": a.reserve_bytes, "floorBytes": a.floor_bytes}
        if free < need:
            refuse(f"destination free {free} < needed {need}")
        le = lane_errors(own_memory_max(), mem_available(), a.host_mem_floor)
        if le:
            refuse("; ".join(le))
        pre = source_identity(backup, PROD["backupSize"] if prod else None)
        if prod:
            fd_ = os.open(BACKUP_RECEIPT[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                rraw = os.read(fd_, 1 << 16)
            finally:
                os.close(fd_)
            be = backup_binding_errors(pre, rraw)
            if be:
                refuse("; ".join(be))
            out["backupReceiptSha256"] = BACKUP_RECEIPT[1]
        out["sourcePre"] = pre; out["qemuInfo"] = qemu_info(backup, fs_blocks * BLOCK)
        run = os.path.join(a.dest_parent, f"compact-header-extraction-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}")
        os.mkdir(run, 0o700); run_fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for d_ in ("plan", "plan/sources", "session", "ready", "files"):
            os.mkdir(os.path.join(run, d_), 0o700)
        out["runDir"] = run
        target = next(e for e in entries if e["path"] == (PROD["plannedTarget"] if prod else a.view_target))
        plan = zero_patch_plan(fs_blocks, uuid, target, None if prod else a.view_target_sha256)
        Path(run, "plan/plan.json").write_text(json.dumps(plan, indent=1, sort_keys=True))
        plan_sha = sha_file(os.path.join(run, "plan/plan.json"))
        me = sha_file(os.path.realpath(__file__))
        private_copy(R9 / "overlay_session.py", os.path.join(run, "overlay_session.py"), R9_PINS["overlaySession"])
        private_copy(os.path.realpath(__file__), os.path.join(run, "extract.py"), me)
        srun, ready_dir = os.path.join(run, "session"), os.path.join(run, "ready")
        mnt, nbd = os.path.join(srun, "work", "mnt"), os.path.join(srun, "work", "view", "nbd")
        tpath = mnt + "/" + target["path"]
        waiter_argv = [PY3, "-I", "-B", os.path.join(run, "extract.py"), "waiter", "--ready-dir", ready_dir, "--max-wait", str(a.hold_seconds)]
        cmd = [PY3, "-I", "-B", os.path.join(run, "overlay_session.py"), "--plan-dir", os.path.join(run, "plan"), "--plan-sha256", plan_sha,
               "--parent", backup, "--run-dir", srun, "--fuse2fs", fuse2fs, "--fuse2fs-sha256", fuse2fs_sha,
               "--exec-timeout", str(a.hold_seconds + 300)]
        if not prod and a.parent_sha256:
            cmd += ["--parent-sha256", a.parent_sha256]
        if stop():
            raise Stopped("stopped before the session")
        log = open(os.path.join(run, "session.out"), "wb")
        sess = subprocess.Popen(cmd + ["--exec", *waiter_argv], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True, close_fds=True, cwd=run, env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
        log.close()
        rc = 4
        end = time.monotonic() + READY_WAIT
        while not os.path.exists(os.path.join(ready_dir, "READY")):
            if stop():
                raise Stopped("stopped while the session was starting")
            if not child_running(sess.pid) or time.monotonic() > end:
                fail("the session ended or did not become READY (its receipt says why)")
            time.sleep(0.5)
        ready = json.loads(Path(ready_dir, "READY").read_text())
        pfd = verify_ready(ready, sess.pid, waiter_argv, tpath)
        out["view"] = check_view(mnt, nbd, uuid); check_fs_header(nbd, uuid)
        if not os.statvfs(mnt).f_flag & os.ST_RDONLY:
            refuse("the view is not ST_RDONLY")
        root_fd = os.open(mnt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        dest_fd = os.open(os.path.join(run, "files"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            for e in entries:                                        # every entry's metadata first: a mismatch refuses before any copy
                f, st = open_nofollow(root_fd, e["path"])
                os.close(f); check_entry(e, st)
            for e in entries:
                if not alive(pfd) or not child_running(sess.pid) or check_view(mnt, nbd, uuid) != out["view"]:
                    fail("the session, its exec or the view changed during the extraction")
                out["files"].append(copy_one(root_fd, dest_fd, e, stop))
        finally:
            os.close(root_fd); os.close(dest_fd)
        rc = 0
    except (Refuse, Fail, Stopped) as e:
        rc = e.rc; out["error"] = f"{type(e).__name__}: {e}"
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError) as e:
        rc = 4 if sess is not None else 3; out["error"] = f"{type(e).__name__}: {e}"
    finally:
        for sg in old:
            signal.signal(sg, signal.SIG_IGN)
        try:
            if sess is not None:
                with contextlib.suppress(OSError):
                    Path(out["runDir"], "ready", "RELEASE").write_text("release\n")
                rc_s = end_session(sess)
                try:
                    r = json.loads(Path(out["runDir"], "session", "receipt.json").read_text())
                    extra = [n for n in os.listdir(os.path.join(out["runDir"], "session")) if n.startswith("receipt-")]
                    ready_pid = json.loads(Path(out["runDir"], "ready", "READY").read_text()).get("pid") if os.path.exists(os.path.join(out["runDir"], "ready", "READY")) else None
                    reasons = check_receipt(r, plan_sha, waiter_argv, ready_pid) + ([f"extra receipts {extra}"] if extra else [])
                except (OSError, ValueError) as e:
                    reasons = [f"receipt unreadable: {e}"]
                if rc_s != 0:
                    reasons.append(f"session rc {rc_s}")
                post = source_identity(backup, PROD["backupSize"] if prod else None)
                if {k: post[k] for k in ("dev", "ino", "size", "mtimeNs", "ctimeNs")} != {k: pre[k] for k in ("dev", "ino", "size", "mtimeNs", "ctimeNs")}:
                    reasons.append("the backup's identity changed")
                if out["runDir"] in Path("/proc/self/mountinfo").read_text():
                    reasons.append("a mount of this run survived")
                out["sourcePost"], out["session"] = post, {"rc": rc_s, "reasons": reasons}
                if reasons and rc == 0:
                    rc = 4
            if pfd is not None:
                os.close(pfd)
        except BaseException as e:                                   # finalization never escapes; the receipt says why
            out.setdefault("finalizationErrors", []).append(f"{type(e).__name__}: {e}")
            rc = 4 if rc in (0, 5) else rc
        out["rc"] = rc
        out["outcome"] = {0: "CLEAN", 3: "REFUSED", 5: "STOPPED"}.get(rc, "FAILED")
        out["totalBytes"] = sum(f["size"] for f in out["files"])
        written = False
        if run_fd is not None:
            try:
                write_json(run_fd, "EXTRACTION-RECEIPT.json", out); written = True
            except OSError as e:
                print(f"## EXTRACTION-RECEIPT.json could not be written: {e}", file=sys.stderr)
            os.close(run_fd)
            rc = out["rc"] = final_rc(rc, written)                     # r2 (1885 H1): never 0 without the receipt on disk
            out["outcome"] = {0: "CLEAN", 3: "REFUSED", 5: "STOPPED"}.get(rc, "FAILED")
        print(json.dumps({k: out.get(k) for k in ("outcome", "rc", "runDir", "totalBytes", "error", "session")}, default=str))
        for sg, h in old.items():
            signal.signal(sg, h)
    return rc


def end_session(p):
    """bounded; only OUR unreaped child's group is ever signalled (as multipart r3 orchestrate.end_session)"""
    end = time.monotonic() + SESSION_END_WAIT
    while child_running(p.pid) and time.monotonic() < end:
        time.sleep(0.5)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not child_running(p.pid):
            break
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, sig)
        end = time.monotonic() + KILL_WAIT
        while child_running(p.pid) and time.monotonic() < end:
            time.sleep(0.5)
    return p.wait(timeout=KILL_WAIT)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--dest-parent", required=True); r.add_argument("--stage-sums", default="")
    r.add_argument("--request"); r.add_argument("--request-sha256")
    r.add_argument("--reserve-bytes", type=int, default=0); r.add_argument("--floor-bytes", type=int, default=PROD["vmFloor"])
    r.add_argument("--host-mem-floor", type=int, default=PROD["hostMemFloor"]); r.add_argument("--hold-seconds", type=int, default=HOLD_DEFAULT)
    r.add_argument("--fixture", action="store_true")
    for k in ("--backup", "--allowlist", "--uuid", "--fuse2fs", "--fuse2fs-sha256", "--parent-sha256", "--view-target", "--view-target-sha256"):
        r.add_argument(k)
    r.add_argument("--fs-blocks", type=int)
    w = sub.add_parser("waiter"); w.add_argument("--ready-dir", required=True); w.add_argument("--max-wait", type=int, required=True)
    q = sub.add_parser("request", help="print the exact purpose-bound request for root to review, save and sha-pin (writes nothing)")
    q.add_argument("--stage-sums", required=True)
    sp = sub.add_parser("state-pins", help="print the state runner's static-file pins of ONE CLEAN extraction run dir (writes nothing)")
    sp.add_argument("--run-dir", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "state-pins":
        try:
            if not (a.run_dir.startswith(PROD["destParent"] + "/compact-header-extraction-") and os.path.normpath(a.run_dir) == a.run_dir):
                refuse("--run-dir is not a production extraction run dir")
            fd_ = os.open(os.path.join(a.run_dir, "EXTRACTION-RECEIPT.json"), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                raw = os.read(fd_, 4 << 20)
            finally:
                os.close(fd_)
            pins = state_pins(json.loads(raw), a.run_dir)
            pins["extractionReceiptSha256"] = sha_bytes(raw)
            print(json.dumps(pins, indent=1, sort_keys=True)); return 0
        except (Refuse, OSError, ValueError) as e:
            print(f"REFUSED: {e}", file=sys.stderr); return 3
    if a.cmd == "waiter":
        return cmd_waiter(a)
    if a.cmd == "request":
        print(json.dumps(request_for(a.stage_sums), indent=1, sort_keys=True)); return 0
    if not a.fixture and (not a.request or not a.request_sha256 or not a.stage_sums or a.floor_bytes < PROD["vmFloor"]
                          or a.host_mem_floor < PROD["hostMemFloor"]):
        print("REFUSED: production needs --request, --request-sha256, --stage-sums and at least the pinned floors", file=sys.stderr); return 3
    if a.fixture and not all((a.backup, a.allowlist, a.uuid, a.fuse2fs, a.fuse2fs_sha256, a.view_target, a.fs_blocks)):
        print("REFUSED: fixture mode needs --backup --allowlist --uuid --fs-blocks --fuse2fs(+sha) --view-target", file=sys.stderr); return 3
    if a.fixture:                                                       # r2 (1885 M4): fixture mode can never touch production
        why = []
        if os.path.realpath(a.backup) == os.path.realpath(PROD["backup"]) or os.path.basename(a.backup) == os.path.basename(PROD["backup"]):
            why.append("fixture mode must never name the production backup")
        if not (os.path.normpath(a.dest_parent) == a.dest_parent and E2E_DEST_RE.fullmatch(a.dest_parent)):
            why.append(f"fixture dest must lie in a /vm E2E workspace {E2E_PARENT}/compact-header-e2e-<UTC>-<pid>[/x[/y]]")
        if a.floor_bytes < PROD["vmFloor"] or a.host_mem_floor < PROD["hostMemFloor"]:
            why.append("fixture mode uses the same pinned floors")
        if why:
            print("REFUSED: " + "; ".join(why), file=sys.stderr); return 3
    return cmd_run(a)


if __name__ == "__main__":
    sys.exit(main())
