#!/usr/bin/env python3
"""Network-HDD storage (layout network-hdd-nbd): the durable origin is an authenticated NBD export of a NEW image file on
the desktop HDD array, attached RAW by the transport (enclave-rpc-hdd hddattach.py). This tool adds the optional
writethrough dm-cache ON THE RAW DEVICE, then mounts the ONE filesystem from the top device. There is exactly one writable
view: the nbd device is never mounted while a mapping uses it, and a mapping is never created over a mounted origin.

  storage_nbd.py create      <cfg> --first-format   blank export only (transport first-format), then the cache files
                                                    through the ledger. Prints the filesystem UUID for the config.
  storage_nbd.py assemble    <cfg>                  verify the attach and placement pin; map (or adopt an IDENTICAL map);
                                                    mount the configured UUID on an empty mount point
  storage_nbd.py disassemble <cfg>                  validate the whole ownership chain first, unmount, unmap, detach only
                                                    this layer's cache loops. Stops at the first failure. Writes the
                                                    clean-shutdown marker ONLY for a healthy session.
  storage_nbd.py cache-loss  <cfg>                  unmounted: unmap, ZERO the cache metadata first, then a read-only fsck
                                                    of the origin
  storage_nbd.py verify-cap  <cfg>                  the shared NVMe budget ledger (budget.py verify)

Cache reuse rule (stale-cache safety):
- assemble with a cache needs a marker whose O_DIRECT superblock fingerprint of the origin still matches.
- A marker comes from a clean disassemble (no supervisor failure recorded for this session, no new ext4 errors, a clean
  unmount) or from cache-loss (after the metadata was zeroed).
- Any mount or write of the filesystem without the cache changes the superblock (mount count, write time, kbytes
  written), so assemble refuses until cache-loss runs.
- Raw block writes to the origin that bypass a mount are NOT detectable this way; after any doubt, run cache-loss.

Nothing here formats a device that is not blank, deletes the export, retries, or resyncs.
"""
import hashlib
import json
import mmap
import os
import re
import signal
import stat
import subprocess
import sys
import uuid as uuidlib

FORMAT = "enclave-rpc-storage-nbd/v1"
KEYS = {"format", "name", "role", "attachConfig", "hddattach", "placementSha256", "bytes", "fsUuid", "mechanism", "mountPoint",
        "dirs", "owner", "py", "budgetTool", "ledger", "reservation", "cdata", "cdataBytes", "cmeta", "cmetaBytes",
        "blockSectors", "nvmeFreeMargin", "stateDir", "watchFailureFile"}


class Stop(Exception):
    pass


def log(m):
    print(f"storage-nbd: {m}", file=sys.stderr, flush=True)


def die(m):
    raise Stop(m)


def run(*a, check=True, timeout=600, **kw):
    r = subprocess.run(list(a), capture_output=True, text=True, timeout=timeout, **kw)
    if check and r.returncode != 0:
        die(f"{a[0]} {' '.join(a[1:3])} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:300]}")
    return r


def load(path):
    with open(path) as f:
        c = json.load(f)
    if not isinstance(c, dict) or set(c) != KEYS or c.get("format") != FORMAT:
        die(f"{path}: must be {FORMAT} with exactly {sorted(KEYS)}")
    if c["role"] not in ("l1", "base") or c["mechanism"] not in ("none", "dm-cache"):
        die("role must be l1/base and mechanism none/dm-cache")
    if not re.fullmatch(r"[a-z0-9-]{3,64}", c["name"]):
        die("name must be a dm-safe name")
    if c["fsUuid"] is not None and not re.fullmatch(r"[0-9a-f-]{36}", c["fsUuid"]):
        die("fsUuid must be null (before the first format) or the filesystem UUID")
    return c


# ---- the attach (transport) and its placement pin ----------------------------------------------------------------------
def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":")).encode()


def attach_view(c):
    with open(c["attachConfig"]) as f:
        a = json.load(f)
    if a.get("role") != c["role"]:
        die(f"attach config role {a.get('role')!r} is not this storage's role {c['role']!r}")
    if a["placement"]["exportName"] != f"enclave-rpc-{c['role']}" or a["placement"]["imageBytes"] != c["bytes"]:
        die("attach config names another export or size than this storage")
    got = hashlib.sha256(canonical(a["placement"])).hexdigest()
    if got != c["placementSha256"]:
        die(f"the attach config's placement statement ({got}) is not the pinned, reviewed one ({c['placementSha256']})")
    r = run(c["py"], "-I", c["hddattach"], "verify-attached", c["attachConfig"], check=False, timeout=120)
    if r.returncode != 0:
        die(f"the transport attachment is not verified: {r.stdout.strip()[-300:]}")
    v = json.loads(r.stdout.strip().splitlines()[-1])["attached"]
    if v["device"] != a["device"] or v["bytes"] != c["bytes"]:
        die("verified attachment does not match the configured device/size")
    return a["device"], v


