#!/usr/bin/env python3
"""nvme-cold-relocation-stage/relocate.py: reversible relocation of EXACTLY /vm/enclave-volumes/codex-archive and
/vm/enclave-volumes/.pixel10 into an ext4 filesystem image on the USB RAID (ntfs3 would lose modes/owners/exec bits), with
a symlink cut-over only after verification. Stdlib only.

Phases (each refuses unless its prerequisites hold; each is idempotent / resumable from the private journal):
  plan              (DEFAULT, read-only) every check that can be made without writing; prints the next allowed phase
  inventory-source  identity (lstat) + sha256 inventory of a source tree into the journal (resumable hashing)
  prepare-image     create the NEW sparse image file (O_EXCL; never reused) and mkfs.ext4 with pinned label/UUID/inodes/owner
                    (without --execute: prints the exact commands only)
  mount-handoff     writes a pinned, unsigned local sudo script (mount -o loop,nodev,nosuid,noatime); never edits fstab.
                    r2: every value in every generated script is shlex-quoted; no config value appears in a comment
  persistence-handoff  (r2) pinned sudo script installing ONE systemd .mount unit (byte-pinned content) + enable; no fstab edit
  verify-persistence   (r2, read-only) the unit file is root-owned, 0644, byte-identical, enabled; no fstab entry competes.
                    cutover REFUSES until this passed (a transient mount would break the archive/SDK at the next boot)
  verify-mount      (as the owner) checks the mount is the pinned image on a loop device; creates the 0700 target parent
  writer-check      (ROOT ONLY; via the emitted pinned sudo script) bounded /proc scan of every process and thread:
                    fd, cwd, root, exe, maps. Incomplete visibility is a failed check, never a pass
  copy              rsync -aHAX --numeric-ids --one-file-system with an explicit --bwlimit; refuses while the USB device
                    is busy unless --accept-busy-usb is given (journaled); refuses if the /vm guard is near shutdown
  verify            source and destination inventories (type, mode, owner, size, mtime, symlink target, xattrs, hardlink
                    groups, sha256) must be identical; codex-archive also against its pinned relocation manifest
  cutover           needs: verified, a FRESH complete root writer-check with zero hits, source and destination unchanged since
                    verify, and an operator attestation that the tree's users are stopped. rename source -> .retire-<name>,
                    symlink source -> destination, then the 2102 manifest links (and .pixel10 inbound links) must resolve;
                    any failure rolls back automatically
  (r4) every rsync argv is checked at run time (no --del*, --remove-source-files, --force, --inplace, --append*); after each
                    rsync, destination directory mtimes are re-applied from the live source (verify stays strict); relative
                    symlinks escaping a tree are refused (they would break after cut-over)
  rollback          remove only OUR symlink (readlink-checked) and rename .retire-<name> back. r2: REFUSED if the target
                    changed since cut-over (that would silently discard what applications wrote there)
  reverse-copy      (r2) copy the CURRENT target back to <source_parent>/.return-<name> (rsync -aHAX), verify it is identical
                    to the target and that the target did not change meanwhile, checked against the /vm guard; then
                    `rollback --use-return-copy` puts it in place. The retired tree, the target and the return copy all stay
  status            print the journal
There is NO deletion phase. The .retire-<name> trees stay until a SEPARATELY reviewed reclamation with exact verified identity.
A verified copy does not quiesce applications: nothing here claims a generic freeze (see writer-check and cutover).
"""
import argparse, contextlib, fcntl, hashlib, json, os, re, shlex, stat, subprocess, sys, time, uuid

CONFIG_FORMAT = "nvme-cold-relocation-config/v1"
JOURNAL_FORMAT = "nvme-cold-relocation-journal/v1"
TREE_NAMES = ("codex-archive", ".pixel10")
# production pins (CLI): the exact source parent and the guard thresholds this plan was reviewed against
PROD = {"source_parent": "/vm/enclave-volumes", "guard_shutdown_bytes": 468719476736, "guard_floor_bytes": 300000000000}
MAX_PROC_ENTRIES = 4_000_000          # writer-check bound: more fd/maps entries than this = incomplete visibility
CHUNK = 1 << 20
MKFS = "/usr/sbin/mkfs.ext4"


class Refuse(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


# ---------------------------------------------------------------------------------------------------------------- env
class Env:
    """Everything that touches the running system; tests substitute fixtures (no root, no loop devices)."""
    production = True
    proc = "/proc"
    mountinfo = "/proc/self/mountinfo"
    sys_block = "/sys/block"

    def euid(self):
        return os.geteuid()

    def readlink(self, p):
        return os.readlink(p)

    def statvfs(self, p):
        return os.statvfs(p)

    def now(self):
        return time.time()

    def sleep(self, s):
        time.sleep(s)

    def run(self, argv):
        return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True).returncode

    def check_mounts(self, cfg):          # tests replace this (their trees share one filesystem)
        check_mount(cfg["source_mount"], self, cfg["source_parent"])
        check_mount(cfg["usb_mount"], self, os.path.dirname(cfg["image"]["path"]))

    systemd_dir = "/etc/systemd/system"
    fstab = "/etc/fstab"
    root_uid = 0

    def check_target(self, cfg, journal):  # tests replace this (no loop devices)
        return check_target_mount(cfg, self, journal)


# ------------------------------------------------------------------------------------------------------------- config
def _abs(p, what):
    """r2: control characters (incl. newline/NUL/DEL) and backslashes are refused; anything else is allowed and is only ever
    passed to a shell through shlex.quote (generated scripts) or argv lists (subprocess), never interpolated raw."""
    if not isinstance(p, str) or not p.startswith("/") or os.path.normpath(p) != p or any(ord(c) < 0x20 or ord(c) == 0x7f for c in p) or "\\" in p:
        refuse(f"config {what} must be a normalized absolute path without control characters or backslashes: {p!r}")
    return p


UNIT_SAFE = re.compile(r"^/[A-Za-z0-9._/-]+$")       # systemd unit values: no specifiers (%), spaces, quotes or escapes


def canonical_uuid(v):
    try:
        u = uuid.UUID(v)
    except (ValueError, TypeError, AttributeError):
        refuse(f"image uuid {v!r} is not a UUID")
    if str(u) != v:
        refuse(f"image uuid must be in canonical lowercase form {str(u)!r}")
    return v


q = shlex.quote


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def read_text(p, errors="strict"):
    with open(p, encoding="utf-8", errors=errors) as f:
        return f.read()


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# r4: rsync options that delete, move away or overwrite in place are refused at run time, whatever built the argv
def safe_rsync_argv(argv):
    bad = [a for a in argv[1:] if a.startswith("--del") or a.startswith("--max-delete") or a in ("--remove-source-files", "--force", "--inplace", "--append", "--append-verify")]
    if bad:
        refuse(f"refusing a destructive rsync argv {bad}: this tool never deletes or overwrites in place")
    return argv


def _under(child, parent):
    return child == parent or child.startswith(parent.rstrip("/") + "/")


def _int(v, what, minimum=1):
    if not isinstance(v, int) or isinstance(v, bool) or v < minimum:
        refuse(f"config {what} must be an integer >= {minimum} (no default is assumed)")
    return v


def _keys(d, want, what):
    if not isinstance(d, dict) or set(d) != set(want):
        refuse(f"config {what} keys must be exactly {sorted(want)}")


def private_file(path, uid, allow_root=True):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid not in ({uid, 0} if allow_root else {uid}) or st.st_mode & 0o022:
        refuse(f"{path}: must be a regular file owned by uid {uid}, not group/world-writable")
    return st


