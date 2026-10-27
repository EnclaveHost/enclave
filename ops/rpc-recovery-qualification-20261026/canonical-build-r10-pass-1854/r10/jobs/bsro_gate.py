#!/usr/bin/env python3
"""base-state-readonly-stage/r10 jobs/bsro_gate.py (prepared by Claude 1839/1844/1848; NOT run by Claude). Standard library + pinned stages only.
r10 = r9 (f7470ced...) + root 1847: run_capture OWNERSHIP is "the leader is not yet reaped by our single final wait" - an EXITED but
unreaped leader still reserves its pgid, so the owned group can be TERMed/KILLed after the leader exited; RUNNING (waitid WNOWAIT) is only
an observation. The lifecycle keeps ticking after EOF until the leader exited AND the group is empty (term_wait escalation still
applies); an fsync failure triggers the same ordered stop; unexpected-error cleanup ends the remaining owned group even after the
leader exited; nothing is ever signalled after the final reap (the forwarding handlers are disarmed first).
r9 = r8 (49a41e28...; actual 10+6+11 and 4 namespace tests PASSED) + review 1841 / root 1843: PB1 the read-only roots are bound
RECURSIVELY read-only (jobs/ns.sh) and every VISIBLE mount at/under them must be ro (ro_tree_ok); #1 the guard receipt must show
success (reason null, childRc exactly int 0, groupLeftAlive exactly false); #2/m1 run_capture ticks its lifecycle deadlines on EVERY
bounded iteration, whatever the output rate; #3 spawn / capture-sink / unexpected errors close the fd and stop the OWNED group in order
(TERM first: the guard ends its own build group, then bounded waits, then KILL of our group only); m2 the forwarding handlers exist
BEFORE the spawn (a signal meanwhile is pending and forwarded as soon as the child exists).

The ONE helper module for the r8 storage correction (plan logs/claude-canonical-build-storage-plan-1837.md); used by the production
jobs AND the tests (no test-only switch in any CLI path). It never reads a production part's bytes.

    bsro_gate.py outer build|preflight     (queue command via jobs/build-outer.sh; real uid; owns the whole run)
    bsro_gate.py qualified                 (the r8 guard-tests AND ns-tests receipts for this frozen stage passed)
    bsro_gate.py inner-gate --uid U --gid G --fingerprint F    (inside `unshare -Urnm`, after jobs/ns.sh hardening)
    bsro_gate.py account --run R --out O --tmp T --build-rc N --unchanged-rc N --lock-rc N   (inside the guarded build)
    bsro_gate.py verify-binaries BIN_DIR   (positive.sh / fixtures.sh: the dir is an authenticated build receipt's /vm output)

outer: 1 the stage SUMS; 2 the qualifying r8 receipts; 3 NOT inside a user namespace (init uid/gid map), not root; 4 the 4096 MiB main
lane (own cgroup memory.max) and MemAvailable >= 16 GiB + 4096 + 256 MiB; 5 root free >= 40 GiB + 8 GiB native + 16 MiB metadata; 6 no
live orchestrate/overlay/composite or memory_gate gate/runtime process (pinned r6 session_guard + r10 memory_gate) and no stage mount;
7 the COMPLETION gate: pinned 1773 runner (which verifies the frozen r3 stage) + r3 core status() on the pinned manifest: copyComplete,
verificationCompleteRecorded, 265 committed == 265 verified (CONFIRMED sessions), nothing stale / unconfirmed / invalid / failed, and 0
remaining bytes on BOTH targets (1773 part_state: record + current dev/ino/size/mtime/ctime/nlink == destIdentity); 8 a NEW 0700 metadata
dir S/runs/MODE-ID; 9 `unshare -Urnm bash jobs/build.sh MODE UID GID FINGERPRINT` with its stdout+stderr through a BOUNDED writer (<= 1 MiB
kept, the rest drained and counted; NO file-size rlimit is set on the child, so the compiler and the guarded build are never limited by
it), SIGTERM/SIGINT/SIGHUP forwarded once to the child's own process group while its leader is unreaped; 10 the receipt: the guard run
dir is authenticated (named in the output; a real 0700 dir of ours, a direct run-* child of the pinned /vm base, same device, its
guard-receipt.json names it), the binaries are hashed IN PLACE on /vm and must equal accounting.json (no root copy; one symlink out ->
the /vm output only), root free after >= the explicit floor (mandatory) and the root free delta recorded as ADVISORY (other writers);
11 exit: a nonzero child rc is preserved; child rc 0 -> 0 only if everything verifies, else 10. Refusals before step 8 write nothing.
"""
import argparse, hashlib, json, os, re, signal, stat, subprocess, sys, time, types

S = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
W = os.path.dirname(os.path.dirname(S))
OUT_B = os.path.dirname(os.path.dirname(W)) + "/outputs/rpc-production-final-20261025/base-multipart-production-20261026"
PINS = {
    "runner1773": (W + "/jobs/root-multipart-batches-1773.py", "5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a"),
    "r3Core": (W + "/recovery-multipart-stage/r3/multipart.py", "3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381"),
    "manifest": (OUT_B + "/manifest.json", "f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9"),
    "r6SessionGuard": (W + "/composite-mdbx-validation-stage/r6/jobs/session_guard.py", "f64c6115ab8ac871d1813d53d45d3b03369c330c45617763824a4bb3fef287ce"),
    "r10MemoryGate": (W + "/composite-mdbx-validation-stage/r10/memory_gate.py", "d5abdd20f74d2e9039278e9a8fd3033a4c4ad187d5bcc902c913122988dcce84"),
}
BASE = "/vm/enclave-volumes/rpc-recovery-validation-build"          # the r7 guard base (unchanged)
GIB, MIB = 1 << 30, 1 << 20
ROOT_FLOOR, NATIVE, META_BUDGET = 40 * GIB, 8 * GIB, 16 * MIB
LANE_MIB, HOST_FLOOR_MIB, HEADROOM_MIB = 4096, 16384, 256
PARTS = 265
FILE_CAP = 1 * MIB                                                   # every root metadata file and accounting.json
CAPTURE_GRACE = 120.0                                                # after the child leader exits: EOF wait before its group is killed
CAPTURE_HARD = 30.0                                                  # after that SIGKILL: stop reading (a holder outside our group)
CAPTURE_TERM_WAIT = 120.0                                            # after OUR TERM (forward / sink failure): orderly exit before KILL
RO_ROOTS = ("/home/steven", "/tmp")                                # bound recursively read-only by jobs/ns.sh in the build namespace
BINARIES = ("base-state-readonly", "mk_fixture")
STAGE_MARKERS = ("/recovery-multipart-stage/", "/recovery-overlay-stage/", "/composite-mdbx-validation-stage/", "/composite-memory-fixture-stage/")
STATUS_LISTS = ("stale", "unconfirmed", "invalidRecords", "failedVerification")


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


def file_sha(path, cap=1 << 34):
    h, n = hashlib.sha256(), 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        while True:
            b = os.read(fd, 8 << 20)
            if not b:
                return h.hexdigest(), n
            n += len(b); h.update(b)
            if n > cap:
                refuse(f"{path}: larger than {cap} bytes")
    finally:
        os.close(fd)


def load_exact(name, modname):
    path, want = PINS[name]
    raw = read_all(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned file")
    mod = types.ModuleType(modname); mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


def write_new(path, data, cap=FILE_CAP):
    """a NEW file (O_EXCL, no symlink), at most cap bytes, fsynced"""
    if len(data) > cap:
        refuse(f"{path}: {len(data)} bytes > the {cap} byte cap")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, data); os.fsync(fd)
    finally:
        os.close(fd)


def free_bytes(path):
    v = os.statvfs(path)
    return v.f_bavail * v.f_frsize


# ---- pure checks (unit-tested) -----------------------------------------------------------------------------------------------------------
def completion(status, remaining):
    """ALL 265 parts committed AND independently verified in CONFIRMED sessions; nothing stale/unconfirmed/invalid/failed; 0 remaining"""
    if not isinstance(status, dict) or not isinstance(remaining, dict):
        refuse("completion: no status")
    if not (status.get("parts") == PARTS and status.get("partsCommitted") == PARTS and status.get("partsVerifiedRecorded") == PARTS
            and status.get("copyComplete") is True and status.get("verificationCompleteRecorded") is True
            and all(status.get(k) == [] for k in STATUS_LISTS)):
        refuse(f"preservation is not complete and independently verified: { {k: status.get(k) for k in ('parts', 'partsCommitted', 'partsVerifiedRecorded', 'copyComplete', 'verificationCompleteRecorded', *STATUS_LISTS)} }")
    if set(remaining) != {"root", "vm"} or any(type(v) is not int or v != 0 for v in remaining.values()):
        refuse(f"remaining multipart bytes are not 0 on both targets: {remaining}")
    keep = {k: status[k] for k in ("parts", "partsCommitted", "partsVerifiedRecorded", "copyComplete", "verificationCompleteRecorded", *STATUS_LISTS)}
    return sha(json.dumps({"status": keep, "remaining": remaining}, sort_keys=True).encode())


