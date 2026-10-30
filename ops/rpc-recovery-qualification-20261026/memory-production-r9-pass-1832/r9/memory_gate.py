#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r9 memory_gate.py (prepared by Claude 1825/1829; NOT run by Claude). Stdlib + pinned stages only.
r9 = r8 (7472d522..., root 1828 + review 1827) + narrow fixes: `stop` (identity-bound SIGTERM of THIS r9 runtime only), `guard` (live
memory_gate.py gate/runtime processes, via the pinned r6 session_guard parser), `evidence` (the job's final-evidence check used by
jobs/final-status.sh), and every telemetry-tick failure counted (soft stop after 3) instead of escaping as a misleading REFUSED.

The memory-aware PRODUCTION entry for the structural MDBX check of the composite view. r1-r7 are unchanged; the r7 2560 MiB path is NOT
used. One file, two entry points:

  gate     fail-closed checks, then ONE mutation (MemoryHigh=3712M on OUR OWN 4096 MiB queue scope, verified), then os.execv(runtime)
  runtime  the UNCHANGED, fixture-qualified r6 lifecycle (composite_session.py 407aa7e9..., its own main()) with two narrow additions:
           a Session subclass (bounded telemetry + an ORDERED soft stop + nbdfuse post-use identity) and a classify wrapper that never
           lets CLEAN/PROBLEMS through after an OOM event. The pinned checker (mdbx_check.py f0d27e40... + mdbx_chk c228b462...) is
           executed exactly as in r6: structural only.

Gate checks (each refuses rc 3; MemoryHigh is set only after ALL pass):
  * this process's RLIMIT_FSIZE <= 32 MiB (the job's `ulimit -f`; every file of the run is bounded)
  * r7 stage SUMS ec006ff6... (+ its gate production_gate.py 33419b83...) and r7's ACTUAL gate-test PASS receipt (exact bytes)
  * through r7's own functions: the r6 stage SUMS / qualified files and the EXACT r6 4+12 qualification receipt
  * the r4 memory fixture stage SUMS 25245e21... and its ACTUAL receipts (exact bytes): tests PASS (11), job PASS (MEASURED, peers
    unchanged, no mount / process left), fixture receipt MEASURED (8 GiB scanned, 0 nonzero, high events > 0, no oom / oom_kill)
  * our cgroup: exactly ONE user-manager transient run-*.scope, memory.max == 4096 MiB (the queue's largest main lane), memory.high
    == max, the job bash (--tree-root-pid) is our ancestor in the same cgroup; MemAvailable >= 16 GiB + 4096 + 256 MiB
  * reservations (pinned 1773 runner part_state through the pinned r4 helper): root free >= every not-r3-validated-committed root
    part + 40 GiB floor + 8 GiB native reservation + the 208 MiB output budget; /vm free >= its remaining + 40 GiB floor; the run dir
    on the pinned root target filesystem (253:0, its UUID, not USB)
  * the REAL production view through r7's check_view: the pinned r6 importer load_view(production) + recheck (ALL 265 parts committed
    AND independently verified in CONFIRMED sessions, bindings, identities, record bytes), manifest f94807f7..., 1,138,166,333,440 B
  * then MemoryHigh=3712M via the pinned r4 setter (ControlGroup == our cgroup BEFORE; own high/max and the PARENT verified after)

LIMITS: MemoryHigh is a reclaim/throttle threshold, NOT a ceiling, and it throttles the WHOLE scope (queue guard, job bash, runtime,
qemu-nbd, nbdfuse, wrapper, mdbx_chk). The memory.max OOM victim is NOT guaranteed. The 0.5 s soft stop (tree VmRSS > 3840 MiB or
MemAvailable < 16896 MiB) RACES the outer 250 ms guard and other host allocations. Production page tables (~used/512) and mdbx_chk's
pagemap (~2 B/page) are ESTIMATES only; the r4 mechanism PASS was 8 GiB synthetic. No smaps_rollup; nothing reads the DB into RAM.
A soft stop is a CANCELLED run (never CLEAN); a timeout is INCONCLUSIVE; an OOM event downgrades CLEAN/PROBLEMS to INCONCLUSIVE.

    memory_gate.py gate --view-dir DIR --run-dir NEW_EMPTY_DIR --max-hours H --tree-root-pid PID
    memory_gate.py runtime --tree-root-pid PID -- <r6 composite_session.py arguments: production only>
    memory_gate.py stop SESSION_DIR          (SIGTERM to the recorded r9 runtime only, after pidfd + identity checks)
    memory_gate.py guard                     (rc 1 while a real memory_gate.py gate/runtime process of this user is live)
    memory_gate.py evidence RECEIPT RC JRC   (rc 0 only for a well-formed, structurally-clean final job receipt)