def load_config(path, env):
    if os.path.islink(path):
        refuse("config must not be a symlink")
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        refuse("config must be a regular file, not group/world-writable")
    cfg = read_json(path)
    _keys(cfg, ["format", "owner_uid", "owner_gid", "source_parent", "trees", "source_mount", "usb_mount", "image", "target_mount",
                "journal_dir", "rsync_path", "copy", "guard", "writer_check_max_age_seconds", "capacity_reserve_bytes", "inode_reserve"], "top level")
    if cfg["format"] != CONFIG_FORMAT:
        refuse("config format")
    _int(cfg["owner_uid"], "owner_uid", 0); _int(cfg["owner_gid"], "owner_gid", 0)
    if st.st_uid not in (cfg["owner_uid"], 0):
        refuse("config must be owned by the configured owner or root")
    sp = _abs(cfg["source_parent"], "source_parent")
    if env.production and sp != PROD["source_parent"]:
        refuse(f"source_parent must be exactly {PROD['source_parent']}")
    if not isinstance(cfg["trees"], list) or [t.get("name") for t in cfg["trees"]] != list(TREE_NAMES):
        refuse(f"trees must be exactly {list(TREE_NAMES)}, in that order")
    for t in cfg["trees"]:
        want = ["name", "source", "manifest"] if t["name"] == "codex-archive" else ["name", "source", "inbound_links"]
        _keys(t, want, f"tree {t['name']}")
        if _abs(t["source"], "tree source") != sp + "/" + t["name"]:
            refuse(f"tree {t['name']} source must be exactly {sp}/{t['name']}")
        if "manifest" in t:
            _keys(t["manifest"], ["path", "sha256", "entries"], "manifest")
            if not _under(_abs(t["manifest"]["path"], "manifest path"), t["source"]):
                refuse("the manifest must live inside codex-archive")
            if not isinstance(t["manifest"]["sha256"], str) or len(t["manifest"]["sha256"]) != 64:
                refuse("manifest sha256 pin")
            _int(t["manifest"]["entries"], "manifest entries")
        else:
            if not isinstance(t["inbound_links"], list):
                refuse("inbound_links must be a list")
            for p in t["inbound_links"]:
                _abs(p, "inbound link")
    for m in ("source_mount", "usb_mount"):
        _keys(cfg[m], ["path", "fstype", "device"], m)
        _abs(cfg[m]["path"], m); _abs(cfg[m]["device"], m + " device")
    if not _under(sp, cfg["source_mount"]["path"]):
        refuse("source_parent must be on source_mount")
    im = cfg["image"]
    _keys(im, ["path", "size_bytes", "inodes", "label", "uuid"], "image")
    _abs(im["path"], "image path"); _int(im["size_bytes"], "image size_bytes"); _int(im["inodes"], "image inodes")
    if not _under(im["path"], cfg["usb_mount"]["path"]) or im["path"] == cfg["usb_mount"]["path"]:
        refuse("the image must be a file on usb_mount")
    if not isinstance(im["label"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,16}", im["label"]):
        refuse("image label must be 1-16 of [A-Za-z0-9_-]")
    canonical_uuid(im["uuid"])
    tm = _abs(cfg["target_mount"], "target_mount")
    cfg["target_parent"] = tm + "/enclave-volumes"
    jd = _abs(cfg["journal_dir"], "journal_dir")
    _abs(cfg["rsync_path"], "rsync_path")
    c = cfg["copy"]
    _keys(c, ["bwlimit_kib", "busy_device_stat", "busy_sample_seconds", "busy_max_write_sectors"], "copy")
    _int(c["bwlimit_kib"], "copy.bwlimit_kib"); _abs(c["busy_device_stat"], "copy.busy_device_stat")
    _int(c["busy_sample_seconds"], "copy.busy_sample_seconds"); _int(c["busy_max_write_sectors"], "copy.busy_max_write_sectors", 0)
    g = cfg["guard"]
    _keys(g, ["status_path", "shutdown_bytes", "floor_bytes"], "guard")
    _abs(g["status_path"], "guard.status_path")
    if env.production and (g["shutdown_bytes"], g["floor_bytes"]) != (PROD["guard_shutdown_bytes"], PROD["guard_floor_bytes"]):
        refuse("guard thresholds differ from the reviewed pins (shutdown 468719476736, floor 300000000000): re-review")
    _int(cfg["writer_check_max_age_seconds"], "writer_check_max_age_seconds")
    _int(cfg["capacity_reserve_bytes"], "capacity_reserve_bytes", 0); _int(cfg["inode_reserve"], "inode_reserve", 0)
    # overlap: sources, target, image, journal must be disjoint
    roots = {"source_parent": sp, "target_mount": tm, "journal_dir": jd, "image": im["path"]}
    for a, pa in roots.items():
        for b, pb in roots.items():
            if a != b and (_under(pa, pb) or _under(pb, pa)):
                refuse(f"overlap: {a} {pa} and {b} {pb}")
    if _under(tm, cfg["source_mount"]["path"]) or _under(tm, cfg["usb_mount"]["path"]):
        refuse("target_mount must be its own mount point, not inside /vm or the USB mount")
    return cfg


# -------------------------------------------------------------------------------------------------------------- mounts
def parse_mountinfo(text):
    out = []
    for line in text.splitlines():
        a, b = line.split(" - ", 1)
        f, g = a.split(), b.split()
        unesc = lambda s: s.encode().decode("unicode_escape")
        out.append({"majmin": f[2], "root": unesc(f[3]), "point": unesc(f[4]), "opts": f[5].split(","),
                    "fstype": g[0], "source": unesc(g[1]), "super": g[2].split(",") if len(g) > 2 else []})
    return out


def mount_of(path, env):
    ents = parse_mountinfo(read_text(env.mountinfo))
    best = None
    for e in ents:
        if _under(path, e["point"]) and (best is None or len(e["point"]) >= len(best["point"])):
            best = e
    return best


def check_mount(pin, env, inside):
    e = mount_of(inside, env)
    if not e or e["point"] != pin["path"] or e["fstype"] != pin["fstype"] or e["source"] != pin["device"]:
        refuse(f"{inside}: expected mount {pin['path']} ({pin['fstype']} on {pin['device']}), found "
               f"{e and (e['point'], e['fstype'], e['source'])}")
    return e


def no_symlink_components(path):
    cur = "/"
    for part in [p for p in path.split("/") if p]:
        cur = os.path.join(cur, part)
        st = os.lstat(cur)
        if stat.S_ISLNK(st.st_mode):
            refuse(f"symlink in path: {cur}")
    return True


def read_ext4_superblock(image):
    with open(image, "rb") as f:
        f.seek(1024)
        sb = f.read(1024)
    if len(sb) < 136 or int.from_bytes(sb[56:58], "little") != 0xEF53:
        refuse(f"{image}: no ext4 superblock")
    u = sb[104:120].hex()
    return {"uuid": f"{u[0:8]}-{u[8:12]}-{u[12:16]}-{u[16:20]}-{u[20:32]}", "label": sb[120:136].rstrip(b"\0").decode("utf-8", "replace")}


def check_target_mount(cfg, env, journal):
    """The target is mounted, ext4, on a loop device whose backing file is the journaled image (same inode), with the
    pinned UUID/label, nodev+nosuid; the mount point is the configured path and not reached through a symlink."""
    tm, im = cfg["target_mount"], cfg["image"]
    no_symlink_components(tm)
    e = mount_of(tm, env)
    if not e or e["point"] != tm or e["fstype"] != "ext4":
        refuse(f"{tm} is not mounted as ext4 (unmounted target)")
    if not e["source"].startswith("/dev/loop"):
        refuse(f"{tm} is mounted from {e['source']}, not a loop device")
    for o in ("nodev", "nosuid"):
        if o not in e["opts"]:
            refuse(f"{tm} must be mounted {o}")
    backing = read_text(os.path.join(env.sys_block, os.path.basename(e["source"]), "loop", "backing_file")).strip()
    if backing != im["path"]:
        refuse(f"loop backing file {backing!r} is not the configured image")
    ident = journal.state.get("image")
    st = os.stat(im["path"])
    if not ident or (st.st_dev, st.st_ino) != (ident["dev"], ident["ino"]):
        refuse("the image file is not the one this journal created (reused or replaced image)")
    sb = read_ext4_superblock(im["path"])
    if sb["uuid"] != im["uuid"] or sb["label"] != im["label"]:
        refuse(f"image superblock {sb} does not carry the pinned UUID/label")
    if os.stat(tm).st_dev == os.stat(cfg["source_parent"]).st_dev:
        refuse("target and source are the same filesystem")
    return e


# ------------------------------------------------------------------------------------------------------------- journal
class Journal:
    def __init__(self, cfg, env, create=False):
        self.dir, self.uid = cfg["journal_dir"], cfg["owner_uid"]
        if not os.path.lexists(self.dir):
            if not create:
                self.state = {"format": JOURNAL_FORMAT, "trees": {}}
                self.readonly = True
                return
            os.mkdir(self.dir, 0o700)
        st = os.lstat(self.dir)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != self.uid or st.st_mode & 0o077:
            refuse(f"journal {self.dir} must be a 0700 directory owned by uid {self.uid} (not a symlink)")
        self.readonly = not create
        p = os.path.join(self.dir, "state.json")
        if os.path.lexists(p):
            private_file(p, self.uid, allow_root=False)
            self.state = read_json(p)
            if self.state.get("format") != JOURNAL_FORMAT:
                refuse("journal format")
        else:
            self.state = {"format": JOURNAL_FORMAT, "trees": {}}

    @contextlib.contextmanager
    def locked(self):
        fd = os.open(os.path.join(self.dir, "lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if os.geteuid() == 0:                            # root writer-check: never leave root-owned journal files
            os.fchown(fd, self.uid, -1)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                refuse("another relocate.py holds the journal lock")
            yield self
        finally:
            os.close(fd)

    def path(self, name):
        return os.path.join(self.dir, name)

    def write_atomic(self, name, text):
        p = self.path(name); tmp = p + ".tmp"
        fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text); f.flush(); os.fsync(f.fileno())
        os.rename(tmp, p)
        dfd = os.open(self.dir, os.O_RDONLY); os.fsync(dfd); os.close(dfd)

    def save(self):
        self.write_atomic("state.json", json.dumps(self.state, indent=1, sort_keys=True))

    def event(self, **kw):
        kw["t"] = time.time()
        fd = os.open(self.path("events.jsonl"), os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(json.dumps(kw, sort_keys=True) + "\n"); f.flush(); os.fsync(f.fileno())

    def tree(self, name):
        return self.state["trees"].setdefault(name, {})


# ----------------------------------------------------------------------------------------------------------- inventory
def _xattrs(p):
    try:
        names = sorted(os.listxattr(p, follow_symlinks=False))
    except OSError:
        return []
    return [[n, hashlib.sha256(os.getxattr(p, n, follow_symlinks=False)).hexdigest()] for n in names]


def walk_meta(root):
    """Deterministic lstat inventory (never follows symlinks, never crosses filesystems). -> list of records."""
    no_symlink_components(root)
    rst = os.lstat(root)
    if not stat.S_ISDIR(rst.st_mode):
        refuse(f"{root} is not a directory")
    recs, inodes, stack = [], {}, [""]
    while stack:
        rel = stack.pop()
        full = os.path.join(root, rel) if rel else root
        st = os.lstat(full)
        if st.st_dev != rst.st_dev:
            refuse(f"mount point inside the tree: {full}")
        m = st.st_mode
        # the top directory's own ctime is excluded: renaming it (cut-over/rollback) changes nothing inside
        r = {"p": rel, "m": stat.S_IMODE(m), "u": st.st_uid, "g": st.st_gid, "x": _xattrs(full),
             "id": [st.st_dev, st.st_ino, st.st_ctime_ns if rel else 0]}
        if stat.S_ISDIR(m):
            r.update(t="d", mt=st.st_mtime_ns)
            names = sorted(os.listdir(full), reverse=True)
            stack.extend(os.path.join(rel, n) if rel else n for n in names)
        elif stat.S_ISREG(m):
            r.update(t="f", s=st.st_size, mt=st.st_mtime_ns, nl=st.st_nlink)
            key = (st.st_dev, st.st_ino)
            if st.st_nlink > 1:
                first = inodes.setdefault(key, [rel, 0, st.st_nlink])
                first[1] += 1
                r["h"] = first[0]
        elif stat.S_ISLNK(m):
            r.update(t="l", l=os.readlink(full))
            # r4: after cut-over the tree is reached through ONE symlink and physically lives on the image; a relative link
            # whose ".." leaves the tree root would then resolve from the new location and break (absolute links still work)
            if not r["l"].startswith("/"):
                res = os.path.normpath(os.path.join(os.path.dirname(rel), r["l"]))
                if res == ".." or res.startswith("../"):
                    refuse(f"relative symlink escapes the tree and would break after cut-over: {full} -> {r['l']}")
        else:
            refuse(f"unsupported file type (fifo/socket/device) in tree: {full}")
        recs.append(r)
    for first, count, nl in inodes.values():
        if count != nl:
            refuse(f"external hardlink: {first} has {nl} links but {count} inside the tree")
    recs.sort(key=lambda x: x["p"])
    return recs


def logical(recs, hashes):
    """The comparable view: no device/inode/ctime/nlink; hardlink groups by first path; sha256 for files."""
    out = []
    for r in recs:
        x = {k: r[k] for k in ("p", "t", "m", "u", "g", "x") if k in r}
        for k in ("s", "mt", "l", "h"):
            if k in r:
                x[k] = r[k]
        if r["t"] == "f":
            x["sha256"] = hashes[r["p"]]
        out.append(x)
    return out


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def hash_files(root, recs, cache_path, journal):
    """sha256 of every regular file; resumable: a cached line is reused only if (size, mtime_ns, dev, ino, ctime_ns) match.
    Every file is re-lstat'ed after hashing: a change during hashing refuses."""
    cache = {}
    if os.path.exists(cache_path):
        for line in read_text(cache_path).splitlines():            # one JSON array per line: names may contain tabs/newlines
            with contextlib.suppress(ValueError):  # a torn last line (crash mid-write) is simply re-hashed
                k, v = json.loads(line)
                cache[k] = v
    fd = os.open(cache_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    hashes, done, reused = {}, 0, 0
    with os.fdopen(fd, "a") as out:
        for r in recs:
            if r["t"] != "f":
                continue
            ident = [r["s"], r["mt"]] + r["id"]
            c = cache.get(r["p"])
            if c and c["ident"] == ident:
                hashes[r["p"]] = c["sha256"]; reused += 1
                continue
            h = hashlib.sha256()
            full = os.path.join(root, r["p"])
            fdr = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fdr, "rb") as f:
                for b in iter(lambda: f.read(CHUNK), b""):
                    h.update(b)
            st = os.lstat(full)
            if [st.st_size, st.st_mtime_ns, st.st_dev, st.st_ino, st.st_ctime_ns] != ident:
                refuse(f"changed while hashing: {full}")
            hashes[r["p"]] = h.hexdigest()
            out.write(json.dumps([r["p"], {"ident": ident, "sha256": hashes[r["p"]]}]) + "\n")
            done += 1
            if done % 256 == 0:
                out.flush(); os.fsync(out.fileno())
        out.flush(); os.fsync(out.fileno())
    return hashes, {"hashed": done, "reused": reused}


def inventory(root, side, name, journal):
    recs = walk_meta(root)
    tag = f"{side}-{name.lstrip('.')}"
    hashes, counts = hash_files(root, recs, journal.path(tag + ".hashcache.tsv"), journal)
    log = logical(recs, hashes)
    journal.write_atomic(tag + ".meta.json", json.dumps(recs))
    journal.write_atomic(tag + ".logical.json", json.dumps(log))
    return {"identity": digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs]),
            "logical": digest(log), "entries": len(recs), "counts": counts,
            "bytes": sum(r["s"] for r in recs if r["t"] == "f" and ("h" not in r or r["h"] == r["p"]))}


def identity_now(root):
    recs = walk_meta(root)
    return digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs])