def parse_map(text):
    rows = [l.split() for l in text.splitlines() if l.strip()]
    if any(len(r) != 3 or not all(x.isdigit() for x in r) for r in rows):
        refuse(f"malformed id map {text!r}")
    return [tuple(int(x) for x in r) for r in rows]


def maps_inside(uid_map, gid_map, setgroups, outer_uid, outer_gid):
    """inside `unshare -Urnm`: EXACTLY root -> our real uid/gid, one id each, setgroups denied (r3 owner checks then mean OUR files)"""
    if parse_map(uid_map) != [(0, outer_uid, 1)] or parse_map(gid_map) != [(0, outer_gid, 1)] or setgroups.strip() != "deny":
        refuse(f"inside id maps are not exactly 0 -> {outer_uid}/{outer_gid} (1 id) with setgroups deny: {uid_map!r} {gid_map!r} {setgroups!r}")
    return True


def maps_outside(uid_map, gid_map, uid, gid):
    """outside: the initial user namespace (identity maps), a non-root real user"""
    full = [(0, 0, 4294967295)]
    if parse_map(uid_map) != full or parse_map(gid_map) != full or uid == 0 or gid == 0:
        refuse("outer gate must run as the non-root user in the initial user namespace")
    return True


def propagation_private(mountinfo):
    """after `mount --make-rprivate /` no mount of this namespace may still propagate (no shared:/master: optional fields)"""
    for line in mountinfo.splitlines():
        pre = line.partition(" - ")[0].split()
        if any(t.startswith(("shared:", "master:", "propagate_from:")) for t in pre[6:]):
            refuse(f"mount propagation is not private: {line[:160]}")
    return True


def read_only(paths, writable=()):
    for p in paths:
        if not os.statvfs(p).f_flag & os.ST_RDONLY:
            refuse(f"{p} is not read-only inside the build namespace")
    for p in writable:
        if os.statvfs(p).f_flag & os.ST_RDONLY:
            refuse(f"{p} must stay writable (the guarded /vm build dir)")
    return True


def parse_mountinfo(text):
    out = []
    for line in text.splitlines():
        pre = line.partition(" - ")[0].split()
        if len(pre) < 6:
            continue
        mp = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), pre[4])
        out.append({"id": int(pre[0]), "parent": int(pre[1]), "mp": mp, "opts": pre[5].split(",")})
    return out


def ro_tree_ok(mountinfo, roots):
    """PB1: for each root, the VISIBLE mount at it (the top of any stack there) and EVERY mount below it in the tree must be ro.
    Mounts at/under the root that hang off another parent are shadowed by that top (not reachable by path) and are ignored."""
    ms = parse_mountinfo(mountinfo)
    for r in roots:
        at = [m for m in ms if m["mp"] == r]
        tops = [m for m in at if not any(o["parent"] == m["id"] for o in at)]
        if len(tops) != 1:
            refuse(f"{r}: {len(tops)} visible mounts at the root (need exactly one read-only bind)")
        tree, frontier = {tops[0]["id"]}, {tops[0]["id"]}
        while frontier:
            frontier = {m["id"] for m in ms if m["parent"] in frontier and m["id"] not in tree}
            tree |= frontier
        bad = [m["mp"] for m in ms if m["id"] in tree and "ro" not in m["opts"]]
        if bad:
            refuse(f"{r}: mounts at/under it are not read-only: {bad[:5]}")
    return True


def ns_checks(mountinfo, ro, rw, ro_roots):
    propagation_private(mountinfo)
    read_only(ro, rw)
    return ro_tree_ok(mountinfo, ro_roots)


