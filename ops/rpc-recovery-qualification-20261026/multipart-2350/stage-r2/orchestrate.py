#!/usr/bin/env python3
"""recovery-multipart-stage/r2 orchestrate.py (PREPARED by Claude 1748; NOT run by Claude). Standard library only.

The ONLY way a production manifest is copied or verified. One run = ONE r9 overlay session, owned by this process:
  1. a root-written PRESERVATION request (recovery-multipart-preservation-request/v1; purpose "preservation-copy", recoveryAccepted,
     productionUse and raidReset all JSON false) bound to the manifest sha, the overlay plan sha, the parent (original) path, and the
     sha256 of multipart.py, orchestrate.py and the r9 overlay_session.py. NOT the r8/r9 diagnostic MDBX request (another purpose).
  2. the frozen r9 stage is verified (its SHA256SUMS pin and every listed file); its overlay_session.py and our multipart.py are
     COPIED into this run's private dir, re-hashed, and only the copies are executed (no swap between check and exec)
  3. admission + the committed-part re-hash pre-pass run BEFORE any session exists (multipart.copy_run)
  4. only then: the copier listens (0700 socket dir), and the r9 session is started as OUR child (start_new_session; the handle is
     held and never reaped until it ends, so its pid cannot be reused) with exactly
       --exec /usr/bin/python3 -I -B RUN/multipart.py serve --socket-dir RUN/sock --expect-size L --session-run-dir RUN/session
  5. the ONE accepted peer must be that exec: SO_PEERCRED pid -> pidfd_open -> /proc/<pid>/stat ppid == our session child,
     cmdline exactly the argv above, environ exactly r9's {PATH, LC_ALL, RECOVERY_TARGET=RUN/session/work/mnt/data/db/mdbx.dat},
     start time read twice and the pidfd not yet readable (alive throughout); the hello must name that target with readOnly true and
     the identity / mnt_id we read ourselves: an lstat of the target, statvfs ST_RDONLY, and the mountinfo entry of
     RUN/session/work/mnt = fuse*, mount option ro, source RUN/session/work/view/nbd. Re-checked at every checkpoint.
     Anything else - another same-uid process, an earlier session, a stale mount, a plain file - refuses (fail closed).
  6. after the work the source sends Q, the session ends by itself (bounded; then TERM/KILL to OUR child's group only); its
     receipt.json must be the only receipt, rc 0, cleanupComplete, parentUnchanged, the pinned plan sha, exec rc 0 with exactly our
     argv and the accepted server pid, every check ok, no leftover process, the overlay deleted. Then session-<id>.json is written
     into every target as CONFIRMED (or UNCONFIRMED + reasons): records bound to an unconfirmed session never count (status).
Production additionally: --require-ro-mount on the session, the pinned plan dir / parent / fuse2fs, ONLY the production pins.
Fixture mode (tests): the same code with a fixture plan dir / parent (+ --parent-sha256) / fuse2fs given on the command line.
Exit: 0 work done AND session CONFIRMED; 3 refused; 4 failed or session UNCONFIRMED; 5 stopped (resumable)."""
import argparse, contextlib, hashlib, json, os, re, select, shutil, signal, stat, subprocess, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE); sys.dont_write_bytecode = True
import multipart as MP  # noqa: E402

W = MP._W
R9 = W + "/recovery-overlay-stage/r9"
PINS = {"r9Sums": "17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3",
        "overlaySessionSha256": "65d45ab79da8e134772374ec7298cd3a53fc54d68ecb3b3fd407eec4874a8153",
        "fuse2fs": "/home/steven/Documents/Codex/2026-10-26/my/work/tr004/fuse2fs-package/usr/bin/fuse2fs",
        "fuse2fsSha256": "6e3b5404898c2e55cb97b75c79f7bf067d1fa3381647b458fb7904b43bc4927b"}
PY3 = "/usr/bin/python3"
REQ_FORMAT, PURPOSE = "recovery-multipart-preservation-request/v1", "preservation-copy"
REQ_KEYS = {"format", "purpose", "kind", "mode", "recoveryAccepted", "productionUse", "raidReset", "manifestSha256", "planSha256",
            "parentPath", "multipartSha256", "orchestrateSha256", "overlaySessionSha256"}
SESSION_END_WAIT, KILL_WAIT = 900, 120


