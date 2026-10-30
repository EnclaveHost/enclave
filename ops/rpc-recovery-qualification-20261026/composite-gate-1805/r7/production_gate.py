#!/usr/bin/env python3
"""composite-mdbx-validation-stage/r7 production_gate.py (prepared by Claude 1802; NOT run by Claude). Stdlib only; no lifecycle.

The ONLY production entry: a fail-closed gate, then os.execv of the UNCHANGED, fixture-qualified r6 runtime
(composite_session.py 407aa7e9..., --expect-kind production) in a NEW run dir. Nothing is mounted, started or written before every
check below passes; the gate writes only its own gate.json (or gate-refused.json) in a NEW 0700 run dir.

Checks (each refuses, rc 3):
  1. the r6 stage: SHA256SUMS bytes = 06705b02..., every listed file re-hashed, and the runtime / guard / both test files at their
     qualified hashes
  2. the ACTUAL r6 fixture qualification receipt: exact bytes (sha256 c94c4689...) AND strict fields - pass, stage/runtime/guard/test
     hashes, suites exactly {test_session_guard: Ran 4, test_composite_session: Ran 12}, rc 0, no bad markers (FAIL/ERROR/skipped/
     Traceback/ResourceWarning), every check true, peers unchanged, no mount left
  3. the queue lane: this process's cgroup memory.max = 2560 MiB exactly (the claude-test-queue.py main lane root reserves for
     this), and MemAvailable >= 16 GiB floor + 2560 + 256 MiB right now
  4. the REAL production view, through the PINNED r6 view importer (reused, not re-implemented; loaded by r6 composite_session's
     own pinned loader): load_view(kind production) + recheck (the incident manifest bytes, r3 recorded state ALL 265 parts committed
     AND independently verified in CONFIRMED sessions, qualified orchestrator bindings, every part's identity and record bytes), and
     exactly: manifestSha256 = f94807f7..., logicalSize = 1,138,166,333,440, 265 parts, kind production
Not launched by the copy driver; root runs it manually in the 2560 MiB main lane after ALL parts are complete. A CLEAN result is
STRUCTURAL ONLY (mdbx_chk); canonical / state / trie / chain validation is separate. Fixtures never make a production acceptance.

    production_gate.py --view-dir DIR --run-dir NEW_DIR --max-hours H     (H 1..168: the validator timeout)
"""
import argparse, hashlib, json, os, sys, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
R6 = W + "/composite-mdbx-validation-stage/r6"
R6_SUMS = "06705b02eab351a718234f22c9a53acdbefe3977122682f8f3f7ac25d5b9914a"
R6_FILES = {"composite_session.py": "407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6",
            "jobs/session_guard.py": "f64c6115ab8ac871d1813d53d45d3b03369c330c45617763824a4bb3fef287ce",
            "tests/test_composite_session.py": "0e087dea4f8768e60d482035f61e010db360cc1a08dee90225444c6d5f5c1fd5",
            "tests/test_session_guard.py": "6a66be0d0a2ff88d58dbff0d7d2b0c2ead3693a6ac12042901719304f273994b"}
R6_RECEIPT = R6 + "/runs/tests-20261027T020755Z-2617132/receipt.json"
R6_RECEIPT_SHA = "c94c4689538744543bad185889e99f69ab6d5b8c0e0aaf79767dc15b1ad74f72"
SUITES = {"test_session_guard": (4, "tests/test_session_guard.py"), "test_composite_session": (12, "tests/test_composite_session.py")}
CHECK_KEYS = {"lastLineOK", "noBadMarkers", "ranExactly", "rc0", "stdoutEmpty"}
MANIFEST_SHA = "f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9"
LOGICAL, PARTS = 1138166333440, 265
LANE_MIB, FLOOR_MIB, HEADROOM_MIB = 2560, 16384, 256
PY3 = "/usr/bin/python3"


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