def lane_ok(memory_max_text, avail_mib):
    if memory_max_text.strip() != str(LANE_MIB * MIB):
        refuse(f"memory.max {memory_max_text.strip()!r} is not the {LANE_MIB} MiB exclusive main lane")
    if avail_mib < HOST_FLOOR_MIB + LANE_MIB + HEADROOM_MIB:
        refuse(f"MemAvailable {avail_mib:.0f} MiB < 16 GiB host floor + {LANE_MIB} + {HEADROOM_MIB}")
    return True


def root_floor_ok(free):
    need = ROOT_FLOOR + NATIVE + META_BUDGET
    if free < need:
        refuse(f"root free {free} < 40 GiB floor + 8 GiB native + 16 MiB metadata ({need})")
    return True


def receipt_ok(r, sums, fmt, suites):
    return (isinstance(r, dict) and r.get("format") == fmt and r.get("pass") is True and r.get("stageSums") == sums
            and isinstance(r.get("suites"), dict) and set(r["suites"]) == set(suites)
            and all(isinstance(r["suites"][k], dict) and r["suites"][k].get("pass") is True and r["suites"][k].get("ran") == [str(n)]
                    for k, n in suites.items()))


GUARD_SUITES = {"test_disk_guard": 10, "test_mount_identity": 6, "test_bsro_gate": 16}
NS_SUITES = {"test_ns": 5}


def qualified(stage=S):
    sums = sha(read_all(os.path.join(stage, "SHA256SUMS"), 1 << 20))
    for pat, fmt, suites in (("guard-tests-", "bsro-guard-test-receipt/r10", GUARD_SUITES), ("ns-tests-", "bsro-ns-test-receipt/r10", NS_SUITES)):
        ok = False
        runs = os.path.join(stage, "runs")
        for n in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
            if n.startswith(pat):
                try:
                    ok = ok or receipt_ok(json.loads(read_all(os.path.join(runs, n, "receipt.json"), FILE_CAP)), sums, fmt, suites)
                except (OSError, ValueError, Refused):
                    continue
        if not ok:
            refuse(f"no passing {fmt} receipt for this frozen stage")
    return sums


# ---- the completion gate (pinned 1773 runner + r3 core; metadata only) -------------------------------------------------------------------
def live_completion():
    sys.dont_write_bytecode = True
    R = load_exact("runner1773", "runner_1773")                     # its top level re-verifies the frozen r3 stage SUMS
    if sha(read_all(os.path.realpath(R.MP.__file__), 4 << 20)) != PINS["r3Core"][1]:
        refuse("the 1773 runner's r3 core is not the pinned multipart.py")
    d, msha = R.MP.load_manifest(*PINS["manifest"])
    status = R.MP.status(d, msha)
    remaining = {}
    for name in ("root", "vm"):
        fd, cache, n = R.MP.open_dir(d["targets"][name]["dir"], f"target {name}"), {}, 0
        try:
            for p in d["parts"]:
                if p["target"] == name and not R.part_state(d, msha, p, fd, cache)["committed"]:
                    n += p["length"]
        finally:
            os.close(fd)
        remaining[name] = n
    return completion(status, remaining)


def no_live_sessions():
    SG = load_exact("r6SessionGuard", "r6_session_guard")
    live, _mentions = SG.scan(os.getuid(), SG.ancestors(os.getpid()))
    if live:
        refuse(f"a live orchestrate/overlay/composite session process: {live[:3]}")
    G = load_exact("r10MemoryGate", "r10_memory_gate")
    if G.guard() != 0:
        refuse("a live memory_gate.py gate/runtime process")
    mi = read_all("/proc/self/mountinfo", 4 << 20).decode()
    hits = [l for l in mi.splitlines() if any(m in l for m in STAGE_MARKERS)]
    if hits:
        refuse(f"a recovery/composite stage mount exists: {hits[0][:160]}")
    return True


def own_lane():
    lines = [l for l in read_all("/proc/self/cgroup", 4096).decode().splitlines() if l.startswith("0::")]
    if len(lines) != 1:
        refuse("not a single cgroup v2 entry")
    mm = read_all("/sys/fs/cgroup" + lines[0][3:] + "/memory.max", 64).decode()
    avail = [int(l.split()[1]) / 1024 for l in read_all("/proc/meminfo", 1 << 16).decode().splitlines() if l.startswith("MemAvailable:")]
    return lane_ok(mm, avail[0] if avail else 0)