def validate_request(r, kind, mode, msha, plan_sha, parent, mp_sha, orch_sha, ovs_sha):
    if not isinstance(r, dict) or set(r) != REQ_KEYS or r["format"] != REQ_FORMAT or r["purpose"] != PURPOSE:
        MP.refuse("request: not exactly a recovery-multipart-preservation-request/v1 for purpose preservation-copy")
    for k in ("recoveryAccepted", "productionUse", "raidReset"):
        if r[k] is not False:
            MP.refuse(f"request: {k} must be JSON false")
    want = {"kind": kind, "mode": mode, "manifestSha256": msha, "planSha256": plan_sha, "parentPath": parent,
            "multipartSha256": mp_sha, "orchestrateSha256": orch_sha, "overlaySessionSha256": ovs_sha}
    bad = sorted(k for k, v in want.items() if r[k] != v)
    if bad:
        MP.refuse(f"request: not bound to this run: {bad}")
    return r


def verify_r9():
    sums = os.path.join(R9, "SHA256SUMS")
    raw = MP.read_small(sums, "r9 SHA256SUMS")
    if MP.sha(raw) != PINS["r9Sums"]:
        MP.refuse("frozen r9 SHA256SUMS changed")
    for line in raw.decode().splitlines():
        h, _, name = line.partition("  ")
        if MP.file_sha(os.path.normpath(os.path.join(R9, name)), "r9 file") != h:
            MP.refuse(f"frozen r9 file {name} changed")
    if MP.file_sha(os.path.join(R9, "overlay_session.py"), "overlay_session.py") != PINS["overlaySessionSha256"]:
        MP.refuse("r9 overlay_session.py is not the pinned one")


def private_copy(src, dst, want):
    b = MP.read_small(src, "code")
    if MP.sha(b) != want:
        MP.refuse(f"{src} is not the pinned code")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
    with os.fdopen(fd, "wb") as f:
        f.write(b); f.flush(); os.fsync(f.fileno())
    if MP.file_sha(dst, "copy") != want:
        MP.refuse("private code copy differs")


