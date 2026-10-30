#!/usr/bin/env python3
"""recovery-overlay-stage/r2 overlay_session.py (prepared by Claude 1660/1674; NOT run by Claude). Standard library + pinned tools.
r2: HARD pre-write bounds (<= 64 non-overlapping patches, <= 1 MiB, a worst-case qcow2 growth estimate within the cap BEFORE any
file is created) and RLIMIT_FSIZE = the cap (and no core files) on EVERY child, so no file a child writes can exceed it; --require-
ro-mount (real): the parent's filesystem must be ST_RDONLY before and after; every child (servers, short tools, --exec) runs in its
OWN process group and is signalled only as a group while its leader is still our UNREAPED child (waitid WNOWAIT), and this process
is a child SUBREAPER, so orphaned descendants (a validator's background or double-forked processes) become our children and are
killed and reaped; --exec failure or timeout gives rc 6.
r2 (da 1671): B1 SIGTERM/SIGINT/SIGHUP run the full cleanup (rc 5) and every child carries PR_SET_PDEATHSIG=SIGTERM (a SIGKILLed
session still ends them; libfuse unmounts on TERM); waits are <= 5 s per phase; B2 the leftover scan also reads /proc/*/{cwd,root,fd}
links into the work dir; B3 --plan-sha256 binds the plan; B4 nbdfuse -C 1 (qemu-nbd --shared=1); N1 the pinned fuse2fs is copied
(bounded) into the private work dir, sha-verified, and THAT copy is executed.
r9 (review 1712 F1): cleanup() FIRST ends a still-running --exec validator group (an interrupt or OSError can leave use() while the
validator holds the read-only view open) and reaps its adopted escaped descendants, and ONLY THEN unmounts fuse2fs/nbdfuse and ends
qemu-nbd - so a cancellation is a clean rc 5, not an EBUSY unmount and rc 4.
r5 (root 1692): AF_UNIX paths are limited to 108 bytes and the run dir can be deeper: qemu-nbd and nbdfuse are spawned with
cwd = our private work dir and use the RELATIVE socket name nbd.sock there (self.sock stays absolute for checks and cleanup; every
image, mount and pid-file path stays absolute). No new external path, no /tmp.
r6 (root 1697): qemu-nbd requires an ABSOLUTE socket path, so both children get SOCK_ARG = "/proc/self/cwd/nbd.sock" (23 bytes):
the kernel resolves /proc/self/cwd per process to its cwd = our work dir (qemu and libnbd use the string as the sun_path; neither
canonicalizes it). self.sock (the full path) is checked to be a SOCKET owned by us in the work dir before nbdfuse connects.

ONE disposable, read-only recovery view of ONE deleted file, from a verified plan (overlay_plan.py):
  1. the PARENT image is opened only read-only (never writable by this user: refused otherwise); its identity is recorded before and
     re-checked after (dev, ino, size, mtime_ns, ctime_ns; plus a full sha256 when --parent-sha256 is given - the fixture)
  2. a NEW qcow2 overlay in the run's private work dir (qemu-img create -u -F qcow2 -b PARENT): the parent is never opened for writing
  3. qemu-io writes EXACTLY the plan's patch sources (sha-verified) at their offsets INTO THE OVERLAY ONLY (backing read-only,
     backing locking off: the parent sits on a read-only mount and other read-only users must not be disturbed); then the overlay
     must be <= the cap (default 64 MiB) and pass qemu-img check
  4. exposure, all read-only and all OUR OWN foreground children (never --fork, never a daemon; signalled only through the Popen
     handle we hold, so a PID is never reused under us): qemu-nbd --read-only (unix socket in the work dir), nbdfuse -r (the raw
     disk as a file), the pinned fuse2fs -f -o ro,norecovery,fakeroot (no journal replay, no write path)
  5. checks: every patched region reads back exactly; writes to the nbd file and to the mount are refused; the target is a regular
     file of the plan's size; fixture: its whole sha256 equals the expected; real: bounded samples read through the filesystem
     equal the same blocks read at the restored map's physical addresses (the view uses the restored map)
  6. optional --exec CMD (a read-only validator; RECOVERY_TARGET=<path>), bounded, or --hold-seconds with a stop file
  7. cleanup ALWAYS: fusermount3 -u of OUR two mountpoints only, our children reaped (TERM, then KILL, via our handles), our socket
     removed, the overlay DELETED unless --keep-overlay; then no process may still name the work dir, and the parent is unchanged
NEVER: a read-write mount, journal replay, a guest boot, a write to the parent, a peer's mount/socket/process. Diagnostic only.

    overlay_session.py --plan-dir DIR --parent IMG --run-dir DIR --fuse2fs BIN --fuse2fs-sha256 H [--parent-sha256 H]
                       [--cap-bytes N] [--exec CMD ...] [--hold-seconds N] [--keep-overlay]
Exit 0 every check passed and cleanup is complete; 1 a check failed (receipt says which; cleanup complete); 3 refused before
exposure (cleanup complete); 4 cleanup INCOMPLETE (stop and inspect: never re-run over it); 6 the --exec validator failed, timed out
or left descendants (all killed and reaped; cleanup complete); 5 interrupted by SIGTERM/SIGINT/SIGHUP (cleanup complete).
"""
import argparse, ctypes, errno, hashlib, json, os, re, resource, signal, stat, subprocess, sys, time