# ---- bounded capture of the namespace build (no rlimit on the child) ---------------------------------------------------------------------
def _write_all(fd, b):
    while b:
        n = os.write(fd, b); b = b[n:]


def group_alive(pgid):
    """any LIVE (non-zombie) process in process group pgid (the zombie leader itself does not count)"""
    for e in os.listdir("/proc"):
        if e.isdigit():
            try:
                with open(f"/proc/{e}/stat") as f:
                    st = f.read()
            except OSError:
                continue
            rest = st[st.rfind(")") + 2:].split()
            if len(rest) > 2 and rest[2] == str(pgid) and rest[0] != "Z":
                return True
    return False


def run_capture(argv, out_path, cap=FILE_CAP, grace=CAPTURE_GRACE, forward=True, hard=CAPTURE_HARD, term_wait=CAPTURE_TERM_WAIT):
    """-> {rc, kept, total, abandoned, sinkError, pid}. The child runs in its OWN process group with NO rlimit; its stdout+stderr go
    through this reader: the first `cap` bytes into out_path (NEW file), the rest drained and counted.
    OWNERSHIP (root 1847): the group is ours while its leader is NOT YET REAPED by our single final wait - also after the leader EXITED (its
    zombie keeps the pgid reserved). `running` (waitid WNOWAIT) is only an observation. Every iteration reads a BOUNDED amount and then
    ticks the lifecycle, also after EOF:
      * our SIGTERM/SIGINT/SIGHUP (handlers installed BEFORE the spawn) and a capture-sink write OR fsync failure send ONE SIGTERM to the
        owned group (build.sh's trap keeps it; disk_guard stops ITS OWN separate build group in order and exits);
      * `grace` s after the leader exited while the pipe is still open or group members still live, or `term_wait` s after our TERM
        while the leader still runs (EOF or not), the owned group is SIGKILLed;
      * `hard` s after that KILL, if the pipe is still held (a holder OUTSIDE our group) or the group still has live members: reading
        stops - abandoned, never a success (no subreaper: such a process is the queue's tree kill's to end);
      * done when EOF AND the leader exited AND the group has no live member.
    Spawn failure: the fd is closed, the exception propagates. Any other unexpected error: the read end is closed, TERM, a bounded wait,
    KILL of the remaining owned group (even if the leader already exited), the final reap, re-raise. Before the final reap the
    forwarding handlers are DISARMED, so no signal is ever sent to a reaped pgid."""
    st = {"p": None, "pending": False, "sentAt": None, "final": False}
    res = {"rc": None, "kept": 0, "total": 0, "abandoned": False, "sinkError": None, "pid": None}

    def running():
        return os.waitid(os.P_PID, st["p"].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None

    def signal_group(sig):
        if st["p"] is not None and not st["final"]:                      # owned: the leader is not yet reaped (final wait not begun)
            try:
                os.killpg(st["p"].pid, sig)
            except ProcessLookupError:
                pass

    def term_group():
        if st["p"] is not None and st["sentAt"] is None and not st["final"]:
            st["sentAt"] = time.monotonic()
            signal_group(signal.SIGTERM)

    def sink_failed(what, e):
        if res["sinkError"] is None:
            res["sinkError"] = f"{what}: {type(e).__name__}: {e}"[:200]
        term_group()                                                     # the evidence sink failed: stop the OWNED build in order

    def fwd(_signum, _f):
        st["pending"] = True
        term_group()                                                     # no-op once disarmed (final) or before the spawn
    old = {s_: signal.signal(s_, fwd) for s_ in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)} if forward else {}
    fd, done = None, False
    try:
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        st["p"] = p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True)
        res["pid"] = p.pid
        if st["pending"]:
            term_group()                                                 # a signal that arrived during the spawn
        rfd = p.stdout.fileno(); os.set_blocking(rfd, False)
        exited_at = killed_at = None
        eof = False
        while True:
            got = 0
            while not eof and got < (64 << 16):                          # bounded per tick: the lifecycle below always runs
                try:
                    b = os.read(rfd, 1 << 16)
                except BlockingIOError:
                    break
                if not b:
                    eof = True
                    try:
                        os.fsync(fd)                                     # the sink is complete only when durable
                    except OSError as e:
                        sink_failed("fsync", e)
                    break
                got += len(b); res["total"] += len(b)
                if res["sinkError"] is None and res["kept"] < cap:
                    try:
                        w = b[:cap - res["kept"]]; _write_all(fd, w); res["kept"] += len(w)
                    except OSError as e:
                        sink_failed("write", e)
            now = time.monotonic()
            if exited_at is None and not running():
                exited_at = now
            members = exited_at is not None and group_alive(p.pid)
            if eof and exited_at is not None and not members:
                break                                                    # done: all output read, leader exited, group empty
            if killed_at is None and ((exited_at is not None and now - exited_at > grace)
                                      or (exited_at is None and st["sentAt"] is not None and now - st["sentAt"] > term_wait)):
                signal_group(signal.SIGKILL); killed_at = now            # owned (unreaped) group: also after the leader exited
            if killed_at is not None and now - killed_at > hard:
                res["abandoned"] = True; break                           # a holder outside our group, or unkillable members
            if not got:
                time.sleep(0.05)
        done = True
    finally:
        if fd is not None:
            os.close(fd)
        p = st["p"]
        if p is not None:
            p.stdout.close()                                             # writers now get EPIPE instead of blocking on us
            if not done:                                                 # unexpected error: owned orderly stop, bounded, then KILL
                term_group()
                end = time.monotonic() + term_wait
                while time.monotonic() < end and (running() or group_alive(p.pid)):
                    time.sleep(0.2)
                if running() or group_alive(p.pid):
                    signal_group(signal.SIGKILL)                         # the remaining OWNED group, even if the leader already exited
            st["final"] = True                                           # disarm: no signal from here on (handlers included)
            res["rc"] = p.wait()                                         # the single, final reap
        for s_, h in old.items():
            signal.signal(s_, h)
    return res