def majmin(path):
    st = os.stat(path)
    if not stat.S_ISBLK(st.st_mode):
        die(f"{path} is not a block device")
    return f"{os.major(st.st_rdev)}:{os.minor(st.st_rdev)}"


def holders(dev):
    try:
        return sorted(os.listdir(f"/sys/block/{os.path.basename(os.path.realpath(dev))}/holders"))
    except OSError:
        return []


def mountpoints_of(dev):
    mm = majmin(dev)
    out = []
    with open("/proc/self/mountinfo") as f:
        for line in f:
            p = line.split()
            if p[2] == mm:
                out.append(p[4])
    return out


def mounted_at(mnt):
    hit = None
    with open("/proc/self/mountinfo") as f:
        for line in f:
            p = line.split()
            if p[4] == mnt:
                hit = p[2]
    return hit


def sb_fingerprint(dev):
    """sha256 of the ext4 superblock (bytes 1024-2047) read with O_DIRECT from the ORIGIN (no page cache, no dm-cache)."""
    fd = os.open(dev, os.O_RDONLY | os.O_DIRECT)
    try:
        buf = mmap.mmap(-1, 4096)
        if os.preadv(fd, [buf], 0) != 4096:
            die(f"short superblock read from {dev}")
        sb = bytes(buf[1024:2048])
    finally:
        os.close(fd)
    if sb[0x38:0x3A] != b"\x53\xef":
        die(f"{dev} has no ext4 superblock")
    return hashlib.sha256(sb).hexdigest()


# ---- cache files (same rules as the local template) ------------------------------------------------------------------
def rot_of_dir(path):
    src = run("findmnt", "-no", "SOURCE", "--target", os.path.dirname(path)).stdout.strip()
    return run("lsblk", "-nso", "ROTA", src).stdout.split()[-1]


def loop_of(path):
    """The loop bound to exactly this backing file, if any."""
    out = run("losetup", "-j", path, "-O", "NAME", "-n").stdout.split()
    return out[0] if out else ""


def credit(path, declared, cdata_dir_dev):
    try:
        if (stat.S_ISREG(os.lstat(path).st_mode) and stat.S_ISREG(os.lstat(path + ".enclave-budget-owner").st_mode)
                and os.lstat(path).st_dev == cdata_dir_dev):
            return min(os.lstat(path).st_blocks * 512, declared)
    except FileNotFoundError:
        pass
    return 0


def expected_table(c, origin):
    sectors = int(run("blockdev", "--getsz", origin).stdout.strip())
    return (f"0 {sectors} cache {majmin(c['_M'])} {majmin(c['_D'])} {majmin(origin)} {c['blockSectors']} 1 writethrough smq 0")


# ---- markers -----------------------------------------------------------------------------------------------------------
def marker_path(c):
    return os.path.join(c["stateDir"], f"{c['name']}.cache-ok.json")


def session_path(c):
    return os.path.join(c["stateDir"], f"{c['name']}.session.json")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def drop(path):
    if os.path.lexists(path):
        os.unlink(path)


# ---- commands ----------------------------------------------------------------------------------------------------------
class Unwind:
    """Undo ONLY what this run created/attached/mapped/mounted, in reverse, stopping at the first failed step."""

    def __init__(self):
        self.created, self.attached, self.mapped, self.mounted = [], [], None, None

    def __call__(self, why):
        if self.mounted and run("umount", self.mounted, check=False).returncode != 0:
            return log(f"cleanup stopped: cannot unmount {self.mounted}; mapping, loops and files kept ({why})")
        if self.mapped and run("dmsetup", "remove", self.mapped, check=False).returncode != 0:
            return log(f"cleanup stopped: cannot remove mapping {self.mapped}; loops and files kept ({why})")
        for l in reversed(self.attached):
            if run("losetup", "-d", l, check=False).returncode != 0:
                return log(f"cleanup stopped: cannot detach {l}; remaining loops and files kept ({why})")
        for f in reversed(self.created):
            try:
                os.unlink(f)
            except OSError as e:
                return log(f"cleanup stopped: cannot remove {f}: {e} ({why})")
        log(f"failed ({why}): undid only what this run created/attached/mapped/mounted")


