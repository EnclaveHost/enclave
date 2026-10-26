#!/usr/bin/env python3
"""nvme-cold-relocation-stage/r10 subtree.py (r9 + r9 review B1, B2, G1-G3: no-follow staging, no-follow fd walk, overlay layers,
per-thread mount namespaces, unknown fanotify mount marks; targets carry the top inode).
r9 (r8 + review R1-R3: staged root execution, bounded no-follow reads, dev+inode scanner).
r8 (r7 + review C1-C4, W1-W3: resume/recovery, read-only root scanner, verified-bytes load): reversible relocation of EXACTLY three closed codex-archive subtrees
  2026-10-24/home/{hf-convert,gvs5h,gguf-e2b}  from /vm (ext4 on /dev/mapper/cryptvm)
  to /home/steven/.cold-archive/codex-archive/<same relative path>  on / (ext4 on /dev/mapper/cryptroot),
with a directory-symlink cut-over that keeps every original path (and the archive manifest's home links) resolving.

A NEW mode beside the unchanged USB-image tool: relocate.py here is byte-identical to frozen r5 (sha256 pinned below) and is
only imported for its reviewed primitives (walk_meta, hash_files, logical, digest, scan_proc, restore_dir_mtimes,
safe_rsync_argv, Journal, check_mount, required_bytes, identity_now). Stdlib only. Phases (owner, never root,
except writer-check):
  plan                read-only: pinned mounts, private destination, capacity (/ keeps >= dest_floor_bytes AFTER every remaining
                      copy), manifest links of each subtree resolve into /vm, informational /proc view, /vm free from statvfs
                      (INFORMATIONAL: this mode only reads /vm until cut-over, so a low /vm is not a reason to refuse relief)
  inventory-source    metadata walk; sha256 REUSED from root's 1381 archive inventory ONLY if that journal is provably 1381
                      (its meta/logical digests equal the pinned identity/logical) AND every record of the subtree (path, type,
                      mode, owner, xattrs, size, mtime, dev, inode, ctime, link target) is identical now; otherwise refuses
                      unless --fresh-hash (full re-hash of that subtree). No partial / generic stale-hash reuse.
  copy                inside root's queue lane only (cgroup memory.max == queue_lane_bytes; the queue's memory guard enforces
                      the 16 GiB host floor every 250 ms and kills the job tree, rsync included), MemAvailable >= 16 GiB at
                      start, ALL subtrees inventoried, source identity unchanged since inventory, / avail - EVERY remaining
                      copy >= dest_floor_bytes, destination + journal proven on the pinned / filesystem (never on /vm);
                      rsync -aHAX --numeric-ids --one-file-system --bwlimit (<= 200 MiB/s) into the 0700 tree.
                      r7: the stopped RPC VM's guard-status.json (no thresholds, stale free) is NOT read: this mode writes only
                      to / and does not relax the production VM prepare/controller/guard thresholds, which keep their own checks
  verify              fresh sha256 of the DESTINATION; source identity must still equal the inventoried one (so its hashes are
                      exact); logical source == destination; each manifest entry's sha256/bytes match the destination
  writer-check        (ROOT, only via the FROZEN jobs/root-writer-check.sh, which pins this stage's exact sha256 of subtree.py and
                      relocate.py, runs root-owned copies with python3 -I -B): complete /proc scan, JSON on STDOUT ONLY. Root opens
                      no journal, takes no lock, writes and chowns nothing (r8 W1). emit-writer-check is gone (r8 W3).
  record-writer-check (owner) --result FILE: validates that JSON (format, euid 0, both tool shas = these files) into the journal
  r8 resume/recovery: every copy attempt re-checks the / floor against the FULL remaining need (C1); a failed verify marks the
                      copy failed and the next copy runs rsync --checksum (C2); re-inventory keeps this journal's own destination
                      (failed + --checksum) and still never adopts an unknown pre-existing directory (C3); rsync stderr tail kept (C4)
  cutover             fresh complete zero-hit writer-check, attestation, identities unchanged since verify; rename source ->
                      .retire-<name> (same directory), symlink source -> destination, post-checks (manifest links resolve
                      into the destination, top mode equal); any failure rolls back automatically
  rollback            remove only OUR symlink (readlink-checked) and rename .retire-<name> back; refuses if the destination
                      changed since cut-over (writes through the symlink)
There is NO deletion phase: /vm space is freed only by a SEPARATELY reviewed reclamation of the .retire-* trees.

r9 (r8 review R1-R3; journal, phases and config template unchanged, so r7/r8 journals continue):
  R1  root never executes a uid-1000 file: the fixed `sudo bash -c` wrapper in README stages subtree.py, relocate.py and
      jobs/root-writer-check.sh by a bounded read into a NEW root-owned 0700 /run/nvme-cold-wc9.* dir, sha256-verifies ALL
      THREE against pins written in the wrapper text, and only then runs the staged job, which takes the staged dir as an argument
  R2  config, writer-check result and journal writer-check.json are opened component by component with O_NOFOLLOW (+O_NONBLOCK),
      must be regular, owner/root-owned, not group/world-writable, <= a size bound, and are parsed from that fd (typed refusal)
  R3  writer-check identifies users by (st_dev, st_ino) of every entry of the source, .retire-* and destination trees across
      /proc/PID/{cwd,root,exe}, per-thread cwd/root, every fd (fdinfo mnt_id+ino; bounded stat fallback), per-thread fd tables
      that are not shared, maps dev+inode, inotify/fanotify marks, loop backing files and swap files - not only path strings;
      it reads every visible mount namespace's mountinfo and reports mount aliases that expose a source/.retire tree at another
      path (blocking) or a destination tree (informational); unreadable entries, hung stats, a non-initial PID namespace, mount
      namespaces held without a process and the entry bound all make the scan incomplete (complete=false blocks cut-over)

r10 (r9 review; journal, phases, config template, copy/inventory/verify unchanged; result keys unchanged, format .../r10):
  B1  the README wrapper stages with `dd iflag=nofollow,nonblock` (root never opens a symlinked or FIFO stage file)
  B2  walk_ids: explicit fd-relative walk; every subdirectory opened O_DIRECTORY|O_NOFOLLOW relative to its parent and
      fstat-compared with its lstat (dev, ino); any listing/open error or replacement is a problem (incomplete), never skipped
  G1  an overlay mount in any visible namespace whose layer is at/under/above a target, or not verifiable by path, is incomplete
  G2  a thread in its own mount namespace adds that namespace's mountinfo (aliases, mount ids)
  G3  a fanotify mount mark on a mount in no visible namespace is incomplete
  each `dir` target carries `ino` (the tree top's st_ino) for binding; r8 and r9 results are refused by record and cut-over
"""
import argparse, errno, hashlib, json, os, re, stat, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
R5_RELOCATE_SHA256 = "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0"


def _load_relocate():
    """r8 W2: execute EXACTLY the verified bytes (compile + exec); never the import system, which would prefer a matching
    __pycache__/*.pyc that nobody verified"""
    import types
    p = os.path.join(HERE, "relocate.py")
    with open(p, "rb") as f:
        b = f.read()
    if hashlib.sha256(b).hexdigest() != R5_RELOCATE_SHA256:
        raise SystemExit("relocate.py beside subtree.py is not the frozen r5 bytes")
    m = types.ModuleType("relocate_r5"); m.__file__ = p
    exec(compile(b, p, "exec", dont_inherit=True), m.__dict__)
    return m


