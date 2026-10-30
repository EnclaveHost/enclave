#!/usr/bin/env python3
"""composite-memory-fixture-stage/r4 memory_fixture.py (prepared by Claude 1810/1813/1821; NOT run by Claude).
r4 = r3 + ONE fix (actual cmf-r3-tests KeyError): the peaks keys are exactly sample()'s walker{VmRSS,RssFile,VmPTE}KiB. Stdlib + pinned tools/helpers.

r2 = r1 (d888cfef...) + review 1811 / root: F1 the job wrapper is `timeout -s TERM -k 120 780` (TERM -> our ordered cancel; KILL of
this controller 120 s later if it is stuck) and the controller's nominal budget is 660 s (walk ends by 660 - 150 s cleanup reserve);
F2 the remaining root recovery reservation is the PINNED 1773 runner's part_state (every root part not r3-validated committed counts
in full) plus an explicit fixture write bound (64 MiB image cap + 3 x 4 MiB child logs (RLIMIT_FSIZE lowered from 64 MiB) + 16 MiB
metadata), independent of the 8 GiB native-build reservation; F3 MemoryHigh is set on the WHOLE queue scope (documented below and in
the receipt); F4 drive() holds the real cancellation / finally / outcome / receipt path (unit-tested); root: a refusal in a run dir
this controller did NOT claim writes NOTHING there (the summary goes to stdout only); F6 no smaps_rollup (Pss) sampling.

A bounded SYNTHETIC mechanism measurement (review 1806, root 1809): what memcg MemoryHigh on OUR OWN queue scope does while a child
touches every 4 KiB page of an 8 GiB read-only FUSE mapping, and what the cgroup (current/high/max/events/stat incl. pagetables) and
the per-process meters (VmRSS/RssFile/RssAnon/VmPTE, the outer guard's tree-VmRSS sum) show. NOT an MDBX check, NOT a production
qualification.

LIMITS (root 1809, review 1811):
  * MemoryHigh is a reclaim/THROTTLE threshold, NOT a ceiling; it can be exceeded
  * it applies to the WHOLE transient queue scope - the queue's node memory-guard, the job bash, this controller, qemu-nbd, nbdfuse and
    the walker, and the page cache / page tables charged to it: all of them can be throttled above 512 MiB. That can delay the OUTER
    guard's own sampling/kill and the servers the walker waits on (priority inversion -> TIMEOUT). A MEASURED result describes
    whole-scope throttling, not walker-only reclaim
  * the scope's memory.max (768) OOM victim is NOT guaranteed to be the walker; cleanup never assumes one
  * the 0.25 s soft stop RACES the outer guard (250 ms) and other host allocations; VmRSS also counts shared pages per process and
    shared pages charged to OTHER cgroups, so SOFT-STOP (rc 6) is a realistic outcome, not MEASURED by default
  * the wrapper KILL (if the controller is stuck past 900 s) skips our ordered cleanup: the servers then end by PDEATHSIG only and a
    dead FUSE mount / unkillable (D-state) process may remain - the job records CLEANUP-INCOMPLETE and any mount left. No absolute
    bound exists for a D-state process; the main-lane flock is released when the queue's guard exits after its own SIGKILL sweep
  * page-table growth is MEASURED, never asserted; the data is synthetic, not MDBX

    memory_fixture.py --run-dir NEW_EMPTY_DIR --tree-root-pid PID
"""
import argparse, contextlib, ctypes, hashlib, json, os, re, signal, stat, subprocess, sys, time, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
STAGE = os.path.dirname(os.path.realpath(__file__))
OUT_B = os.path.dirname(os.path.dirname(W)) + "/outputs/rpc-production-final-20261025/base-multipart-production-20261026"
PINS = {
    "r6Runtime": (W + "/composite-mdbx-validation-stage/r6/composite_session.py", "407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6"),
    "runner1773": (W + "/jobs/root-multipart-batches-1773.py", "5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a"),
    "r3Core": (W + "/recovery-multipart-stage/r3/multipart.py", "3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381"),
    "manifest": (OUT_B + "/manifest.json", "f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9"),
    "walker": (STAGE + "/walker.py", "bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113"),
    "systemctl": ("/usr/bin/systemctl", "6e727451366c75070ab02f02d945e3c83f8774ddf7e1661c5d71cbbf0d59b3cc"),
    "python3": ("/usr/bin/python3", "375532f83be620283ab780c14ca6bcc5907dc379d2b621de0c5d0a112cf5458b"),
}
FORMAT = "composite-memory-fixture-receipt/r2"
MIB = 1 << 20
LANE_MIB, HIGH_MIB, FLOOR_MIB, ADMIT_HEADROOM_MIB = 768, 512, 16384, 256
SOFT_TREE_RSS_MIB, SOFT_AVAIL_MIB = 640, FLOOR_MIB + 512
IMAGE_BYTES, ALLOC_CAP, ROOT_RESERVE = 8 << 30, 64 << 20, 8 << 30
LOG_CAP = 4 << 20                                                    # RLIMIT_FSIZE of every child (r6 CHILD_FSIZE overridden: 64 -> 4 MiB)
FIXTURE_WRITE_BOUND = ALLOC_CAP + 3 * LOG_CAP + (16 << 20)          # image + qemu-nbd/nbdfuse/walker logs + walker copy/receipts/pid
ROOT_MAJMIN = "253:0"
TOTAL_BUDGET, CLEANUP_RESERVE, POLL, SAMPLE_EVERY, MAX_SAMPLES = 660, 150, 0.25, 2.0, 340
WRAPPER = {"termAtSeconds": 780, "killGraceSeconds": 120, "killAtSeconds": 900}   # jobs/run-fixture.sh: timeout -s TERM -k 120 780
CG = "/sys/fs/cgroup"
STAT_KEYS = ("anon", "file", "file_mapped", "pagetables", "sec_pagetables", "kernel", "shmem", "slab", "active_file", "inactive_file")
SCOPE_RE = r"/user\.slice/user-{uid}\.slice/user@{uid}\.service/(?:[A-Za-z0-9_.@-]+\.slice/)*(run-[A-Za-z0-9_-]+\.scope)"
LIMITS = ["MemoryHigh is a reclaim/throttle threshold, not a ceiling",
          "MemoryHigh applies to the WHOLE queue scope (node memory-guard, job bash, controller, qemu-nbd, nbdfuse, walker): the outer "
          "guard and the servers can be throttled too; a result describes whole-scope throttling, not walker-only reclaim",
          "the memory.max OOM victim is not guaranteed",
          "the 0.25 s soft stop races the outer 250 ms guard and other host allocations; VmRSS counts shared pages per process and pages "
          "charged elsewhere: SOFT-STOP is a realistic outcome",
          "a wrapper KILL (stuck controller) skips ordered cleanup: servers end by PDEATHSIG only; a dead mount / D-state process may remain",
          "page-table growth is measured, not asserted", "synthetic zero-filled sparse data, not MDBX"]


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


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
                refuse(f"{path}: larger than {cap} bytes")
    finally:
        os.close(fd)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def load_exact(name, modname):
    """a reused module compiled from exactly the bytes that were hashed (no second read, no bytecode)"""
    path, want = PINS[name]
    raw = read_all(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned file")
    mod = types.ModuleType(modname); mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


def load_runner():
    """the pinned 1773 batch runner (its own top level re-verifies the frozen r3 stage SUMS before importing the r3 core); its core
    must be the pinned r3 multipart.py"""
    sys.dont_write_bytecode = True
    R = load_exact("runner1773", "runner_1773")
    if sha(read_all(os.path.realpath(R.MP.__file__), 4 << 20)) != PINS["r3Core"][1]:
        refuse("the 1773 runner's r3 core is not the pinned multipart.py")
    return R


def file_pinned(name, cap=64 << 20):
    path, want = PINS[name]
    if sha(read_all(os.path.realpath(path), cap)) != want:
        refuse(f"{name}: {path} is not the pinned file")
    return {"path": path, "sha256": want}


# ---- pure / small checks (unit-tested) ------------------------------------------------------------------------------------------------
def scope_of(cgroup_text, uid):
    """-> (cgroup path, unit) of exactly ONE user-manager transient run-*.scope (the queue's systemd-run --user --scope)"""
    lines = [l for l in cgroup_text.splitlines() if l.strip()]
    if len(lines) != 1 or not lines[0].startswith("0::"):
        refuse("not exactly one cgroup v2 entry")
    rel = lines[0][3:]
    m = re.fullmatch(SCOPE_RE.format(uid=uid), rel)
    if not m:
        refuse(f"our cgroup {rel!r} is not a transient run-*.scope of this user's manager (run through jobs/q-exit-status.sh ... 768)")
    return rel, m[1]


def lane_ok(memory_max_text):
    if memory_max_text.strip() != str(LANE_MIB * MIB):
        refuse(f"memory.max {memory_max_text.strip()!r} is not the {LANE_MIB} MiB queue lane")
    return True


def root_remaining(R, d, msha, name):
    """F2: EVERY part of target `name` that is NOT r3-validated committed (the 1773 runner's part_state: valid record, current identity
    == destIdentity, nlink 1, confirmed binding or a confirmed fresh PASS) counts with its FULL manifest length"""
    dfd, cache, out = R.MP.open_dir(d["targets"][name]["dir"], f"target {name}"), {}, 0
    try:
        for p in d["parts"]:
            if p["target"] == name and not R.part_state(d, msha, p, dfd, cache)["committed"]:
                out += p["length"]
    finally:
        os.close(dfd)
    return out


def reservation_ok(free, remaining, floor):
    need = remaining + floor + ROOT_RESERVE + FIXTURE_WRITE_BOUND
    if free < need:
        refuse(f"root filesystem free {free} < remaining recovery {remaining} + floor {floor} + 8 GiB root reservation + fixture writes "
               f"{FIXTURE_WRITE_BOUND}")
    return {"freeBytes": free, "remainingRootRecoveryBytes": remaining, "floorBytes": floor, "rootReserveBytes": ROOT_RESERVE,
            "fixtureWriteBoundBytes": FIXTURE_WRITE_BOUND, "neededBytes": need, "marginBytes": free - need}


def soft_stop_reason(tree_rss_mib, avail_mib):
    if tree_rss_mib > SOFT_TREE_RSS_MIB:
        return f"soft stop: tree VmRSS {tree_rss_mib:.0f} MiB > {SOFT_TREE_RSS_MIB} MiB (the outer guard stops at {LANE_MIB})"
    if avail_mib < SOFT_AVAIL_MIB:
        return f"soft stop: MemAvailable {avail_mib:.0f} MiB < {SOFT_AVAIL_MIB} MiB (16 GiB floor + 512)"
    return None


def allocated_ok(path, cap=ALLOC_CAP):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_blocks * 512 > cap:
        refuse(f"{path}: allocated {st.st_blocks * 512} bytes > {cap} (must stay sparse)")
    return st.st_blocks * 512


def set_memory_high(rel, unit, run, cg=CG):
    """bind unit <-> our cgroup, set MemoryHigh on OUR scope only, verify nothing else changed. run(argv) -> (rc, stdout)."""
    own, parent = os.path.join(cg, rel.lstrip("/")), os.path.dirname(os.path.join(cg, rel.lstrip("/")))
    rd = lambda p: read_all(p, 4096).decode().strip()
    rc, out = run(["show", "-p", "ControlGroup", "--value", unit])
    if rc != 0 or out.strip() != rel:
        refuse(f"systemd's ControlGroup of {unit} is {out.strip()!r}, not our cgroup {rel!r}")
    before = {"ownHigh": rd(own + "/memory.high"), "ownMax": rd(own + "/memory.max"), "parentHigh": rd(parent + "/memory.high")}
    if before["ownHigh"] != "max":
        refuse(f"our scope already has memory.high {before['ownHigh']!r}")
    rc, out = run(["set-property", "--runtime", unit, f"MemoryHigh={HIGH_MIB}M"])
    if rc != 0:
        refuse(f"systemctl set-property failed (rc {rc}): {out.strip()[:200]}")
    after = {"ownHigh": rd(own + "/memory.high"), "ownMax": rd(own + "/memory.max"), "parentHigh": rd(parent + "/memory.high")}
    if after["ownHigh"] != str(HIGH_MIB * MIB) or after["ownMax"] != before["ownMax"] or after["parentHigh"] != before["parentHigh"]:
        refuse(f"MemoryHigh not applied to our scope only: before {before} after {after}")
    rc, out = run(["show", "-p", "MemoryHigh", "--value", unit])
    if rc != 0 or out.strip() != str(HIGH_MIB * MIB):
        refuse(f"systemd reports MemoryHigh {out.strip()!r} for {unit}")
    return {"unit": unit, "cgroup": rel, "before": before, "after": after, "appliesTo": "the WHOLE scope (see limits)"}


def systemctl_runner(uid):
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "XDG_RUNTIME_DIR": f"/run/user/{uid}",
           "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus"}

    def run(args):
        p = subprocess.run([PINS["systemctl"][0], "--user", *args], capture_output=True, text=True, timeout=30, env=env,
                           stdin=subprocess.DEVNULL)
        return p.returncode, p.stdout + p.stderr
    return run


