#!/usr/bin/env python3
"""base-state-readonly-stage/r8 jobs/bsro_gate.py (prepared by Claude 1839; NOT run by Claude). Standard library + pinned stages only.

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


GUARD_SUITES = {"test_disk_guard": 10, "test_mount_identity": 6, "test_bsro_gate": 11}
NS_SUITES = {"test_ns": 4}


def qualified(stage=S):
    sums = sha(read_all(os.path.join(stage, "SHA256SUMS"), 1 << 20))
    for pat, fmt, suites in (("guard-tests-", "bsro-guard-test-receipt/r8", GUARD_SUITES), ("ns-tests-", "bsro-ns-test-receipt/r8", NS_SUITES)):
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
def run_capture(argv, out_path, cap=FILE_CAP, grace=CAPTURE_GRACE, forward=True, hard=CAPTURE_HARD):
    """-> (rc, kept, total, abandoned). The child runs in its OWN process group; its stdout+stderr go through this reader: the first `cap` bytes
    are written to out_path (NEW file), the rest is drained and counted (never blocks the child, never limits its files). Our
    SIGTERM/SIGINT/SIGHUP is forwarded ONCE to the child's group while its leader is unreaped. After the leader exits, EOF is awaited
    for `grace` s, then the remaining group is SIGKILLed (leader still unreaped: its pgid cannot be reused); if the pipe is STILL held
    `hard` s later (a holder outside our group) reading stops (abandoned=True, never a success); then the single reap."""
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    sent, old = {"n": False}, {}

    def unreaped():
        return os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None

    def fwd(signum, _f):
        if not sent["n"]:
            sent["n"] = True
            try:
                os.killpg(p.pid, signal.SIGTERM)                         # leader unreaped until our single reap: pgid is ours
            except ProcessLookupError:
                pass
    if forward:
        old = {s: signal.signal(s, fwd) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    kept = total = 0
    exited_at, killed_at, abandoned = None, None, False
    try:
        os.set_blocking(p.stdout.fileno(), False)
        while True:
            try:
                b = os.read(p.stdout.fileno(), 1 << 16)
            except BlockingIOError:
                b = None
            if b == b"":
                break
            if b:
                total += len(b)
                if kept < cap:
                    w = b[:cap - kept]; os.write(fd, w); kept += len(w)
                continue
            if exited_at is None and not unreaped():
                exited_at = time.monotonic()
            if killed_at is None and exited_at is not None and time.monotonic() - exited_at > grace:
                try:
                    os.killpg(p.pid, signal.SIGKILL)                     # a descendant still holds the pipe: our group only
                except ProcessLookupError:
                    pass
                killed_at = time.monotonic()
            if killed_at is not None and time.monotonic() - killed_at > hard:
                abandoned = True; break
            time.sleep(0.05)
    finally:
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        p.stdout.close()
        rc = p.wait()
        for s, h in old.items():
            signal.signal(s, h)
    return rc, kept, total, abandoned


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
    if acc.get("format") != "bsro-build-accounting/r8" or acc.get("verdict") != "ok":
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
    rec = {"format": "bsro-build-accounting/r8", "runDir": run, "runDirAllocBytes": spec.alloc_bytes(run), "tmpResidualBytes": spec.alloc_bytes(tmp),
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
        rc, kept, total, abandoned = run_capture(argv, os.path.join(meta, "build-output.txt"))
    except OSError as e:                                                # e.g. unshare missing: recorded, never a success
        rc, kept, total, abandoned = 127, 0, 0, False
        print(f"## could not start the namespace build: {e}", file=sys.stderr)
    root1 = free_bytes(S)
    rec = {"format": "bsro-build-receipt/r8", "mode": mode, "stageSums": sums, "completionFingerprint": fp, "childRc": rc,
           "capture": {"keptBytes": kept, "totalBytes": total, "truncated": total > kept, "abandoned": abandoned},
           "rootFree": {"before": root0, "after": root1, "deltaAdvisory": root0 - root1}, "verified": False}
    try:
        text = read_all(os.path.join(meta, "build-output.txt"), FILE_CAP).decode(errors="replace")
        run, rec["guard"] = authenticate(text, BASE, mode)
        root_floor_ok(root1)
        if abandoned:
            refuse("the build output pipe was still held by a process outside our group")                                             # the explicit root floor is MANDATORY after the run too
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
            propagation_private(read_all("/proc/self/mountinfo", 4 << 20).decode())
            read_only(a.ro, a.rw)
            if live_completion() != a.fingerprint:
                refuse("the completion fingerprint inside the namespace differs from the outer gate's")
            return 0
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
    print("usage: bsro_gate.py outer MODE | qualified | inner-gate ... | account ... | verify-binaries DIR", file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main())