R = _load_relocate()
Refuse, refuse = R.Refuse, R.refuse
FORMAT, JMODE = "nvme-cold-subtree-config/v1", "subtree-r6"
GIB = 1 << 30
HOST_FLOOR = 16 * GIB
PROD = {"archive_root": "/vm/enclave-volumes/codex-archive",
        "subtrees": ["2026-10-24/home/hf-convert", "2026-10-24/home/gvs5h", "2026-10-24/home/gguf-e2b"],
        "dest_root": "/home/steven/.cold-archive/codex-archive",
        "source_mount": {"path": "/vm", "fstype": "ext4", "device": "/dev/mapper/cryptvm"},
        "dest_mount": {"path": "/", "fstype": "ext4", "device": "/dev/mapper/cryptroot"},
        "dest_floor_min_bytes": 300000000000, "bwlimit_max_kib": 204800,                  # 200 MiB/s
        "manifest": {"path": "/vm/enclave-volumes/codex-archive/2026-10-24/recovery-documents/artifact-relocation-manifest.json",
                     "sha256": "77b5cf1ce8e9f53a2333e4c6895b918b16a861b8a5e38908fa8cc15b19a8b493", "entries": 2102},
        "inventory_1381": {"identity": "d3f4775fc09ae7f0df6c6b2ce3d846cb439e737718fc8fe2125ba065cd27f4e2",
                           "logical": "fb369205b3b1962d4bd14eb46e829e51d1d1db0c5486c93ae50e5e215518d26e"}}


CONFIG_MAX, RESULT_MAX, PROC_FILE_MAX = 64 << 10, 32 << 20, 1 << 20
MAX_TARGET_ENTRIES, MAX_HITS, MAX_TIMEOUTS = 2_000_000, 1000, 16      # ~250 B per target id: <= ~0.5 GB under the 1 GiB scope
JOB = "jobs/root-writer-check.sh"
TOOLS = ("subtree.py", "relocate.py", JOB)