"""
import argparse, hashlib, json, os, resource, signal, sys, time, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
THIS = os.path.realpath(__file__)
R7D, R4D = W + "/composite-mdbx-validation-stage/r7", W + "/composite-memory-fixture-stage/r4"
PINS = {
    "r7Gate": (R7D + "/production_gate.py", "33419b834d896601a4cfa7d82e18282c51327ce94ecb20aec8ee7fa8ee7152eb"),
    "r7Sums": (R7D + "/SHA256SUMS", "ec006ff6e7b0095c03c108a4d82d8ca1bdbf7515d6858a3b1886fb51c7198396"),
    "r7GateTests": (R7D + "/runs/gate-tests-20261027T021511Z-2624653/receipt.json", "24d3a9893421b3e1e59730976a6a3fa43f3b08118f0f1947c7754d1363829299"),
    "r6Runtime": (W + "/composite-mdbx-validation-stage/r6/composite_session.py", "407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6"),
    "r4Fixture": (R4D + "/memory_fixture.py", "f1e04105027af197e3517d734e031872939f5490e2b9cf3100f0c37d8772c274"),
    "r4Sums": (R4D + "/SHA256SUMS", "25245e21772377bcbacd9e27d8eb9d330e1340a3b2b1de9f98177b3603a17789"),
    "r4Tests": (R4D + "/runs/tests-20261027T032614Z-2700983/receipt.json", "559ed6d5b80ef83631a01193650eef316d5d00f3abc677eb2eaf910939c8048a"),
    "r4Job": (R4D + "/runs/job-20261027T034625Z-2720327/receipt.json", "c24bc095716c9b8cfb44e60d28d0420a3c82579c86821df0fb9af3cb61521b3c"),
    "r4Run": (R4D + "/runs/fixture-20261027T034625Z-2720327/receipt.json", "f7b11bb1ac9ef5cc5621d6ba0f17e8775bc5619b5f82678495aaef81fe2e500a"),
    "r6SessionGuard": (W + "/composite-mdbx-validation-stage/r6/jobs/session_guard.py", "f64c6115ab8ac871d1813d53d45d3b03369c330c45617763824a4bb3fef287ce"),
}
MANIFEST_SHA = "f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9"
MIB = 1 << 20
LANE_MIB, HIGH_MIB, FLOOR_MIB, ADMIT_HEADROOM_MIB = 4096, 3712, 16384, 256
SOFT_TREE_RSS_MIB, SOFT_AVAIL_MIB = 3840, FLOOR_MIB + 512
NATIVE_RESERVE = 8 << 30
JOB_FILE_CAP, CHILD_LOG_CAP = 32 << 20, 16 << 20                       # the job's `ulimit -f 32768`; every r6 child's RLIMIT_FSIZE
OUTPUT_BUDGET = 4 * JOB_FILE_CAP + 4 * CHILD_LOG_CAP + (16 << 20)      # job stdout/stderr, gate.json, receipt + qemu-nbd/nbdfuse logs,
#                                                                      # validator.out, mdbx-report.json + small files = 208 MiB
SAMPLE_EVERY, MAX_SAMPLES, TELEMETRY_FAILS, MAX_ERRORS = 120.0, 2048, 3, 20
OOM_KEYS = ("oom", "oom_kill", "oom_group_kill")
PY3 = "/usr/bin/python3"
LIMITS = ["MemoryHigh 3712 MiB is a reclaim/throttle threshold, NOT a ceiling",
          "MemoryHigh applies to the WHOLE queue scope (node guard, job bash, runtime, qemu-nbd, nbdfuse, wrapper, mdbx_chk): all can be "
          "throttled, which can delay the outer guard and slow the servers",
          "the memory.max (4096 MiB) OOM victim is NOT guaranteed",
          "the 0.5 s soft stop races the outer 250 ms tree-VmRSS guard and other host allocations",
          "production page tables (~used bytes / 512) and mdbx_chk's pagemap (~2 bytes/page) are ESTIMATES; the r4 mechanism PASS was an "
          "8 GiB synthetic mapping", "CLEAN is STRUCTURAL ONLY (mdbx_chk); not chain / state / trie / canonical-root / RPC validation"]


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
    """a pinned module compiled from exactly the bytes that were hashed (no second read, no bytecode)"""
    path, want = PINS[name]
    raw = read_all(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned file")
    mod = types.ModuleType(modname); mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


def pinned_json(name):
    path, want = PINS[name]
    raw = read_all(path, 1 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the exact pinned receipt")
    return json.loads(raw)


# ---- pure checks (unit-tested) ---------------------------------------------------------------------------------------------------------
CHK5 = {"lastLineOK", "noBadMarkers", "ranExactly", "rc0", "stdoutEmpty"}


def all_true(d, keys):
    return isinstance(d, dict) and set(d) == keys and all(v is True for v in d.values())


def check_r7_gate_tests(r):
    if not (isinstance(r, dict) and r.get("format") == "composite-production-gate-test-receipt/r7" and r.get("pass") is True
            and r.get("rc") == 0 and r.get("ran") == ["6"] and r.get("expectedTests") == 6 and r.get("badMarkers") == []
            and all_true(r.get("checks"), CHK5) and r.get("stageSums") == PINS["r7Sums"][1] and r.get("gateSha256") == PINS["r7Gate"][1]):
        refuse("r7 gate-test receipt: not the actual 6-test PASS of the pinned r7 gate")
    return True


def check_r4_tests(r):
    if not (isinstance(r, dict) and r.get("format") == "composite-memory-fixture-test-receipt/r2" and r.get("pass") is True
            and r.get("rc") == 0 and r.get("ran") == ["11"] and r.get("expectedTests") == 11 and r.get("badMarkers") == []
            and all_true(r.get("checks"), CHK5) and r.get("stageSums") == PINS["r4Sums"][1] and r.get("fixtureSha256") == PINS["r4Fixture"][1]):
        refuse("r4 test receipt: not the actual 11-test PASS of the pinned r4 fixture")
    return True


def check_r4_job(r):
    w = r.get("walker") if isinstance(r, dict) else None
    res = (w or {}).get("result") or {}
    if not (isinstance(r, dict) and r.get("format") == "composite-memory-fixture-job-receipt/r2" and r.get("pass") is True
            and r.get("outcome") == "MEASURED" and r.get("controllerRc") == 0 and r.get("controllerKilled") is False
            and r.get("wrapperTerm") is False and r.get("mountsLeft") == "" and r.get("processesLeft") == ""
            and all_true(r.get("checks"), {"cleanupComplete", "controllerRc0", "measured", "noMountLeft", "noProcessLeft", "peersUnchanged"})
            and r.get("stageSums") == PINS["r4Sums"][1] and r.get("controllerReceiptSha256") == PINS["r4Run"][1]
            and isinstance(w, dict) and w.get("rc") == 0 and w.get("softStop") is None and w.get("timedOut") is False
            and res.get("scannedBytes") == 8 << 30 and res.get("nonzeroPages") == 0):
        refuse("r4 job receipt: not the actual MEASURED PASS (peers unchanged, nothing left, 8 GiB scanned)")
    return True


def check_r4_run(r):
    if not isinstance(r, dict):
        refuse("r4 fixture receipt: not an object")
    b, a = ((r.get("cgBefore") or {}).get("events") or {}), ((r.get("cgAfter") or {}).get("events") or {})
    sc = r.get("scope") or {}
    if not (r.get("format") == "composite-memory-fixture-receipt/r2" and r.get("outcome") == "MEASURED" and r.get("rc") == 0
            and r.get("cleanupComplete") is True and r.get("childrenAlive") == [] and r.get("leftoverProcesses") == []
            and r.get("mountLeft") is False and not dirty(b, a) and a.get("high", 0) > b.get("high", 0)
            and (sc.get("after") or {}).get("parentHigh") == (sc.get("before") or {}).get("parentHigh")):
        refuse("r4 fixture receipt: not a MEASURED run with high events, no OOM event, complete cleanup and the parent unchanged")
    return True


def dirty(before, after):
    """an OOM event (or unreadable counters) between two memory.events snapshots"""
    if not (isinstance(before, dict) and isinstance(after, dict)):
        return True
    return any(not isinstance(before.get(k), int) or not isinstance(after.get(k), int) or after[k] > before[k] for k in OOM_KEYS)


def lane_ok(memory_max_text, high_text, avail_mib):
    if memory_max_text.strip() != str(LANE_MIB * MIB):
        refuse(f"memory.max {memory_max_text.strip()!r} is not the {LANE_MIB} MiB main queue lane (the r7 2560 path is not used)")
    if high_text.strip() != "max":
        refuse(f"our scope already has memory.high {high_text.strip()!r}")
    if avail_mib < FLOOR_MIB + LANE_MIB + ADMIT_HEADROOM_MIB:
        refuse(f"MemAvailable {avail_mib:.0f} MiB < 16 GiB floor + {LANE_MIB} + {ADMIT_HEADROOM_MIB}")
    return {"memoryMaxMiB": LANE_MIB, "memAvailableMiB": round(avail_mib)}


def reserve(free_root, rem_root, floor_root, free_vm, rem_vm, floor_vm):
    need_root = rem_root + floor_root + NATIVE_RESERVE + OUTPUT_BUDGET
    need_vm = rem_vm + floor_vm
    if free_root < need_root:
        refuse(f"root free {free_root} < remaining {rem_root} + floor {floor_root} + 8 GiB native + output budget {OUTPUT_BUDGET}")
    if free_vm < need_vm:
        refuse(f"/vm free {free_vm} < remaining {rem_vm} + floor {floor_vm}")
    return {"root": {"free": free_root, "remaining": rem_root, "floor": floor_root, "native": NATIVE_RESERVE, "outputBudget": OUTPUT_BUDGET,
                     "need": need_root, "margin": free_root - need_root},
            "vm": {"free": free_vm, "remaining": rem_vm, "floor": floor_vm, "need": need_vm, "margin": free_vm - need_vm}}


def soft_reason(tree_rss_mib, avail_mib):
    if tree_rss_mib > SOFT_TREE_RSS_MIB:
        return f"soft stop: tree VmRSS {tree_rss_mib:.0f} MiB > {SOFT_TREE_RSS_MIB} MiB (the outer guard stops at {LANE_MIB})"
    if avail_mib < SOFT_AVAIL_MIB:
        return f"soft stop: MemAvailable {avail_mib:.0f} MiB < {SOFT_AVAIL_MIB} MiB (16 GiB floor + 512)"
    return None


def ancestor_in_cgroup(root_pid):
    p, chain = os.getpid(), []
    while p > 1 and len(chain) < 64:
        s = read_all(f"/proc/{p}/stat", 4096).decode(errors="replace")
        p = int(s[s.rindex(")") + 2:].split()[1]); chain.append(p)
    if root_pid not in chain:
        refuse(f"--tree-root-pid {root_pid} is not our ancestor")
    if read_all(f"/proc/{root_pid}/cgroup", 4096) != read_all("/proc/self/cgroup", 4096):
        refuse("the tree root is not in our cgroup")
    return True


def fsize_ok():
    soft = resource.getrlimit(resource.RLIMIT_FSIZE)[0]
    if soft == resource.RLIM_INFINITY or soft > JOB_FILE_CAP:
        refuse(f"RLIMIT_FSIZE {soft} is not <= {JOB_FILE_CAP} (the job runs this under `ulimit -f 32768`)")
    return soft


# ---- gate ------------------------------------------------------------------------------------------------------------------------------
def check_qualifications(R7):
    out = {"r7": R7.check_stage(stage=R7D, sums_pin=PINS["r7Sums"][1], files={"production_gate.py": PINS["r7Gate"][1]})}
    check_r7_gate_tests(pinned_json("r7GateTests"))
    out["r6Stage"], out["r6Qualification"] = R7.check_stage(), R7.check_receipt()     # r7's own pins: r6 SUMS + exact 4+12 receipt
    out["r4"] = R7.check_stage(stage=R4D, sums_pin=PINS["r4Sums"][1], files={"memory_fixture.py": PINS["r4Fixture"][1]})
    check_r4_tests(pinned_json("r4Tests")); check_r4_job(pinned_json("r4Job")); check_r4_run(pinned_json("r4Run"))
    out["r4Receipts"] = {k: PINS[k][1] for k in ("r4Tests", "r4Job", "r4Run", "r7GateTests")}
    return out


def bind_scope(M4, root_pid):
    rel, unit = M4.scope_of(read_all("/proc/self/cgroup", 4096).decode(), os.getuid())
    d = os.path.join(M4.CG, rel.lstrip("/"))
    lane = lane_ok(read_all(d + "/memory.max", 64).decode(), read_all(d + "/memory.high", 64).decode(), M4.mem_available_mib())
    ancestor_in_cgroup(root_pid)
    return rel, unit, lane


def reservation(M4, run_dir):
    R = M4.load_runner()                                                # the pinned 1773 runner (re-verifies frozen r3) + r3 core
    d, msha = R.MP.load_manifest(M4.PINS["manifest"][0], M4.PINS["manifest"][1])
    if msha != MANIFEST_SHA:
        refuse("not the incident production manifest")
    rt, vt = d["targets"]["root"], d["targets"]["vm"]
    mm = R.MP.majmin(os.stat(run_dir).st_dev)
    if mm != M4.ROOT_MAJMIN or mm != rt["majmin"]:
        refuse(f"run dir filesystem {mm} is not the pinned root target filesystem")
    u, fmm = R.MP.findmnt_uuid(run_dir)
    if (u, fmm) != (rt["uuid"], mm) or R.MP.is_usb(mm):
        refuse("run dir filesystem UUID/device differ from the root target, or it is USB")
    rem_root, rem_vm = M4.root_remaining(R, d, msha, "root"), M4.root_remaining(R, d, msha, "vm")
    fr, fv = os.open(run_dir, os.O_RDONLY | os.O_DIRECTORY), R.MP.open_dir(vt["dir"], "vm target")
    try:
        return reserve(R.MP.free_bytes(fr), rem_root, rt["floorBytes"], R.MP.free_bytes(fv), rem_vm, vt["floorBytes"])
    finally:
        os.close(fr); os.close(fv)


def write_new(run_dir, name, obj):
    fd = os.open(os.path.join(run_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True, default=str) + "\n")


def gate(argv):
    ap = argparse.ArgumentParser(prog="memory_gate.py gate")
    ap.add_argument("--view-dir", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--max-hours", type=int, required=True); ap.add_argument("--tree-root-pid", type=int, required=True)
    a = ap.parse_args(argv)
    rd = a.run_dir
    try:
        st = os.lstat(rd)
        ours = os.path.isabs(rd) and os.path.realpath(rd) == rd and os.path.isdir(rd) and not os.path.islink(rd) \
            and st.st_uid == os.geteuid() and not st.st_mode & 0o077 and not os.listdir(rd)
    except OSError:
        ours = False
    if not ours:                                                        # never write into a run dir we did not just receive empty
        print(json.dumps({"gate": "REFUSED", "reason": "--run-dir must be an existing, EMPTY, private, real absolute directory"})); return 3
    g = {"format": "composite-production-memory-gate/r9", "viewDir": a.view_dir, "maxHours": a.max_hours, "limits": LIMITS, "checks": {},
         "meaning": "gate only; a later CLEAN is STRUCTURAL (mdbx_chk) only"}
    try:
        g["checks"]["rlimitFsize"] = fsize_ok()
        if not 1 <= a.max_hours <= 168:
            refuse("--max-hours must be 1..168")
        R7 = load_exact("r7Gate", "r7_production_gate")
        g["checks"]["qualifications"] = check_qualifications(R7)
        M4 = load_exact("r4Fixture", "r4_memory_fixture")
        M4.LANE_MIB, M4.HIGH_MIB = LANE_MIB, HIGH_MIB                   # the r4 setter / lane helpers, on THIS private instance only
        rel, unit, g["checks"]["lane"] = bind_scope(M4, a.tree_root_pid)
        g["checks"]["reservation"] = reservation(M4, rd)
        g["checks"]["view"] = R7.check_view(a.view_dir)                 # ALL 265 committed + verified (CONFIRMED), the incident view
        g["scope"] = M4.set_memory_high(rel, unit, M4.systemctl_runner(os.getuid()))   # the ONLY mutation, last
        d = os.path.join(M4.CG, rel.lstrip("/"))
        if str(os.getpid()) not in read_all(d + "/cgroup.procs", 1 << 20).decode().split() \
                or read_all(d + "/memory.max", 64).decode().strip() != str(LANE_MIB * MIB):
            refuse("after MemoryHigh: we are no longer in the bound 4096 MiB scope")
    except Exception as e:                                              # noqa: BLE001 - every failure refuses; nothing was started
        g["refused"] = f"{type(e).__name__}: {e}"[:600]
        write_new(rd, "gate-refused.json", g)
        print(json.dumps({"gate": "REFUSED", "reason": g["refused"]})); return 3
    session = os.path.join(rd, "session")
    os.mkdir(session, 0o700)
    argv2 = [PY3, "-I", "-B", THIS, "runtime", "--tree-root-pid", str(a.tree_root_pid), "--", "--view-dir", a.view_dir,
             "--run-dir", session, "--expect-kind", "production", "--validator-timeout", str(a.max_hours * 3600)]
    g["session"] = {"runDir": session, "argv": argv2}
    write_new(rd, "gate.json", g)
    print(json.dumps({"gate": "PASSED", "exec": argv2}), flush=True)
    os.execv(PY3, argv2)


# ---- runtime: the unchanged r6 lifecycle + memory telemetry / soft stop / OOM-aware classification ---------------------------------
def make_memory_session(C, M4, cfg, holder):
    class SoftStop(C.Stop):
        """an ORDERED own-session cancellation: r6 main records it as interrupted (CANCELLED, never CLEAN) and runs its cleanup"""

    class Probe:
        """r9 helpers for this session; exited_nowait on the RUNNING validator is also the telemetry / soft-stop tick (r6 polls it
        every 0.5 s in use()); every other call (other pids, phases, stop_group internals) is passed through untouched"""
        def __init__(self, R9, s):
            self._R9, self._s = R9, s

        def __getattr__(self, n):
            return getattr(self._R9, n)

        def exited_nowait(self, pid):
            done = self._R9.exited_nowait(pid)
            s, c = self._s, self._s.children.get("exec")
            if s._phase and c is not None and pid == c.pid:
                s._tick(done)
            return done

    class MemorySession(C.Session):
        def __init__(self, a, R9, PI):
            super().__init__(a, R9, PI)
            self._r9, self.R9 = R9, Probe(R9, self)
            self._phase, self._last_full, self._fails = False, None, 0
            self.mem = {"limits": LIMITS, "lane": {"memoryMaxMiB": LANE_MIB, "memoryHighMiB": HIGH_MIB},
                        "softStopAt": {"treeVmRssMiB": SOFT_TREE_RSS_MIB, "memAvailableMiB": SOFT_AVAIL_MIB, "pollSeconds": 0.5},
                        "childLogCapBytes": CHILD_LOG_CAP, "eventsBefore": None, "peaks": {"treeVmRssMiB": 0.0, "cgCurrent": 0,
                        "cgPagetables": 0, "cgFileMapped": 0, "cgAnon": 0, "minMemAvailableMiB": None, "chkVmRSSKiB": 0,
                        "chkRssFileKiB": 0, "chkRssAnonKiB": 0, "chkVmPTEKiB": 0}, "samples": [], "samplesDropped": 0,
                        "softStop": None, "telemetryErrors": []}
            self.receipt["memory"] = self.mem
            holder["s"] = self
            try:
                self.mem["eventsBefore"] = M4.cg_sample(cfg["rel"])["events"]
            except Exception as e:                                       # noqa: BLE001 - recorded; classification then fails closed
                self.mem["telemetryErrors"].append(f"eventsBefore: {type(e).__name__}: {e}"[:200])

        def step(self, s):
            super().step(s)
            self._phase = s == "validator"                              # r6: "validator" ... "post-use recheck" / "cleanup"

        def _soft(self, reason):
            self._phase = False; self.mem["softStop"] = reason
            raise SoftStop(reason)

        def _tick(self, done):
            """r9 (review 1827 A1): ANY failure in the tick (reading OR processing) is a counted telemetry error - never an exception
            escaping r6 use() as a misleading REFUSED; 3 in a row while the validator runs -> an ordered soft stop. SoftStop propagates."""
            try:
                self._tick_body(done)
            except SoftStop:
                raise
            except Exception as e:                                       # noqa: BLE001
                self._fails += 1
                if len(self.mem["telemetryErrors"]) < MAX_ERRORS:
                    self.mem["telemetryErrors"].append(f"{type(e).__name__}: {e}"[:200])
                else:
                    self.mem["telemetryErrorsDropped"] = self.mem.get("telemetryErrorsDropped", 0) + 1
                if done:
                    self._phase = False
                elif self._fails >= TELEMETRY_FAILS:
                    self._soft(f"soft stop: memory telemetry failed {self._fails} times in a row")

        def _tick_body(self, done):
            now, m = time.monotonic(), self.mem
            cg = M4.cg_sample(cfg["rel"]); trss = M4.tree_rss_mib(self._r9, cfg["root"]); avail = M4.mem_available_mib()
            pk, st = m["peaks"], cg["stat"]
            pk["treeVmRssMiB"] = max(pk["treeVmRssMiB"], trss); pk["cgCurrent"] = max(pk["cgCurrent"], cg["current"])
            pk["cgPagetables"] = max(pk["cgPagetables"], st.get("pagetables", 0))
            pk["cgFileMapped"] = max(pk["cgFileMapped"], st.get("file_mapped", 0)); pk["cgAnon"] = max(pk["cgAnon"], st.get("anon", 0))
            pk["minMemAvailableMiB"] = avail if pk["minMemAvailableMiB"] is None else min(pk["minMemAvailableMiB"], avail)
            if done or self._last_full is None or now - self._last_full >= SAMPLE_EVERY:
                self._last_full, procs = now, {}
                for p in sorted(M4.tree(self._r9, self.children["exec"].pid)):
                    try:
                        comm = read_all(f"/proc/{p}/comm", 64).decode().strip()
                    except (OSError, Refused):
                        continue
                    procs[f"{comm}:{p}"] = ps = M4.proc_status(p)
                    if comm == "mdbx_chk":
                        for k in ("VmRSS", "RssFile", "RssAnon", "VmPTE"):
                            pk[f"chk{k}KiB"] = max(pk[f"chk{k}KiB"], ps.get(f"{k}KiB", 0))
                if len(m["samples"]) < MAX_SAMPLES:
                    m["samples"].append({"t": round(now, 1), "treeVmRssMiB": round(trss, 1), "memAvailableMiB": round(avail), "cg": cg,
                                         "procs": procs})
                else:
                    m["samplesDropped"] += 1
            self._fails = 0                                              # a COMPLETE tick resets the failure run
            if done:
                self._phase = False; m["eventsAtValidatorEnd"] = cg["events"]
                return
            why = soft_reason(trss, avail)
            if why:
                self._soft(why)

        def nbdfuse_same(self):
            return "nbdfuse" in self.children and self.same("nbdfuse")

        def held(self, label):
            ok = super().held(label)
            if label == "postUse":                                       # r8: the FUSE server must also still be the bound process
                nb = self.nbdfuse_same()
                self.receipt["checks"]["postUseNbdfuseSame"] = {"ok": nb}
                ok = ok and nb
            return ok
    MemorySession.SoftStop = SoftStop
    return MemorySession


def memory_classify(orig, M4, rel, holder):
    def classify(exec_info, report, post_ok, fixture_exec, expected_bytes=None):
        name, rc, reasons = orig(exec_info, report, post_ok, fixture_exec, expected_bytes)
        s = holder.get("s")
        before = s.mem.get("eventsBefore") if s is not None else None
        try:
            after = M4.cg_sample(rel)["events"]
        except Exception:                                                # noqa: BLE001 - unreadable counters are dirty
            after = None
        bad = dirty(before, after)
        if s is not None:
            s.mem.update(eventsAfter=after, memoryDirty=bad)
        if name in ("CLEAN", "PROBLEMS") and bad:
            return "INCONCLUSIVE", 7, list(reasons) + [f"memory.events oom counters changed or unreadable ({before} -> {after}): not trusted"]
        return name, rc, reasons
    return classify


def runtime(argv):
    if "--" not in argv:
        print("REFUSED: runtime --tree-root-pid PID -- <r6 arguments>", file=sys.stderr); return 3
    i = argv.index("--")
    ap = argparse.ArgumentParser(prog="memory_gate.py runtime"); ap.add_argument("--tree-root-pid", type=int, required=True)
    a, rest = ap.parse_args(argv[:i]), argv[i + 1:]
    try:
        if "--fixture-exec" in rest or "--fixture-unmount-exe" in rest or rest.count("--expect-kind") != 1 \
                or rest[rest.index("--expect-kind") + 1] != "production":
            refuse("the r9 runtime runs the production kind only, never a fixture exec")
        fsize_ok()
        M4 = load_exact("r4Fixture", "r4_memory_fixture")
        C = load_exact("r6Runtime", "r6_composite_session")
        rel, _unit = M4.scope_of(read_all("/proc/self/cgroup", 4096).decode(), os.getuid())
        d = os.path.join(M4.CG, rel.lstrip("/"))
        if read_all(d + "/memory.max", 64).decode().strip() != str(LANE_MIB * MIB) \
                or read_all(d + "/memory.high", 64).decode().strip() != str(HIGH_MIB * MIB):
            refuse("our scope is not the gate-bound 4096 MiB lane with MemoryHigh 3712 MiB")
        ancestor_in_cgroup(a.tree_root_pid)
    except Exception as e:                                              # noqa: BLE001 - nothing claimed or written
        print(f"REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr); return 3
    holder = {}
    C.CHILD_FSIZE = CHILD_LOG_CAP                                       # every r6 child's RLIMIT_FSIZE (logs, validator.out, report)
    C.Session = make_memory_session(C, M4, {"rel": rel, "root": a.tree_root_pid}, holder)
    C.classify = memory_classify(C.classify, M4, rel, holder)
    return C.main(rest)                                                 # the UNCHANGED r6 lifecycle, cleanup, receipt


# ---- r9: stop helper (root 1828 #1), live-session guard (#3), final evidence (#2) ------------------------------------------------------
def proc_argv(pid):
    raw = read_all(f"/proc/{pid}/cmdline", 1 << 20).split(b"\0")
    if raw and raw[-1] == b"":
        raw.pop()
    return [x.decode(errors="replace") for x in raw]


def proc_start(pid):
    s = read_all(f"/proc/{pid}/stat", 4096).decode(errors="replace")
    return int(s[s.rindex(")") + 2:].split()[19])


def runtime_identity(argv, session, script, py=PY3):
    """the EXACT argv the gate execs: PY3 -I -B <r9 memory_gate.py> runtime --tree-root-pid N -- ... --run-dir SESSION ...
    --expect-kind production ... (never a fixture exec)"""
    if argv[:5] != [py, "-I", "-B", script, "runtime"] or "--" not in argv:
        refuse("the process is not THIS r9 memory_gate.py runtime")
    i = argv.index("--")
    own, rest = argv[5:i], argv[i + 1:]
    if len(own) != 2 or own[0] != "--tree-root-pid" or not own[1].isdigit():
        refuse("unexpected runtime options")
    if "--fixture-exec" in rest or "--fixture-unmount-exe" in rest:
        refuse("a fixture runtime is never a production session")
    pairs = {rest[k]: rest[k + 1] for k in range(len(rest) - 1) if rest[k].startswith("--")}
    if pairs.get("--run-dir") != session or pairs.get("--expect-kind") != "production" or rest.count("--run-dir") != 1:
        refuse(f"the runtime's --run-dir is not exactly {session}")
    return True


def stop_session(session, script=None, py=PY3):
    """SIGTERM to the r9 runtime recorded in SESSION/session.pid ONLY: its start time, owner and exact argv are checked AFTER a pidfd
    pins it; the signal goes through that pidfd (never a PID, a process group or the queue). r6 then cancels in order."""
    script = script or THIS
    if not (isinstance(session, str) and os.path.isabs(session) and os.path.realpath(session) == session and os.path.isdir(session)):
        refuse("SESSION_DIR must be a real absolute directory")
    try:
        rec = json.loads(read_all(os.path.join(session, "session.pid"), 4096))
        pid, start = rec["pid"], rec["startTime"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        refuse(f"session.pid unreadable or malformed: {type(e).__name__}")
    if not (type(pid) is int and type(start) is int and pid > 1):
        refuse("session.pid malformed")
    try:
        fd = os.pidfd_open(pid)
    except OSError:
        refuse(f"pid {pid} is not running")
    try:
        if proc_start(pid) != start or os.stat(f"/proc/{pid}").st_uid != os.getuid():
            refuse(f"pid {pid} is not the recorded session (start time / owner differ: exited or reused)")
        runtime_identity(proc_argv(pid), session, script, py)
        if proc_start(pid) != start:                                    # identity re-checked, still the pidfd's process
            refuse(f"pid {pid} changed during the check")
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    finally:
        os.close(fd)
    return {"signalled": pid, "startTime": start, "signal": "SIGTERM"}


def memory_session_argv(SG, argv):
    """a REAL python invocation of memory_gate.py gate|runtime (the pinned r6 guard parser decides what the script is); text mentions
    (shells, grep, editors, python -c, other subcommands) are not sessions"""
    s = SG.script_of(argv)
    if s is None or os.path.basename(s) != "memory_gate.py":
        return False
    k = argv.index(s)
    return k + 1 < len(argv) and argv[k + 1] in ("gate", "runtime")


def guard():
    SG = load_exact("r6SessionGuard", "r6_session_guard")
    live, excl = [], SG.ancestors(os.getpid())
    for e in os.listdir("/proc"):
        if not e.isdigit() or int(e) in excl:
            continue
        pid = int(e)
        try:
            if os.stat(f"/proc/{pid}").st_uid != os.getuid():
                continue
            argv, _ppid, start, _comm = SG.info(pid)
        except (OSError, ValueError, IndexError):
            continue
        if memory_session_argv(SG, argv):
            live.append({"pid": pid, "startTime": start, "argv": argv[:6]})
    for x in live:
        print("## guard LIVE memory_gate session process: " + json.dumps(x, sort_keys=True))
    return 1 if live else 0


JOB_CHECKS = {"rc0", "clean", "cleanupComplete", "peersUnchanged", "noMountLeft", "noProcessLeft"}


def evidence(path, rc, jrc):
    """rc 0 ONLY when the final job receipt exists, is well-formed, belongs to this runtime rc, its generator succeeded and every
    final check is true; anything else (missing, truncated, malformed, failed) is rc 1"""
    try:
        r = json.loads(read_all(path, 1 << 20))
        ok = (isinstance(r, dict) and r.get("format") == "composite-production-memory-job-receipt/r9" and jrc == 0 and rc == 0
              and r.get("rc") == rc and r.get("structurallyCleanRun") is True and all_true(r.get("checks"), JOB_CHECKS)
              and r.get("outcome") == "CLEAN")
    except Exception:                                                   # noqa: BLE001
        ok = False
    return 0 if ok else 1


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["gate"]:
        return gate(argv[1:])
    if argv[:1] == ["runtime"]:
        return runtime(argv[1:])
    try:
        if argv[:1] == ["stop"] and len(argv) == 2:
            print(json.dumps(stop_session(argv[1]))); return 0
        if argv == ["guard"]:
            return guard()
        if argv[:1] == ["evidence"] and len(argv) == 4:
            return evidence(argv[1], int(argv[2]), int(argv[3]))
    except Exception as e:                                              # noqa: BLE001
        print(f"REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr); return 3
    print("usage: memory_gate.py gate ... | runtime --tree-root-pid PID -- ... | stop SESSION_DIR | guard | evidence RECEIPT RC JRC",
          file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main())
