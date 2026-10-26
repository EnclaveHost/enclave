#!/usr/bin/env python3
"""recovery-overlay-stage/r1 overlay_session.py (prepared by Claude 1660; NOT run by Claude). Standard library + pinned tools.

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
exposure (cleanup complete); 4 cleanup INCOMPLETE (stop and inspect: never re-run over it).
"""
import argparse, errno, hashlib, json, os, re, signal, stat, subprocess, sys, time

BLOCK = 4096
CAP_DEFAULT = 64 << 20
MIN_FREE = 1 << 30
FIXTURE_FULL_READ_MAX = 256 << 20
FUSE2FS_OPTS = "ro,norecovery,fakeroot,cache_size=64M"
ACCEPTANCE = "DIAGNOSTIC RECOVERY VIEW ONLY: not a recovery, restore or production acceptance; the data blocks are not authenticated"
WAIT = 60


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


def run(cmd, timeout=120):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
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
        self.sock = os.path.join(self.work, "nbd.sock")
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
        self.plan = json.loads(plan_b)
        self.receipt["planSha256"] = hashlib.sha256(plan_b).hexdigest()
        if self.plan.get("format") != "recovery-overlay-plan/v1" or self.plan["fs"]["fsOffset"] != 0:
            raise Refused("not a recovery-overlay-plan/v1 plan for a filesystem at offset 0")
        self.sources = []
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

    # ---- overlay -----------------------------------------------------------------------------------------------------------------
    def build_overlay(self):
        os.mkdir(self.work, 0o700); os.mkdir(self.view, 0o700); os.mkdir(self.mnt, 0o700)
        self.step("overlay create")
        rc, _o, err = run(["qemu-img", "create", "-q", "-f", "qcow2", "-u", "-F", "qcow2", "-b", self.a.parent,
                           "-o", "cluster_size=65536", self.overlay, str(self.vsize)])
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
        rc, out, err = run(cmd, timeout=300)
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
    def spawn(self, name, cmd):
        log = open(os.path.join(self.work, name + ".out"), "wb")
        self.logs.append(log)
        self.children[name] = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.receipt.setdefault("children", {})[name] = {"pid": self.children[name].pid, "cmd": cmd}

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
        self.spawn("qemu-nbd", ["qemu-nbd", "--read-only", "--shared=1", f"--socket={self.sock}", "--image-opts",
                                image_opts(self.overlay, self.a.parent, read_only=True)])
        self.wait_for("the nbd socket", lambda: os.path.exists(self.sock), "qemu-nbd")
        self.step("nbdfuse")
        pidf = os.path.join(self.work, "nbdfuse.pid")
        self.spawn("nbdfuse", ["nbdfuse", "-r", "-P", pidf, self.view, "--unix", self.sock])
        self.wait_for("the nbdfuse mount", lambda: os.path.exists(pidf) and mounted(self.view), "nbdfuse")
        if int(slurp(pidf, 64).strip() or 0) != self.children["nbdfuse"].pid:
            raise Refused("nbdfuse is not our foreground child (it daemonized): refusing to continue")
        if os.stat(self.nbd).st_size != self.vsize:
            raise Refused("the nbd view is not the overlay's virtual size")
        self.step("fuse2fs")
        self.spawn("fuse2fs", [self.a.fuse2fs, self.nbd, self.mnt, "-f", "-o", FUSE2FS_OPTS])
        self.wait_for("the fuse2fs mount", lambda: mounted(self.mnt), "fuse2fs")

    def refuses_write(self, fn):
        for flags in (os.O_WRONLY, os.O_RDWR, os.O_WRONLY | os.O_CREAT):
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
        self.check("newFileRefused", *self.refuses_write(os.path.join(self.mnt, "recovery-overlay-new-probe")))
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

    def use(self):
        a = self.a
        if a.exec:
            self.step("exec")
            env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "RECOVERY_TARGET": self.mnt + self.plan["target"]["path"]}
            with open(os.path.join(a.run_dir, "exec.out"), "wb") as o:
                try:
                    r = subprocess.run(a.exec, env=env, cwd=a.run_dir, stdin=subprocess.DEVNULL, stdout=o, stderr=subprocess.STDOUT,
                                       timeout=a.exec_timeout, start_new_session=True)
                    self.receipt["exec"] = {"cmd": a.exec, "rc": r.returncode}
                except subprocess.TimeoutExpired:
                    self.receipt["exec"] = {"cmd": a.exec, "rc": None, "timeout": a.exec_timeout}
        elif a.hold_seconds:
            self.step("hold")
            stop, end = os.path.join(a.run_dir, "STOP"), time.monotonic() + a.hold_seconds
            self.receipt["hold"] = {"mount": self.mnt, "stopFile": stop}
            while time.monotonic() < end and not os.path.exists(stop):
                time.sleep(1)

    # ---- cleanup (always) ----------------------------------------------------------------------------------------------------------
    def end_child(self, name, unmount=None):
        c = self.children.get(name)
        if unmount and mounted(unmount):
            rc, _o, err = run(["fusermount3", "-u", unmount], timeout=30)
            self.receipt.setdefault("unmount", {})[name] = rc if rc == 0 else f"{rc}: {err.strip()[:120]}"
        if c is None:
            return
        for sig, wait in ((None, 20), (signal.SIGTERM, 10), (signal.SIGKILL, 10)):
            if sig is not None and c.poll() is None:
                c.send_signal(sig)                               # our own unreaped child: its PID cannot have been reused
            try:
                c.wait(timeout=wait); break
            except subprocess.TimeoutExpired:
                continue
        self.receipt["children"][name]["returncode"] = c.returncode
        if c.returncode is None or (unmount and mounted(unmount)):
            self.cleanup_ok = False

    def cleanup(self):
        self.step("cleanup")
        self.end_child("fuse2fs", self.mnt)
        self.end_child("nbdfuse", self.view)
        self.end_child("qemu-nbd")
        for log in self.logs:
            log.close()
        for mp in (self.mnt, self.view):
            if mounted(mp):
                self.cleanup_ok = False
        if os.path.lexists(self.sock):
            os.unlink(self.sock)
        if os.path.exists(self.overlay) and not self.a.keep_overlay and self.cleanup_ok:
            os.unlink(self.overlay)
        self.receipt["overlayDeleted"] = not os.path.exists(self.overlay)
        mine = []                                                # nothing may still name our work dir
        for d in os.listdir("/proc"):
            if d.isdigit() and int(d) != os.getpid():
                try:
                    if self.work.encode() in slurp(f"/proc/{d}/cmdline", 1 << 20):
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
        self.receipt["parentPost"], self.receipt["parentUnchanged"] = post, same
        if same is False:
            self.cleanup_ok = False
        self.receipt["cleanupComplete"] = self.cleanup_ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan-dir", required=True); ap.add_argument("--parent", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--fuse2fs", required=True); ap.add_argument("--fuse2fs-sha256", required=True)
    ap.add_argument("--parent-sha256"); ap.add_argument("--cap-bytes", type=int, default=CAP_DEFAULT)
    ap.add_argument("--hold-seconds", type=int, default=0); ap.add_argument("--exec-timeout", type=int, default=86400)
    ap.add_argument("--keep-overlay", action="store_true"); ap.add_argument("--exec", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    if not 0 < a.cap_bytes <= CAP_DEFAULT or not 0 <= a.hold_seconds <= 86400:
        print("cap must be in (0, 64 MiB]; hold in [0, 86400]", file=sys.stderr); return 2
    s, rc = Session(a), 0
    try:
        s.prepare()
        s.build_overlay()
        s.expose()
        s.checks()
        rc = 0 if all(v["ok"] for v in s.receipt["checks"].values()) else 1
        if rc == 0:
            s.use()
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        s.receipt["refused"] = f"{type(e).__name__}: {e}"
        rc = 3 if not s.receipt["checks"].get("patchesReadBack") else 1
    finally:
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
        print(json.dumps({k: s.receipt.get(k) for k in ("rc", "refused", "cleanupComplete", "parentUnchanged", "overlayBytes")}))
    return rc


if __name__ == "__main__":
    sys.exit(main())