def check_stage(stage=R6, sums_pin=R6_SUMS, files=R6_FILES):
    raw = read_all(os.path.join(stage, "SHA256SUMS"), 1 << 20)
    if sha(raw) != sums_pin:
        refuse("r6 SHA256SUMS is not the qualified one")
    listed = {}
    for line in raw.decode().splitlines():
        h, _, name = line.partition("  ")
        if not name or os.path.isabs(name) or ".." in name.split("/"):
            refuse(f"r6 SHA256SUMS: bad entry {line[:80]!r}")
        if sha(read_all(os.path.join(stage, name), 64 << 20)) != h:
            refuse(f"r6 {name} differs from its SHA256SUMS")
        listed[name] = h
    for name, h in files.items():
        if listed.get(name) != h:
            refuse(f"r6 {name} is not the qualified file")
    return {"stage": stage, "sums": sums_pin, "files": len(listed)}


def check_receipt_fields(r, sums_pin=R6_SUMS, files=R6_FILES):
    if not isinstance(r, dict) or r.get("format") != "composite-mdbx-validation-test-receipt/r6" or r.get("pass") is not True:
        refuse("receipt: not a passing r6 fixture receipt")
    if (r.get("stageSums"), r.get("sessionSha256"), r.get("guardSha256")) != (sums_pin, files["composite_session.py"], files["jobs/session_guard.py"]):
        refuse("receipt: stage / runtime / guard hashes are not the qualified ones")
    if r.get("environment") != {"noMountLeft": True, "peersUnchanged": True}:
        refuse("receipt: environment not clean")
    s = r.get("suites")
    if not isinstance(s, dict) or set(s) != set(SUITES):
        refuse("receipt: suites are not exactly the 4 + 12 qualification suites")
    for name, (n, test) in SUITES.items():
        x = s[name]
        if not (isinstance(x, dict) and x.get("pass") is True and x.get("rc") == 0 and x.get("ran") == [str(n)] and x.get("expectedTests") == n
                and x.get("badMarkers") == [] and isinstance(x.get("checks"), dict) and set(x["checks"]) == CHECK_KEYS
                and all(v is True for v in x["checks"].values()) and x.get("testsSha256") == files[test]):
            refuse(f"receipt: suite {name} is not exactly Ran {n}, rc 0, all checks true, no bad markers, qualified tests")
    return True


def check_receipt(path=R6_RECEIPT, pin=R6_RECEIPT_SHA):
    raw = read_all(path, 1 << 20)
    if sha(raw) != pin:
        refuse("the r6 qualification receipt is not the exact pinned bytes")
    try:
        r = json.loads(raw)
    except ValueError:
        refuse("the r6 qualification receipt is not JSON")
    check_receipt_fields(r)
    return {"receipt": path, "sha256": pin}