def attach_file(path, uw):
    l = loop_of(path)
    if not l:
        l = run("losetup", "--find", "--show", "--", path).stdout.strip()
        uw.attached.append(l)
    return l


def cmd_create(c, argv, uw):
    if "--first-format" not in argv:
        die("create needs --first-format: it formats a NEW (blank) export once")
    if c["fsUuid"] is not None:
        die("fsUuid is configured: this export was formatted before and is never reformatted")
    dev, _ = attach_view(c)
    if holders(dev) or mountpoints_of(dev):
        die(f"{dev} is in use (holders {holders(dev)}, mounts {mountpoints_of(dev)})")
    cached = c["mechanism"] == "dm-cache"
    if cached:
        for f in (c["cdata"], c["cmeta"]):
            if not os.path.isdir(os.path.dirname(f)):
                die(f"{os.path.dirname(f)} does not exist")
            if rot_of_dir(f) != "0":
                die(f"{f} must be on NVMe (non-rotational)")
        dd = os.stat(os.path.dirname(c["cdata"])).st_dev
        need = c["cdataBytes"] + c["cmetaBytes"] + c["nvmeFreeMargin"] - credit(c["cdata"], c["cdataBytes"], dd) - credit(c["cmeta"], c["cmetaBytes"], dd)
        v = os.statvfs(os.path.dirname(c["cdata"]))
        if v.f_bavail * v.f_frsize < need:
            die("not enough NVMe free space for the cache plus margin")
        run(c["py"], "-I", c["budgetTool"], "admit", c["ledger"], c["reservation"], f"{c['cdata']}={c['cdataBytes']}", f"{c['cmeta']}={c['cmetaBytes']}")
    # the transport's first-format: refuses unless the export is blank (no signature, zero first/last MiB)
    r = run(c["py"], "-I", c["hddattach"], "first-format", c["attachConfig"], "--i-am-formatting-a-new-export", check=False, timeout=3600)
    if r.returncode != 0:
        die(f"first-format refused: {r.stdout.strip()[-300:]}")
    fsuuid = json.loads(r.stdout.strip().splitlines()[-1])["uuid"]
    if cached:
        out = run(c["py"], "-I", c["budgetTool"], "allocate", c["ledger"], c["reservation"]).stdout
        uw.created += [p for w, p in (l.split(None, 1) for l in out.splitlines() if l.strip()) if w == "created"]
        with open(c["cmeta"], "r+b") as f:     # zeroed: dm-cache formats an empty cache
            f.write(b"\0" * (8 << 20)); f.flush(); os.fsync(f.fileno())
        # an EMPTY cache over a filesystem that has only ever been written uncached by this format: consistent
        write_json(marker_path(c), {"fingerprint": sb_fingerprint(dev), "by": "create (empty cache)"})
    uw.created = []
    print(json.dumps({"created": c["name"], "fsUuid": fsuuid,
                      "next": "set fsUuid in the storage config AND filesystem.uuid in the attach config, re-render, then assemble"}))


def cache_gate(c, origin):
    """True when the cache may be reused; refuses otherwise (cache-loss first)."""
    m = read_json(marker_path(c))
    fp = sb_fingerprint(origin)
    if m is None:
        die("no clean-shutdown or cache-loss marker for this cache: run cache-loss before assemble (stale-cache hazard)")
    if m.get("fingerprint") != fp:
        die("the origin's superblock changed since the cache was last consistent (uncached mount/write): run cache-loss first")
    return fp