# ---- authenticated receipt (binaries stay on /vm) -------------------------------------------------------------------------------------
RUN_LINE = re.compile(r"^## disk-guard run dir (/\S+)$", re.M)


def authenticate(capture_text, base=BASE, mode="build"):
    """-> (run dir, details): the guard's announced run dir, verified on disk; for build mode also the in-place binaries + accounting"""
    runs = RUN_LINE.findall(capture_text)
    if len(runs) != 1:
        refuse(f"the guard announced {len(runs)} run dirs (need exactly one)")
    run = runs[0]
    bst = os.lstat(base)
    if os.path.dirname(run) != base.rstrip("/") or not re.fullmatch(r"run-\d{8}T\d{6}Z-\d+", os.path.basename(run)):
        refuse(f"{run} is not a run-* child of the pinned base {base}")
    st = os.lstat(run)
    if not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o700 or st.st_uid != os.getuid() or st.st_dev != bst.st_dev:
        refuse(f"{run} is not our real 0700 directory on the base filesystem")
    g = json.loads(read_all(os.path.join(run, "guard-receipt.json"), 4 * MIB))
    if g.get("format") != "bsro-disk-guard/r5" or g.get("runDir") != run:
        refuse("guard-receipt.json does not name this run dir")
    if "reason" not in g or g["reason"] is not None or type(g.get("childRc")) is not int or g["childRc"] != 0 \
            or g.get("groupLeftAlive") is not False:                    # root 1843 #1: ONLY a guard that ended clean
        refuse(f"the guard did not end clean: reason {g.get('reason')!r}, childRc {g.get('childRc')!r}, groupLeftAlive {g.get('groupLeftAlive')!r}")
    out = {"runDir": run, "guardReceiptSha256": sha(read_all(os.path.join(run, "guard-receipt.json"), 4 * MIB)),
           "guardReason": g.get("reason"), "guardChildRc": g.get("childRc")}
    if mode != "build":
        return run, out
    od = os.path.join(run, "out")
    ost = os.lstat(od)
    if not stat.S_ISDIR(ost.st_mode) or ost.st_dev != bst.st_dev:
        refuse("the build output is not a real directory in the run dir")
    raw = read_all(os.path.join(od, "accounting.json"), FILE_CAP)
    acc = json.loads(raw)
    bins = {}
    for b in BINARIES:
        p = os.path.join(od, b)
        bst2 = os.lstat(p)
        if not stat.S_ISREG(bst2.st_mode) or bst2.st_dev != bst.st_dev or stat.S_IMODE(bst2.st_mode) != 0o555:
            refuse(f"{p} is not a 0555 regular file on /vm")
        h, n = file_sha(p)
        bins[b] = {"path": p, "sha256": h, "size": n, "ino": bst2.st_ino}
        if (acc.get("binaries") or {}).get(b, {}).get("sha256") != h:
            refuse(f"{b}: the in-place sha256 differs from accounting.json")
    if acc.get("format") != "bsro-build-accounting/r10" or acc.get("verdict") != "ok":
        refuse(f"accounting.json verdict is not ok: {acc.get('verdict')}")
    out.update(outDir=od, binaries=bins, accountingSha256=sha(raw), allocBytes=acc.get("runDirAllocBytes"), tmpResidualBytes=acc.get("tmpResidualBytes"))
    return run, out