def check_lane(cgroup_text, memory_max_text, meminfo_text):
    """pure: the 2560 MiB queue lane (exact cgroup v2 memory.max) and the 16 GiB floor + lane + headroom available now"""
    lines = [l for l in cgroup_text.splitlines() if l.startswith("0::")]
    if len(lines) != 1:
        refuse("not a single cgroup v2 hierarchy")
    if memory_max_text.strip() != str(LANE_MIB << 20):
        refuse(f"memory.max is {memory_max_text.strip()!r}, not the {LANE_MIB} MiB queue lane: run through jobs/q-exit-status.sh ... 2560")
    avail = [int(l.split()[1]) // 1024 for l in meminfo_text.splitlines() if l.startswith("MemAvailable:")]
    if len(avail) != 1 or avail[0] < FLOOR_MIB + LANE_MIB + HEADROOM_MIB:
        refuse(f"MemAvailable {avail} MiB < floor {FLOOR_MIB} + lane {LANE_MIB} + {HEADROOM_MIB}")
    return {"memoryMaxMiB": LANE_MIB, "memAvailableMiB": avail[0]}


def live_lane():
    with open("/proc/self/cgroup") as f:
        cg = f.read()
    rel = [l for l in cg.splitlines() if l.startswith("0::")]
    mm = ""
    if len(rel) == 1:
        with open("/sys/fs/cgroup" + rel[0][3:] + "/memory.max") as f:
            mm = f.read()
    with open("/proc/meminfo") as f:
        return check_lane(cg, mm, f.read())


def check_view_record(rec):
    """pure: the exact incident production view (after the importer's load_view + recheck)"""
    if rec.get("kind") != "production":
        refuse("the view is not a production view")
    if rec.get("manifestSha256") != MANIFEST_SHA:
        refuse("the view is not of the incident production manifest")
    if rec.get("logicalSize") != LOGICAL or rec.get("sectors") != LOGICAL // 512:
        refuse("the view's logical size is not the incident's 1,138,166,333,440 bytes")
    if not isinstance(rec.get("parts"), list) or len(rec["parts"]) != PARTS:
        refuse(f"the view does not hold exactly {PARTS} parts")
    return {"manifestSha256": MANIFEST_SHA, "logicalSize": LOGICAL, "parts": PARTS}


def load_r6_importer():
    """the r6 runtime's OWN pinned loader (composite_session.load_pinned), from the qualified runtime bytes"""
    path = os.path.join(R6, "composite_session.py")
    raw = read_all(path, 4 << 20)
    if sha(raw) != R6_FILES["composite_session.py"]:
        refuse("r6 composite_session.py is not the qualified runtime")
    C = types.ModuleType("r6_composite_session"); C.__file__ = path
    exec(compile(raw, path, "exec"), C.__dict__)
    sys.path.insert(0, os.path.dirname(C.PINS["r6Importer"][0]))
    return C.load_pinned("r6Importer", "r6_production_import")


def check_view(view_dir):
    PI = load_r6_importer()
    rec = PI.load_view(view_dir, "production")              # kind re-asserted by the importer
    check_view_record(rec)                                  # the incident's exact manifest / size / count first (cheap)
    PI.recheck(rec)                                         # r3: ALL parts committed + verified in CONFIRMED sessions, bindings, identities
    return check_view_record(rec)


def write_new(run_dir, name, obj):
    fd = os.open(os.path.join(run_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--view-dir", required=True); ap.add_argument("--run-dir", required=True)
    ap.add_argument("--max-hours", type=int, required=True)
    a = ap.parse_args(argv)
    if not (os.path.isabs(a.run_dir) and os.path.isdir(a.run_dir) and not os.path.islink(a.run_dir) and not os.listdir(a.run_dir)):
        print("REFUSED: --run-dir must be an existing, EMPTY, absolute directory", file=sys.stderr); return 3
    gate = {"format": "composite-production-gate/r7", "viewDir": a.view_dir, "maxHours": a.max_hours, "checks": {},
            "meaning": "gate only; a later CLEAN from the r6 runtime is STRUCTURAL (mdbx_chk) only - canonical/state validation is separate"}
    try:
        if not 1 <= a.max_hours <= 168:
            refuse("--max-hours must be 1..168")
        gate["checks"]["stage"] = check_stage()
        gate["checks"]["qualification"] = check_receipt()
        gate["checks"]["lane"] = live_lane()
        gate["checks"]["view"] = check_view(a.view_dir)
    except Exception as e:                                  # noqa: BLE001 - every failure refuses; nothing was started
        gate["refused"] = f"{type(e).__name__}: {e}"[:500]
        write_new(a.run_dir, "gate-refused.json", gate)
        print(json.dumps({"gate": "REFUSED", "reason": gate["refused"]})); return 3
    session = os.path.join(a.run_dir, "session")
    os.mkdir(session, 0o700)
    gate["session"] = {"runDir": session, "argv": [PY3, "-I", "-B", os.path.join(R6, "composite_session.py"), "--view-dir", a.view_dir,
                                                   "--run-dir", session, "--expect-kind", "production", "--validator-timeout", str(a.max_hours * 3600)]}
    write_new(a.run_dir, "gate.json", gate)
    print(json.dumps({"gate": "PASSED", "exec": gate["session"]["argv"]}), flush=True)
    os.execv(PY3, gate["session"]["argv"])                  # the unchanged r6 runtime re-checks its pins and the view itself


if __name__ == "__main__":
    sys.exit(main())