def cmd_assemble(c, uw):
    if c["fsUuid"] is None:
        die("fsUuid is not configured; nothing is mounted by guesswork")
    dev, _ = attach_view(c)
    cached = c["mechanism"] == "dm-cache"
    if mountpoints_of(dev):
        die(f"{dev} (the origin) is mounted at {mountpoints_of(dev)} without this layer: refusing (stale-cache / two-view hazard)")
    # every refusal about the mount point BEFORE anything is mapped (a refused start must not consume the cache marker)
    mnt = c["mountPoint"]
    if not os.path.isdir(os.path.dirname(mnt)):
        die(f"{os.path.dirname(mnt)} does not exist")
    if os.path.lexists(mnt) and (os.path.islink(mnt) or not os.path.isdir(mnt)):
        die(f"{mnt} must be a real directory")
    pre = mounted_at(mnt) if os.path.lexists(mnt) else None
    if pre is not None:
        want_top = f"/dev/mapper/{c['name']}" if cached else dev
        if not os.path.exists(want_top) or pre != majmin(want_top):
            die(f"{mnt} is mounted from another device ({pre}); leaving it")
    elif os.path.lexists(mnt) and os.listdir(mnt):
        die(f"{mnt} is not empty: something wrote into the bare mount point (on the VM disk); investigate first")
    top = dev
    if cached:
        for f in (c["cdata"], c["cmeta"]):
            if not os.path.isfile(f):
                die("cache images missing")
        run(c["py"], "-I", c["budgetTool"], "verify", c["ledger"], c["reservation"])
        c["_D"], c["_M"] = attach_file(c["cdata"], uw), attach_file(c["cmeta"], uw)
        want = expected_table(c, dev)
        if run("dmsetup", "info", c["name"], check=False).returncode == 0:
            have = run("dmsetup", "table", c["name"]).stdout.strip()
            if have != want:
                die(f"mapping {c['name']} exists but is not this storage's (have {have}; want {want}); leaving it")
        else:
            if holders(dev):
                die(f"{dev} is held by {holders(dev)}: another mapping uses the origin; refusing")
            cache_gate(c, dev)
            drop(marker_path(c))                     # consumed: a crash from here on leaves no marker
            run("dmsetup", "create", c["name"], "--table", want)
            uw.mapped = c["name"]
        if "writethrough" not in run("dmsetup", "status", c["name"]).stdout.split():
            die(f"mapping {c['name']} is not writethrough")
        top = f"/dev/mapper/{c['name']}"
    probe = run("blkid", "-p", "-o", "export", top, check=False).stdout
    sig = dict(l.split("=", 1) for l in probe.splitlines() if "=" in l)
    if sig.get("TYPE") != "ext4" or sig.get("UUID") != c["fsUuid"]:
        die(f"{top} holds {sig.get('TYPE')} {sig.get('UUID')}, not ext4 {c['fsUuid']}")
    if not os.path.lexists(mnt):
        os.mkdir(mnt, 0o000)                         # the bare mount point: no one but root can write into it
    if os.path.islink(mnt) or not os.path.isdir(mnt):
        die(f"{mnt} must be a real directory")
    at = mounted_at(mnt)
    if at is not None:
        if at != majmin(top):
            die(f"{mnt} is mounted from another device ({at}); leaving it")
    else:
        if os.listdir(mnt):
            die(f"{mnt} is not empty: something wrote into the bare mount point (on the VM disk); investigate first")
        run("mount", "-t", "ext4", "-o", "noatime,nodev,nosuid", top, mnt)
        uw.mounted = mnt
    o = c["owner"]
    run("chown", f"{o}:{o}", mnt); os.chmod(mnt, 0o700)
    for d in c["dirs"]:
        os.makedirs(d, exist_ok=True); run("chown", f"{o}:{o}", d); os.chmod(d, 0o700)
    write_json(session_path(c), {"session": uuidlib.uuid4().hex, "top": top, "origin": dev})
    drop(c["watchFailureFile"])
    uw.attached, uw.mapped, uw.mounted = [], None, None
    print(json.dumps({"assembled": top, "mountPoint": mnt, "origin": dev, "cached": cached}))


def ext4_errors(top):
    try:
        with open(f"/sys/fs/ext4/{os.path.basename(os.path.realpath(top))}/errors_count") as f:
            return int(f.read().strip())
    except OSError:
        return None