def unescape(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def mount_entry(mountpoint):
    """-> (mnt_id, fstype, source, per-mount options) of the exact mountpoint; exactly one entry or refused"""
    out = []
    with open("/proc/self/mountinfo") as f:
        for line in f:
            pre, _, post = line.rstrip("\n").partition(" - ")
            a, b = pre.split(), post.split()
            if len(a) >= 6 and len(b) >= 2 and unescape(a[4]) == mountpoint:
                out.append((int(a[0]), b[0], unescape(b[1]), a[5].split(",")))
    if len(out) != 1:
        MP.refuse(f"mountpoint {mountpoint}: {len(out)} mountinfo entries (need exactly 1)")
    return out[0]


def proc_stat(pid):
    with open(f"/proc/{pid}/stat") as f:
        s = f.read()
    rest = s[s.rindex(")") + 2:].split()
    return int(rest[1]), int(rest[19])                               # ppid (field 4), starttime (field 22)


def proc_list(pid, name):
    with open(f"/proc/{pid}/{name}", "rb") as f:
        raw = f.read()
    return [x.decode() for x in raw.split(b"\0")[:-1]] if raw.endswith(b"\0") else MP.refuse(f"/proc/{pid}/{name} malformed")


def alive_pidfd(pidfd):
    p = select.poll(); p.register(pidfd, select.POLLIN)
    return not p.poll(0)                                             # readable = the process exited


def child_running(pid):
    """our session child, never reaped here (WNOWAIT)"""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None
    except ChildProcessError:
        return False


class Provenance:
    """accepts ONLY the exec child of OUR session process; rechecked at every checkpoint"""
    def __init__(self, orch):
        self.o, self.pidfd, self.binding = orch, None, None

    def __call__(self, conn, pid, hello):
        o = self.o
        if not child_running(o.sess.pid):
            MP.refuse("the session process is not running")
        try:
            self.pidfd = os.pidfd_open(pid)
        except OSError as e:
            MP.refuse(f"peer pid {pid}: pidfd_open failed ({e.strerror})")
        try:
            ppid, start = proc_stat(pid)
            cmd, env = proc_list(pid, "cmdline"), proc_list(pid, "environ")
        except OSError as e:
            MP.refuse(f"peer {pid}: /proc unreadable ({e.strerror})")
        if ppid != o.sess.pid:
            MP.refuse(f"peer {pid} is not a child of our session {o.sess.pid} (ppid {ppid}): refused")
        if cmd != o.exec_argv:
            MP.refuse(f"peer {pid} cmdline differs from the session exec: {cmd}")
        if sorted(env) != sorted([f"PATH=/usr/bin:/bin", "LC_ALL=C", f"RECOVERY_TARGET={o.target}"]):
            MP.refuse(f"peer {pid} environment differs from the r9 exec environment: {env}")
        if proc_stat(pid) != (ppid, start) or not alive_pidfd(self.pidfd):
            MP.refuse(f"peer {pid} changed or exited during the provenance check")
        st = os.lstat(o.target)
        mid, fstype, src, opts = mount_entry(o.mnt)
        if not (stat.S_ISREG(st.st_mode) and st.st_size == o.d["source"]["logicalSize"] and os.statvfs(o.target).f_flag & os.ST_RDONLY):
            MP.refuse("the reconstructed target is not a regular file of the logical size on an ST_RDONLY mount")
        if not (fstype.startswith("fuse") and "ro" in opts and src == o.nbd):
            MP.refuse(f"the target mount is not the session's read-only fuse2fs view of {o.nbd}: {fstype} {src} {opts}")
        if hello.get("sourceKind") != "recovery-target" or hello.get("target") != o.target or hello.get("readOnly") is not True \
                or hello.get("identity") != MP.ident(st) or hello.get("mntId") != mid:
            MP.refuse("the server's hello does not match the target identity / mount we observe")
        self.pid, self.start, self.ident, self.mid = pid, start, MP.ident(st), mid
        self.binding = {"kind": "session", "sessionId": o.sid, "sessionRunDir": o.srun, "sessionPid": o.sess.pid,
                        "sessionStartTime": proc_stat(o.sess.pid)[1], "serverPid": pid, "serverStartTime": start, "target": o.target,
                        "targetIdentity": self.ident, "mntId": mid, "planSha256": o.d["source"]["planSha256"],
                        "parentPath": o.parent, "manifestSha256": o.msha, "requestSha256": o.req_sha, "mode": o.mode,
                        "overlaySessionSha256": PINS["overlaySessionSha256"], "multipartSha256": o.mp_sha}
        return self.binding

    def recheck(self):
        o = self.o
        if not child_running(o.sess.pid) or not alive_pidfd(self.pidfd) or proc_stat(self.pid)[1] != self.start:
            MP.fail("the session or its server ended or changed")
        if MP.ident(os.lstat(o.target)) != self.ident or mount_entry(o.mnt)[0] != self.mid:
            MP.fail("the reconstructed target's identity or mount changed")

    def close(self):
        if self.pidfd is not None:
            os.close(self.pidfd); self.pidfd = None


class Orchestrator:
    def __init__(self, a):
        self.a, self.sess, self.prov = a, None, None
        self.d, self.msha = MP.load_manifest(a.manifest, a.manifest_sha256)
        self.kind, self.mode = self.d["kind"], a.mode
        prod = self.kind == "production"
        if prod and (a.fixture_plan_dir or a.fixture_parent or a.fixture_parent_sha256 or a.fuse2fs or a.fuse2fs_sha256):
            MP.refuse("production: no fixture plan dir / parent / fuse2fs may be given (only the pins)")
        self.plan_dir = os.path.dirname(MP.PROD["planPath"]) if prod else a.fixture_plan_dir
        self.parent = MP.PROD["originalPath"] if prod else a.fixture_parent
        self.fuse2fs, self.fuse2fs_sha = (PINS["fuse2fs"], PINS["fuse2fsSha256"]) if prod else (a.fuse2fs, a.fuse2fs_sha256)
        if not (self.plan_dir and self.parent and self.fuse2fs and self.fuse2fs_sha):
            MP.refuse("fixture: --fixture-plan-dir, --fixture-parent, --fuse2fs and --fuse2fs-sha256 are required")
        plan_sha = MP.file_sha(os.path.join(self.plan_dir, "plan.json"), "plan.json")
        if plan_sha != self.d["source"]["planSha256"] or self.parent != self.d["source"]["originalPath"]:
            MP.refuse("the session's plan / parent are not the manifest's")
        verify_r9()
        self.mp_sha = MP.file_sha(os.path.join(HERE, "multipart.py"), "multipart.py")
        self.orch_sha = MP.file_sha(os.path.realpath(__file__), "orchestrate.py")
        raw = MP.read_small(a.request, "request")
        if MP.sha(raw) != a.request_sha256:
            MP.refuse("request sha256 differs from --request-sha256")
        self.req_sha = a.request_sha256
        try:
            req = json.loads(raw.decode())
        except (UnicodeDecodeError, ValueError):
            MP.refuse("request is not JSON")
        validate_request(req, self.kind, self.mode, self.msha, plan_sha, self.parent, self.mp_sha, self.orch_sha, PINS["overlaySessionSha256"])
        if prod and not (os.statvfs(self.parent).f_flag & os.ST_RDONLY):
            MP.refuse("production: the original is not on a read-only mount")
        MP.bind_inputs(self.d)
        # this run's private dir: NEW, 0700
        self.run = a.run_dir
        MP.no_symlink_ancestors(self.run, "--run-dir")
        os.mkdir(self.run, 0o700)
        self.sock, self.srun = os.path.join(self.run, "sock"), os.path.join(self.run, "session")
        os.mkdir(self.sock, 0o700); os.mkdir(self.srun, 0o700)
        private_copy(os.path.join(R9, "overlay_session.py"), os.path.join(self.run, "overlay_session.py"), PINS["overlaySessionSha256"])
        private_copy(os.path.join(HERE, "multipart.py"), os.path.join(self.run, "multipart.py"), self.mp_sha)
        self.sid = MP.run_id()
        self.mnt = os.path.join(self.srun, "work", "mnt")
        self.nbd = os.path.join(self.srun, "work", "view", "nbd")
        self.target = self.mnt + MP.TARGET_PATH
        self.exec_argv = [PY3, "-I", "-B", os.path.join(self.run, "multipart.py"), "serve", "--socket-dir", self.sock,
                          "--expect-size", str(self.d["source"]["logicalSize"]), "--session-run-dir", self.srun]

    def open_src(self):
        """called by multipart.copy_run / verify_run AFTER admission and the pre-pass: listen, start the session, accept the exec"""
        src = MP.SocketSource(self.sock, self.d["source"]["logicalSize"], expect_kind="recovery-target")
        try:
            cmd = [PY3, "-I", "-B", os.path.join(self.run, "overlay_session.py"), "--plan-dir", self.plan_dir,
                   "--plan-sha256", self.d["source"]["planSha256"], "--parent", self.parent, "--run-dir", self.srun,
                   "--fuse2fs", self.fuse2fs, "--fuse2fs-sha256", self.fuse2fs_sha, "--exec-timeout", str(self.a.exec_timeout)]
            if self.kind == "production":
                cmd.append("--require-ro-mount")
            elif self.a.fixture_parent_sha256:
                cmd += ["--parent-sha256", self.a.fixture_parent_sha256]
            log = open(os.path.join(self.run, "session.out"), "wb")
            with MP.critical():                                      # the handle is stored before any signal can be raised
                self.sess = subprocess.Popen(cmd + ["--exec", *self.exec_argv], stdin=subprocess.DEVNULL, stdout=log,
                                             stderr=subprocess.STDOUT, start_new_session=True, close_fds=True, cwd=self.run,
                                             env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
            log.close()
            self.prov = Provenance(self)
            src.provenance = self.prov
            src.accept(self.a.accept_timeout, alive=lambda: child_running(self.sess.pid))
            return src
        except BaseException:
            src.close(); raise

    def end_session(self):
        """after the source sent Q (or closed): the session ends by itself; bounded; only OUR child's group is ever signalled"""
        p = self.sess
        if p is None:
            return None
        end = time.monotonic() + SESSION_END_WAIT
        while child_running(p.pid) and time.monotonic() < end:
            time.sleep(0.5)
        for sig, wait in ((signal.SIGTERM, KILL_WAIT), (signal.SIGKILL, KILL_WAIT)):
            if not child_running(p.pid):
                break
            with contextlib.suppress(ProcessLookupError):
                os.killpg(p.pid, sig)                                # the leader is unreaped: its pgid is still ours
            end = time.monotonic() + wait
            while child_running(p.pid) and time.monotonic() < end:
                time.sleep(0.5)
        return p.wait(timeout=KILL_WAIT)

    def confirm(self, rc_session):
        """the r9 receipt decides; -> (status, reasons, receipt sha)"""
        reasons = []
        names = sorted(n for n in os.listdir(self.srun) if n.startswith("receipt"))
        if names != ["receipt.json"]:
            return "UNCONFIRMED", [f"receipts present: {names}"], None
        raw = MP.read_small(os.path.join(self.srun, "receipt.json"), "receipt")
        try:
            r = json.loads(raw.decode())
        except (UnicodeDecodeError, ValueError):
            return "UNCONFIRMED", ["receipt is not JSON"], MP.sha(raw)
        b = self.prov.binding if self.prov else None
        checks = [
            (rc_session == 0 and r.get("rc") == 0, f"session rc {rc_session} / receipt rc {r.get('rc')}"),
            (r.get("cleanupComplete") is True, "cleanupComplete is not true"),
            (r.get("parentUnchanged") is True, "parentUnchanged is not true"),
            (r.get("planSha256") == self.d["source"]["planSha256"], "receipt plan sha differs"),
            (isinstance(r.get("exec"), dict) and r["exec"].get("rc") == 0 and r["exec"].get("cmd") == self.exec_argv
             and not r["exec"].get("timedOut") and not r["exec"].get("groupLeftovers") and r["exec"].get("escapedKilled") == 0,
             "the exec did not end cleanly with exactly our argv"),
            (b is not None and r.get("children", {}).get("exec", {}).get("pid") == b["serverPid"], "the receipt's exec pid is not the accepted server"),
            (bool(r.get("checks")) and all(v.get("ok") for v in r["checks"].values()), "a session check failed"),
            (not r.get("leftoverProcesses"), "leftover processes"),
            (r.get("overlayDeleted") is True, "overlay not deleted"),
        ]
        reasons = [why for ok, why in checks if not ok]
        return ("CONFIRMED" if not reasons else "UNCONFIRMED"), reasons, MP.sha(raw)

    def record_session(self, status, reasons, rsha, rc_session):
        if self.prov is None or self.prov.binding is None:
            return                                                   # no server was ever accepted: nothing is bound to this session
        doc = {"format": MP.FMT["session"], "sessionId": self.sid, "status": status, "reasons": reasons, "receiptSha256": rsha,
               "sessionRc": rc_session, "binding": self.prov.binding}
        for name in sorted(self.d["targets"]):
            fd = MP.open_dir(self.d["targets"][name]["dir"], f"target {name}")
            try:
                if MP.exists_in(fd, MP.MARKER):
                    MP.write_state(fd, MP.session_name(self.sid), doc)
            finally:
                os.close(fd)
        fd = MP.open_dir(self.run, "run dir")
        try:
            MP.write_state(fd, "session-confirmation.json", doc)
        finally:
            os.close(fd)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    for k in ("--request", "--request-sha256", "--manifest", "--manifest-sha256", "--run-dir"):
        r.add_argument(k, required=True)
    r.add_argument("--mode", choices=("copy", "verify"), required=True); r.add_argument("--parts"); r.add_argument("--max-bytes", type=int)
    r.add_argument("--accept-timeout", type=int, default=900); r.add_argument("--exec-timeout", type=int, default=86400)
    for k in ("--fixture-plan-dir", "--fixture-parent", "--fixture-parent-sha256", "--fuse2fs", "--fuse2fs-sha256"):
        r.add_argument(k)
    a = ap.parse_args(argv)
    old = MP.install_signals()
    o, rc, out = None, 0, {}
    try:
        o = Orchestrator(a)
        parts = MP.select(o.d, a.parts)
        if a.mode == "copy":
            out["copied"] = MP.copy_run(o.d, o.msha, parts, o.open_src, a.max_bytes)
        else:
            out["verified"], out["run"] = MP.verify_run(o.d, o.msha, parts, o.open_src)
    except (MP.Refuse, MP.Fail, MP.Cancelled) as e:
        rc = e.rc; out["error"] = f"{type(e).__name__}: {e}"
    except OSError as e:
        rc = 4; out["error"] = f"OSError: {e}"
    finally:
        for sg in old:                                               # the session end and its confirmation are never interrupted
            signal.signal(sg, signal.SIG_IGN)
        try:
            if o is not None and o.sess is not None:
                rc_s = o.end_session()
                st, reasons, rsha = o.confirm(rc_s)
                o.record_session(st, reasons, rsha, rc_s)
                out["session"] = {"id": o.sid, "status": st, "reasons": reasons, "rc": rc_s}
                if st != "CONFIRMED" and rc == 0:
                    rc = 4
            if o is not None and o.prov is not None:
                o.prov.close()
            if o is not None:
                out["statusRecorded"] = MP.status(o.d, o.msha)
        finally:
            for sg, h in old.items():
                signal.signal(sg, h)
    print(json.dumps(out, default=str))
    return rc


if __name__ == "__main__":
    sys.exit(main())