# ------------------------------------------------------------------------------------------------- bounded no-follow reads (R2)
def open_nofollow(path, flags):
    """open `path` race-free: each directory component relative to its parent with O_NOFOLLOW|O_DIRECTORY, the last with
    O_NOFOLLOW; a symlink anywhere fails (ENOTDIR/ELOOP) instead of being followed"""
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        refuse("path must be absolute")
    parts = [p for p in path.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        refuse("path must be normalized")
    dflags = getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", dflags)
    try:
        for p in parts[:-1]:
            nfd = os.open(p, dflags, dir_fd=fd)
            os.close(fd); fd = nfd
        return os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
    finally:
        os.close(fd)


def read_bounded(path, cap, what, uids=None):
    """(fstat, bytes) of a regular, not group/world-writable file of <= cap bytes, read from the no-follow fd (never by path
    again). O_NONBLOCK: a FIFO cannot block the open. Messages never carry file content."""
    try:
        fd = open_nofollow(os.path.abspath(path), os.O_RDONLY | os.O_NONBLOCK)
    except OSError as e:
        refuse(f"{what}: cannot open without following a symlink ({e.strerror})")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            refuse(f"{what} must be a regular file (not a symlink, FIFO, device or directory)")
        if st.st_mode & 0o022:
            refuse(f"{what} must not be group/world-writable")
        if uids is not None and st.st_uid not in uids:
            refuse(f"{what} must be owned by uid {sorted(uids)}")
        if st.st_size > cap:
            refuse(f"{what} is larger than {cap} bytes")
        chunks, n = [], 0
        while True:
            b = os.read(fd, min(65536, cap + 1 - n))
            if not b:
                break
            chunks.append(b); n += len(b)
            if n > cap:
                refuse(f"{what} grew beyond {cap} bytes while being read")
        return st, b"".join(chunks)
    finally:
        os.close(fd)


def parse_json(raw, what):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        refuse(f"{what} is not valid UTF-8 JSON")


def _stat_bounded(p, timeout, fn=os.stat):
    """os.stat (follows /proc magic links) in a helper thread: a hung filesystem (FUSE, NFS) cannot stall the scan forever"""
    box = {}

    def run():
        try:
            box["st"] = fn(p)
        except BaseException as e:      # noqa: BLE001 - re-raised in the caller's thread
            box["err"] = e
    th = threading.Thread(target=run, daemon=True); th.start(); th.join(timeout)
    if th.is_alive():
        raise TimeoutError(errno.ETIMEDOUT, "stat timed out")
    if "err" in box:
        raise box["err"]
    return box["st"]


_KCMP = {"x86_64": 312, "aarch64": 272}
_LIBC = []


class Env(R.Env):
    meminfo = "/proc/meminfo"
    stat_timeout = 5.0

    # r9 scanner hooks (tests substitute fixtures)
    def pids(self):
        return sorted((n for n in os.listdir(self.proc) if n.isdigit()), key=int)

    def listdir(self, p):
        return os.listdir(p)

    def read_proc(self, p, cap=PROC_FILE_MAX):
        with open(p, "rb") as f:
            b = f.read(cap + 1)
        if len(b) > cap:
            raise OSError(errno.EFBIG, f"more than {cap} bytes")
        return b.decode("utf-8", "surrogateescape")

    def open_lines(self, p):
        return open(p, encoding="utf-8", errors="surrogateescape")

    def stat_link(self, p):
        return _stat_bounded(p, self.stat_timeout)

    def real_dev(self, p):
        return os.stat(existing_ancestor(p)).st_dev

    def same_files(self, pid, tid):
        """kcmp(KCMP_FILES): True if the thread shares the process's fd table; None if unknown (then it is scanned too)"""
        nr = _KCMP.get(os.uname().machine)
        if nr is None:
            return None
        try:
            import ctypes
            if not _LIBC:
                _LIBC.append(ctypes.CDLL(None, use_errno=True))
            L = ctypes.c_long
            r = _LIBC[0].syscall(L(nr), L(int(pid)), L(int(tid)), L(2), L(0), L(0))
        except (OSError, AttributeError, ValueError):
            return None
        return None if r < 0 else r == 0

    def check_mounts(self, cfg):
        R.check_mount(cfg["source_mount"], self, cfg["archive_root"])
        R.check_mount(cfg["dest_mount"], self, existing_ancestor(cfg["dest_root"]))
        R.check_mount(cfg["dest_mount"], self, existing_ancestor(cfg["journal_dir"]))     # r7: the journal is on / too

    def dev_of(self, p):
        return os.stat(existing_ancestor(p)).st_dev

    def run_tail(self, argv):
        """rc and the last 4 KiB of stderr (journalled; C4). rsync is bounded by --bwlimit, not by a timeout (local copy)"""
        import subprocess
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return r.returncode, r.stderr[-4096:].decode("utf-8", "replace")

    def cgroup_max(self):
        rel = [l for l in R.read_text("/proc/self/cgroup").splitlines() if l.startswith("0::")][0][3:]
        return R.read_text(f"/sys/fs/cgroup{rel}/memory.max").strip()

    def mem_available(self):
        for l in R.read_text(self.meminfo).splitlines():
            if l.startswith("MemAvailable:"):
                return int(l.split()[1]) * 1024
        refuse("MemAvailable unreadable (fail closed)")


# ------------------------------------------------------------------------------------------------------------- config
def load_config(path, env):
    st, raw = read_bounded(path, CONFIG_MAX, "config")          # r9 R2: no-follow fd, regular, <= 64 KiB, parsed from that fd
    cfg = parse_json(raw, "config")
    R._keys(cfg, ["format", "owner_uid", "owner_gid", "archive_root", "subtrees", "dest_root", "source_mount", "dest_mount", "manifest",
                  "inventory_1381", "journal_dir", "rsync_path", "bwlimit_kib", "queue_lane_bytes", "dest_floor_bytes",
                  "writer_check_max_age_seconds"], "top level")
    if cfg["format"] != FORMAT:
        refuse("config format")
    R._int(cfg["owner_uid"], "owner_uid", 0); R._int(cfg["owner_gid"], "owner_gid", 0)
    if st.st_uid not in (cfg["owner_uid"], 0):                  # the uid of the file that was actually read (fstat)
        refuse("config must be owned by the configured owner or root")
    for k in ("archive_root", "dest_root", "journal_dir", "rsync_path"):
        R._abs(cfg[k], k)
    if not isinstance(cfg["subtrees"], list) or not cfg["subtrees"] or len(set(cfg["subtrees"])) != len(cfg["subtrees"]):
        refuse("subtrees must be a non-empty list of distinct relative paths")
    for s in cfg["subtrees"]:
        if not isinstance(s, str) or s.startswith("/") or os.path.normpath(s) != s or ".." in s.split("/") or not s:
            refuse(f"subtree {s!r} must be a normalized relative path inside the archive")
    for a in cfg["subtrees"]:
        for b in cfg["subtrees"]:
            if a != b and R._under(a, b):
                refuse("subtrees must not nest")
    for m in ("source_mount", "dest_mount"):
        R._keys(cfg[m], ["path", "fstype", "device"], m); R._abs(cfg[m]["path"], m); R._abs(cfg[m]["device"], m + " device")
        if cfg[m]["fstype"] != "ext4":
            refuse(f"{m} must be ext4 (metadata-exact; ntfs3/USB is the r5 image mode, not this one)")
    R._keys(cfg["manifest"], ["path", "sha256", "entries"], "manifest"); R._int(cfg["manifest"]["entries"], "manifest entries")
    R._keys(cfg["inventory_1381"], ["journal_dir", "identity", "logical"], "inventory_1381"); R._abs(cfg["inventory_1381"]["journal_dir"], "1381 journal")
    R._int(cfg["bwlimit_kib"], "bwlimit_kib"); R._int(cfg["queue_lane_bytes"], "queue_lane_bytes")
    R._int(cfg["dest_floor_bytes"], "dest_floor_bytes"); R._int(cfg["writer_check_max_age_seconds"], "writer_check_max_age_seconds")
    if cfg["bwlimit_kib"] > PROD["bwlimit_max_kib"]:
        refuse(f"bwlimit_kib {cfg['bwlimit_kib']} > {PROD['bwlimit_max_kib']} (200 MiB/s maximum)")
    if env.production:
        for k in ("archive_root", "subtrees", "dest_root", "source_mount", "dest_mount", "manifest"):
            if cfg[k] != PROD[k]:
                refuse(f"{k} differs from the reviewed pin {PROD[k]!r}")
        if {k: cfg["inventory_1381"][k] for k in ("identity", "logical")} != PROD["inventory_1381"]:
            refuse("inventory_1381 identity/logical differ from root 1381's pinned output")
        if cfg["dest_floor_bytes"] < PROD["dest_floor_min_bytes"]:
            refuse("dest_floor_bytes must be >= 300000000000 (/ keeps its 300 GB operational floor)")
    if not R._under(cfg["archive_root"], cfg["source_mount"]["path"]) or R._under(cfg["dest_root"], cfg["archive_root"]) \
            or R._under(cfg["archive_root"], cfg["dest_root"]) or R._under(cfg["journal_dir"], cfg["archive_root"]) \
            or R._under(cfg["journal_dir"], cfg["dest_root"]):
        refuse("archive_root, dest_root and journal_dir must be disjoint (archive on source_mount)")
    if cfg["journal_dir"] == cfg["inventory_1381"]["journal_dir"]:
        refuse("the subtree journal must not be root's 1381 (r5) journal")
    return cfg


def existing_ancestor(p):
    while not os.path.lexists(p):
        p = os.path.dirname(p)
    return p


def name_of(rel):
    return os.path.basename(rel)


def src_of(cfg, rel):
    return cfg["archive_root"] + "/" + rel


def dest_of(cfg, rel):
    return cfg["dest_root"] + "/" + rel


def retire_of(cfg, rel):
    return os.path.dirname(src_of(cfg, rel)) + "/.retire-" + name_of(rel)


def pick(cfg, rel):
    if rel not in cfg["subtrees"]:
        refuse(f"unknown subtree {rel!r}; only {cfg['subtrees']}")
    return rel


def open_journal(cfg, env, create):
    j = R.Journal(cfg, env, create=create)
    mode = j.state.get("mode")
    if j.state["trees"] and mode != JMODE or mode not in (None, JMODE):
        refuse("this journal is not a subtree-r6 journal (never mix with the r5 image journal)")
    j.state["mode"] = JMODE
    return j


# ------------------------------------------------------------------------------------------------------------- checks
def private_dest(cfg, create=False):
    """dest_root's ancestors are real directories (no symlinks); <home>/.cold-archive and everything below it on the path to
    each destination parent is a 0700 directory owned by the owner. With create=True, missing ones are made 0700."""
    top = os.path.dirname(cfg["dest_root"])                 # /home/steven/.cold-archive
    R.no_symlink_components(existing_ancestor(top))
    chain = [top, cfg["dest_root"]]
    for rel in cfg["subtrees"]:
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            chain.append(cfg["dest_root"] + "/" + "/".join(parts[:i]))
    for d in dict.fromkeys(chain):
        if not os.path.lexists(d):
            if not create:
                continue
            os.mkdir(d, 0o700)
        st = os.lstat(d)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != cfg["owner_uid"] or stat.S_IMODE(st.st_mode) != 0o700:
            refuse(f"{d} must be a 0700 directory owned by uid {cfg['owner_uid']} (private destination)")
    return True


def writes_on_dest(cfg, env):
    """r7: every path this mode writes before cut-over (destination tree, journal incl. hash caches, writer-check result, rsync
    temp files which rsync creates inside the destination directory) is on the destination filesystem, never on the source"""
    src_dev, dest_dev = env.dev_of(cfg["archive_root"]), env.dev_of(cfg["dest_root"])
    if dest_dev == src_dev:
        refuse("the destination is on the SOURCE filesystem: refused (relief must write only to /)")
    if env.dev_of(cfg["journal_dir"]) != dest_dev:
        refuse("the journal is not on the destination filesystem (journal/hash-cache writes must never land on /vm)")
    return dest_dev


def in_queue(cfg, env):
    if env.cgroup_max() != str(cfg["queue_lane_bytes"]):
        refuse(f"not inside root's queue lane (cgroup memory.max {env.cgroup_max()} != {cfg['queue_lane_bytes']}): "
               "the continuous 16 GiB host floor is the queue's memory guard; never run this phase outside it")
    if env.mem_available() < HOST_FLOOR:
        refuse("host MemAvailable below 16 GiB: not starting")


def manifest_entries(cfg, rel):
    m = cfg["manifest"]
    raw = R.read_bytes(m["path"])
    if hashlib.sha256(raw).hexdigest() != m["sha256"]:
        refuse("relocation manifest sha256 differs from the pin")
    ents = json.loads(raw)
    if not isinstance(ents, list) or len(ents) != m["entries"]:
        refuse(f"relocation manifest must have exactly {m['entries']} entries")
    return [e for e in ents if R._under(e.get("destination", ""), src_of(cfg, rel))]


def check_links(cfg, rel, base):
    """every manifest link into this subtree is a symlink resolving to the same relative path under `base`, and exists"""
    bad = []
    ents = manifest_entries(cfg, rel)
    for e in ents:
        want = os.path.join(base, os.path.relpath(e["destination"], src_of(cfg, rel)))
        if not os.path.islink(e["source"]) or os.path.realpath(e["source"]) != want or not os.path.exists(e["source"]):
            bad.append(e["source"])
    if bad:
        refuse(f"{len(bad)} manifest links of {rel} do not resolve under {base}, first: {bad[0]}")
    return len(ents)


def record_key(r, top):
    k = {x: r.get(x) for x in ("t", "m", "u", "g", "x", "s", "mt", "l", "nl", "h")}
    k["id"] = r["id"][:2] if top else r["id"]               # a subtree's own top: dev+ino (walk_meta zeroes a root's ctime)
    return k


def reuse_1381(cfg, rel, live):
    """sha256 from root's 1381 inventory, ONLY for an exact, complete identity match of this subtree"""
    jd = cfg["inventory_1381"]["journal_dir"]
    st = R.read_json(os.path.join(jd, "state.json"))
    inv = st.get("trees", {}).get("codex-archive", {}).get("source_inventory", {})
    meta = R.read_json(os.path.join(jd, "source-codex-archive.meta.json"))
    log = R.read_json(os.path.join(jd, "source-codex-archive.logical.json"))
    want = cfg["inventory_1381"]
    if inv.get("identity") != want["identity"] or inv.get("logical") != want["logical"] \
            or R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in meta]) != want["identity"] \
            or R.digest(log) != want["logical"]:
        refuse("the 1381 journal is not provably root 1381's inventory (digests differ): no reuse")
    sub = {r["p"]: r for r in meta if r["p"] == rel or r["p"].startswith(rel + "/")}
    mapped = {("" if p == rel else p[len(rel) + 1:]): r for p, r in sub.items()}
    if set(mapped) != {r["p"] for r in live}:
        refuse(f"{rel}: the set of paths differs from 1381 (added/removed entries): no reuse (use --fresh-hash)")
    for r in live:
        if record_key(r, r["p"] == "") != record_key(mapped[r["p"]], r["p"] == ""):
            refuse(f"{rel}/{r['p']}: metadata/identity differs from 1381: no reuse (use --fresh-hash)")
        if r.get("nl", 1) != 1 or "h" in r:
            refuse(f"{rel}/{r['p']}: hardlinks are not reused (use --fresh-hash)")
    sha = {x["p"]: x["sha256"] for x in log if x["t"] == "f"}
    return {("" if p == rel else p[len(rel) + 1:]): sha[p] for p in sub if sub[p]["t"] == "f"}