BLOCK = 4096
CAP_DEFAULT = 64 << 20
MIN_FREE = 1 << 30
FIXTURE_FULL_READ_MAX = 256 << 20
FUSE2FS_OPTS = "ro,norecovery,fakeroot,cache_size=64M"
ACCEPTANCE = "DIAGNOSTIC RECOVERY VIEW ONLY: not a recovery, restore or production acceptance; the data blocks are not authenticated"
WAIT = 60
CLUSTER = 65536
MAX_PATCHES, MAX_PATCH_BYTES = 64, 1 << 20
PR_SET_CHILD_SUBREAPER, PR_SET_PDEATHSIG = 36, 1
SOCK_NAME = "nbd.sock"                                          # the socket file, in our work dir
SOCK_ARG = "/proc/self/cwd/" + SOCK_NAME                         # r6: absolute for qemu-nbd, resolved per process to cwd = work
_LIBC = ctypes.CDLL(None, use_errno=True)


class Stop(Exception):
    """a termination signal: run the full cleanup"""


def limits(fsize):
    """preexec for every child: no file it writes may exceed fsize bytes (EFBIG / SIGXFSZ), no core file, and SIGTERM when this
    session dies (PR_SET_PDEATHSIG; if the session already died before the prctl, the child exits at once)"""
    parent = os.getpid()

    def apply():
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if _LIBC.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != parent:
            os._exit(125)
    return apply


def proc_fields(pid):
    """(state, ppid, pgrp, session) from /proc/PID/stat, or None"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            st = f.read(4096).decode(errors="replace")
    except OSError:
        return None
    rest = st[st.rfind(")") + 2:].split()
    return rest[0], int(rest[1]), int(rest[2]), int(rest[3])


def all_pids():
    return [int(d) for d in os.listdir("/proc") if d.isdigit()]


def group_members(pgid):
    return [p for p in all_pids() if p != pgid and (f := proc_fields(p)) and f[2] == pgid and f[0] != "Z"]


def exited_nowait(pid):
    """has our child exited? WITHOUT reaping it (its PID - and so its process-group id - stays reserved)"""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def stop_group(c, grace):
    """c: our Popen leader of its own process group, NOT yet reaped. Wait `grace` for a clean exit, then TERM, then KILL the whole
    group (the leader's zombie keeps the pgid reserved); reap the leader last. -> True when the group is empty."""
    if c.returncode is not None:
        return not group_members(c.pid)
    end = time.monotonic() + min(grace, 5)
    while time.monotonic() < end and not exited_nowait(c.pid):
        time.sleep(0.2)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if exited_nowait(c.pid) and not group_members(c.pid):
            break
        try:
            os.killpg(c.pid, sig)
        except ProcessLookupError:
            pass
        end = time.monotonic() + 5
        while time.monotonic() < end and not (exited_nowait(c.pid) and not group_members(c.pid)):
            time.sleep(0.2)
    empty = exited_nowait(c.pid) and not group_members(c.pid)
    if exited_nowait(c.pid):
        c.wait(timeout=5)
    return empty


class Refused(Exception):
    pass


def sha256_file(path, limit):
    h, n = hashlib.sha256(), 0
    with open(path, "rb", buffering=0) as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                return h.hexdigest()
            n += len(b)
            if n > limit:
                raise Refused(f"{path} is larger than {limit} bytes")
            h.update(b)


def slurp(path, limit):
    with open(path, "rb") as f:
        return f.read(limit)


def mounted(path):
    with open("/proc/self/mountinfo") as f:
        for line in f:
            mp = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), line.split()[4])   # mountinfo octal escapes
            if mp == path:
                return True
    return False