def cmd_disassemble(c):
    cached = c["mechanism"] == "dm-cache"
    with open(c["attachConfig"]) as f:
        dev = json.load(f)["device"]
    # validate the complete ownership chain BEFORE the first destructive action
    top = None; remove_map = False
    if cached and run("dmsetup", "info", c["name"], check=False).returncode == 0:
        c["_D"], c["_M"] = loop_of(c["cdata"]), loop_of(c["cmeta"])
        if not (c["_D"] and c["_M"]):
            die(f"mapping {c['name']} exists but its cache loops are not ours: leaving it")
        if run("dmsetup", "table", c["name"]).stdout.strip() != expected_table(c, dev):
            die(f"mapping {c['name']} is not this storage's: leaving it")
        top, remove_map = f"/dev/mapper/{c['name']}", True
    elif not cached and os.path.exists(dev):
        top = dev
    mnt, healthy = c["mountPoint"], True
    at = mounted_at(mnt)
    if at is not None:
        if top is None or at != majmin(top):
            die(f"{mnt} is mounted but not from this storage's device: leaving it")
        errs = ext4_errors(top)
        failed = read_json(c["watchFailureFile"])
        healthy = errs == 0 and failed is None
        if run("umount", mnt, check=False, timeout=300).returncode != 0:
            die(f"unmount of {mnt} failed: stopping (nothing unmapped or detached)")
        if not healthy:
            log(f"session was not healthy (ext4 errors {errs}, supervisor failure {failed and failed.get('reason')}): no cache-reuse marker")
    else:
        healthy = False                              # no clean unmount observed by this run
    if remove_map:
        if run("dmsetup", "remove", c["name"], check=False).returncode != 0:
            die(f"dmsetup remove {c['name']} failed: stopping (loops kept)")
    if cached:
        drop(marker_path(c))
        if healthy:
            try:
                write_json(marker_path(c), {"fingerprint": sb_fingerprint(dev), "by": "clean disassemble"})
            except (OSError, Stop) as e:
                log(f"no marker: origin superblock unreadable ({e})")
        for f in (c["cmeta"], c["cdata"]):
            l = loop_of(f)
            if not l:
                continue
            busy = run("lsblk", "-nro", "MOUNTPOINTS", l).stdout.strip() or len(run("lsblk", "-nro", "NAME", l).stdout.split()) > 1
            if busy:
                die(f"{l} ({f}) is still mounted or held by another device: not detaching it (stopping)")
            run("losetup", "-d", l)
    drop(session_path(c))
    print(json.dumps({"disassembled": c["name"], "cacheReuseMarker": bool(cached and healthy)}))


def cmd_cache_loss(c, uw):
    if c["mechanism"] != "dm-cache":
        die("no cache configured")
    if mounted_at(c["mountPoint"]) is not None:
        die(f"{c['mountPoint']} is mounted: stop the consumers and run disassemble first")
    dev, _ = attach_view(c)
    if run("dmsetup", "info", c["name"], check=False).returncode == 0:
        c["_D"], c["_M"] = loop_of(c["cdata"]), loop_of(c["cmeta"])
        if not (c["_D"] and c["_M"]) or run("dmsetup", "table", c["name"]).stdout.strip() != expected_table(c, dev):
            die(f"mapping {c['name']} is not this storage's: leaving it")
        run("dmsetup", "remove", c["name"])
    if holders(dev) or mountpoints_of(dev):
        die(f"{dev} is in use; refusing")
    drop(marker_path(c))
    # INVALIDATE before the origin is touched: writethrough means the origin already holds every completed write
    with open(c["cmeta"], "r+b") as f:
        f.write(b"\0" * (8 << 20)); f.flush(); os.fsync(f.fileno())
    r = run("e2fsck", "-fn", dev, check=False, timeout=3600)
    write_json(marker_path(c), {"fingerprint": sb_fingerprint(dev), "by": "cache-loss", "fsckRc": r.returncode})
    print(json.dumps({"cacheInvalidated": c["cmeta"], "originFsckRc": r.returncode, "fsck": r.stdout[-400:],
                      "next": "the next assemble starts from an EMPTY cache"}))
    if r.returncode not in (0,):
        log("the read-only fsck reported problems: review before assemble (nothing was repaired)")


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr); return 64
    def on_signal(sig, _frame):   # a signal (systemd stop, hangup) takes the same unwind path as an error
        raise Stop(f"signal {signal.Signals(sig).name}")
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)
    uw = Unwind()
    try:
        c = load(argv[2])
        cmd = argv[1]
        if cmd == "create":
            cmd_create(c, argv[3:], uw)
        elif cmd == "assemble":
            cmd_assemble(c, uw)
        elif cmd == "disassemble":
            cmd_disassemble(c)
        elif cmd == "cache-loss":
            cmd_cache_loss(c, uw)
        elif cmd == "verify-cap":
            if c["mechanism"] == "dm-cache":
                os.execv(c["py"], [c["py"], "-I", c["budgetTool"], "verify", c["ledger"], c["reservation"]])
            print(json.dumps({"cache": "none", "nvmeBytes": 0}))
        else:
            print(__doc__, file=sys.stderr); return 64
    except (Stop, KeyboardInterrupt, subprocess.TimeoutExpired) as e:
        uw(str(e))
        log(str(e))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