# ------------------------------------------------------------------------------------------------------------- phases
def phase_inventory(cfg, env, journal, rel, fresh=False):
    ts = journal.tree(rel)
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg)
    src = src_of(cfg, rel)
    recs = R.walk_meta(src)
    if fresh:
        in_queue(cfg, env)
        hashes, counts = R.hash_files(src, recs, journal.path(f"source-{name_of(rel)}.hashcache.tsv"), journal)
        how = "fresh"
    else:
        hashes, counts, how = reuse_1381(cfg, rel, recs), {"hashed": 0, "reused1381": len([r for r in recs if r["t"] == "f"])}, "1381"
    if R.walk_meta(src) != recs:
        refuse("the subtree changed during inventory")
    log = R.logical(recs, hashes)
    tag = f"source-{name_of(rel)}"
    journal.write_atomic(tag + ".meta.json", json.dumps(recs)); journal.write_atomic(tag + ".logical.json", json.dumps(log))
    inv = {"identity": R.digest([[r["p"], r["id"], r.get("s"), r.get("mt"), r.get("l"), r["m"]] for r in recs]), "logical": R.digest(log),
           "entries": len(recs), "counts": counts, "hashes": how,
           "bytes": sum(r["s"] for r in recs if r["t"] == "f")}
    dst = dest_of(cfg, rel)
    owned = os.path.lexists(dst) and ts.get("copy") in ("running", "failed", "done")
    keep = {k: ts[k] for k in ("copy", "dest_top") if k in ts} if owned else {}
    ts.clear(); ts.update(keep); ts["source_inventory"] = inv
    if owned:                                              # C3: this journal's own copy, now against a new inventory
        ts["copy"], ts["checksum"] = "failed", True
    journal.event(phase="inventory-source", subtree=rel, how=how, identity=inv["identity"]); journal.save()
    return inv


def remaining_need(cfg, journal):
    tot = 0
    for rel in cfg["subtrees"]:
        ts = journal.tree(rel)
        if ts.get("copy") != "done" and "source_inventory" in ts:
            tot += R.required_bytes(journal, name_of(rel))[0]
    return tot


def phase_plan(cfg, env, journal):
    rep = {"checks": [], "notes": []}
    ok = rep["checks"].append
    env.check_mounts(cfg); ok("source /vm (cryptvm ext4) and destination / (cryptroot ext4) are the pinned mounts")
    R.no_symlink_components(cfg["archive_root"])
    st = os.lstat(cfg["archive_root"])
    if st.st_uid != cfg["owner_uid"] or stat.S_IMODE(st.st_mode) != 0o700:
        refuse("the archive root must be the owner's 0700 directory")
    private_dest(cfg); ok("destination path private (0700, owner) where it exists; no symlinks")
    writes_on_dest(cfg, env); ok("destination and journal are on the pinned / filesystem, not on /vm")
    for rel in cfg["subtrees"]:
        ts = journal.state["trees"].get(rel, {})
        if ts.get("cutover") == "complete":
            ok(f"{rel}: cut over"); continue
        s = src_of(cfg, rel); R.no_symlink_components(s)
        if os.lstat(s).st_uid != cfg["owner_uid"] or os.path.lexists(retire_of(cfg, rel)):
            refuse(f"{rel}: not the owner's, or {retire_of(cfg, rel)} exists")
        ok(f"{rel}: {check_links(cfg, rel, s)} manifest links resolve into /vm")
    dv = env.statvfs(existing_ancestor(cfg["dest_root"])); avail = dv.f_bavail * dv.f_frsize
    need = remaining_need(cfg, journal)
    sv = env.statvfs(cfg["archive_root"])
    rep["capacity"] = {"destAvail": avail, "remainingInventoriedNeed": need, "destFloor": cfg["dest_floor_bytes"],
                       "destAvailAfter": avail - need, "sourceFreeInformational": sv.f_bavail * sv.f_frsize,
                       "notInventoried": [r for r in cfg["subtrees"] if "source_inventory" not in journal.state["trees"].get(r, {})]}
    if need and avail - need < cfg["dest_floor_bytes"]:
        refuse(f"/ would fall to {avail - need} < floor {cfg['dest_floor_bytes']}")
    rep["notes"] += ["/vm space is freed ONLY by a separately reviewed reclamation of the .retire-* trees (no deletion here)",
                     "the three subtrees free about 328 GB, about 22 GB above the current qualification threshold; the live Qwen "
                     "padbank can still grow by about 64 GB: if it resumes, that margin (and the qualification capacity) is lost",
                     "source free is informational only; the production RPC VM prepare/controller/guard thresholds are unchanged "
                     "and are enforced by their own tools, not by this relief copy (which writes only to /)"]
    vis = R.scan_proc([src_of(cfg, r) for r in cfg["subtrees"]], env)
    rep["notes"].append(f"as uid {env.euid()}: /proc complete={vis['complete']} hits={len(vis['hits'])} (informational only)")
    return rep


def phase_copy(cfg, env, journal, rel):
    ts = journal.tree(rel)
    if "source_inventory" not in ts:
        refuse("inventory-source first")
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); in_queue(cfg, env); writes_on_dest(cfg, env)
    missing = [r for r in cfg["subtrees"] if "source_inventory" not in journal.tree(r)]
    if missing:
        refuse(f"inventory every subtree first ({missing}): the / floor is checked against ALL remaining copies")
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if R.identity_now(src) != ts["source_inventory"]["identity"]:
        refuse("the source changed since inventory: inventory-source again")
    if os.path.lexists(dst):
        if ts.get("copy") not in ("running", "failed"):
            refuse(f"{dst} exists but is not this journal's copy (an unknown pre-existing directory is never adopted)")
        top = os.lstat(dst)
        if not stat.S_ISDIR(top.st_mode) or ("dest_top" in ts and [top.st_dev, top.st_ino] != ts["dest_top"]):
            refuse(f"{dst} is not the directory this journal's copy created")
    dv = env.statvfs(existing_ancestor(cfg["dest_root"])); avail = dv.f_bavail * dv.f_frsize
    need = remaining_need(cfg, journal)                    # C1: FULL remaining need (this + every other one not yet done), EVERY attempt
    if avail - need < cfg["dest_floor_bytes"]:
        refuse(f"/ free {avail} - remaining need {need} < floor {cfg['dest_floor_bytes']} (insufficient capacity; nothing run)")
    private_dest(cfg, create=True)
    resume = ts.get("copy") in ("running", "failed")
    argv = R.safe_rsync_argv([cfg["rsync_path"], "-aHAX", "--numeric-ids", "--one-file-system", "--protect-args"]
                             + (["--checksum"] if resume or ts.get("checksum") else [])           # C2/C3: never trust quick-check on a repair
                             + [f"--bwlimit={cfg['bwlimit_kib']}", src, os.path.dirname(dst) + "/"])
    ts["copy"] = "running"; ts.pop("verified", None); journal.event(phase="copy", subtree=rel, argv=argv); journal.save()
    if not os.path.lexists(dst):                           # C3: OUR top (0700 until rsync -a sets the source's mode), recorded before rsync
        os.mkdir(dst, 0o700); ts["dest_top"] = [os.lstat(dst).st_dev, os.lstat(dst).st_ino]; journal.save()
    rc, tail = env.run_tail(argv)
    if os.path.isdir(dst) and not os.path.islink(dst) and "dest_top" not in ts:   # an r6/r7 journal's existing copy
        ts["dest_top"] = [os.lstat(dst).st_dev, os.lstat(dst).st_ino]
    if rc == 0:
        journal.event(phase="copy", subtree=rel, dir_mtimes_restored=R.restore_dir_mtimes(src, dst))
        ts.pop("checksum", None)
    ts["copy"] = "done" if rc == 0 else "failed"; journal.event(phase="copy", subtree=rel, rc=rc, stderr_tail=tail); journal.save()
    if rc != 0:
        refuse(f"rsync rc {rc}: resumable (re-run copy); nothing was deleted")
    return {"rc": 0, "dest": dst}