def ident(st):
    return {"dev": st.st_dev, "ino": st.st_ino, "size": st.st_size, "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}


def run(cmd, timeout=120, fsize=CAP_DEFAULT):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
                       preexec_fn=limits(fsize), start_new_session=True)
    return r.returncode, r.stdout, r.stderr


def image_opts(overlay, parent, read_only):
    for p in (overlay, parent):
        if "," in p or not os.path.isabs(p):
            raise Refused(f"path {p!r} must be absolute and contain no comma (qemu option syntax)")
    o = (f"driver=qcow2,file.driver=file,file.filename={overlay},backing.driver=qcow2,backing.read-only=on,"
         f"backing.file.driver=file,backing.file.filename={parent},backing.file.locking=off")
    return o + (",read-only=on" if read_only else "")


class Session:
    def __init__(self, a):
        self.a, self.children, self.receipt, self.cleanup_ok = a, {}, {"acceptance": ACCEPTANCE, "checks": {}, "steps": []}, True
        self.logs = []
        self.work = os.path.join(a.run_dir, "work")
        self.overlay = os.path.join(self.work, "overlay.qcow2")
        self.sock = os.path.join(self.work, SOCK_NAME)
        self.view = os.path.join(self.work, "view")
        self.mnt = os.path.join(self.work, "mnt")
        self.nbd = os.path.join(self.view, "nbd")

    def step(self, s):
        self.receipt["steps"].append([round(time.time(), 3), s])

    def check(self, name, ok, detail=None):
        self.receipt["checks"][name] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
        return ok

    # ---- preparation (refusals) -------------------------------------------------------------------------------------------------
    def prepare(self):
        a = self.a
        if not os.path.isabs(a.run_dir) or not os.path.isdir(a.run_dir) or os.path.islink(a.run_dir):
            raise Refused("run dir must be an existing absolute directory")
        st = os.stat(a.run_dir)
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Refused("run dir must be this user's and private (0700)")
        if os.path.lexists(self.work):
            raise Refused("run dir already has a work dir: one session per run dir, never over a previous one")
        if os.statvfs(a.run_dir).f_bavail * os.statvfs(a.run_dir).f_frsize < MIN_FREE:
            raise Refused("less than 1 GiB free for the overlay work dir")
        if sha256_file(a.fuse2fs, 16 << 20) != a.fuse2fs_sha256:
            raise Refused("fuse2fs binary is not the pinned one")
        plan_b = slurp(os.path.join(a.plan_dir, "plan.json"), 16 << 20)
        self.receipt["planSha256"] = hashlib.sha256(plan_b).hexdigest()
        if self.receipt["planSha256"] != a.plan_sha256:
            raise Refused("plan.json is not the pinned --plan-sha256 (the plan dir is owner-writable: it must be bound)")
        self.plan = json.loads(plan_b)
        if self.plan.get("format") != "recovery-overlay-plan/v1" or self.plan["fs"]["fsOffset"] != 0:
            raise Refused("not a recovery-overlay-plan/v1 plan for a filesystem at offset 0")
        self.sources = []
        if len(self.plan["patches"]) > MAX_PATCHES:
            raise Refused(f"{len(self.plan['patches'])} patches exceed the hard bound {MAX_PATCHES}")
        for p in self.plan["patches"]:
            fn = os.path.join(a.plan_dir, "sources", p["source"])
            b = slurp(fn, p["length"] + 1)
            if len(b) != p["length"] or hashlib.sha256(b).hexdigest() != p["sha256"] or not 0 < p["length"] <= BLOCK or p["byteOffset"] < 0:
                raise Refused(f"patch source {p['source']} is not its planned bytes")
            self.sources.append((p, fn, b))
        # the parent: read-only for us, identity recorded
        fd = os.open(a.parent, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            pst = os.fstat(fd)
        finally:
            os.close(fd)
        if not stat.S_ISREG(pst.st_mode):
            raise Refused("parent is not a regular file")
        if os.access(a.parent, os.W_OK):
            raise Refused("parent is WRITABLE by this user: refused (it must be read-only: 0444 or a read-only mount)")
        self.parent_pre = ident(pst)
        self.receipt["parentPre"] = self.parent_pre
        if a.parent_sha256:
            got = sha256_file(a.parent, 1 << 30)
            if got != a.parent_sha256:
                raise Refused("parent sha256 is not the expected one")
        rc, out, err = run(["qemu-img", "info", "-U", "--output=json", a.parent])
        if rc:
            raise Refused(f"qemu-img info on the parent failed: {err.strip()[:200]}")
        info = json.loads(out)
        need = self.plan["fs"]["fsBlocks"] * BLOCK
        if info.get("format") != "qcow2" or "backing-filename" in info or info.get("virtual-size", 0) < need:
            raise Refused("parent must be a qcow2 without its own backing file, holding the whole filesystem")
        self.vsize = info["virtual-size"]
        for p, _fn, _b in self.sources:
            if p["byteOffset"] + p["length"] > need:
                raise Refused("a patch lies outside the filesystem")
        # r2 HARD pre-write bounds: total bytes, no overlap, and a worst-case overlay size within the cap before anything is created
        spans = sorted((p["byteOffset"], p["byteOffset"] + p["length"]) for p, _fn, _b in self.sources)
        if sum(e - b for b, e in spans) > MAX_PATCH_BYTES or any(spans[i][1] > spans[i + 1][0] for i in range(len(spans) - 1)):
            raise Refused("patches exceed 1 MiB or overlap")
        clusters = {o // CLUSTER for b, e in spans for o in (b, e - 1)}
        l2 = {o // (CLUSTER * CLUSTER // 8) for b, e in spans for o in (b, e - 1)}
        l1 = -(-(-(-self.vsize // (CLUSTER * CLUSTER // 8)) * 8) // CLUSTER)
        estimate = CLUSTER * (1 + l1 + 2 + len(clusters) + len(l2)) + (1 << 20)      # header, L1, refcounts, data, L2, slack
        self.receipt["overlayEstimate"] = estimate
        if estimate > a.cap_bytes:
            raise Refused(f"worst-case overlay estimate {estimate} exceeds the cap {a.cap_bytes} (nothing created)")
        if a.require_ro_mount and not os.statvfs(a.parent).f_flag & os.ST_RDONLY:
            raise Refused("the parent's filesystem is not mounted read-only (ST_RDONLY), as the real original must be")

    # ---- overlay -----------------------------------------------------------------------------------------------------------------
    def build_overlay(self):
        os.mkdir(self.work, 0o700); os.mkdir(self.view, 0o700); os.mkdir(self.mnt, 0o700)
        self.step("overlay create")
        rc, _o, err = run(["qemu-img", "create", "-q", "-f", "qcow2", "-u", "-F", "qcow2", "-b", self.a.parent,
                           "-o", "cluster_size=65536", self.overlay, str(self.vsize)], fsize=self.a.cap_bytes)
        if rc:
            raise Refused(f"qemu-img create failed: {err.strip()[:200]}")
        rc, out, err = run(["qemu-img", "info", "-U", "--output=json", self.overlay])
        info = json.loads(out) if rc == 0 else {}
        if info.get("backing-filename") != self.a.parent or info.get("virtual-size") != self.vsize:
            raise Refused("the overlay is not backed by exactly the parent")
        self.step("overlay patch")
        cmd = ["qemu-io", "--image-opts", image_opts(self.overlay, self.a.parent, read_only=False)]
        for p, fn, _b in self.sources:
            cmd += ["-c", f"write -q -s {fn} {p['byteOffset']} {p['length']}"]
        rc, out, err = run(cmd, timeout=300, fsize=self.a.cap_bytes)        # RLIMIT_FSIZE: the overlay can never pass the cap
        if rc or any(w in (out + err).lower() for w in ("error", "failed", "cannot", "denied")):
            raise Refused(f"qemu-io patch failed: {(out + err).strip()[:300]}")
        st = os.stat(self.overlay)
        size = max(st.st_size, st.st_blocks * 512)
        self.receipt["overlayBytes"] = size
        if not self.check("overlayWithinCap", size <= self.a.cap_bytes, size):
            raise Refused(f"overlay {size} bytes exceeds the cap {self.a.cap_bytes}")
        rc, out, err = run(["qemu-img", "check", "-U", "--output=json", self.overlay])
        if not self.check("overlayQcowCheck", rc == 0, (out or err).strip()[:300]):
            raise Refused("qemu-img check of the overlay failed")

    # ---- exposure (our own foreground children only) -----------------------------------------------------------------------------
    def spawn(self, name, cmd, cwd=None):
        log = open(os.path.join(self.work, name + ".out"), "wb")
        self.logs.append(log)
        self.children[name] = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd=cwd,
                                               preexec_fn=limits(self.a.cap_bytes))
        self.receipt.setdefault("children", {})[name] = {"pid": self.children[name].pid, "cmd": cmd, "cwd": cwd}

    def wait_for(self, what, cond, child):
        end = time.monotonic() + WAIT
        while time.monotonic() < end:
            if cond():
                return
            if self.children[child].poll() is not None:
                raise Refused(f"{child} exited ({self.children[child].returncode}) before {what}")
            time.sleep(0.2)
        raise Refused(f"timed out waiting for {what}")

    def expose(self):
        self.step("qemu-nbd")
        if os.path.dirname(self.sock) != self.work or not os.path.isdir(self.work):
            raise Refused("internal: the socket must be in our own work dir")
        self.spawn("qemu-nbd", ["qemu-nbd", "--read-only", "--shared=1", f"--socket={SOCK_ARG}", "--image-opts",
                                image_opts(self.overlay, self.a.parent, read_only=True)], cwd=self.work)   # relative socket, r5
        self.wait_for("the nbd socket", lambda: os.path.exists(self.sock), "qemu-nbd")
        self.step("nbdfuse")
        pidf = os.path.join(self.work, "nbdfuse.pid")
        st = os.lstat(self.sock)                                    # r6: the bound path is OUR socket in OUR work dir
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid():
            raise Refused("the nbd socket in the work dir is not a socket of this user")
        self.spawn("nbdfuse", ["nbdfuse", "-r", "-C", "1", "-P", pidf, self.view, "--unix", SOCK_ARG],   # one connection: --shared=1
                   cwd=self.work)                                                  # the same relative socket, same cwd
        self.wait_for("the nbdfuse mount", lambda: os.path.exists(pidf) and mounted(self.view), "nbdfuse")
        if int(slurp(pidf, 64).strip() or 0) != self.children["nbdfuse"].pid:
            raise Refused("nbdfuse is not our foreground child (it daemonized): refusing to continue")
        if os.stat(self.nbd).st_size != self.vsize:
            raise Refused("the nbd view is not the overlay's virtual size")
        self.step("fuse2fs")
        b = slurp(self.a.fuse2fs, 16 << 20)                      # N1: a private, verified copy is what runs (no swap after the check)
        priv = os.path.join(self.work, "fuse2fs")
        fd = os.open(priv, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
        try:
            os.write(fd, b)
        finally:
            os.close(fd)
        if hashlib.sha256(slurp(priv, 16 << 20)).hexdigest() != self.a.fuse2fs_sha256:
            raise Refused("the private fuse2fs copy is not the pinned binary")
        self.spawn("fuse2fs", [priv, self.nbd, self.mnt, "-f", "-o", FUSE2FS_OPTS])
        self.wait_for("the fuse2fs mount", lambda: mounted(self.mnt), "fuse2fs")

    def refuses_write(self, fn, create=False):
        flag_sets = (os.O_WRONLY | os.O_CREAT | os.O_EXCL,) if create else (os.O_WRONLY, os.O_RDWR, os.O_WRONLY | os.O_CREAT)
        for flags in flag_sets:
            try:
                fd = os.open(fn, flags | os.O_CLOEXEC, 0o600)
            except OSError as e:
                if e.errno not in (errno.EROFS, errno.EACCES, errno.EPERM):
                    return False, f"unexpected errno {e.errno}"
                continue
            os.close(fd)
            return False, f"opened for writing with flags {flags}"
        return True, None

    def checks(self):
        plan, t = self.plan, self.plan["target"]
        fd = os.open(self.nbd, os.O_RDONLY | os.O_CLOEXEC)
        try:
            bad = [p["source"] for p, _fn, b in self.sources if os.pread(fd, p["length"], p["byteOffset"]) != b]
            self.check("patchesReadBack", not bad, bad or None)
        finally:
            os.close(fd)
        self.check("nbdRefusesWrite", *self.refuses_write(self.nbd))
        target = self.mnt + t["path"]
        st = os.stat(target)
        self.check("targetRegularAndSized", stat.S_ISREG(st.st_mode) and st.st_size == t["size"], {"size": st.st_size})
        self.check("targetRefusesWrite", *self.refuses_write(target))
        try:
            os.mkdir(os.path.join(self.mnt, "recovery-overlay-write-probe"))
            self.check("mountRefusesMkdir", False, "mkdir succeeded")
        except OSError as e:
            self.check("mountRefusesMkdir", e.errno in (errno.EROFS, errno.EACCES, errno.EPERM), e.errno)
        self.check("newFileRefused", *self.refuses_write(os.path.join(self.mnt, "recovery-overlay-new-probe"), create=True))
        if "expectedSha256" in t:                                # the fixture: the whole file, exactly
            if t["size"] > FIXTURE_FULL_READ_MAX:
                raise Refused("fixture target too large for a full read")
            got = sha256_file(target, FIXTURE_FULL_READ_MAX)
            self.check("targetExact", got == t["expectedSha256"], got)
        tfd, dfd = os.open(target, os.O_RDONLY | os.O_CLOEXEC), os.open(self.nbd, os.O_RDONLY | os.O_CLOEXEC)
        try:                                                     # bounded: the view reads the RESTORED map's physical blocks
            diff = []
            for l, p in plan["samples"]:
                n = min(BLOCK, t["size"] - l * BLOCK)
                if n <= 0:
                    continue
                if os.pread(tfd, n, l * BLOCK) != os.pread(dfd, n, p * BLOCK):
                    diff.append([l, p])
            self.check("samplesFollowRestoredMap", not diff, diff[:8] or len(plan["samples"]))
        finally:
            os.close(tfd); os.close(dfd)

    def adopted(self):
        """processes whose parent is THIS process but that are not our live Popen children: orphans we adopted as subreaper"""
        live = {c.pid for c in self.children.values() if c.returncode is None}
        return [p for p in all_pids() if p not in live and (f := proc_fields(p)) and f[1] == os.getpid()]

    def reap_adopted(self):
        """kill and reap adopted orphans: they are OUR children until reaped, so their PIDs cannot have been reused"""
        killed = []
        for _ in range(5):
            pids = self.adopted()
            if not pids:
                break
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL); killed.append(pid)
                except ProcessLookupError:
                    pass
            for pid in pids:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        self.receipt.setdefault("adoptedKilled", []).extend(killed)
        return not self.adopted()

    def use(self):
        """-> True when the use succeeded (no exec, or exec rc 0 within its timeout)"""
        a = self.a
        if a.exec:
            self.step("exec")
            env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "RECOVERY_TARGET": self.mnt + self.plan["target"]["path"]}
            with open(os.path.join(a.run_dir, "exec.out"), "wb") as o:
                c = subprocess.Popen(a.exec, env=env, cwd=a.run_dir, stdin=subprocess.DEVNULL, stdout=o, stderr=subprocess.STDOUT,
                                     start_new_session=True, preexec_fn=limits(a.cap_bytes))
                self.children["exec"] = c
                self.receipt.setdefault("children", {})["exec"] = {"pid": c.pid, "cmd": a.exec}
                end, timed_out = time.monotonic() + a.exec_timeout, False
                while not exited_nowait(c.pid):
                    if time.monotonic() > end:
                        timed_out = True; break
                    time.sleep(0.5)
                leftovers = group_members(c.pid)
                empty = stop_group(c, grace=0 if timed_out else 2)        # the validator's whole group, never anyone else's
                before = len(self.receipt.get("adoptedKilled", []))
                orphans_gone = self.reap_adopted()                       # descendants that escaped the group (setsid, double fork)
                escaped = len(self.receipt.get("adoptedKilled", [])) - before
                self.receipt["children"]["exec"]["returncode"] = c.returncode
                self.receipt["exec"] = {"cmd": a.exec, "rc": c.returncode, "timedOut": timed_out, "timeout": a.exec_timeout,
                                        "groupLeftovers": leftovers, "escapedKilled": escaped, "groupEmpty": empty, "orphansGone": orphans_gone}
                # a validator that left ANY descendant behind is a failure too (they were killed and reaped)
                return c.returncode == 0 and not timed_out and not leftovers and escaped == 0 and empty and orphans_gone

        elif a.hold_seconds:
            self.step("hold")
            stop, end = os.path.join(a.run_dir, "STOP"), time.monotonic() + a.hold_seconds
            self.receipt["hold"] = {"mount": self.mnt, "stopFile": stop}
            while time.monotonic() < end and not os.path.exists(stop):
                time.sleep(1)
        return True

    # ---- cleanup (always) ----------------------------------------------------------------------------------------------------------
    def end_child(self, name, unmount=None):
        c = self.children.get(name)
        if unmount and mounted(unmount):
            rc, _o, err = run(["fusermount3", "-u", unmount], timeout=30)
            self.receipt.setdefault("unmount", {})[name] = rc if rc == 0 else f"{rc}: {err.strip()[:120]}"
        if c is None:
            return
        empty = stop_group(c, grace=20 if unmount else 0)                # signals only our own group (leader unreaped)
        self.receipt["children"][name]["returncode"] = c.returncode
        if c.returncode is None or not empty or (unmount and mounted(unmount)):
            self.cleanup_ok = False

    def cleanup(self):
        self.step("cleanup")
        if "exec" in self.children:                                 # r9 F1: the validator (and anything it left) before any unmount
            self.end_child("exec")
            if not self.reap_adopted():
                self.cleanup_ok = False
        self.end_child("fuse2fs", self.mnt)
        self.end_child("nbdfuse", self.view)
        self.end_child("qemu-nbd")
        for log in self.logs:
            log.close()
        for mp in (self.mnt, self.view):
            if mounted(mp):
                self.cleanup_ok = False
        if not self.reap_adopted():                                       # orphans of any child, adopted by us
            self.cleanup_ok = False
        if os.path.lexists(self.sock):
            os.unlink(self.sock)
        if os.path.exists(self.overlay) and not self.a.keep_overlay and self.cleanup_ok:
            os.unlink(self.overlay)
        self.receipt["overlayDeleted"] = not os.path.exists(self.overlay)
        mine = []                                                # nothing may still name or hold our work dir (B2)
        for d in os.listdir("/proc"):
            if not d.isdigit() or int(d) == os.getpid():
                continue
            try:
                held = self.work.encode() in slurp(f"/proc/{d}/cmdline", 1 << 20)
                links = [f"/proc/{d}/cwd", f"/proc/{d}/root"]
                try:
                    links += [f"/proc/{d}/fd/{x}" for x in os.listdir(f"/proc/{d}/fd")[:4096]]
                except OSError:
                    pass
                for ln in links:
                    try:
                        if os.readlink(ln).startswith(self.work):
                            held = True; break
                    except OSError:
                        pass
                if held:
                    mine.append(int(d))
            except OSError:
                pass
        self.receipt["leftoverProcesses"] = mine
        if mine:
            self.cleanup_ok = False
        try:
            post = ident(os.stat(self.a.parent))
        except OSError as e:
            post = {"error": e.strerror}
        same = post == self.parent_pre if hasattr(self, "parent_pre") else None
        if same and self.a.parent_sha256:
            same = sha256_file(self.a.parent, 1 << 30) == self.a.parent_sha256
        if self.a.require_ro_mount:
            same = bool(same) and bool(os.statvfs(self.a.parent).f_flag & os.ST_RDONLY)
        self.receipt["parentPost"], self.receipt["parentUnchanged"] = post, same
        if same is False:
            self.cleanup_ok = False
        self.receipt["cleanupComplete"] = self.cleanup_ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan-dir", required=True); ap.add_argument("--parent", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--fuse2fs", required=True); ap.add_argument("--fuse2fs-sha256", required=True)
    ap.add_argument("--plan-sha256", required=True)
    ap.add_argument("--parent-sha256"); ap.add_argument("--cap-bytes", type=int, default=CAP_DEFAULT)
    ap.add_argument("--hold-seconds", type=int, default=0); ap.add_argument("--exec-timeout", type=int, default=86400)
    ap.add_argument("--keep-overlay", action="store_true"); ap.add_argument("--require-ro-mount", action="store_true")
    ap.add_argument("--exec", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    if not 0 < a.cap_bytes <= CAP_DEFAULT or not 0 <= a.hold_seconds <= 86400 or not 0 < a.exec_timeout <= 86400:
        print("cap must be in (0, 64 MiB]; hold in [0, 86400]; exec timeout in (0, 86400]", file=sys.stderr); return 2
    # r2: orphaned descendants of ANY child are re-parented to this process, so they can be killed and reaped safely
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        print("cannot become a child subreaper (prctl)", file=sys.stderr); return 2
    s, rc = Session(a), 0

    def stop(signum, _frame):
        raise Stop(f"signal {signum}")
    old = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        s.prepare()
        s.build_overlay()
        s.expose()
        s.checks()
        rc = 0 if all(v["ok"] for v in s.receipt["checks"].values()) else 1
        if rc == 0 and not s.use():
            rc = 6                                               # the validator failed, timed out or left descendants
    except Stop as e:
        s.receipt["interrupted"] = str(e)
        rc = 5
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        s.receipt["refused"] = f"{type(e).__name__}: {e}"
        rc = 3 if not s.receipt["checks"].get("patchesReadBack") else 1
    finally:
        for sig in old:                                          # the cleanup itself is never interrupted by another signal
            signal.signal(sig, signal.SIG_IGN)
        if os.path.isdir(s.work):
            s.cleanup()
        else:
            s.receipt["cleanupComplete"] = True                  # nothing was created
        if not s.receipt["cleanupComplete"]:
            rc = 4
        s.receipt["rc"] = rc
        data = json.dumps(s.receipt, indent=1, sort_keys=True, default=str).encode()
        if os.path.isdir(a.run_dir):
            name = "receipt.json" if not os.path.lexists(os.path.join(a.run_dir, "receipt.json")) else f"receipt-{time.time_ns()}.json"
            fd = os.open(os.path.join(a.run_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.write(fd, data); os.close(fd)
        print(json.dumps({k: s.receipt.get(k) for k in ("rc", "refused", "interrupted", "cleanupComplete", "parentUnchanged", "overlayBytes")}))
        for sig, h in old.items():
            signal.signal(sig, h)
    return rc


if __name__ == "__main__":
    sys.exit(main())