def final_rc(child_rc, verified):
    return child_rc if child_rc != 0 else (0 if verified else 10)


def account(run, out, tmp, build_rc, unchanged_rc, lock_rc):
    """inside the guarded build: the terminal accounting (bounded, O_EXCL) of the ONE /vm run dir"""
    spec = types.ModuleType("bsro_disk_guard"); path = os.path.join(S, "jobs", "disk_guard.py")
    exec(compile(read_all(path, 1 << 20), path, "exec"), spec.__dict__)            # the unchanged r5 guard's own alloc_bytes
    bins = {}
    for b in BINARIES:
        p = os.path.join(out, b)
        if os.path.isfile(p) and not os.path.islink(p):
            h, n = file_sha(p); bins[b] = {"sha256": h, "size": n}
    ok = build_rc == 0 and unchanged_rc == 0 and lock_rc == 0 and set(bins) == set(BINARIES)
    rec = {"format": "bsro-build-accounting/r10", "runDir": run, "runDirAllocBytes": spec.alloc_bytes(run), "tmpResidualBytes": spec.alloc_bytes(tmp),
           "binaries": bins, "buildRc": build_rc, "unchangedRc": unchanged_rc, "lockRc": lock_rc, "verdict": "ok" if ok else "failed"}
    write_new(os.path.join(out, "accounting.json"), (json.dumps(rec, indent=1, sort_keys=True) + "\n").encode())
    return 0 if ok else 1


# ---- the outer orchestration -----------------------------------------------------------------------------------------------------------
def outer(mode):
    if mode not in ("build", "preflight"):
        refuse("mode must be build or preflight")
    sums = qualified()
    maps_outside(read_all("/proc/self/uid_map", 4096).decode(), read_all("/proc/self/gid_map", 4096).decode(), os.getuid(), os.getgid())
    own_lane()
    root_floor_ok(free_bytes(S))
    no_live_sessions()
    fp = live_completion()
    meta = os.path.join(S, "runs", f"{mode}-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}")
    os.mkdir(meta, 0o700)
    root0 = free_bytes(S)
    argv = ["unshare", "-Urnm", "bash", os.path.join(S, "jobs", "build.sh"), mode, str(os.getuid()), str(os.getgid()), fp]
    try:
        cap = run_capture(argv, os.path.join(meta, "build-output.txt"))
    except OSError as e:                                                # e.g. unshare missing: recorded, never a success
        cap = {"rc": 127, "kept": 0, "total": 0, "abandoned": False, "sinkError": f"spawn: {type(e).__name__}: {e}"[:200], "pid": None}
        print(f"## could not start the namespace build: {e}", file=sys.stderr)
    rc = cap["rc"]
    root1 = free_bytes(S)
    rec = {"format": "bsro-build-receipt/r10", "mode": mode, "stageSums": sums, "completionFingerprint": fp, "childRc": rc,
           "capture": {"keptBytes": cap["kept"], "totalBytes": cap["total"], "truncated": cap["total"] > cap["kept"],
                       "abandoned": cap["abandoned"], "sinkError": cap["sinkError"]},
           "rootFree": {"before": root0, "after": root1, "deltaAdvisory": root0 - root1}, "verified": False}
    try:
        text = read_all(os.path.join(meta, "build-output.txt"), FILE_CAP).decode(errors="replace")
        run, rec["guard"] = authenticate(text, BASE, mode)
        root_floor_ok(root1)                                             # the explicit root floor is MANDATORY after the run too
        if cap["abandoned"]:
            refuse("the build output pipe was still held by a process outside our group")
        if cap["sinkError"]:
            refuse(f"the capture sink failed: {cap['sinkError']}")
        rec["verified"] = True
    except (Refused, OSError, ValueError) as e:
        rec["verifyError"] = f"{type(e).__name__}: {e}"[:400]
    rec["finalRc"] = final_rc(rc, rec["verified"])
    write_new(os.path.join(meta, "receipt.json"), (json.dumps(rec, indent=1, sort_keys=True, default=str) + "\n").encode())
    if mode == "build" and rec["verified"]:
        os.symlink(rec["guard"]["outDir"], os.path.join(meta, "out"))   # a pointer only; the binaries stay on /vm
    print(json.dumps({k: rec.get(k) for k in ("mode", "childRc", "finalRc", "verified", "verifyError")}))
    return rec["finalRc"]