def phase_verify(cfg, env, journal, rel):
    ts = journal.tree(rel)
    if ts.get("copy") != "done":
        refuse("copy first")
    if ts.get("cutover") in ("renaming", "renamed", "complete"):
        refuse("already cut over")
    env.check_mounts(cfg); in_queue(cfg, env); private_dest(cfg)
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if R.identity_now(src) != ts["source_inventory"]["identity"]:
        refuse("the source changed since inventory: its hashes are no longer exact (inventory-source + copy again)")
    d = R.inventory(dst, "dest", name_of(rel), journal)
    if d["logical"] != ts["source_inventory"]["logical"]:
        a = R.read_json(journal.path(f"source-{name_of(rel)}.logical.json")); b = R.read_json(journal.path(f"dest-{name_of(rel)}.logical.json"))
        journal.write_atomic(f"verify-diff-{name_of(rel)}.json", json.dumps([x for x in a if x not in b][:20] + [["dest-only", x] for x in b if x not in a][:20]))
        ts["copy"], ts["checksum"] = "failed", True                 # C2: recoverable: the next copy repairs with --checksum
        journal.event(phase="verify", subtree=rel, ok=False); journal.save()
        refuse("destination differs from the source (differences in the journal); copy again (rsync --checksum repair), then verify")
    hashes = {x["p"]: x for x in R.read_json(journal.path(f"dest-{name_of(rel)}.logical.json")) if x["t"] == "f"}
    for e in manifest_entries(cfg, rel):
        x = hashes.get(os.path.relpath(e["destination"], src))
        if not x or x["sha256"] != e["sha256"] or x["s"] != e["bytes"]:
            ts["copy"], ts["checksum"] = "failed", True; journal.save()
            refuse(f"destination does not match the relocation manifest at {e['destination']}; copy again (--checksum)")
    ts["verified"] = {"source_identity": ts["source_inventory"]["identity"], "dest_identity": d["identity"], "logical": d["logical"], "t": env.now()}
    journal.event(phase="verify", subtree=rel, ok=True); journal.save()
    return ts["verified"]


WC_FORMAT, WC_FORMAT_R9, WC_FORMAT_R8 = ("nvme-cold-subtree-writer-check/r10", "nvme-cold-subtree-writer-check/r9",
                                         "nvme-cold-subtree-writer-check/r8")
WC_KEYS = ["format", "t", "tEnd", "euid", "tools", "prefixes", "targets", "hits", "hitsTotal", "aliases", "destAliases",
           "nsCopies", "fsWatchers", "incomplete", "entries", "complete", "scan", "limitations"]
LIMITATIONS = [
    "snapshot: a process can open a target after its own /proc entries were read; cut-over relies on the age bound, the "
    "attestation and the identity re-checks, and reclamation must prove .retire identity == the verified source identity (R4)",
    "fds in flight inside AF_UNIX SCM_RIGHTS messages are in no fd table; io_uring registered files are matched by path only",
    "kernel holders other than loop backing files and swap files (nfsd/ksmbd exports, BPF, acct, binfmt_misc ...) are not "
    "enumerated; loop and swap backing files are resolved by their path string in the scanner's mount namespace",
    "stacked filesystems: overlay mounts of visible namespaces are checked by their layer paths; a detached overlay held only "
    "by an fd, and other kernel stacking filesystems, are not detected",
    "fanotify filesystem/mount-wide marks on a target device are reported in fsWatchers, not as hits",
    "destination aliases (e.g. sandboxes that bind the home directory) are reported in destAliases, not blocking"]


def tool_shas():
    return {p: hashlib.sha256(R.read_bytes(os.path.join(HERE, p))).hexdigest() for p in TOOLS}