def required_bytes(journal, name, block=4096):
    recs = read_json(journal.path(f"source-{name.lstrip('.')}.meta.json"))
    total = 0
    for r in recs:
        if r["t"] == "f" and ("h" not in r or r["h"] == r["p"]):
            total += -(-r["s"] // block) * block
        elif r["t"] == "d":
            total += block
        elif r["t"] == "l" and len(r["l"]) >= 60:
            total += block
    return total, len(recs)


# ------------------------------------------------------------------------------------------------------- manifest/links
def check_manifest(tree, base=None):
    """Every manifest source is a symlink that resolves exactly to its destination inside codex-archive (or, after
    cut-over, to the same relative path under `base`), and the destination exists."""
    m = tree["manifest"]
    raw = read_bytes(m["path"]) if base is None else read_bytes(os.path.join(base, os.path.relpath(m["path"], tree["source"])))
    if hashlib.sha256(raw).hexdigest() != m["sha256"]:
        refuse("relocation manifest sha256 differs from the pin (mismatched manifest)")
    ents = json.loads(raw)
    if not isinstance(ents, list) or len(ents) != m["entries"]:
        refuse(f"relocation manifest must have exactly {m['entries']} entries")
    bad = []
    for e in ents:
        src, dst = e.get("source"), e.get("destination")
        if not isinstance(src, str) or not isinstance(dst, str) or not _under(dst, tree["source"]):
            refuse("manifest entry shape")
        want = dst if base is None else os.path.join(base, os.path.relpath(dst, tree["source"]))
        if not os.path.islink(src) or os.path.realpath(src) != want or not os.path.exists(src):
            bad.append(src)
    if bad:
        refuse(f"{len(bad)} manifest symlinks do not resolve as required, first: {bad[0]}")
    return len(ents)


def check_inbound(tree, base=None):
    for p in tree.get("inbound_links", []):
        rp = os.path.realpath(p)
        want_root = tree["source"] if base is None else base
        if not os.path.islink(p) or not _under(rp, want_root) or not os.path.exists(p):
            refuse(f"inbound link {p} does not resolve into {want_root}")
    return len(tree.get("inbound_links", []))


# ------------------------------------------------------------------------------------------------------- writer check
def scan_proc(prefixes, env):
    """Bounded scan of /proc (no filesystem walk): per process and per thread: cwd, root, exe; per process: every fd link
    and every mapped path. Any unreadable entry of a live process = incomplete visibility."""
    hits, incomplete, seen = [], [], 0
    def under_any(p):
        p = p.split(" (deleted)")[0]
        return any(_under(p, x) for x in prefixes)
    for pid in sorted(os.listdir(env.proc)):
        if not pid.isdigit():
            continue
        base = os.path.join(env.proc, pid)
        try:
            links = [os.path.join(base, n) for n in ("cwd", "root", "exe")]
            tdir = os.path.join(base, "task")
            if os.path.isdir(tdir):
                for tid in os.listdir(tdir):
                    links += [os.path.join(tdir, tid, "cwd"), os.path.join(tdir, tid, "root")]
            fdd = os.path.join(base, "fd")
            links += [os.path.join(fdd, n) for n in os.listdir(fdd)]
            for l in links:
                seen += 1
                try:
                    t = env.readlink(l)
                except FileNotFoundError:
                    continue
                if under_any(t):
                    hits.append([pid, l, t])
            with open(os.path.join(base, "maps")) as mf:
                for line in mf:
                    seen += 1
                    parts = line.split(None, 5)
                    if len(parts) == 6 and under_any(parts[5].strip()):
                        hits.append([pid, "maps", parts[5].strip()])
        except FileNotFoundError:
            continue                                   # the process exited during the scan
        except PermissionError as e:
            incomplete.append([pid, str(e)])
        if seen > MAX_PROC_ENTRIES:
            incomplete.append(["*", f"more than {MAX_PROC_ENTRIES} entries"])
            break
    # kernel-held users have no process fd: loop devices backed by a file in the trees, and swap files
    try:
        for dev in sorted(os.listdir(env.sys_block)):
            bf = os.path.join(env.sys_block, dev, "loop", "backing_file")
            if dev.startswith("loop") and os.path.exists(bf) and under_any(read_text(bf).strip()):
                hits.append(["kernel", dev, read_text(bf).strip()])
        swaps = os.path.join(env.proc, "swaps")
        if os.path.exists(swaps):
            for line in read_text(swaps).splitlines()[1:]:
                if line.split() and under_any(line.split()[0]):
                    hits.append(["kernel", "swap", line.split()[0]])
    except PermissionError as e:
        incomplete.append(["kernel", str(e)])
    return {"hits": hits, "incomplete": incomplete, "entries": seen, "complete": not incomplete}


# ----------------------------------------------------------------------------------------------------------- phases
def tree_cfg(cfg, name):
    for t in cfg["trees"]:
        if t["name"] == name:
            return t
    refuse(f"unknown tree {name!r}; only {list(TREE_NAMES)}")


def dest_of(cfg, name):
    return cfg["target_parent"] + "/" + name


def retire_of(cfg, name):
    return cfg["source_parent"] + "/.retire-" + name.lstrip(".")


def guard_status(cfg, env):
    try:
        g = read_json(cfg["guard"]["status_path"])
        th, free = g["thresholds"]["nvme"], g["free"]["nvme"]
    except (OSError, KeyError, TypeError, ValueError) as e:
        refuse(f"guard status unreadable ({e}): not proceeding without the live guard view")
    if (th["shutdown"], th["floor"]) != (cfg["guard"]["shutdown_bytes"], cfg["guard"]["floor_bytes"]):
        refuse("the live guard thresholds differ from the pinned ones: re-review before any phase")
    return {"free": free, "shutdown": th["shutdown"], "floor": th["floor"], "state": g.get("state")}


def phase_plan(cfg, env, journal):
    rep = {"checks": [], "notes": []}
    ok = lambda s: rep["checks"].append(s)
    env.check_mounts(cfg); ok("source and USB mounts are the pinned devices")
    no_symlink_components(cfg["source_parent"]); ok("no symlink in the source parent path")
    gs = guard_status(cfg, env); ok(f"guard thresholds pinned; /vm free {gs['free']} vs shutdown {gs['shutdown']}")
    for t in cfg["trees"]:
        src, name = t["source"], t["name"]
        ts = journal.state["trees"].get(name, {})
        if ts.get("cutover") == "complete":
            ok(f"{name}: cut over (source is a symlink to {dest_of(cfg, name)})"); continue
        no_symlink_components(src)
        st = os.lstat(src)
        if st.st_uid != cfg["owner_uid"]:
            refuse(f"{src} is not owned by uid {cfg['owner_uid']}")
        if os.path.lexists(retire_of(cfg, name)):
            refuse(f"{retire_of(cfg, name)} already exists")
        if "manifest" in t:
            ok(f"{name}: {check_manifest(t)} manifest symlinks resolve into the archive")
        else:
            ok(f"{name}: {check_inbound(t)} inbound links resolve")
    us = env.statvfs(cfg["usb_mount"]["path"])
    usb_free = us.f_bavail * us.f_frsize
    if not journal.state.get("image"):
        if os.path.lexists(cfg["image"]["path"]):
            refuse("the image path already exists but this journal did not create it (reused image)")
        if usb_free < cfg["image"]["size_bytes"] + cfg["capacity_reserve_bytes"]:
            refuse(f"USB free {usb_free} < image size + reserve")
    ok(f"USB free {usb_free}")
    vis = scan_proc([t["source"] for t in cfg["trees"]], env)
    rep["notes"].append(f"as uid {env.euid()}: /proc visibility complete={vis['complete']} hits={len(vis['hits'])} "
                        "(informational; only the root writer-check counts)")
    rep["next"] = next_phase(cfg, journal)
    return rep


def next_phase(cfg, journal):
    s = journal.state
    for t in cfg["trees"]:
        if "source_inventory" not in s["trees"].get(t["name"], {}):
            return f"inventory-source --tree {t['name']}"
    if "image" not in s or not s["image"].get("formatted"):
        return "prepare-image"
    if not s.get("mount_verified"):
        return "mount-handoff, then verify-mount"
    for t in cfg["trees"]:
        ts = s["trees"][t["name"]]
        if ts.get("copy") != "done":
            return f"copy --tree {t['name']}"
        if "verified" not in ts:
            return f"verify --tree {t['name']}"
    if not s.get("persistence_verified"):
        return "persistence-handoff (sudo script), then verify-persistence"
    for t in cfg["trees"]:
        if s["trees"][t["name"]].get("cutover") != "complete":
            return f"writer-check (root), then cutover --tree {t['name']}"
    return "none (hold period; reclamation is NOT part of this tool)"


def phase_inventory_source(cfg, env, journal, name):
    t = tree_cfg(cfg, name)
    if journal.tree(name).get("cutover") in ("renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg)
    inv = inventory(t["source"], "source", name, journal)
    journal.tree(name)["source_inventory"] = inv
    journal.event(phase="inventory-source", tree=name, logical=inv["logical"], identity=inv["identity"])
    journal.save()
    return inv


def phase_prepare_image(cfg, env, journal, execute):
    im = cfg["image"]
    s = journal.state
    if s.get("image", {}).get("formatted"):
        sb = read_ext4_superblock(im["path"])
        st = os.stat(im["path"])
        if (st.st_dev, st.st_ino) != (s["image"]["dev"], s["image"]["ino"]) or sb["uuid"] != im["uuid"]:
            refuse("journaled image identity differs (reused/replaced image)")
        return {"already": True}
    need, entries = 0, 0
    for t in cfg["trees"]:
        if "source_inventory" not in journal.tree(t["name"]):
            refuse(f"inventory-source --tree {t['name']} first (capacity is computed from it, never assumed)")
        b, n = required_bytes(journal, t["name"]); need += b; entries += n
    if im["inodes"] < entries + cfg["inode_reserve"]:
        refuse(f"image inodes {im['inodes']} < {entries} entries + inode_reserve")
    # ext4 metadata (inode tables) is charged against the image too
    if im["size_bytes"] < need + im["inodes"] * 256 + cfg["capacity_reserve_bytes"]:
        refuse(f"image size {im['size_bytes']} < data {need} + inode tables + reserve (insufficient capacity)")
    us = env.statvfs(cfg["usb_mount"]["path"])
    if us.f_bavail * us.f_frsize < im["size_bytes"] + cfg["capacity_reserve_bytes"]:
        refuse("USB free space < image size + reserve")
    parent = os.path.dirname(im["path"])
    mkfs = [MKFS, "-q", "-L", im["label"], "-U", im["uuid"], "-N", str(im["inodes"]), "-m", "0",
            "-E", f"nodiscard,root_owner={cfg['owner_uid']}:{cfg['owner_gid']}", im["path"]]
    plan = {"create": f"O_EXCL new file {im['path']}, ftruncate {im['size_bytes']} (sparse)", "mkfs": mkfs}
    if not execute:
        plan["note"] = "dry run: re-run with --execute"
        return plan
    if s.get("image") and not s["image"].get("formatted"):
        refuse("a previous prepare-image stopped after creating the file: inspect it; the tool never reuses or deletes it")
    if os.path.lexists(im["path"]):
        refuse("image path exists (never reused)")
    if not os.path.isdir(parent):
        os.mkdir(parent, 0o700)
    fd = os.open(im["path"], os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.ftruncate(fd, im["size_bytes"]); os.fsync(fd)
    st = os.fstat(fd); os.close(fd)
    s["image"] = {"dev": st.st_dev, "ino": st.st_ino, "size": im["size_bytes"], "formatted": False}
    journal.event(phase="prepare-image", step="created", dev=st.st_dev, ino=st.st_ino); journal.save()
    if env.run(mkfs) != 0:
        refuse("mkfs.ext4 failed; the created file is left for inspection (never deleted by this tool)")
    sb = read_ext4_superblock(im["path"])
    if sb["uuid"] != im["uuid"] or sb["label"] != im["label"]:
        refuse("formatted image does not carry the pinned UUID/label")
    s["image"]["formatted"] = True
    journal.event(phase="prepare-image", step="formatted", uuid=sb["uuid"]); journal.save()
    return {"created": True}


def tool_sha():
    return hashlib.sha256(read_bytes(os.path.abspath(__file__))).hexdigest()


def phase_mount_handoff(cfg, env, journal, config_path):
    s, im, tm = journal.state, cfg["image"], cfg["target_mount"]
    if not s.get("image", {}).get("formatted"):
        refuse("prepare-image --execute first")
    me, cp = os.path.abspath(__file__), os.path.abspath(config_path)
    ino = str(int(s["image"]["ino"]))
    script = f"""#!/bin/bash
# nvme-cold-relocation r2: mount handoff (UNSIGNED local sudo script; review, then run: sudo bash <this file>).
# Every value below is shell-quoted; the pins are the assignments. It mounts ONLY: no copy, move, delete or fstab edit.
set -euo pipefail
IMAGE={q(im['path'])}
TARGET={q(tm)}
WANT_INO={q(ino)}
WANT_UUID={q(canonical_uuid(im['uuid']))}
[ "$(id -u)" = 0 ] || {{ printf '%s\\n' 'run with sudo'; exit 2; }}
[ "$(stat -c %i -- "$IMAGE")" = "$WANT_INO" ] || {{ printf '%s\\n' 'image inode differs from the journal'; exit 3; }}
[ "$(blkid -p -s UUID -o value -- "$IMAGE")" = "$WANT_UUID" ] || {{ printf '%s\\n' 'image UUID differs'; exit 3; }}
if mountpoint -q -- "$TARGET"; then printf '%s\\n' 'target is already a mount point: refusing'; exit 4; fi
if [ -L "$TARGET" ]; then printf '%s\\n' 'target is a symlink: refusing'; exit 4; fi
install -d -m 0755 -o root -g root -- "$TARGET"
mount -t ext4 -o loop,noatime,nodev,nosuid -- "$IMAGE" "$TARGET"
printf '%s\\n' 'mounted; next, as the owner:' {q(f"python3 -I {q(me)} verify-mount --config {q(cp)}")}
"""
    journal.write_atomic("mount-handoff.sh", script)
    journal.event(phase="mount-handoff", script=digest(script)); journal.save()
    return {"script": journal.path("mount-handoff.sh")}


def systemd_escape_path(p):
    """systemd-escape --path (for the strict UNIT_SAFE charset): "/mnt/vm-cold" -> "mnt-vm\\x2dcold"."""
    out = []
    for i, part in enumerate(p.strip("/").split("/")):
        if i:
            out.append("-")
        for j, c in enumerate(part):
            out.append(c if (c.isascii() and (c.isalnum() or c in "_.") and not (i == 0 and j == 0 and c == ".")) else "\\x%02x" % ord(c))
    return "".join(out) or "-"


def persistence_unit(cfg):
    im, tm, usb = cfg["image"]["path"], cfg["target_mount"], cfg["usb_mount"]["path"]
    for v in (im, tm, usb):
        if not UNIT_SAFE.fullmatch(v):
            refuse(f"persistence needs conservative path characters [A-Za-z0-9._/-] for the unit values: {v!r}")
    name = systemd_escape_path(tm) + ".mount"
    text = ("# nvme-cold-relocation r2 persistence unit (generated; verify-persistence checks it byte-for-byte)\n"
            "[Unit]\nDescription=nvme-cold-relocation ext4 image (codex-archive, .pixel10)\n"
            f"RequiresMountsFor={usb}\n\n[Mount]\nWhat={im}\nWhere={tm}\nType=ext4\nOptions=loop,noatime,nodev,nosuid\n\n"
            "[Install]\nWantedBy=multi-user.target\n")
    return name, text


def phase_persistence_handoff(cfg, env, journal, config_path):
    if not journal.state.get("mount_verified"):
        refuse("verify-mount first (the unit must describe the mount that was verified)")
    name, text = persistence_unit(cfg)
    unit = os.path.join(env.systemd_dir, name)
    sha = hashlib.sha256(text.encode()).hexdigest()
    me, cp = os.path.abspath(__file__), os.path.abspath(config_path)
    script = f"""#!/bin/bash
# nvme-cold-relocation r2: persistence handoff (UNSIGNED local sudo script; review, then run: sudo bash <this file>).
# Installs ONE systemd mount unit with byte-pinned content and enables it. It does not edit /etc/fstab, start, stop or
# remount anything, and refuses if fstab already names the target or a different unit file exists.
set -euo pipefail
UNIT={q(unit)}
UNIT_NAME={q(name)}
TARGET={q(cfg['target_mount'])}
FSTAB={q(env.fstab)}
WANT_SHA={q(sha)}
[ "$(id -u)" = 0 ] || {{ printf '%s\\n' 'run with sudo'; exit 2; }}
if awk -v t="$TARGET" '$1 !~ /^#/ && $2 == t {{ found = 1 }} END {{ exit !found }}' "$FSTAB"; then
  printf '%s\\n' 'fstab already has an entry for the target: refusing (one persistence mechanism only)'; exit 4; fi
TMP=$(mktemp)
trap 'rm -f -- "$TMP"' EXIT
cat > "$TMP" <<'NVME_COLD_RELOCATION_UNIT'
{text}NVME_COLD_RELOCATION_UNIT
printf '%s  %s\\n' "$WANT_SHA" "$TMP" | sha256sum -c --quiet
if [ -e "$UNIT" ] || [ -L "$UNIT" ]; then
  cmp -s -- "$TMP" "$UNIT" || {{ printf '%s\\n' 'a different unit file already exists: refusing'; exit 4; }}
else
  install -m 0644 -o root -g root -- "$TMP" "$UNIT"
fi
systemctl daemon-reload
systemctl enable -- "$UNIT_NAME"
printf '%s\\n' 'enabled (not restarted); next, as the owner:' {q(f"python3 -I {q(me)} verify-persistence --config {q(cp)}")}
"""
    journal.write_atomic("persistence-handoff.sh", script)
    journal.event(phase="persistence-handoff", unit=name, sha256=sha); journal.save()
    return {"script": journal.path("persistence-handoff.sh"), "unit": unit, "sha256": sha}


def check_persistence(cfg, env):
    """Read-only: the durable mount configuration exists exactly as generated and is enabled; nothing else mounts the target."""
    name, text = persistence_unit(cfg)
    unit = os.path.join(env.systemd_dir, name)
    try:
        st = os.lstat(unit)
    except FileNotFoundError:
        refuse(f"no persistent mount unit {unit}: run persistence-handoff.sh first (cut-over needs a durable mount)")
    if not stat.S_ISREG(st.st_mode) or st.st_uid != env.root_uid or st.st_mode & 0o022:
        refuse(f"{unit} must be a root-owned regular file, not group/world-writable")
    if read_bytes(unit) != text.encode():
        refuse(f"{unit} differs from the generated unit")
    wants = os.path.join(env.systemd_dir, "multi-user.target.wants", name)
    if not os.path.islink(wants) or os.path.realpath(wants) != os.path.realpath(unit):
        refuse(f"{name} is not enabled ({wants} must link to {unit})")
    for line in read_text(env.fstab, errors="replace").splitlines():
        f = line.split()
        if f and not f[0].startswith("#") and len(f) > 1 and f[1] == cfg["target_mount"]:
            refuse("/etc/fstab also names the target: one persistence mechanism only")
    return {"unit": unit, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def phase_verify_persistence(cfg, env, journal):
    env.check_target(cfg, journal)
    res = check_persistence(cfg, env)
    journal.state["persistence_verified"] = res
    journal.event(phase="verify-persistence", **res); journal.save()
    return res


def phase_verify_mount(cfg, env, journal):
    env.check_target(cfg, journal)
    tp = cfg["target_parent"]
    st = os.lstat(cfg["target_mount"])
    if st.st_uid != cfg["owner_uid"]:
        refuse("the image root is not owned by the owner (mkfs root_owner)")
    if not os.path.lexists(tp):
        os.mkdir(tp, 0o700)
    st = os.lstat(tp)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != cfg["owner_uid"] or stat.S_IMODE(st.st_mode) != 0o700:
        refuse(f"{tp} must be a 0700 directory owned by the owner")
    journal.state["mount_verified"] = {"dev": os.stat(cfg["target_mount"]).st_dev}
    journal.event(phase="verify-mount"); journal.save()
    return {"target_parent": tp}


def phase_writer_check(cfg, env, journal, emit=False, config_path=None):
    if emit:
        me, cp = os.path.abspath(__file__), os.path.abspath(config_path)
        script = f"""#!/bin/bash
# nvme-cold-relocation r2: root writer-check (UNSIGNED local sudo script; review, then: sudo bash <this file>).
# Runs ONLY the reviewed tool (sha256 pinned) in its read-only writer-check phase; writes one 0600 result into the journal.
set -euo pipefail
TOOL={q(me)}
CONFIG={q(cp)}
WANT_SHA={q(tool_sha())}
[ "$(id -u)" = 0 ] || {{ printf '%s\\n' 'run with sudo'; exit 2; }}
printf '%s  %s\\n' "$WANT_SHA" "$TOOL" | sha256sum -c --quiet
exec python3 -I "$TOOL" writer-check --config "$CONFIG"
"""
        journal.write_atomic("writer-check.sh", script)
        return {"script": journal.path("writer-check.sh")}
    if env.euid() != 0:
        refuse("writer-check must run as root (complete /proc visibility); use the emitted writer-check.sh")
    prefixes = []
    for t in cfg["trees"]:
        prefixes += [os.path.realpath(t["source"]), retire_of(cfg, t["name"]), dest_of(cfg, t["name"]), return_of(cfg, t["name"])]
    res = scan_proc(sorted(set(prefixes)), env)
    res.update(t=env.now(), prefixes=sorted(set(prefixes)))
    journal.write_atomic("writer-check.json", json.dumps(res))
    with contextlib.suppress(PermissionError):
        os.chown(journal.path("writer-check.json"), cfg["owner_uid"], cfg["owner_gid"])
        os.chown(journal.path("events.jsonl"), cfg["owner_uid"], cfg["owner_gid"]) if os.path.exists(journal.path("events.jsonl")) else None
    return {"complete": res["complete"], "hits": len(res["hits"]), "entries": res["entries"]}


def usb_busy(cfg, env):
    c = cfg["copy"]
    def writes():
        return int(read_text(c["busy_device_stat"]).split()[6])       # field 7: sectors written
    a = writes(); env.sleep(c["busy_sample_seconds"]); b = writes()
    return b - a


def restore_dir_mtimes(src_root, dst_root):
    """r4: root's runs 1302/1303 showed the pinned rsync 3.4.1 (-aHAX, this argv) leaving every DESTINATION DIRECTORY mtime at
    copy time while files, modes, links and xattrs matched (cause under root diagnosis: jobs/rsync-dir-mtime-diagnostic.py).
    Directory mtimes are therefore re-applied from the LIVE source after each rsync: lstat only, never following symlinks,
    only onto destination directories. verify still compares every mtime strictly; nothing is relaxed."""
    no_symlink_components(dst_root)
    rst = os.lstat(src_root)
    dirs, stack = [], [""]
    while stack:
        rel = stack.pop()
        sp = os.path.join(src_root, rel) if rel else src_root
        st = os.lstat(sp)
        if not stat.S_ISDIR(st.st_mode) or st.st_dev != rst.st_dev:
            continue
        dirs.append((rel, st.st_mtime_ns))
        for n in os.listdir(sp):
            if stat.S_ISDIR(os.lstat(os.path.join(sp, n)).st_mode):
                stack.append(os.path.join(rel, n) if rel else n)
    for rel, mt in sorted(dirs, key=lambda d: -d[0].count("/")):
        dp = os.path.join(dst_root, rel) if rel else dst_root
        dst = os.lstat(dp)
        if not stat.S_ISDIR(dst.st_mode):
            refuse(f"destination {dp} is not a directory: the copy is incomplete")
        os.utime(dp, ns=(dst.st_atime_ns, mt), follow_symlinks=False)
    return len(dirs)


def phase_copy(cfg, env, journal, name, accept_busy=False):
    t = tree_cfg(cfg, name)
    ts = journal.tree(name)
    if "source_inventory" not in ts:
        refuse("inventory-source first")
    if not journal.state.get("mount_verified"):
        refuse("verify-mount first")
    if ts.get("cutover") in ("renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); env.check_target(cfg, journal)
    gs = guard_status(cfg, env)
    if gs["free"] <= gs["shutdown"]:
        refuse("the /vm guard is at/below its shutdown threshold: resolve that first")
    delta = usb_busy(cfg, env)
    if delta > cfg["copy"]["busy_max_write_sectors"]:
        if not accept_busy:
            refuse(f"USB device busy ({delta} sectors written in {cfg['copy']['busy_sample_seconds']} s > "
                   f"{cfg['copy']['busy_max_write_sectors']}): not starting (operator flag --accept-busy-usb to override)")
        journal.event(phase="copy", tree=name, busy_override=delta)
    need, _ = required_bytes(journal, name)
    vs = env.statvfs(cfg["target_mount"])
    avail = vs.f_bavail * vs.f_frsize
    if ts.get("copy") is None and avail < need + cfg["capacity_reserve_bytes"]:
        refuse(f"target free {avail} < {need} + reserve (insufficient capacity)")
    argv = [cfg["rsync_path"], "-aHAX", "--numeric-ids", "--one-file-system", "--protect-args",
            f"--bwlimit={cfg['copy']['bwlimit_kib']}", t["source"], cfg["target_parent"] + "/"]
    safe_rsync_argv(argv)
    ts["copy"] = "running"; journal.event(phase="copy", tree=name, argv=argv); journal.save()
    rc = env.run(argv)
    if rc == 0:
        n = restore_dir_mtimes(t["source"], dest_of(cfg, name))
        journal.event(phase="copy", tree=name, dir_mtimes_restored=n)
    ts["copy"] = "done" if rc == 0 else "failed"
    ts.pop("verified", None)
    journal.event(phase="copy", tree=name, rc=rc); journal.save()
    if rc != 0:
        refuse(f"rsync rc {rc}: copy is resumable (re-run copy); nothing was deleted")
    return {"rc": rc}


def phase_verify(cfg, env, journal, name):
    t = tree_cfg(cfg, name)
    ts = journal.tree(name)
    if ts.get("copy") != "done":
        refuse("copy first")
    if ts.get("cutover") in ("renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); env.check_target(cfg, journal)
    src = inventory(t["source"], "source", name, journal)
    dst = inventory(dest_of(cfg, name), "dest", name, journal)
    if src["logical"] != dst["logical"]:
        a = read_json(journal.path(f"source-{name.lstrip('.')}.logical.json"))
        b = read_json(journal.path(f"dest-{name.lstrip('.')}.logical.json"))
        diff = [x for x in a if x not in b][:20] + [["dest-only", x] for x in b if x not in a][:20]
        journal.write_atomic(f"verify-diff-{name.lstrip('.')}.json", json.dumps(diff))
        ts.pop("verified", None); journal.event(phase="verify", tree=name, ok=False); journal.save()
        refuse(f"destination differs from source ({len(diff)} differences listed in the journal)")
    if "manifest" in t:      # the archive's own pinned manifest, against the DESTINATION copy
        m = read_json(os.path.join(dest_of(cfg, name), os.path.relpath(t["manifest"]["path"], t["source"])))
        hashes = {x["p"]: x for x in read_json(journal.path(f"dest-{name.lstrip('.')}.logical.json")) if x["t"] == "f"}
        for e in m:
            x = hashes.get(os.path.relpath(e["destination"], t["source"]))
            if not x or x["sha256"] != e["sha256"] or x["s"] != e["bytes"]:
                refuse(f"destination does not match the relocation manifest at {e['destination']}")
    ts["source_inventory"] = src
    ts["verified"] = {"source_identity": src["identity"], "dest_identity": dst["identity"], "logical": src["logical"], "t": env.now()}
    journal.event(phase="verify", tree=name, ok=True, logical=src["logical"]); journal.save()
    return ts["verified"]


def require_fresh_writer_check(cfg, env, journal, path):
    wc_path = journal.path("writer-check.json")
    if not os.path.exists(wc_path):
        refuse("no root writer-check result: run writer-check.sh (root) right before this phase")
    wst = os.lstat(wc_path)
    if wst.st_uid not in (cfg["owner_uid"], 0) or wst.st_mode & 0o077:
        refuse("writer-check result must be private (0600)")
    wc = read_json(wc_path)
    if not wc["complete"]:
        refuse(f"writer-check visibility was incomplete ({len(wc['incomplete'])} processes unreadable): not proof of no writers")
    if wc["hits"]:
        refuse(f"active users of the trees: {wc['hits'][:3]}")
    if env.now() - wc["t"] > cfg["writer_check_max_age_seconds"] or path not in wc["prefixes"]:
        refuse("writer-check result is stale or not for this tree: re-run it")


def require_attestation(attest):
    if not attest or len(attest.strip()) < 8:
        refuse("--apps-stopped-attestation is required: name what was stopped/held for this tree (no generic freeze exists)")


def return_of(cfg, name):
    return cfg["source_parent"] + "/.return-" + name.lstrip(".")


def phase_cutover(cfg, env, journal, name, attest):
    t = tree_cfg(cfg, name)
    ts = journal.tree(name)
    src, dst, ret = t["source"], dest_of(cfg, name), retire_of(cfg, name)
    if ts.get("cutover") == "complete":
        post_cutover_checks(cfg, t)
        return {"already": True}
    if "verified" not in ts:
        refuse("verify first")
    require_attestation(attest)
    env.check_mounts(cfg); env.check_target(cfg, journal)
    if not journal.state.get("persistence_verified"):
        refuse("no verified persistent mount configuration: persistence-handoff.sh + verify-persistence first "
               "(cut-over onto a transient mount would break the archive/SDK at the next boot)")
    check_persistence(cfg, env)                         # still in place, byte-identical and enabled right now
    if ts.get("cutover") == "renaming":                  # crashed between the intent record and/or the rename itself
        if not os.path.lexists(src) and os.path.isdir(ret):
            ts["cutover"] = "renamed"; journal.event(phase="cutover", tree=name, step="renamed-recovered"); journal.save()
        elif os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret):
            ts.pop("cutover"); journal.save()
        else:
            refuse("inconsistent cut-over state after a crash: manual review")
    if ts.get("cutover") != "renamed":
        require_fresh_writer_check(cfg, env, journal, os.path.realpath(src))
        if identity_now(src) != ts["verified"]["source_identity"]:
            refuse("source changed after verify (new writer?): copy + verify again")
        if identity_now(dst) != ts["verified"]["dest_identity"]:
            refuse("destination changed after verify")
        if os.path.lexists(ret):
            refuse(f"{ret} exists")
        ts["cutover"] = "renaming"; ts["attestation"] = attest
        journal.event(phase="cutover", tree=name, step="rename-intent", attest=attest); journal.save()
        os.rename(src, ret)
        ts["cutover"] = "renamed"; journal.event(phase="cutover", tree=name, step="renamed"); journal.save()
    if not os.path.lexists(src):
        os.symlink(dst, src)
    try:
        if os.readlink(src) != dst:
            refuse(f"{src} exists and is not our symlink")
        post_cutover_checks(cfg, t)
    except Exception as e:
        journal.event(phase="cutover", tree=name, step="post-check-failed", error=str(e)); journal.save()
        phase_rollback(cfg, env, journal, name)
        refuse(f"post-cutover check failed and was rolled back: {e}")
    ts["cutover"] = "complete"
    ts["dest_identity_at_cutover"] = identity_now(dst)  # rollback refuses if the target differs from this later
    journal.event(phase="cutover", tree=name, step="complete"); journal.save()
    return {"cutover": "complete", "retired": ret}


def post_cutover_checks(cfg, t):
    src, dst = t["source"], dest_of(cfg, t["name"])
    if os.readlink(src) != dst or os.path.realpath(src) != dst:
        refuse("the source path does not resolve to the destination")
    ret_mode = stat.S_IMODE(os.lstat(retire_of(cfg, t["name"])).st_mode)
    if stat.S_IMODE(os.stat(dst).st_mode) != ret_mode:
        refuse("destination top-level mode differs from the source's")
    if "manifest" in t:
        check_manifest(t, base=dst)
    else:
        check_inbound(t, base=dst)


def _our_symlink(src, dst):
    if os.path.islink(src):
        if os.readlink(src) != dst:
            refuse(f"{src} is a symlink but not ours: manual review")
        return True
    if os.path.lexists(src):
        refuse(f"{src} exists and is not our symlink: manual review")
    return False


def phase_rollback(cfg, env, journal, name, use_return=False):
    t = tree_cfg(cfg, name)
    ts = journal.tree(name)
    src, dst, ret = t["source"], dest_of(cfg, name), retire_of(cfg, name)
    if os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret) and not use_return:
        ts.pop("cutover", None); journal.save()
        return {"already": "source is in place"}
    if use_return:
        rc, rcopy = ts.get("return_copy") or {}, return_of(cfg, name)
        if rc.get("state") != "verified" or not os.path.isdir(rcopy) or os.path.islink(rcopy):
            refuse("no verified return copy: reverse-copy first")
        if identity_now(rcopy) != rc["identity"]:
            refuse("the return copy changed after its verification")
        if identity_now(dst) != rc["dest_identity"]:
            refuse("the target changed after the reverse copy: reverse-copy again (users must stay stopped)")
        if _our_symlink(src, dst):
            journal.event(phase="rollback", tree=name, step="unlink-our-symlink", via="return-copy"); journal.save()
            os.unlink(src)                               # the ONLY unlink in this tool: our own verified symlink
        os.rename(rcopy, src)
        ts.pop("cutover", None); ts.pop("verified", None); ts["copy"] = None
        rc["state"] = "restored"
        journal.event(phase="rollback", tree=name, step="restored-return-copy", retired_kept=ret, target_kept=dst); journal.save()
        return {"rolled_back": "return-copy", "kept": [ret, dst]}
    if not (os.path.isdir(ret) and not os.path.islink(ret)):
        refuse(f"{ret} is missing: manual review (nothing changed)")
    if os.path.lexists(dst):
        base = ts.get("dest_identity_at_cutover") or (ts.get("verified") or {}).get("dest_identity")
        if base is None or identity_now(dst) != base:
            refuse("the target changed since cut-over (applications wrote through the symlink): switching back to the retired "
                   "tree would discard those changes. Stop the users, writer-check, reverse-copy, then rollback --use-return-copy")
    if _our_symlink(src, dst):
        journal.event(phase="rollback", tree=name, step="unlink-our-symlink"); journal.save()
        os.unlink(src)
    os.rename(ret, src)
    ts.pop("cutover", None)
    journal.event(phase="rollback", tree=name, step="restored"); journal.save()
    return {"rolled_back": True}


def phase_reverse_copy(cfg, env, journal, name, attest):
    """Copy the CURRENT target back onto /vm as .return-<name> and verify it; nothing is removed or switched here."""
    t = tree_cfg(cfg, name)
    ts = journal.tree(name)
    src, dst, rcopy = t["source"], dest_of(cfg, name), return_of(cfg, name)
    if ts.get("cutover") != "complete":
        refuse("reverse-copy is only for a completed cut-over (otherwise use rollback)")
    rc = ts.get("return_copy") or {}
    if rc.get("state") == "verified" and identity_now(dst) == rc["dest_identity"]:
        return {"already": rcopy}
    # a target that changed after an earlier return copy is re-synced INTO that (our own) copy; never with --delete: if
    # something was removed from the target the verification below fails and the copy is kept for inspection
    require_attestation(attest)
    env.check_mounts(cfg); env.check_target(cfg, journal)
    require_fresh_writer_check(cfg, env, journal, dst)
    if os.path.lexists(rcopy) and rc.get("state") not in ("copying", "failed", "verified"):
        refuse(f"{rcopy} exists and is not this journal's return copy")
    recs = walk_meta(dst)
    need = sum(-(-r["s"] // 4096) * 4096 for r in recs if r["t"] == "f" and ("h" not in r or r["h"] == r["p"])) + 4096 * len(recs)
    gs = guard_status(cfg, env)
    if gs["free"] - need <= gs["shutdown"] + cfg["capacity_reserve_bytes"]:
        refuse(f"a {need}-byte return copy would take /vm to the guard shutdown threshold (+reserve): not starting")
    before = identity_now(dst)
    ts["return_copy"] = {"state": "copying"}; journal.event(phase="reverse-copy", tree=name, need=need); journal.save()
    argv = [cfg["rsync_path"], "-aHAX", "--numeric-ids", "--one-file-system", "--protect-args",
            f"--bwlimit={cfg['copy']['bwlimit_kib']}", dst + "/", rcopy + "/"]
    rcode = env.run(safe_rsync_argv(argv))
    if rcode == 0:
        journal.event(phase="reverse-copy", tree=name, dir_mtimes_restored=restore_dir_mtimes(dst, rcopy))
    if rcode != 0:
        ts["return_copy"] = {"state": "failed"}; journal.event(phase="reverse-copy", tree=name, rc=rcode); journal.save()
        refuse(f"rsync rc {rcode}: the return copy is incomplete (kept; re-run reverse-copy)")
    a = inventory(dst, "dest", name, journal)
    b = inventory(rcopy, "return", name, journal)
    if a["logical"] != b["logical"]:
        ts["return_copy"] = {"state": "failed"}; journal.save()
        refuse("the return copy differs from the target (kept for inspection)")
    if a["identity"] != before:
        ts["return_copy"] = {"state": "failed"}; journal.save()
        refuse("the target changed during the reverse copy: users are not stopped")
    ts["return_copy"] = {"state": "verified", "identity": b["identity"], "dest_identity": a["identity"], "logical": a["logical"]}
    journal.event(phase="reverse-copy", tree=name, ok=True); journal.save()
    return {"return_copy": rcopy, "verified": True}


# ---------------------------------------------------------------------------------------------------------------- CLI
def main(argv=None, env=None):
    env = env or Env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", nargs="?", default="plan", choices=["plan", "status", "inventory-source", "prepare-image", "mount-handoff",
                    "verify-mount", "persistence-handoff", "verify-persistence", "writer-check", "emit-writer-check", "copy", "verify",
                    "cutover", "rollback", "reverse-copy"])
    ap.add_argument("--config", required=True)
    ap.add_argument("--tree")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--accept-busy-usb", action="store_true")
    ap.add_argument("--apps-stopped-attestation")
    ap.add_argument("--use-return-copy", action="store_true")
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config, env)
        if a.phase not in ("writer-check",) and env.euid() == 0 and env.production:
            refuse("run as the owner, not root (only writer-check runs as root)")
        if a.phase in ("plan", "status"):
            j = Journal(cfg, env, create=False)
            out = j.state if a.phase == "status" else phase_plan(cfg, env, j)
        else:
            j = Journal(cfg, env, create=True)
            with j.locked():
                if a.phase == "inventory-source": out = phase_inventory_source(cfg, env, j, a.tree)
                elif a.phase == "prepare-image": out = phase_prepare_image(cfg, env, j, a.execute)
                elif a.phase == "mount-handoff": out = phase_mount_handoff(cfg, env, j, a.config)
                elif a.phase == "verify-mount": out = phase_verify_mount(cfg, env, j)
                elif a.phase == "persistence-handoff": out = phase_persistence_handoff(cfg, env, j, a.config)
                elif a.phase == "verify-persistence": out = phase_verify_persistence(cfg, env, j)
                elif a.phase == "writer-check": out = phase_writer_check(cfg, env, j)
                elif a.phase == "emit-writer-check": out = phase_writer_check(cfg, env, j, emit=True, config_path=a.config)
                elif a.phase == "copy": out = phase_copy(cfg, env, j, a.tree, a.accept_busy_usb)
                elif a.phase == "verify": out = phase_verify(cfg, env, j, a.tree)
                elif a.phase == "cutover": out = phase_cutover(cfg, env, j, a.tree, a.apps_stopped_attestation)
                elif a.phase == "rollback": out = phase_rollback(cfg, env, j, a.tree, a.use_return_copy)
                elif a.phase == "reverse-copy": out = phase_reverse_copy(cfg, env, j, a.tree, a.apps_stopped_attestation)
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