def verify_binaries(bin_dir, stage=S):
    """positive.sh / fixtures.sh: BIN_DIR must be the /vm out dir of a VERIFIED build receipt of this stage, binaries unchanged"""
    sums = sha(read_all(os.path.join(stage, "SHA256SUMS"), 1 << 20))
    runs = os.path.join(stage, "runs")
    for n in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
        if not n.startswith("build-"):
            continue
        try:
            r = json.loads(read_all(os.path.join(runs, n, "receipt.json"), FILE_CAP))
        except (OSError, ValueError, Refused):
            continue
        g = r.get("guard") or {}
        if r.get("verified") is True and r.get("finalRc") == 0 and r.get("stageSums") == sums and g.get("outDir") == os.path.normpath(bin_dir):
            for b in BINARIES:
                if file_sha(os.path.join(g["outDir"], b))[0] != g["binaries"][b]["sha256"]:
                    refuse(f"{b} changed since its build receipt")
            return True
    refuse(f"{bin_dir} is not the output of a verified build receipt of this stage")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv[:1] == ["outer"] and len(argv) == 2:
            return outer(argv[1])
        if argv == ["qualified"]:
            qualified(); return 0
        if argv[:1] == ["verify-binaries"] and len(argv) == 2:
            verify_binaries(argv[1]); return 0
        if argv[:1] == ["inner-gate"]:
            ap = argparse.ArgumentParser(prog="bsro_gate.py inner-gate")
            ap.add_argument("--uid", type=int, required=True); ap.add_argument("--gid", type=int, required=True)
            ap.add_argument("--fingerprint", required=True); ap.add_argument("--ro", action="append", default=[])
            ap.add_argument("--rw", action="append", default=[])
            a = ap.parse_args(argv[1:])
            maps_inside(read_all("/proc/self/uid_map", 4096).decode(), read_all("/proc/self/gid_map", 4096).decode(),
                        read_all("/proc/self/setgroups", 64).decode(), a.uid, a.gid)
            ns_checks(read_all("/proc/self/mountinfo", 4 << 20).decode(), a.ro, a.rw, RO_ROOTS)
            if live_completion() != a.fingerprint:
                refuse("the completion fingerprint inside the namespace differs from the outer gate's")
            return 0
        if argv[:1] == ["ns-check"]:                                     # read-only checks only (the namespace test's production path)
            ap = argparse.ArgumentParser(prog="bsro_gate.py ns-check")
            ap.add_argument("--ro", action="append", default=[]); ap.add_argument("--rw", action="append", default=[])
            ap.add_argument("--ro-root", action="append", default=[])
            a = ap.parse_args(argv[1:])
            ns_checks(read_all("/proc/self/mountinfo", 4 << 20).decode(), a.ro, a.rw, a.ro_root or RO_ROOTS); return 0
        if argv[:1] == ["account"]:
            ap = argparse.ArgumentParser(prog="bsro_gate.py account")
            for k in ("--run", "--out", "--tmp"):
                ap.add_argument(k, required=True)
            for k in ("--build-rc", "--unchanged-rc", "--lock-rc"):
                ap.add_argument(k, type=int, required=True)
            a = ap.parse_args(argv[1:])
            return account(a.run, a.out, a.tmp, a.build_rc, a.unchanged_rc, a.lock_rc)
    except (Refused, OSError, ValueError) as e:
        print(f"## REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr); return 3
    print("usage: bsro_gate.py outer MODE | qualified | inner-gate ... | ns-check ... | account ... | verify-binaries DIR", file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main())