# ---- meters (no smaps_rollup / Pss: review 1811 F6) ----------------------------------------------------------------------------------
def proc_status(pid):
    out = {}
    with contextlib.suppress(OSError):
        for l in read_all(f"/proc/{pid}/status", 1 << 16).decode().splitlines():
            k, _, v = l.partition(":")
            if k in ("VmRSS", "RssAnon", "RssFile", "RssShmem", "VmPTE"):
                out[k + "KiB"] = int(v.split()[0])
    return out


def tree(R9, root):
    par = {p: f[1] for p in R9.all_pids() if (f := R9.proc_fields(p))}
    owned = {root}
    while True:
        more = owned | {p for p, pp in par.items() if pp in owned}
        if more == owned:
            return owned
        owned = more


def tree_rss_mib(R9, root):
    return sum(proc_status(p).get("VmRSSKiB", 0) for p in tree(R9, root)) / 1024


def mem_available_mib():
    for l in read_all("/proc/meminfo", 1 << 16).decode().splitlines():
        if l.startswith("MemAvailable:"):
            return int(l.split()[1]) / 1024
    refuse("MemAvailable missing")


def cg_sample(rel):
    d = os.path.join(CG, rel.lstrip("/"))
    rd = lambda n: read_all(os.path.join(d, n), 1 << 16).decode()
    ev = dict((k, int(v)) for k, v in (l.split() for l in rd("memory.events").splitlines() if l.strip()))
    st = dict((k, int(v)) for k, v in (l.split() for l in rd("memory.stat").splitlines() if l.strip()) if k in STAT_KEYS)
    return {"current": int(rd("memory.current")), "high": rd("memory.high").strip(), "max": rd("memory.max").strip(), "events": ev, "stat": st}


