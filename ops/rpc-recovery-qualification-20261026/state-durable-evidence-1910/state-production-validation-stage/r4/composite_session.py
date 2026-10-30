# state-production-validation-stage/r1: composite-mdbx-validation-stage/r6 composite_session.py (407aa7e9...) + ONE seam:
# Session.exec_plan() supplies (argv, limit, report path) to Session.use(); use() keeps the report bytes (report_raw) and records
# reportPath; OUTPUT_NAMES gains state-report.json. EVERYTHING ELSE IS r6 BYTE-FOR-BYTE (tests/test_state.py test 1 proves it by AST).
#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r3 composite_session.py (prepared by Claude 1782/1785/1787; NOT run by Claude). Stdlib + pinned tools.
r3 = r2 + root review: B1 unmount() records ANY ordinary exception (missing / non-executable unmount program, OSError, ...) and
end_child() ends its child in a `finally`, so no unmount error can skip ending that same child; B2 cleanup acts ONLY on a work dir
THIS session created (owns_work, set together with the mkdir while signals are deferred); spawning (Popen + record) and binding
(pidfd + record) are also signal-deferred, so every started child and opened pidfd is known to cleanup; a run dir this session did
not claim (a previous run's outputs or work) gets a separate receipt-refused-<ns>.json and is otherwise left exactly as found.
r2 = r1 + review 1784: A2 every cleanup step is independent (an exception or a timed-out / failed unmount never skips ending the
remaining owned children, closing pidfds/logs or the leftover inspection; a mount left after its server was ended is lazily detached
with the pinned fusermount3 -u -z - our mount only - and the run stays CLEANUP-INCOMPLETE); m1 a run dir holding any previous output
(mdbx-report.json, validator.out, session.pid, receipt*) is refused; m2 CLEAN also requires the report's mdbxDatBytes == the view's
logical size (else INCONCLUSIVE).

ONE read-only diagnostic MDBX check of the composite mdbx.dat: the multipart VMDK FLAT view (multipart-validation-view-stage/r6,
records-bound) is exposed by our OWN foreground children - the pinned qemu-nbd --read-only (unix socket in our work dir) and the
pinned nbdfuse -r -C 1 -o ro as <work>/db/mdbx.dat on a READ-ONLY (ST_RDONLY) FUSE mount - and the PINNED read-only validator
wrapper (mdbx-recovery-validator-stage/r4 mdbx_check.py, unchanged) runs the PINNED official mdbx_chk (libmdbx v0.13.12) on <work>/db.
No ext4 reconstruction: the view's bytes ARE mdbx.dat. No part is written, chmod'ed or moved; the original is never read.

REUSED, not re-implemented (each loaded from the exact bytes whose sha256 is pinned below):
  * recovery-overlay-stage/r9 overlay_session.py: limits() (RLIMIT_FSIZE, no core, PR_SET_PDEATHSIG + parent check), exited_nowait()
    (waitid WNOWAIT), group_members(), stop_group() (wait, TERM, KILL the group while the leader is UNREAPED; reap last), mounted(),
    run(); and its control flow: subreaper, own process groups, validator group ended FIRST, then unmount, then servers (r9 F1)
  * multipart-validation-view-stage/r6 production_import.py: load_view (kind re-asserted), recheck (manifest, r3 recorded state,
    identities, record bytes, production binding shape) and check-held (EVERY fd of the PID: bound inodes + descriptor, O_RDONLY)

Sequence (any failure -> refusal or a failure outcome; the receipt is ALWAYS written):
  1. pins (scripts + binaries by sha256); the view: load_view(--expect-kind, default production) + recheck  [pre-use]
  2. qemu-nbd: our child, own group; bound by pidfd + /proc start time + exact cmdline + /proc/PID/exe == the pinned binary's inode;
     check-held (all fds O_RDONLY, every bound inode + the descriptor) BEFORE the mount
  3. nbdfuse: our foreground child (pid file == our child), bound the same way; the mount must be ST_RDONLY, hold exactly mdbx.dat
     of the view's logical size, and refuse an O_WRONLY open
  4. check-held again, then the validator (own group, bounded); its group and any escaped descendant are ended and reaped
  5. REQUIRED post-use: the qemu child is still the same process, check-held + recheck pass; otherwise the result is VOID
  6. cleanup ALWAYS: validator group, adopted orphans, fusermount3 -u of OUR mount, nbdfuse, qemu-nbd; no mount, no process naming
     the work dir may remain; the socket is removed
Outcomes (rc): CLEAN 0 (mdbx_chk rc 0, structurally clean, post-use recheck OK) | PROBLEMS 2 (mdbx_chk reported problems: rc 1/2/3)
| REFUSED 3 (nothing was used) | CLEANUP-INCOMPLETE 4 (stop and inspect) | CANCELLED 5 | EXEC-FAILED 6 (fixture exec only)
| INCONCLUSIVE 7 (timeout, truncated output, held/escaped output, mdbx_chk rc 4/5, wrapper refusal, missing report, leftovers)
| VOID 8 (the view or the held inodes changed: any validator result is discarded).
CLEAN means "mdbx_chk found no structural problem in this byte view": NOT chain verification, NOT state/trie/canonical-root
validation, NOT RPC or SNP readiness, NOT a recovery acceptance.

    composite_session.py --view-dir DIR --run-dir DIR [--expect-kind production|fixture] [--validator-timeout SEC]
                         [--exec-timeout SEC --fixture-exec CMD ...   (fixture kind ONLY: replaces the validator, tests)]
Stop: kill -TERM <the PID in RUN_DIR/session.pid> after checking its start time (jobs/stop-session.sh); never anyone else's PID.
"""
import argparse, contextlib, ctypes, hashlib, io, json, os, signal, stat, subprocess, sys, time, types

sys.dont_write_bytecode = True
W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
PINS = {
    "r9OverlaySession": (W + "/recovery-overlay-stage/r9/overlay_session.py", "65d45ab79da8e134772374ec7298cd3a53fc54d68ecb3b3fd407eec4874a8153"),
    "r6ViewDescriptor": (W + "/multipart-validation-view-stage/r6/view_descriptor.py", "23370c97956fb1a4dde30f4a657ca97e89ce452f1a982cfc29c36970113d39e0"),
    "r6Importer": (W + "/multipart-validation-view-stage/r6/production_import.py", "4d48f74ea0360db6b264fcef97750a5c83e3ba5f8ef47260864b93e940b1b2dc"),
    "mdbxCheckPy": (W + "/mdbx-recovery-validator-stage/r4/src/mdbx_check.py", "f0d27e40c29271b94d2b48b9d4ab70a84de1f946709db4e9361cdfba00bac131"),
    "mdbxChk": (W + "/mdbx-recovery-validator-stage/r4/runs/run-20261026T210943Z-2354169/bin/mdbx_chk",
                "c228b462c3c71c87b0fd2e9cfa6b3e6bccb2d793dd545bc6a18bef7113187981"),
    "qemuNbd": ("/usr/bin/qemu-nbd", "b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934"),
    "nbdfuse": ("/usr/bin/nbdfuse", "51c1a1fd18785d4fe2240c1710eb4f78590b9d333fcde4cda421871d6f010a01"),
    "fusermount3": ("/usr/bin/fusermount3", "c3d04bdf77c7152eba94ce670338e7089730b8dbfede57762b7b92c893a00f4f"),
}
PY3 = "/usr/bin/python3"
FORMAT = "composite-mdbx-validation-receipt/r2"
UNMOUNT_TIMEOUT, FIXTURE_UNMOUNT_TIMEOUT = 30, 3
OUTPUT_NAMES = ("receipt.json", "mdbx-report.json", "validator.out", "session.pid", "state-report.json")   # state r1: + the state report
SOCK_NAME, SOCK_ARG = "nbd.sock", "/proc/self/cwd/nbd.sock"     # r9 r5/r6: relative socket in cwd = work (sun_path 108 bytes)
CHILD_FSIZE = 64 << 20                                             # = r9 CAP_DEFAULT: no child file write may exceed it
WAIT, VALIDATOR_GRACE = 60, 600
NOT_CLAIMED = ["chain verification", "reth table semantics", "state / trie / canonical-root validation", "static_files segments",
               "value bytes inside structurally valid pages (MDBX has no per-page checksums)", "RPC readiness", "SNP readiness",
               "recovery acceptance"]


class Refused(Exception):
    pass


def read_all(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        out = b""
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                return out
            out += b
            if len(out) > cap:
                raise Refused(f"{path}: larger than {cap} bytes")
    finally:
        os.close(fd)


def file_sha(path, cap=64 << 20):
    h, n = hashlib.sha256(), 0
    with open(path, "rb", buffering=0) as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                return h.hexdigest()
            n += len(b)
            if n > cap:
                raise Refused(f"{path}: larger than {cap} bytes")
            h.update(b)


def load_pinned(name, modname):
    """a reused module compiled from exactly the bytes that were hashed (no second read, no bytecode)"""
    path, want = PINS[name]
    raw = read_all(path, 4 << 20)
    if hashlib.sha256(raw).hexdigest() != want:
        raise Refused(f"{name}: {path} is not the pinned file")
    mod = types.ModuleType(modname)
    mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


def start_time(pid):
    with open(f"/proc/{pid}/stat", "rb") as f:
        s = f.read(4096).decode(errors="replace")
    return int(s[s.rfind(")") + 2:].split()[19])


def classify(exec_info, report, post_ok, fixture_exec, expected_bytes=None):
    """-> (outcome, rc, reasons). Pure: the validator outcome AFTER cleanup / cancellation / refusal were handled by the caller"""
    if not post_ok:
        return "VOID", 8, ["post-use recheck or check-held failed: any validator result is discarded"]
    e = exec_info or {}
    if e.get("timedOut") or e.get("groupLeftovers") or e.get("escapedKilled") or not e.get("groupEmpty", True) or not e.get("orphansGone", True):
        return "INCONCLUSIVE", 7, ["the validator timed out or left descendants (all ended and reaped)"]
    if fixture_exec:
        return ("EXEC-OK", 0, []) if e.get("rc") == 0 else ("EXEC-FAILED", 6, [f"fixture exec rc {e.get('rc')}"])
    if not isinstance(report, dict):
        return "INCONCLUSIVE", 7, [f"no validator report (wrapper rc {e.get('rc')})"]
    flags = [k for k in ("timedOut", "outputTruncated", "stdoutHeldAfterExit", "escapedHolder") if report.get(k)]
    if flags or report.get("unchangedIdentity") is not True:
        return "INCONCLUSIVE", 7, [f"validator run not conclusive: {flags or ['db identity changed']}"]
    if report.get("rc") == 0 and report.get("structurallyClean") is True and e.get("rc") == 0:
        got = (report.get("preflight") or {}).get("mdbxDatBytes")
        if not isinstance(expected_bytes, int) or got != expected_bytes:            # m2: the check covered the WHOLE view
            return "INCONCLUSIVE", 7, [f"checked mdbx.dat bytes {got} != the view's logical size {expected_bytes}"]
        return "CLEAN", 0, []
    if report.get("rc") in (1, 2, 3):
        return "PROBLEMS", 2, [f"mdbx_chk rc {report['rc']} ({report.get('result')})"]
    return "INCONCLUSIVE", 7, [f"mdbx_chk rc {report.get('rc')} / wrapper rc {e.get('rc')}"]


class Stop(Exception):
    pass


_SIG = {"defer": 0, "pending": None, "armed": False}


def _on_signal(signum, _frame):
    if _SIG["defer"]:
        _SIG["pending"] = _SIG["pending"] or signum                  # B2: recorded; raised when the critical section ends
        return
    if _SIG["armed"]:
        raise Stop(f"signal {signum}")


@contextlib.contextmanager
def deferred():
    """a termination signal inside is only recorded: a resource and its ownership record are created together (never one alone)"""
    _SIG["defer"] += 1
    try:
        yield
    finally:
        _SIG["defer"] -= 1
        if not _SIG["defer"] and _SIG["pending"] is not None and _SIG["armed"]:
            signum, _SIG["pending"] = _SIG["pending"], None
            raise Stop(f"signal {signum}")


class Session:
    def __init__(self, a, R9, PI):
        self.a, self.R9, self.PI = a, R9, PI
        self.work = os.path.join(a.run_dir, "work")
        self.db, self.sock = os.path.join(self.work, "db"), os.path.join(self.work, SOCK_NAME)
        self.dat = os.path.join(self.db, "mdbx.dat")
        self.children, self.bind, self.logs = {}, {}, []
        self.receipt = {"format": FORMAT, "checks": {}, "steps": [], "notClaimed": NOT_CLAIMED, "kind": a.expect_kind}
        self.cleanup_ok, self.post_ok, self.exec_info, self.report = True, None, None, None
        self.owns_run = self.owns_work = False                                # B2: set only by THIS session's own creations

    def step(self, s):
        self.receipt["steps"].append([round(time.time(), 3), s])

    def check(self, name, ok, detail=None):
        self.receipt["checks"][name] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
        if not ok:
            raise Refused(f"check {name} failed: {detail}")

    # ---- 1. preparation (refusals; nothing exposed) -------------------------------------------------------------------------------
    def prepare(self, pins):
        a = self.a
        if not os.path.isabs(a.run_dir) or os.path.islink(a.run_dir) or not os.path.isdir(a.run_dir):
            raise Refused("run dir must be an existing absolute directory")
        st = os.stat(a.run_dir)
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise Refused("run dir must be this user's and private (0700)")
        old = [n for n in os.listdir(a.run_dir) if n == "work" or n in OUTPUT_NAMES or n.startswith("receipt")]
        if old:                                                              # m1: never read a previous run's output
            raise Refused(f"run dir already used (holds {sorted(old)}): one session per NEW run dir")
        with deferred():                                                     # B2: claim the run dir atomically (O_EXCL)
            fd = os.open(os.path.join(a.run_dir, "session.pid"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            self.owns_run = True
        os.write(fd, json.dumps({"pid": os.getpid(), "startTime": start_time(os.getpid())}).encode()); os.close(fd)
        if (a.fixture_exec or a.fixture_unmount_exe) and a.expect_kind != "fixture":
            raise Refused("--fixture-exec / --fixture-unmount-exe are for fixture views only; production always runs the pinned tools")
        if a.fixture_unmount_exe and not os.path.isabs(a.fixture_unmount_exe):
            raise Refused("--fixture-unmount-exe must be absolute")
        self.receipt["pins"] = pins
        self.step("view")
        self.view = self.PI.load_view(a.view_dir, a.expect_kind)        # kind re-asserted (default production)
        self.PI.recheck(self.view)                                        # pre-use: manifest, r3 state, identities, records
        self.receipt["view"] = {"dir": a.view_dir, "kind": self.view["kind"], "manifestSha256": self.view["manifestSha256"],
                                "descriptorSha256": self.view["descriptorSha256"], "logicalSize": self.view["logicalSize"],
                                "parts": len(self.view["parts"]),
                                "receiptSha256": hashlib.sha256(read_all(os.path.join(a.view_dir, "receipt.json"), 16 << 20)).hexdigest()}
        self.receipt["checks"]["preUseRecheck"] = {"ok": True}

    # ---- children (r9 pattern) ------------------------------------------------------------------------------------------------------
    def spawn(self, name, argv, cwd):
        with deferred():                                                     # B2: a started child is always recorded
            log = open(os.path.join(self.work, f"{name}.log"), "wb"); self.logs.append(log)
            c = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                 preexec_fn=self.R9.limits(CHILD_FSIZE), env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            self.children[name] = c
            self.receipt.setdefault("children", {})[name] = {"pid": c.pid, "argv": argv}
        return c

    def bind_child(self, name, exe):
        """pidfd + start time + exact cmdline + /proc/PID/exe == the pinned binary's inode"""
        c = self.children[name]
        with deferred():                                                     # an opened pidfd is always recorded (and closed by cleanup)
            pidfd = os.pidfd_open(c.pid)
            self.bind[name] = {"pidfd": pidfd, "startTime": None}
        cmd = read_all(f"/proc/{c.pid}/cmdline", 1 << 20)
        e, x = os.stat(f"/proc/{c.pid}/exe"), os.stat(exe)
        st = start_time(c.pid)
        want = b"\0".join(a.encode() for a in self.receipt["children"][name]["argv"]) + b"\0"
        self.bind[name] = {"pidfd": pidfd, "startTime": st}
        self.receipt["children"][name].update(startTime=st, exe=[e.st_dev, e.st_ino])
        self.check(f"{name}Bound", cmd == want and (e.st_dev, e.st_ino) == (x.st_dev, x.st_ino),
                   "cmdline / exe differ from what we spawned")

    def same(self, name):
        c, b = self.children[name], self.bind.get(name)
        if b is None or self.R9.exited_nowait(c.pid):
            return False
        try:
            signal.pidfd_send_signal(b["pidfd"], 0)
            return start_time(c.pid) == b["startTime"]
        except OSError:
            return False

    def held(self, label):
        """our unreaped qemu child is still the bound process, and r6 check-held passes (every fd O_RDONLY; all bound inodes held)"""
        ok = self.same("qemu-nbd")
        if ok:
            ns = argparse.Namespace(view_dir=self.a.view_dir, pid=self.children["qemu-nbd"].pid, expect_kind=self.a.expect_kind)
            with contextlib.redirect_stdout(io.StringIO()):
                try:
                    ok = self.PI.cmd_check_held(ns) == 0
                except Exception as e:                                    # noqa: BLE001 - a refusal of check-held
                    ok, self.receipt["checks"][label + "Error"] = False, f"{type(e).__name__}: {e}"[:300]
        return ok

    def wait_for(self, what, cond, name):
        end = time.monotonic() + WAIT
        while not cond():
            if self.R9.exited_nowait(self.children[name].pid):
                raise Refused(f"{name} exited before {what}")
            if time.monotonic() > end:
                raise Refused(f"timed out waiting for {what}")
            time.sleep(0.2)

    # ---- 2-3. exposure ----------------------------------------------------------------------------------------------------------------
    def expose(self):
        with deferred():                                                     # B2: the work dir and its ownership flag exist together
            os.mkdir(self.work, 0o700)
            self.owns_work = True
        os.mkdir(self.db, 0o700)
        self.step("qemu-nbd")
        self.spawn("qemu-nbd", [PINS["qemuNbd"][0], "--read-only", "--shared=1", f"--socket={SOCK_ARG}", "--image-opts",
                                self.view["imageOpts"]], cwd=self.work)
        self.wait_for("the nbd socket", lambda: os.path.exists(self.sock), "qemu-nbd")
        st = os.lstat(self.sock)
        self.check("socketOurs", stat.S_ISSOCK(st.st_mode) and st.st_uid == os.geteuid(), "not our socket")
        self.bind_child("qemu-nbd", PINS["qemuNbd"][0])
        self.check("heldBeforeMount", self.held("heldBeforeMount"), "check-held refused")
        self.step("nbdfuse")
        pidf = os.path.join(self.work, "nbdfuse.pid")
        self.spawn("nbdfuse", [PINS["nbdfuse"][0], "-r", "-C", "1", "-o", "ro", "-P", pidf, self.dat, "--unix", SOCK_ARG], cwd=self.work)
        self.wait_for("the nbdfuse mount", lambda: os.path.exists(pidf) and self.R9.mounted(self.db), "nbdfuse")
        self.check("nbdfuseForeground", int(self.R9.slurp(pidf, 64).strip() or 0) == self.children["nbdfuse"].pid, "it daemonized")
        self.bind_child("nbdfuse", PINS["nbdfuse"][0])
        self.check("mountReadOnly", bool(os.statvfs(self.db).f_flag & os.ST_RDONLY), "the FUSE mount is not ST_RDONLY")
        self.check("onlyMdbxDat", sorted(os.listdir(self.db)) == ["mdbx.dat"], sorted(os.listdir(self.db)))
        self.check("logicalSize", os.stat(self.dat).st_size == self.view["logicalSize"], os.stat(self.dat).st_size)
        try:
            os.close(os.open(self.dat, os.O_WRONLY)); refused = False
        except OSError:
            refused = True
        self.check("writeRefused", refused, "an O_WRONLY open of the exposed mdbx.dat succeeded")

    # ---- 4-5. use + REQUIRED post-use recheck -----------------------------------------------------------------------------------------
    def adopted(self):
        live = {c.pid for c in self.children.values() if c.returncode is None}
        return [p for p in self.R9.all_pids() if p not in live and (f := self.R9.proc_fields(p)) and f[1] == os.getpid()]

    def reap_adopted(self):
        killed = []
        for _ in range(5):
            pids = self.adopted()
            if not pids:
                break
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL); killed.append(pid)          # our adopted child: unreaped, so never reused
                except ProcessLookupError:
                    pass
            for pid in pids:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        self.receipt.setdefault("adoptedKilled", []).extend(killed)
        return not self.adopted()

    def exec_plan(self):
        """state r1 SEAM (the ONLY lifecycle change vs r6): -> (argv, limit seconds, report path). This default is r6's exact choice
        (the fixture exec, or the pinned mdbx_check wrapper + mdbx_chk writing <run_dir>/mdbx-report.json); a subclass may override it"""
        a = self.a
        report = os.path.join(a.run_dir, "mdbx-report.json")
        if a.fixture_exec:
            return a.fixture_exec, a.exec_timeout, report
        argv = [PY3, "-I", "-B", PINS["mdbxCheckPy"][0], "--chk", PINS["mdbxChk"][0], "--chk-sha256", PINS["mdbxChk"][1],
                "--db-dir", self.db, "--timeout", str(a.validator_timeout), "--out", report]
        return argv, a.validator_timeout + VALIDATOR_GRACE, report      # the wrapper ends its own mdbx_chk first

    def use(self):
        a = self.a
        self.check("heldBeforeExec", self.held("heldBeforeExec"), "check-held refused")
        self.report_raw = None                                           # state r1: the exact report bytes (for strict re-parsing)
        argv, limit, report = self.exec_plan()                           # state r1: argv AND report path from ONE seam
        self.receipt["reportPath"] = report
        self.step("validator")
        with open(os.path.join(a.run_dir, "validator.out"), "wb") as o:   # retained: the wrapper's / exec's complete output
            c = subprocess.Popen(argv, cwd=a.run_dir, stdin=subprocess.DEVNULL, stdout=o, stderr=subprocess.STDOUT, start_new_session=True,
                                 preexec_fn=self.R9.limits(CHILD_FSIZE),
                                 env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "RECOVERY_TARGET_DB": self.db})
            self.children["exec"] = c
            self.receipt.setdefault("children", {})["exec"] = {"pid": c.pid, "argv": argv}
            end, timed_out = time.monotonic() + limit, False
            while not self.R9.exited_nowait(c.pid):
                if time.monotonic() > end:
                    timed_out = True; break
                time.sleep(0.5)
            leftovers = self.R9.group_members(c.pid)
            empty = self.R9.stop_group(c, grace=0 if timed_out else 2)
            before = len(self.receipt.get("adoptedKilled", []))
            orphans_gone = self.reap_adopted()
        self.exec_info = {"rc": c.returncode, "timedOut": timed_out, "limitSeconds": limit, "groupLeftovers": leftovers,
                          "escapedKilled": len(self.receipt.get("adoptedKilled", [])) - before, "groupEmpty": empty, "orphansGone": orphans_gone}
        self.receipt["exec"] = self.exec_info
        if os.path.lexists(report):
            raw = read_all(report, 32 << 20)
            self.report_raw = raw                                        # state r1
            self.receipt["reportSha256"] = hashlib.sha256(raw).hexdigest()
            try:
                self.report = json.loads(raw)
            except ValueError:
                self.report = None
        self.step("post-use recheck")
        self.post_ok = self.held("postUse")                               # includes recheck before and after the fd scan
        self.receipt["checks"]["postUseRecheck"] = {"ok": self.post_ok}

    # ---- 6. cleanup (always) ----------------------------------------------------------------------------------------------------------
    def unmount(self, path, lazy=False):
        """-> True when OUR mount is gone. A timeout or failure is recorded (never raised). The FIRST, normal unmount may be replaced
        by --fixture-unmount-exe (fixture kind only: fault injection); the lazy fallback always uses the pinned fusermount3."""
        inj = self.a.fixture_unmount_exe if not lazy else None
        argv = [inj or PINS["fusermount3"][0], "-u"] + (["-z"] if lazy else []) + [path]
        key = "lazy" if lazy else "normal"
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=FIXTURE_UNMOUNT_TIMEOUT if inj else UNMOUNT_TIMEOUT,
                               stdin=subprocess.DEVNULL)
            self.receipt.setdefault("unmount", {})[key] = r.returncode if r.returncode == 0 else f"{r.returncode}: {r.stderr.strip()[:160]}"
        except subprocess.TimeoutExpired:                                    # subprocess.run killed and reaped the fusermount3 it started
            self.receipt.setdefault("unmount", {})[key] = "timeout"
        except Exception as e:                                               # noqa: BLE001 - B1: missing / unexecutable program, OSError...
            self.receipt.setdefault("unmount", {})[key] = f"error: {type(e).__name__}: {e}"[:200]
        return not self.R9.mounted(path)

    def end_child(self, name, mountpoint=None):
        """A2: ALWAYS ends our child's group (even after a failed / timed-out unmount); records instead of raising"""
        c = self.children.get(name)
        errors = self.receipt.setdefault("cleanupErrors", [])
        try:
            if mountpoint and self.R9.mounted(mountpoint) and not self.unmount(mountpoint):
                self.cleanup_ok = False                                      # the normal unmount failed: never a complete cleanup
        except Exception as e:                                               # noqa: BLE001 - B1: recorded; the child is still ended below
            self.cleanup_ok = False; errors.append(f"unmount {name}: {type(e).__name__}: {e}"[:300])
        finally:
            if c is not None:
                try:
                    empty = self.R9.stop_group(c, grace=20 if mountpoint else 0)   # our own group only; reaped leader: never signalled
                except Exception as e:                                       # noqa: BLE001
                    empty = False; errors.append(f"stop {name}: {type(e).__name__}: {e}"[:300])
                    with contextlib.suppress(Exception):                     # still OUR unreaped child: KILL its group and reap
                        if c.returncode is None and not self.R9.exited_nowait(c.pid):
                            os.killpg(c.pid, signal.SIGKILL)
                        if c.returncode is None:
                            c.wait(timeout=10)
                self.receipt["children"][name]["returncode"] = c.returncode
                if c.returncode is None or not empty:
                    self.cleanup_ok = False
        try:
            if mountpoint and self.R9.mounted(mountpoint):                   # the server is gone: detach OUR dead mount, stay incomplete
                self.cleanup_ok = False
                self.unmount(mountpoint, lazy=True)
        except Exception as e:                                               # noqa: BLE001
            self.cleanup_ok = False; errors.append(f"lazy {name}: {type(e).__name__}: {e}"[:300])

    def holders(self):
        mine = []
        for d in os.listdir("/proc"):
            if not d.isdigit() or int(d) == os.getpid():
                continue
            try:
                held = self.work.encode() in read_all(f"/proc/{d}/cmdline", 1 << 20)
                links = [f"/proc/{d}/cwd", f"/proc/{d}/root"]
                with contextlib.suppress(OSError):
                    links += [f"/proc/{d}/fd/{x}" for x in os.listdir(f"/proc/{d}/fd")[:4096]]
                for ln in links:
                    with contextlib.suppress(OSError):
                        if os.readlink(ln).startswith(self.work):
                            held = True; break
                if held:
                    mine.append(int(d))
            except (OSError, Refused):
                pass
        return mine

    def cleanup(self):
        """A2: every step runs even if an earlier one raised; any error is recorded and makes the cleanup incomplete"""
        self.step("cleanup")
        errors = self.receipt.setdefault("cleanupErrors", [])

        def safe(label, fn):
            try:
                if fn() is False:
                    self.cleanup_ok = False
            except Exception as e:                                           # noqa: BLE001
                self.cleanup_ok = False; errors.append(f"{label}: {type(e).__name__}: {e}"[:300])
        if "exec" in self.children:                                       # r9 F1: the validator and its descendants BEFORE any unmount
            safe("exec", lambda: self.end_child("exec"))
            safe("adopted-after-exec", self.reap_adopted)
        safe("nbdfuse", lambda: self.end_child("nbdfuse", self.db))
        safe("qemu-nbd", lambda: self.end_child("qemu-nbd"))
        for name, b in self.bind.items():
            safe(f"pidfd {name}", lambda b=b: os.close(b["pidfd"]))
        for log in self.logs:
            safe("log", log.close)
        safe("adopted-final", self.reap_adopted)
        def unlink_sock():
            if os.path.lexists(self.sock):
                os.unlink(self.sock)
        safe("socket", unlink_sock)
        safe("holders", lambda: self.receipt.__setitem__("leftoverProcesses", self.holders()))
        safe("mounts", lambda: self.receipt.__setitem__("mountLeft", self.R9.mounted(self.db)))
        safe("children", lambda: self.receipt.__setitem__("childrenAlive",
                                                          [n for n, c in self.children.items() if c.returncode is None]))
        if self.receipt.get("leftoverProcesses", [None]) or self.receipt.get("mountLeft", True) or self.receipt.get("childrenAlive", [None]):
            self.cleanup_ok = False
        self.receipt["cleanupComplete"] = self.cleanup_ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--view-dir", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--expect-kind", choices=("production", "fixture"), default="production")
    ap.add_argument("--validator-timeout", type=int, default=7 * 86400); ap.add_argument("--exec-timeout", type=int, default=600)
    ap.add_argument("--fixture-unmount-exe")                              # fixture kind only: replaces the FIRST unmount (fault injection)
    ap.add_argument("--fixture-exec", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    if not 1 <= a.validator_timeout <= 7 * 86400 or not 1 <= a.exec_timeout <= 86400:
        print("validator timeout 1..604800, exec timeout 1..86400", file=sys.stderr); return 2
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:       # PR_SET_CHILD_SUBREAPER (r9)
        print("cannot become a child subreaper", file=sys.stderr); return 2
    s, rc, refused, interrupted = None, 3, None, None

    _SIG.update(defer=0, pending=None, armed=True)
    old = {sig: signal.signal(sig, _on_signal) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    receipt = {"format": FORMAT, "kind": a.expect_kind}
    try:
        try:
            pins = {}
            for k, (p, h) in PINS.items():
                if file_sha(p) != h:
                    raise Refused(f"{k}: {p} is not the pinned file")
                pins[k] = {"path": p, "sha256": h}
            R9 = load_pinned("r9OverlaySession", "r9_overlay_session")
            sys.path.insert(0, os.path.dirname(PINS["r6Importer"][0]))    # its `import view_descriptor` = the pinned file above
            PI = load_pinned("r6Importer", "r6_production_import")
            s = Session(a, R9, PI); receipt = s.receipt
            s.prepare(pins)
            s.expose()
            s.use()
        except Stop as e:
            interrupted = str(e)
        except Exception as e:                                             # noqa: BLE001 - every failure is a refusal / failure outcome
            refused = f"{type(e).__name__}: {e}"[:500]
        finally:
            for sig in old:                                                # the cleanup itself is never interrupted
                signal.signal(sig, signal.SIG_IGN)
            _SIG["armed"] = False
            if _SIG["pending"] is not None and not interrupted:              # a signal recorded inside a critical section
                interrupted = f"signal {_SIG['pending']}"
            if s is not None and s.owns_work:                                # B2: ONLY a work dir THIS session created
                try:
                    s.cleanup()
                except BaseException as e:                                 # noqa: BLE001 - cleanup() records per step; this is a last resort
                    s.cleanup_ok = False; receipt["cleanupError"] = f"{type(e).__name__}: {e}"[:300]; receipt["cleanupComplete"] = False
            else:
                receipt["cleanupComplete"] = True                          # nothing was exposed
        if not receipt.get("cleanupComplete"):
            outcome, rc, reasons = "CLEANUP-INCOMPLETE", 4, ["cleanup incomplete: stop and inspect; never re-run over this run dir"]
        elif interrupted:
            outcome, rc, reasons = "CANCELLED", 5, [interrupted]
        elif refused and (s is None or s.exec_info is None):
            outcome, rc, reasons = "REFUSED", 3, [refused]
        elif refused:
            outcome, rc, reasons = "INCONCLUSIVE", 7, [refused]
        else:
            outcome, rc, reasons = classify(s.exec_info, s.report, s.post_ok, bool(a.fixture_exec), s.view["logicalSize"])
        receipt.update(outcome=outcome, rc=rc, reasons=reasons, refused=refused, interrupted=interrupted)
        if s is not None and s.report is not None:
            receipt["validatorReport"] = {k: s.report.get(k) for k in ("rc", "result", "structurallyClean", "timedOut", "outputTruncated",
                                                                        "unchangedIdentity", "seconds", "preflight")}
        data = (json.dumps(receipt, indent=1, sort_keys=True, default=str) + "\n").encode()
        if os.path.isdir(a.run_dir) and not os.path.islink(a.run_dir):
            owned = s is not None and s.owns_run                              # B2: never take a receipt name in a run dir we did not claim
            name = "receipt.json" if owned and not os.path.lexists(os.path.join(a.run_dir, "receipt.json")) else f"receipt-refused-{time.time_ns()}.json"
            fd = os.open(os.path.join(a.run_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.write(fd, data); os.close(fd)
        print(json.dumps({k: receipt.get(k) for k in ("outcome", "rc", "reasons", "cleanupComplete")}))
    finally:
        for sig, h in old.items():
            signal.signal(sig, h)
    return rc


if __name__ == "__main__":
    sys.exit(main())