def _unesc(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def parse_mounts(text):
    """mountinfo with the mount id (fdinfo mnt_id refers to it)"""
    out = []
    for line in text.splitlines():
        a, b = line.split(" - ", 1)
        f, g = a.split(), b.split()
        out.append({"id": int(f[0]), "majmin": f[2], "root": _unesc(f[3]), "point": _unesc(f[4]), "fstype": g[0],
                    "opts": g[2] if len(g) > 2 else ""})               # r10 G1: super options (overlay layers), kept raw
    return out


OVERLAY_LAYER_KEYS = ("lowerdir", "lowerdir+", "datadir+", "upperdir", "workdir")


def overlay_problems(m, prefixes):
    """r10 G1: an overlay's real files are opened by the kernel (user fds show the overlay's dev/inode), so a layer at, under
    or above a target, or one that cannot be checked by its path string (relative, /proc/..., escaped), is lost visibility"""
    out = []
    for o in m["opts"].split(","):
        k, eq, v = o.partition("=")
        if not eq or k not in OVERLAY_LAYER_KEYS:
            continue
        for layer in [x for x in (v.split(":") if k == "lowerdir" else [v]) if x]:
            if not layer.startswith("/") or layer.startswith("/proc/") or "\\" in layer:
                out.append(f"overlay layer {k}={layer!r} cannot be checked by its path")
            elif any(R._under(layer, x) or R._under(x, layer) for x in prefixes):
                out.append(f"overlay layer {k}={layer!r} is at, under or above a target tree (kernel-held files are not visible)")
    return out


def _majmin(dev):
    return f"{os.major(dev)}:{os.minor(dev)}"


def _dev(majmin, base=10):
    a, b = majmin.split(":")
    return os.makedev(int(a, base), int(b, base))


def _kdev(x):
    """fdinfo sdev: the kernel-internal dev_t (major << 20 | minor), in hex"""
    v = int(x, 16)
    return os.makedev(v >> 20, v & 0xfffff)


def _join(a, rel):
    return a if rel == "." else a.rstrip("/") + "/" + rel


def target_roots(cfg):
    return [(c, rel, f(cfg, rel)) for rel in cfg["subtrees"] for c, f in (("source", src_of), ("retire", retire_of), ("dest", dest_of))]


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def walk_ids(cls, rel, path, ids, budget):
    """(dev, ino) of every entry of one target tree, never entering another filesystem. -> (info, problems)
    r10 B2 (not os.fwalk, which opens a subdirectory by name WITHOUT O_NOFOLLOW/O_DIRECTORY and silently skips it when it
    changed): every subdirectory is opened O_DIRECTORY|O_NOFOLLOW relative to its parent's fd, so a symlink, FIFO or device
    swapped in is never opened, and must be the (dev, ino) that was lstat'ed; any listing/open error or replacement is a
    problem (the scan is incomplete), never a silent skip. Holds O(depth) fds."""
    info, probs = {"class": cls, "subtree": rel, "path": path, "state": None, "entries": 0}, []
    try:
        top = open_nofollow(path, DIR_FLAGS)
    except FileNotFoundError:
        info["state"] = "absent"; return info, probs
    except OSError as e:
        try:
            lst = os.lstat(path)
        except OSError:
            lst = None
        if lst is not None and stat.S_ISLNK(lst.st_mode):         # a cut-over source: our symlink (its target is walked as dest)
            info.update(state="symlink", target=os.readlink(path)); return info, probs
        info["state"] = "unreadable"; probs.append(f"{cls} {path}: {e.strerror}"); return info, probs
    stack = [[top, path, None]]                     # [dir fd, shown path, subdirectories still to enter (None: not listed yet)]
    try:
        st0 = os.fstat(top); dev = st0.st_dev
        info.update(state="dir", majmin=_majmin(dev), dev=dev, ino=st0.st_ino)
        ids[(dev, st0.st_ino)] = (cls, rel); n = 1
        while stack:
            dfd, dpath, todo = stack[-1]
            if todo is None:
                todo = stack[-1][2] = []
                try:
                    names = sorted(os.listdir(dfd))
                except OSError as e:
                    probs.append(f"{cls} {dpath}: {e.strerror} (directory not listable)"); names = []
                for name in names:
                    try:
                        s = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                    except OSError as e:
                        probs.append(f"{cls} {dpath}/{name}: {e.strerror} (changed during the scan?)"); continue
                    n += 1
                    if n > budget[0]:
                        probs.append(f"more than {MAX_TARGET_ENTRIES} target entries"); return info, probs
                    if s.st_dev != dev:
                        probs.append(f"{cls} {dpath}/{name}: another filesystem is mounted inside the tree"); continue
                    ids[(s.st_dev, s.st_ino)] = (cls, rel)
                    if stat.S_ISDIR(s.st_mode):
                        todo.append((name, s.st_ino))
            if not todo:
                stack.pop(); os.close(dfd); continue
            name, ino = todo.pop()
            try:
                cfd = os.open(name, DIR_FLAGS, dir_fd=dfd)
            except OSError as e:
                probs.append(f"{cls} {dpath}/{name}: {e.strerror} (the directory changed during the scan?)"); continue
            c = os.fstat(cfd)
            if (c.st_dev, c.st_ino) != (dev, ino):
                os.close(cfd); probs.append(f"{cls} {dpath}/{name}: replaced during the scan (not the directory that was listed)"); continue
            stack.append([cfd, f"{dpath}/{name}", None])
        info["entries"] = n; budget[0] -= n
        return info, probs
    finally:
        for dfd, _, _ in stack:
            os.close(dfd)


def scan_users(ids, prefixes, targets, env):
    """every visible process and thread: cwd/root/exe, fds, maps, inotify/fanotify marks matched by (st_dev, st_ino) against
    `ids` (and by path string as before), plus kernel loop/swap holders and the mount namespaces' aliases"""
    r = {"hits": [], "hitsTotal": 0, "aliases": [], "destAliases": [], "nsCopies": 0, "fsWatchers": [], "incomplete": [], "entries": 0}
    sc = {"pids": 0, "raced": 0, "timeouts": 0, "namespaces": 0, "kcmpUnknown": 0}
    tdevs = {d for d, _ in ids}
    views, mnt_dev, held = {}, {}, set()

    def inc(where, why):
        r["incomplete"].append([str(where), str(why)])

    def under_any(p):
        p = p.split(" (deleted)")[0]
        return any(R._under(p, x) for x in prefixes)

    def safe(where, fn, default=None):
        try:
            return fn()
        except (FileNotFoundError, ProcessLookupError):
            sc["raced"] += 1; return default                     # exited / closed during the scan
        except TimeoutError:
            sc["timeouts"] += 1; inc(where, "stat timed out (hung filesystem?)"); return default
        except OSError as e:
            inc(where, f"{type(e).__name__}: {e.strerror or e}"); return default

    def comm(pid):
        c = safe(f"{pid} comm", lambda: env.read_proc(f"{env.proc}/{pid}/comm"), "")
        return (c or "").strip()[:64]

    def hit(pid, where, how, key, shown):
        r["hitsTotal"] += 1
        if len(r["hits"]) < MAX_HITS:
            cls, rel = ids.get(key, (None, None)) if key else (None, None)
            r["hits"].append({"pid": pid, "comm": comm(pid) if pid != "kernel" else "", "where": where, "how": how,
                              "class": cls, "subtree": rel, "target": shown})

    def check_id(pid, where, dev, ino, shown):
        if (dev, ino) in ids:
            hit(pid, where, "inode", (dev, ino), shown)

    def link(pid, where, p):
        t = safe(f"{pid} {where}", lambda: env.readlink(p))
        if t is None:
            return
        r["entries"] += 1
        if under_any(t):
            hit(pid, where, "path", None, t)
        if t.startswith(("pipe:", "socket:", "anon_inode:")):
            return
        st = safe(f"{pid} {where}", lambda: env.stat_link(p))
        if st is not None:
            check_id(pid, where, st.st_dev, st.st_ino, t)

    def add_view(key, pid, text):
        try:
            ms = parse_mounts(text)
        except (ValueError, IndexError):
            inc(f"{pid} mountinfo", "unparsable"); return
        views[key] = (pid, ms); sc["namespaces"] = len(views)
        for m in ms:
            mnt_dev[m["id"]] = _dev(m["majmin"])
            if m["fstype"] == "nsfs" and m["root"].startswith("mnt:["):
                held.add(m["root"])

    def fdinfo(pid, where, t, text):
        f, uring = {}, False
        for line in text.splitlines():
            k, _, v = line.partition(":")
            if k in ("mnt_id", "ino") and not uring:
                f[k] = v.strip()
            elif line.startswith(("inotify ", "fanotify ")):
                kv = dict(x.split(":", 1) for x in line.split()[1:] if ":" in x)
                try:
                    if "ino" in kv and "sdev" in kv:
                        check_id(pid, where + " " + line.split()[0], _kdev(kv["sdev"]), int(kv["ino"], 16), t)
                    elif line.startswith("fanotify ") and ("sdev" in kv or "mnt_id" in kv) and "flags" not in kv:
                        d = _kdev(kv["sdev"]) if "sdev" in kv else mnt_dev.get(int(kv["mnt_id"], 16))
                        if d is None:                          # r10 G3: never silently ignored
                            inc(f"{pid} {where} fdinfo", "a fanotify mount mark on a mount in no visible mount namespace")
                        elif d in tdevs:
                            r["fsWatchers"].append({"pid": pid, "comm": comm(pid), "where": where, "mark": line[:200]})
                except ValueError:
                    inc(f"{pid} {where} fdinfo", "unparsable watch mark")
            elif k == "UserFiles":
                uring = True
            elif uring and re.match(r"^\s*\d+: ", line) and under_any(line.split(": ", 1)[1]):
                hit(pid, where + " io_uring", "path", None, line.split(": ", 1)[1])
        return f

    def fds(pid, fddir, infodir, label):
        names = safe(f"{pid} {label}", lambda: env.listdir(fddir))
        for n in names or []:
            p, where = f"{fddir}/{n}", f"{label}/{n}"
            t = safe(f"{pid} {where}", lambda: env.readlink(p))
            if t is None:
                continue
            r["entries"] += 1
            if under_any(t):
                hit(pid, where, "path", None, t)
            if t.startswith(("pipe:", "socket:")):
                continue
            if t.startswith("mnt:["):
                held.add(t); continue
            text = safe(f"{pid} {where} fdinfo", lambda: env.read_proc(f"{infodir}/{n}"))
            if text is None:
                continue
            f = fdinfo(pid, where, t, text)
            if t.startswith("anon_inode:"):
                continue
            dev = mnt_dev.get(int(f["mnt_id"])) if f.get("mnt_id", "").isdigit() else None
            if dev is not None and f.get("ino", "").isdigit():
                check_id(pid, where, dev, int(f["ino"]), t)
            else:                                              # a mount in no visible namespace (detached / lazily unmounted)
                st = safe(f"{pid} {where}", lambda: env.stat_link(p))
                if st is not None:
                    check_id(pid, where, st.st_dev, st.st_ino, t)

    status = safe("self status", lambda: env.read_proc(f"{env.proc}/self/status"), "")
    nspid = [l.split()[1:] for l in (status or "").splitlines() if l.startswith("NSpid:")]
    if not nspid or len(nspid[0]) != 1:
        inc("self", "the scanner is not in the initial PID namespace (or NSpid is unreadable): processes may be invisible")
    me = safe("self ns/mnt", lambda: env.readlink(f"{env.proc}/self/ns/mnt")) or "self"
    txt = safe("self mountinfo", lambda: env.read_proc(env.mountinfo))
    if txt is not None:
        add_view(me, "self", txt)
    for pid in env.pids():
        if r["entries"] > R.MAX_PROC_ENTRIES:
            inc("*", f"more than {R.MAX_PROC_ENTRIES} entries"); break
        if sc["timeouts"] > MAX_TIMEOUTS:
            inc("*", f"more than {MAX_TIMEOUTS} hung stats: scan aborted"); break
        base = f"{env.proc}/{pid}"
        if not os.path.lexists(base):
            sc["raced"] += 1; continue
        sc["pids"] += 1
        ns = safe(f"{pid} ns/mnt", lambda: env.readlink(f"{base}/ns/mnt"))
        if ns and ns not in views:
            txt = safe(f"{pid} mountinfo", lambda: env.read_proc(f"{base}/mountinfo"))
            if txt is not None:
                add_view(ns, pid, txt)
        for n in ("cwd", "root", "exe"):
            link(pid, n, f"{base}/{n}")
        fds(pid, f"{base}/fd", f"{base}/fdinfo", "fd")
        for tid in safe(f"{pid} task", lambda: env.listdir(f"{base}/task"), []) or []:
            tb = f"{base}/task/{tid}"
            tns = safe(f"{pid} task/{tid} ns/mnt", lambda: env.readlink(f"{tb}/ns/mnt"))
            if tns and tns not in views:                       # r10 G2: a thread in its own mount namespace
                txt = safe(f"{pid} task/{tid} mountinfo", lambda: env.read_proc(f"{tb}/mountinfo"))
                if txt is not None:
                    add_view(tns, pid, txt)
            for n in ("cwd", "root"):
                link(pid, f"task/{tid}/{n}", f"{tb}/{n}")
            if tid != pid:
                same = env.same_files(pid, tid)
                if same is not True:                           # an unshared fd table (or unknown): scan it as well
                    sc["kcmpUnknown"] += same is None
                    fds(pid, f"{tb}/fd", f"{tb}/fdinfo", f"task/{tid}/fd")
        try:
            with env.open_lines(f"{base}/maps") as mf:
                for line in mf:
                    r["entries"] += 1
                    parts = line.split(None, 5)
                    if len(parts) < 5:
                        continue
                    path = parts[5].strip() if len(parts) == 6 else ""
                    if path and under_any(path):
                        hit(pid, "maps", "path", None, path)
                    if parts[4].isdigit() and int(parts[4]):
                        try:
                            check_id(pid, "maps", _dev(parts[3], 16), int(parts[4]), path)
                        except ValueError:
                            inc(f"{pid} maps", "unparsable device column")
        except (FileNotFoundError, ProcessLookupError):
            sc["raced"] += 1
        except OSError as e:
            inc(f"{pid} maps", f"{type(e).__name__}: {e.strerror or e}")
    for ns in sorted(held - set(views)):
        inc(ns, "a mount namespace is held without a visible process (ns fd or nsfs bind mount): its mounts are not visible")
    for ns, (pid, ms) in views.items():                       # r10 G1: overlay layers touching a target
        for m in ms:
            if m["fstype"] == "overlay":
                for why in overlay_problems(m, prefixes):
                    inc(f"{pid} {ns} overlay {m['point']}", why)
    # kernel-held users: loop devices and swap files, by path AND by (dev, ino) of the resolved path
    def kernel(where, p):
        if under_any(p):
            hit("kernel", where, "path", None, p)
        if p.endswith(" (deleted)"):
            return                                             # not an entry of any target tree now
        try:
            st = env.stat_link(p)
        except OSError as e:
            inc(f"kernel {where}", f"backing path not resolvable from the scanner's namespace: {e.strerror or e}"); return
        check_id("kernel", where, st.st_dev, st.st_ino, p)
    for dev in safe("sys/block", lambda: env.listdir(env.sys_block), []) or []:
        if dev.startswith("loop"):
            bf = safe(f"kernel {dev}", lambda: env.read_proc(f"{env.sys_block}/{dev}/loop/backing_file"))
            if bf and bf.strip():
                kernel(dev, bf.strip())
    sw = safe("swaps", lambda: env.read_proc(f"{env.proc}/swaps"))
    for line in (sw or "").splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "file":
            kernel("swap", _unesc(parts[0]))
    # mount aliases: any visible namespace's mount of a target's filesystem that exposes the target at ANOTHER path
    self_ms = views.get(me, (None, []))[1]
    for t in targets:
        if t["state"] != "dir":
            continue
        best = None
        for m in self_ms:
            if R._under(t["path"], m["point"]) and (best is None or len(m["point"]) >= len(best["point"])):
                best = m
        if best is None or best["majmin"] != t["majmin"]:
            inc(t["path"], "the target's own mount is not the filesystem that was walked (overmounted?)"); continue
        fsrel = _join(best["root"], os.path.relpath(t["path"], best["point"]))
        for ns, (pid, ms) in views.items():
            for m in ms:
                if m["majmin"] != t["majmin"]:
                    continue
                if R._under(fsrel, m["root"]):
                    vis = _join(m["point"], os.path.relpath(fsrel, m["root"]))
                elif R._under(m["root"], fsrel):
                    vis = m["point"]                           # a part of the target mounted on its own
                else:
                    continue
                if vis == t["path"]:
                    r["nsCopies"] += ns != me; continue
                rec = {"ns": ns, "pid": pid, "mountId": m["id"], "point": m["point"], "root": m["root"], "exposesAt": vis,
                       "class": t["class"], "subtree": t["subtree"], "path": t["path"]}
                (r["destAliases"] if t["class"] == "dest" else r["aliases"]).append(rec)
    r["scan"] = sc
    return r


def phase_writer_check(cfg, env):
    """ROOT, read-only: walk the target trees (no symlink followed), then scan every process, thread, fd, mapping, mark and
    mount namespace. Returned (printed to stdout by main). No journal, lock, file write or chown."""
    if env.euid() != 0:
        refuse("writer-check must run as root (complete /proc visibility), only via the staged wrapper (README)")
    t0 = env.now()
    env.check_mounts(cfg)
    prefixes = sorted({p for rel in cfg["subtrees"] for p in (os.path.realpath(src_of(cfg, rel)), src_of(cfg, rel), retire_of(cfg, rel), dest_of(cfg, rel))})
    ids, targets, probs, budget = {}, [], [], [MAX_TARGET_ENTRIES]
    try:
        pinned = {"source": env.real_dev(cfg["archive_root"]), "retire": env.real_dev(cfg["archive_root"]), "dest": env.real_dev(cfg["dest_root"])}
        for cls, rel, p in target_roots(cfg):
            info, pr = walk_ids(cls, rel, p, ids, budget)
            if info["state"] == "dir" and info["dev"] != pinned[cls]:
                pr.append(f"{cls} {p}: not on the pinned {cls} filesystem")
            targets.append(info); probs += pr
        res = scan_users(ids, prefixes, targets, env)
    except (OSError, ValueError, KeyError, IndexError) as e:     # never a traceback and never a partial "complete" result
        refuse(f"writer-check aborted ({type(e).__name__}: {getattr(e, 'strerror', None) or e}): no result")
    res["incomplete"] = [["target", x] for x in probs] + res["incomplete"]
    res.update(format=WC_FORMAT, t=t0, tEnd=env.now(), prefixes=prefixes, euid=env.euid(), tools=tool_shas(), targets=targets,
               complete=not res["incomplete"], limitations=LIMITATIONS)
    return res


def phase_record_writer_check(cfg, env, journal, result_path):
    """owner: accept the root scanner's stdout JSON only if it is that scanner's output for THESE exact tool bytes"""
    if not result_path:
        refuse("--result FILE (the stdout of the staged root wrapper, README) is required")
    st, raw = read_bounded(result_path, RESULT_MAX, "writer-check result", {cfg["owner_uid"]})   # the caller's own redirect
    res = parse_json(raw, "writer-check result")
    if isinstance(res, dict) and res.get("format") == WC_FORMAT_R8:
        refuse("an r8 (path-string) writer-check result: run the r10 staged root scan")
    if isinstance(res, dict) and res.get("format") == WC_FORMAT_R9:
        refuse("an r9 writer-check result (its walk could skip a changed directory silently): run the r10 staged root scan")
    R._keys(res, WC_KEYS, "writer-check result")
    if res["format"] != WC_FORMAT or res["euid"] != 0:
        refuse("not a root writer-check result of this tool")
    if res["tools"] != tool_shas() or res["tools"]["relocate.py"] != R5_RELOCATE_SHA256:
        refuse("the root scan ran other tool bytes than these (subtree.py/relocate.py/root-writer-check.sh sha256 differ)")
    if not all(isinstance(res[k], list) for k in ("hits", "aliases", "incomplete", "targets", "prefixes")) or not isinstance(res["complete"], bool):
        refuse("malformed writer-check result")
    journal.write_atomic("writer-check.json", json.dumps(res))
    journal.event(phase="record-writer-check", complete=res["complete"], hits=res["hitsTotal"], aliases=len(res["aliases"]), t=res["t"])
    journal.save()
    return {"recorded": True, "complete": res["complete"], "hits": res["hitsTotal"], "aliases": len(res["aliases"])}


def require_writer_check(cfg, env, journal, path, rel=None):
    p = journal.path("writer-check.json")
    if not os.path.lexists(p):
        refuse("no root writer-check result: run the staged root wrapper (README) > FILE, then record-writer-check --result FILE")
    st, raw = read_bounded(p, RESULT_MAX, "journal writer-check result", {cfg["owner_uid"], 0})
    if st.st_mode & 0o077:
        refuse("writer-check result must be private (0600)")
    wc = parse_json(raw, "journal writer-check result")
    if not isinstance(wc, dict) or wc.get("format") != WC_FORMAT:
        refuse("the recorded writer-check is not an r10 result (r8/r9 results are not accepted): re-run it")
    if not wc["complete"]:
        refuse(f"writer-check visibility was incomplete ({len(wc['incomplete'])} problems): not proof of no users")
    if wc["hits"] or wc["hitsTotal"]:
        refuse(f"active users: {wc['hits'][:3]}")
    if wc["aliases"]:
        refuse(f"the source/.retire tree is exposed at another path (mount alias): {wc['aliases'][:2]}")
    if env.now() - wc["t"] > cfg["writer_check_max_age_seconds"] or path not in wc["prefixes"]:
        refuse("writer-check result is stale or not for this subtree: re-run it")
    if rel is not None and not any(t.get("class") == "source" and t.get("subtree") == rel and t.get("state") == "dir" and t.get("entries", 0) > 0
                                   for t in wc["targets"]):
        refuse("the writer-check did not walk this subtree's source tree: re-run it")


def post_checks(cfg, rel):
    src, dst = src_of(cfg, rel), dest_of(cfg, rel)
    if os.readlink(src) != dst or os.path.realpath(src) != dst:
        refuse("the original path does not resolve to the destination")
    if stat.S_IMODE(os.stat(dst).st_mode) != stat.S_IMODE(os.lstat(retire_of(cfg, rel)).st_mode):
        refuse("destination top-level mode differs from the source's")
    check_links(cfg, rel, dst)


def phase_cutover(cfg, env, journal, rel, attest):
    ts = journal.tree(rel)
    src, dst, ret = src_of(cfg, rel), dest_of(cfg, rel), retire_of(cfg, rel)
    if ts.get("cutover") == "complete":
        post_checks(cfg, rel); return {"already": True}
    if "verified" not in ts:
        refuse("verify first")
    R.require_attestation(attest)
    env.check_mounts(cfg); private_dest(cfg)
    if ts.get("cutover") == "renaming":
        if not os.path.lexists(src) and os.path.isdir(ret):
            ts["cutover"] = "renamed"; journal.save()
        elif os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret):
            ts.pop("cutover"); journal.save()
        else:
            refuse("inconsistent cut-over state after a crash: manual review")
    if ts.get("cutover") != "renamed":
        require_writer_check(cfg, env, journal, os.path.realpath(src), rel)
        if R.identity_now(src) != ts["verified"]["source_identity"]:
            refuse("source changed after verify (a writer?): copy + verify again")
        if R.identity_now(dst) != ts["verified"]["dest_identity"]:
            refuse("destination changed after verify")
        if os.path.lexists(ret):
            refuse(f"{ret} exists")
        ts["cutover"] = "renaming"; ts["attestation"] = attest
        journal.event(phase="cutover", subtree=rel, step="rename-intent", attest=attest); journal.save()
        os.rename(src, ret)
        ts["cutover"] = "renamed"; journal.event(phase="cutover", subtree=rel, step="renamed"); journal.save()
    if not os.path.lexists(src):
        os.symlink(dst, src)
    try:
        if os.readlink(src) != dst:
            refuse(f"{src} exists and is not our symlink")
        post_checks(cfg, rel)
    except Exception as e:
        journal.event(phase="cutover", subtree=rel, step="post-check-failed", error=str(e)); journal.save()
        phase_rollback(cfg, env, journal, rel)
        refuse(f"post-cutover check failed and was rolled back: {e}")
    ts["cutover"] = "complete"; ts["dest_identity_at_cutover"] = R.identity_now(dst)
    journal.event(phase="cutover", subtree=rel, step="complete"); journal.save()
    return {"cutover": "complete", "retired": ret, "note": "nothing deleted; reclamation of the .retire tree is a separate review"}