def make_session_class(C):
    class FixtureSession(C.Session):
        """r6 Session (ownership, spawn/bind, ordered cleanup) with this fixture's prepare / expose / use"""
        def __init__(self, a, R9, R, pins):
            super().__init__(a, R9, None)
            self.R, self.MP, self.pins = R, (R.MP if R is not None else None), pins
            self.dat = os.path.join(self.db, "disk.raw")                 # nbdfuse MOUNTPOINT/FILENAME: our mount stays self.db
            self.image = os.path.join(self.work, "sparse.raw")
            self.image_id, self.walk, self.rel = None, None, None
            self.receipt.update(format=FORMAT, kind="synthetic-memory-fixture", limits=LIMITS, wrapper=WRAPPER, notClaimed=[
                "MDBX validity", "production lane safety", "a MemoryHigh ceiling", "walker-only reclaim", "the OOM victim",
                "the outer guard never firing"])
            self.peaks = {"treeVmRssMiB": 0.0, "cgCurrent": 0, "walkerVmRSSKiB": 0, "walkerRssFileKiB": 0, "walkerVmPTEKiB": 0,
                          "cgPagetables": 0, "minMemAvailableMiB": None}
            self.samples, self.stop_reason, self.timed_out = [], None, False

        # 1-2 ---------------------------------------------------------------------------------------------------------------------
        def prepare(self):
            a, MP = self.a, self.MP
            rd = os.path.realpath(a.run_dir)
            if rd != a.run_dir or os.path.dirname(rd) != os.path.join(STAGE, "runs") or os.path.islink(a.run_dir):
                refuse("--run-dir must be a direct, real child of this stage's runs/")
            st = os.stat(a.run_dir)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077 or os.listdir(a.run_dir):
                refuse("--run-dir must be an existing, EMPTY, private (0700) directory of this user")
            if "," in a.run_dir or ":" in a.run_dir:
                refuse("--run-dir must not contain ',' or ':' (image-opts)")
            with C.deferred():                                            # r6 B2: claim the run dir atomically
                fd = os.open(os.path.join(a.run_dir, "session.pid"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                self.owns_run = True
            os.write(fd, json.dumps({"pid": os.getpid(), "startTime": C.start_time(os.getpid())}).encode()); os.close(fd)
            self.receipt["pins"] = self.pins
            p, chain = os.getpid(), []                                    # the tree root (the job bash) is our ancestor, in our scope
            while p > 1 and len(chain) < 64:
                p = self.R9.proc_fields(p)[1]; chain.append(p)
            if a.tree_root_pid not in chain:
                refuse(f"--tree-root-pid {a.tree_root_pid} is not our ancestor")
            mine = read_all("/proc/self/cgroup", 4096).decode()
            if read_all(f"/proc/{a.tree_root_pid}/cgroup", 4096).decode() != mine:
                refuse("the tree root is not in our cgroup")
            rel, unit = scope_of(mine, os.getuid())
            lane_ok(read_all(os.path.join(CG, rel.lstrip("/"), "memory.max"), 64).decode())
            d, msha = MP.load_manifest(PINS["manifest"][0], PINS["manifest"][1])
            t = d["targets"]["root"]
            mm = MP.majmin(os.stat(a.run_dir).st_dev)
            if mm != ROOT_MAJMIN or mm != t["majmin"]:
                refuse(f"run dir filesystem {mm} is not the pinned root target filesystem {ROOT_MAJMIN}")
            u, fmm = MP.findmnt_uuid(a.run_dir)
            if (u, fmm) != (t["uuid"], mm) or MP.is_usb(mm):
                refuse("run dir filesystem UUID/device differ from the root target, or it is USB")
            remaining = root_remaining(self.R, d, msha, "root")           # F2: the 1773 runner's r3-validated part_state
            dfd = os.open(a.run_dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                self.receipt["reservation"] = reservation_ok(MP.free_bytes(dfd), remaining, t["floorBytes"])
            finally:
                os.close(dfd)
            avail = mem_available_mib()
            if avail < FLOOR_MIB + LANE_MIB + ADMIT_HEADROOM_MIB:
                refuse(f"MemAvailable {avail:.0f} MiB < 16 GiB floor + {LANE_MIB} + {ADMIT_HEADROOM_MIB}")
            self.rel = rel
            self.receipt["scope"] = set_memory_high(rel, unit, systemctl_runner(os.getuid()))
            if str(os.getpid()) not in read_all(os.path.join(CG, rel.lstrip("/"), "cgroup.procs"), 1 << 20).decode().split():
                refuse("we are no longer in the scope we bound")
            self.receipt["checks"]["scopeBound"] = {"ok": True}

        # 3 -------------------------------------------------------------------------------------------------------------------------
        def expose(self):
            with C.deferred():                                            # r6 B2: the work dir and its ownership flag together
                os.mkdir(self.work, 0o700)
                self.owns_work = True
            with C.deferred():                                            # the image and its identity together
                fd = os.open(self.image, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                try:
                    st = os.fstat(fd); self.image_id = (st.st_dev, st.st_ino)
                    os.ftruncate(fd, IMAGE_BYTES); os.fsync(fd)
                finally:
                    os.close(fd)
            self.receipt["allocatedBefore"] = allocated_ok(self.image)
            os.mkdir(self.db, 0o700)
            self.step("qemu-nbd")
            self.spawn("qemu-nbd", [C.PINS["qemuNbd"][0], "--read-only", "--shared=1", f"--socket={C.SOCK_ARG}", "--image-opts",
                                    f"driver=raw,read-only=on,file.driver=file,file.filename={self.image}"], cwd=self.work)
            self.wait_for("the nbd socket", lambda: os.path.exists(self.sock), "qemu-nbd")
            st = os.lstat(self.sock)
            self.check("socketOurs", stat.S_ISSOCK(st.st_mode) and st.st_uid == os.geteuid(), "not our socket")
            self.bind_child("qemu-nbd", C.PINS["qemuNbd"][0])
            self.check("imageHeldReadOnly", self.image_held_ro(), "qemu-nbd does not hold the image, or not O_RDONLY")
            self.step("nbdfuse")
            pidf = os.path.join(self.work, "nbdfuse.pid")
            self.spawn("nbdfuse", [C.PINS["nbdfuse"][0], "-r", "-C", "1", "-o", "ro", "-P", pidf, self.dat, "--unix", C.SOCK_ARG], cwd=self.work)
            self.wait_for("the nbdfuse mount", lambda: os.path.exists(pidf) and self.R9.mounted(self.db), "nbdfuse")
            self.check("nbdfuseForeground", int(self.R9.slurp(pidf, 64).strip() or 0) == self.children["nbdfuse"].pid, "it daemonized")
            self.bind_child("nbdfuse", C.PINS["nbdfuse"][0])
            self.check("mountReadOnly", bool(os.statvfs(self.db).f_flag & os.ST_RDONLY), "not ST_RDONLY")
            self.check("onlyDisk", sorted(os.listdir(self.db)) == ["disk.raw"], sorted(os.listdir(self.db)))
            self.check("size", os.stat(self.dat).st_size == IMAGE_BYTES, os.stat(self.dat).st_size)
            try:
                os.close(os.open(self.dat, os.O_WRONLY)); refused = False
            except OSError:
                refused = True
            self.check("writeRefused", refused, "an O_WRONLY open succeeded")

        def image_held_ro(self):
            pid, found = self.children["qemu-nbd"].pid, []
            for n in os.listdir(f"/proc/{pid}/fd"):
                with contextlib.suppress(OSError):
                    st = os.stat(f"/proc/{pid}/fd/{n}")
                    if (st.st_dev, st.st_ino) == self.image_id:
                        flags = [l for l in read_all(f"/proc/{pid}/fdinfo/{n}", 4096).decode().splitlines() if l.startswith("flags:")]
                        found.append(len(flags) == 1 and int(flags[0].split()[1], 8) & os.O_ACCMODE == os.O_RDONLY)
            return bool(found) and all(found)

        # 4 -------------------------------------------------------------------------------------------------------------------------
        def sample(self, full):
            now = round(time.monotonic() - self.t0, 2)
            cg = cg_sample(self.rel)
            trss, avail = tree_rss_mib(self.R9, self.a.tree_root_pid), mem_available_mib()
            w = proc_status(self.children["exec"].pid) if not self.R9.exited_nowait(self.children["exec"].pid) else {}
            pk = self.peaks
            pk["treeVmRssMiB"] = max(pk["treeVmRssMiB"], trss); pk["cgCurrent"] = max(pk["cgCurrent"], cg["current"])
            pk["cgPagetables"] = max(pk["cgPagetables"], cg["stat"].get("pagetables", 0))
            pk["minMemAvailableMiB"] = avail if pk["minMemAvailableMiB"] is None else min(pk["minMemAvailableMiB"], avail)
            for k in ("VmRSS", "RssFile", "VmPTE"):
                pk[f"walker{k}KiB"] = max(pk[f"walker{k}KiB"], w.get(f"{k}KiB", 0))
            if full and len(self.samples) < MAX_SAMPLES:
                self.samples.append({"t": now, "treeVmRssMiB": round(trss, 1), "memAvailableMiB": round(avail), "cg": cg, "walker": w})
            return soft_stop_reason(trss, avail)

        def walker_argv(self, walker, limit):
            return [PINS["python3"][0], "-I", "-B", walker, self.dat, str(IMAGE_BYTES), str(limit)]

        def use(self):
            walker = os.path.join(self.work, "walker.py")                 # r9 N1: a private, verified copy is what runs
            raw = read_all(PINS["walker"][0], 1 << 20)
            if sha(raw) != PINS["walker"][1]:
                refuse("walker.py is not the pinned file")
            with C.deferred():
                fd = os.open(walker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o500)
                try:
                    os.write(fd, raw)
                finally:
                    os.close(fd)
            if sha(read_all(walker, 1 << 20)) != PINS["walker"][1]:
                refuse("the private walker copy differs")
            limit = int(self.deadline - time.monotonic() - CLEANUP_RESERVE)
            if limit < 60:
                refuse("not enough of the budget left for the walk")
            self.receipt["cgBefore"] = cg_sample(self.rel)
            self.step("walker")
            c = self.spawn("exec", self.walker_argv(walker, limit), cwd=self.work)
            last, hard = 0.0, time.monotonic() + limit + 10
            while not self.R9.exited_nowait(c.pid):
                if time.monotonic() > hard:                               # checked BEFORE a (possibly slow) sample
                    self.timed_out = True; break
                full = time.monotonic() - last >= SAMPLE_EVERY
                if full:
                    last = time.monotonic()
                why = self.sample(full)
                if why:
                    self.stop_reason = why; break
                time.sleep(POLL)
            leftovers = self.R9.group_members(c.pid)
            empty = self.R9.stop_group(c, grace=0 if (self.stop_reason or self.timed_out) else 2)   # ORDERED: the walker first
            orphans_gone = self.reap_adopted()
            tail = read_all(os.path.join(self.work, "exec.log"), 1 << 20).decode(errors="replace").splitlines()[-40:]
            result = None
            for l in reversed(tail):
                with contextlib.suppress(ValueError):
                    x = json.loads(l)
                    if isinstance(x, dict) and "scannedBytes" in x:
                        result = x; break
            self.walk = {"rc": c.returncode, "result": result, "limitSeconds": limit, "groupLeftovers": leftovers, "groupEmpty": empty,
                         "orphansGone": orphans_gone, "softStop": self.stop_reason, "timedOut": self.timed_out}
            self.receipt["walker"] = self.walk
            self.receipt["cgAfter"] = cg_sample(self.rel)
    return FixtureSession


def outcome(rec, walk, interrupted, refused):
    if not rec.get("cleanupComplete"):
        return "CLEANUP-INCOMPLETE", 4, ["cleanup incomplete: stop and inspect; nothing removed"]
    if interrupted:
        return "CANCELLED", 5, [interrupted]
    if refused and walk is None:
        return "REFUSED", 3, [refused]
    if refused:
        return "FAILED", 7, [refused]
    if walk.get("softStop"):
        return "SOFT-STOP", 6, [walk["softStop"]]
    if walk.get("timedOut"):
        return "TIMEOUT", 7, ["the walk exceeded its budget"]
    r = walk.get("result") or {}
    if walk.get("rc") != 0 or r.get("scannedBytes") != IMAGE_BYTES or r.get("nonzeroPages") != 0 or walk.get("groupLeftovers") \
            or not walk.get("groupEmpty") or not walk.get("orphansGone"):
        return "FAILED", 7, [f"walker rc {walk.get('rc')} scanned {r.get('scannedBytes')} nonzero {r.get('nonzeroPages')}"]
    before, after = (rec.get("cgBefore") or {}).get("events", {}), (rec.get("cgAfter") or {}).get("events", {})
    if after.get("high", 0) - before.get("high", 0) < 1:
        return "INCONCLUSIVE", 7, ["no memory.events high during the walk: the MemoryHigh mechanism was not exercised"]
    return "MEASURED", 0, []


def drive(a, C, build, t0):
    """F4: the ONE cancellation / cleanup / outcome / receipt path. build() -> session. SIGTERM/SIGINT/SIGHUP raise r6's Stop (deferred
    inside r6 critical sections); cleanup of an OWNED work dir always runs with those signals IGNORED; the receipt is written ONLY into a
    run dir this controller claimed (root: a refusal never writes into someone else's run dir; the summary goes to stdout)."""
    s, refused, interrupted, receipt = None, None, None, {"format": FORMAT, "limits": LIMITS, "wrapper": WRAPPER}
    C._SIG.update(defer=0, pending=None, armed=True)
    old = {sig: signal.signal(sig, C._on_signal) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        try:
            s = build(); receipt = s.receipt
            s.t0, s.deadline = t0, t0 + TOTAL_BUDGET
            s.prepare()
            s.expose()
            s.use()
        except Exception as e:                                             # noqa: BLE001 - r6 Stop is an Exception subclass
            if isinstance(e, C.Stop):
                interrupted = str(e)
            else:
                refused = f"{type(e).__name__}: {e}"[:500]
        finally:
            C._SIG["armed"] = False                                        # FIRST: from here a signal can no longer raise Stop
            for sig in old:                                                # the cleanup itself is never interrupted by these signals
                signal.signal(sig, signal.SIG_IGN)
            if C._SIG["pending"] is not None and not interrupted:
                interrupted = f"signal {C._SIG['pending']}"
            if s is not None and s.owns_work:                              # r6 B2: ONLY a work dir THIS run created
                try:
                    s.cleanup()                                            # r6 ordered cleanup: walker, adopted, unmount, nbdfuse, qemu
                except BaseException as e:                                 # noqa: BLE001
                    s.cleanup_ok = False; receipt["cleanupError"] = f"{type(e).__name__}: {e}"[:300]; receipt["cleanupComplete"] = False
                if receipt.get("cleanupComplete") and s.image_id is not None:
                    try:                                                   # our sparse image: only after a COMPLETE cleanup, same inode
                        st = os.lstat(s.image)
                        receipt["allocatedAfter"] = st.st_blocks * 512
                        if (st.st_dev, st.st_ino) == s.image_id:
                            os.unlink(s.image); receipt["imageRemoved"] = True
                        if receipt["allocatedAfter"] > ALLOC_CAP:
                            refused = refused or f"the image became allocated ({receipt['allocatedAfter']} bytes)"
                    except OSError as e:
                        receipt["imageRemoved"] = f"{type(e).__name__}: {e}"[:200]
            else:
                receipt["cleanupComplete"] = True                          # nothing was exposed
        walk = s.walk if s is not None else None
        name, rc, reasons = outcome(receipt, walk, interrupted, refused)
        receipt.update(outcome=name, rc=rc, reasons=reasons, refused=refused, interrupted=interrupted,
                       seconds=round(time.monotonic() - t0, 1), kernel=os.uname().release)
        if s is not None:
            receipt.update(peaks=s.peaks, samples=s.samples)
        if s is not None and s.owns_run and os.path.isdir(a.run_dir) and not os.path.islink(a.run_dir):
            nm = "receipt.json" if not os.path.lexists(os.path.join(a.run_dir, "receipt.json")) else f"receipt-{time.time_ns()}.json"
            data = (json.dumps(receipt, indent=1, sort_keys=True, default=str) + "\n").encode()
            fd = os.open(os.path.join(a.run_dir, nm), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.write(fd, data); os.close(fd)
            receipt["receiptFile"] = nm
        print(json.dumps({k: receipt.get(k) for k in ("outcome", "rc", "reasons", "cleanupComplete", "receiptFile")}, default=str))
    finally:
        for sig, h in old.items():
            signal.signal(sig, h)
    return rc


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True); ap.add_argument("--tree-root-pid", type=int, required=True)
    a = ap.parse_args(argv)
    a.expect_kind, a.fixture_unmount_exe, a.view_dir = "fixture", None, None
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:       # PR_SET_CHILD_SUBREAPER (r9 / r6)
        print("cannot become a child subreaper", file=sys.stderr); return 2
    t0 = time.monotonic()
    try:                                                                   # nothing is claimed or written before these pass
        pins = {"manifest": {"path": PINS["manifest"][0], "sha256": PINS["manifest"][1]}}
        for k in ("walker", "systemctl", "python3"):
            pins[k] = file_pinned(k)
        C = load_exact("r6Runtime", "r6_composite_session")
        for k, (p, h) in C.PINS.items():
            if k in ("qemuNbd", "nbdfuse", "fusermount3", "r9OverlaySession"):
                if C.file_sha(p) != h:
                    refuse(f"{k}: {p} is not the pinned file")
                pins[k] = {"path": p, "sha256": h}
        C.CHILD_FSIZE = LOG_CAP                                            # F2: every child's RLIMIT_FSIZE (its log) <= 4 MiB
        R9 = C.load_pinned("r9OverlaySession", "r9_overlay_session")
        R = load_runner()
        pins.update(runner1773={"path": PINS["runner1773"][0], "sha256": PINS["runner1773"][1]},
                    r3Core={"path": PINS["r3Core"][0], "sha256": PINS["r3Core"][1]},
                    r6Runtime={"path": PINS["r6Runtime"][0], "sha256": PINS["r6Runtime"][1]})
    except Exception as e:                                                 # noqa: BLE001
        print(json.dumps({"outcome": "REFUSED", "rc": 3, "reasons": [f"{type(e).__name__}: {e}"[:500]], "receiptFile": None}))
        return 3
    return drive(a, C, lambda: make_session_class(C)(a, R9, R, pins), t0)


if __name__ == "__main__":
    sys.exit(main())