def phase_rollback(cfg, env, journal, rel):
    ts = journal.tree(rel)
    src, dst, ret = src_of(cfg, rel), dest_of(cfg, rel), retire_of(cfg, rel)
    if os.path.isdir(src) and not os.path.islink(src) and not os.path.lexists(ret):
        ts.pop("cutover", None); journal.save(); return {"already": "source is in place"}
    if not (os.path.isdir(ret) and not os.path.islink(ret)):
        refuse(f"{ret} is missing: manual review (nothing changed)")
    base = ts.get("dest_identity_at_cutover") or (ts.get("verified") or {}).get("dest_identity")
    if os.path.lexists(dst) and (base is None or R.identity_now(dst) != base):
        refuse("the destination changed since cut-over (writes through the symlink): rolling back would discard them")
    if R._our_symlink(src, dst):
        journal.event(phase="rollback", subtree=rel, step="unlink-our-symlink"); journal.save()
        os.unlink(src)                                   # the ONLY unlink: our own readlink-verified symlink
    os.rename(ret, src)
    ts.pop("cutover", None); journal.event(phase="rollback", subtree=rel, step="restored"); journal.save()
    return {"rolled_back": True, "kept": dst}


def main(argv=None, env=None):
    env = env or Env()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("phase", nargs="?", default="plan", choices=["plan", "status", "inventory-source", "copy", "verify",
                    "writer-check", "record-writer-check", "cutover", "rollback"])
    ap.add_argument("--config", required=True); ap.add_argument("--subtree"); ap.add_argument("--result")
    ap.add_argument("--fresh-hash", action="store_true"); ap.add_argument("--apps-stopped-attestation")
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config, env)
        if a.phase != "writer-check" and env.euid() == 0 and env.production:
            refuse("run as the owner, not root (only writer-check runs as root)")
        if a.phase == "writer-check":                       # W1: root scans and PRINTS; it never opens the journal
            out = phase_writer_check(cfg, env)
        elif a.phase in ("plan", "status"):
            j = open_journal(cfg, env, create=False)
            out = j.state if a.phase == "status" else phase_plan(cfg, env, j)
        else:
            env.check_mounts(cfg); writes_on_dest(cfg, env)        # r7: before the journal is created or written at all
            j = open_journal(cfg, env, create=True)
            with j.locked():
                rel = pick(cfg, a.subtree) if a.phase in ("inventory-source", "copy", "verify", "cutover", "rollback") else None
                out = {"inventory-source": lambda: phase_inventory(cfg, env, j, rel, a.fresh_hash), "copy": lambda: phase_copy(cfg, env, j, rel),
                       "verify": lambda: phase_verify(cfg, env, j, rel),
                       "record-writer-check": lambda: phase_record_writer_check(cfg, env, j, a.result),
                       "cutover": lambda: phase_cutover(cfg, env, j, rel, a.apps_stopped_attestation),
                       "rollback": lambda: phase_rollback(cfg, env, j, rel)}[a.phase]()
        print(json.dumps(out, indent=1, sort_keys=True, default=str))
        return 0
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
