#!/usr/bin/env python3
"""state-fixture-capture-stage/r1 capture.py (PREPARED by Claude 1877; NOT run by Claude). Standard library + PINNED frozen code only.

Runs ONE frozen base-state-readonly r11 compiled-fixture script (jobs/positive.sh: 26 runs, or jobs/fixtures.sh: 6 cases) as its OWN
child, captures the child's combined output itself, validates it with the pinned acceptance r1 `check_fixture_capture`, and writes an
authenticated-BY-CAPTURE receipt next to the capture inside the VERIFIED /vm build output. NOTHING here runs automatically.

REUSE, not a new lifecycle (all from the pinned, frozen r11 jobs/bsro_gate.py `42cf6b47...`, loaded from its hashed bytes):
  run_capture       owned new session/group, bounded NEW capture file (1 MiB kept, rest drained+counted), TERM/INT/HUP forwarding,
                    grace/hard/term_wait deadlines, owned-group cleanup, single final reap
  verify_binaries   the dir is the /vm out dir of a VERIFIED r11 build receipt and both binaries still hash as recorded
  qualified         passing r11 guard-tests + ns-tests receipts for the frozen r11 SUMS
  live_completion   the all-265 completion gate (pinned 1773 runner + r3 core; metadata only)
  no_live_sessions  no live orchestrate/overlay/composite/memory-gate session, no stage mount
  root_floor_ok     root >= 40 GiB floor + 8 GiB native + 16 MiB (here checked with a further 128 MiB for the scripts' own r11/runs files)
  maps_inside / propagation_private   the exact `unshare -Urnm` user namespace (0 -> the real uid/gid, setgroups deny) and private mounts
From the pinned acceptance r1 (`81c3fd3c...`; its own 38-test receipt pinned): check_fixture_capture + MAX_CAPTURE_BYTES.
LOCAL (the r11 own_lane is hard-wired to the 4096 MiB build lane): a 512 MiB lane check with the same 16 GiB host floor + 256 MiB.

Exit: 0 = receipt written with pass true; 4 = the script ran but something failed (receipt written with pass false when possible);
3 = refused before anything ran (nothing spawned, no receipt). Every receipt is synthetic:false only because THIS process spawned the
frozen script and captured it; a receipt is NOT forgery-proof against a malicious same-user writer, and a consumer must re-verify it
(receipt_errors + re-running check_fixture_capture on the bound capture bytes).

  capture.py run positive|fixtures BUILD_OUT_DIR --uid UID --gid GID     (only via jobs/run.sh, inside `unshare -Urnm`)
"""
import argparse
import hashlib
import json
import os
import re
import stat
import sys
import time
import types

HERE = os.path.dirname(os.path.realpath(__file__))
W = os.path.dirname(os.path.dirname(HERE))
R11 = W + "/base-state-readonly-stage/r11"
ACC = W + "/state-helper-qualification-stage/r1"
PINS = {
    "r11Sums": (R11 + "/SHA256SUMS", "246ff06b4df2869596af7f8fdbc784af349bfe88c071e5660ae982048cfa1ced"),
    "r11Gate": (R11 + "/jobs/bsro_gate.py", "42cf6b47b52419ba7cbe8c99b784f93459af75478121f9fd4152b0996c088cd8"),
    "accSums": (ACC + "/SHA256SUMS", "25ca8ece39facad5b1ffc4b1c1ef821324f205f9c8b0d8b5c58b23111edf52a7"),
    "acceptance": (ACC + "/acceptance.py", "81c3fd3c9d25bfd0ed2c3a92ddf098fa3902fdd7f4e2ab0ddab50b5245636769"),
    "accTests": (ACC + "/runs/tests-20261027T093534Z-3031705/receipt.json",
                 "1f6ec605414218653567fbdc588a36b1ac280987189da16834e59b64528743b9"),
}
KINDS = {
    "positive": {"script": "jobs/positive.sh", "limit": 12600, "tmpPrefix": "bsro-r11-pos-"},   # 26 x (120 + 300) s + margin
    "fixtures": {"script": "jobs/fixtures.sh", "limit": 900, "tmpPrefix": "bsro-r11-fix-"},     # 6 x 60 s + margin
}
BUILD_BASE = "/vm/enclave-volumes/rpc-recovery-validation-build"      # = bsro_gate.BASE (checked at run time)
OUT_RE = re.compile(re.escape(BUILD_BASE) + r"/run-\d{8}T\d{6}Z-\d+/out")
MIB, GIB = 1 << 20, 1 << 30
LANE_MIB, HOST_FLOOR_MIB, HEADROOM_MIB = 512, 16384, 256
VM_FLOOR, CAPTURE_BUDGET, ROOT_SCRIPT_EXTRA = 40 * GIB, 64 * MIB, 128 * MIB
KILL_AFTER = 60
RECEIPT_FORMAT = "bsro-fixture-capture-receipt/r1"
RECEIPT_KEYS = frozenset({"format", "kind", "pass", "synthetic", "authenticatedBy", "reasons", "pins", "wrapperSums", "buildOutDir",
                          "buildReceipt", "identitiesBefore", "identitiesAfter", "completionFingerprint", "spawn", "capture", "check",
                          "cleanup", "verifyBinariesAfter", "startedUtc", "seconds"})
IDENT_KEYS = frozenset({"stageSums", "scriptSha256", "helperSha256", "mkFixtureSha256", "buildReceiptSha256"})


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_bytes(path, cap):
    """a regular file, opened without following a final symlink, at most cap bytes"""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            refuse(f"{path} is not a regular file")
        chunks, n = [], 0
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            n += len(b)
            if n > cap:
                refuse(f"{path} exceeds {cap} bytes")
            chunks.append(b)
        return b"".join(chunks)
    finally:
        os.close(fd)


def load_pinned(name, modname):
    path, want = PINS[name]
    raw = read_bytes(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned {want[:12]}")
    mod = types.ModuleType(modname)
    mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)                    # exactly the hashed bytes
    return mod


# ---- pure checks (tests/test_capture.py) ------------------------------------------------------------------------------------------
def parse_sums(text):
    """SHA256SUMS text -> {relpath: sha}; strict: '<64 hex>  <relative path>' lines, no duplicates, no absolute/.. paths"""
    out = {}
    if type(text) is not str or not text.endswith("\n"):
        refuse("SHA256SUMS is not newline-terminated text")
    for line in text.split("\n")[:-1]:
        m = re.fullmatch(r"([0-9a-f]{64})  ([^\s/][^\s]*)", line)
        if not m or ".." in m.group(2).split("/") or m.group(2) in out:
            refuse(f"bad SHA256SUMS line {line[:80]!r}")
        out[m.group(2)] = m.group(1)
    if not out:
        refuse("empty SHA256SUMS")
    return out


def lane512_ok(memory_max_text, avail_mib):
    if type(memory_max_text) is not str or memory_max_text.strip() != str(LANE_MIB * MIB):
        refuse(f"memory.max {memory_max_text!r} is not the {LANE_MIB} MiB queue lane")
    if type(avail_mib) not in (int, float) or avail_mib < HOST_FLOOR_MIB + LANE_MIB + HEADROOM_MIB:
        refuse(f"MemAvailable {avail_mib} MiB < 16 GiB host floor + {LANE_MIB} + {HEADROOM_MIB}")
    return True


def no_ipv4_routes(proc_net_route):
    lines = [l for l in proc_net_route.splitlines() if l.strip()]
    if len(lines) > 1:
        refuse("an IPv4 route exists: run inside `unshare -Urnm`")
    return True


def tmp_leftovers(names, prefix):
    return sorted(n for n in names if n.startswith(prefix))


def mount_leftovers(mountinfo, prefix):
    hits = []
    for l in mountinfo.splitlines():
        f = l.split(" ")
        if len(f) > 4 and f[4].startswith("/tmp/" + prefix):
            hits.append(f[4])
    return hits


def out_dir_ok(bd):
    if type(bd) is not str or not OUT_RE.fullmatch(bd) or os.path.normpath(bd) != bd:
        refuse(f"{bd!r} is not {BUILD_BASE}/run-<UTC>-<pid>/out")
    return bd


def matching_build_receipts(receipts, sums, bd):
    """[(name, sha256, receipt)] -> those that verify_binaries would accept for bd (same rule); the caller requires exactly one"""
    out = []
    for name, rsha, r in receipts:
        g = r.get("guard") if type(r) is dict else None
        if (type(r) is dict and r.get("verified") is True and type(r.get("finalRc")) is int and r["finalRc"] == 0
                and r.get("stageSums") == sums and type(g) is dict and g.get("outDir") == bd and r.get("mode") == "build"):
            out.append((name, rsha, r))
    return out


def expected_identities(kind, build_receipt, build_receipt_sha, A):
    g = build_receipt["guard"]["binaries"]
    return {"stageSums": PINS["r11Sums"][1],
            "scriptSha256": A.R11_POSITIVE_SH_SHA256 if kind == "positive" else A.R11_FIXTURES_SH_SHA256,
            "helperSha256": g["base-state-readonly"]["sha256"], "mkFixtureSha256": g["mk_fixture"]["sha256"],
            "buildReceiptSha256": build_receipt_sha}


def decide(cap, timed_out, check, before, after, expected, cleanup, verify_after):
    """-> (pass, reasons). pass only if the capture is complete, nothing changed, cleanup is complete and the output check passed."""
    r = []
    if type(cap) is not dict or type(cap.get("rc")) is not int:
        r.append("no child rc")
    else:
        if cap.get("abandoned") is not False:
            r.append("capture abandoned (a holder outside our group)")
        if cap.get("sinkError") is not None:
            r.append(f"capture sink failed: {cap.get('sinkError')}")
        if not (type(cap.get("kept")) is int and type(cap.get("total")) is int and cap["total"] == cap["kept"]):
            r.append("capture truncated")
    if timed_out is not False:
        r.append("timed out")
    if before != after:
        r.append("an identity changed during the run")
    if before != expected:
        r.append("observed identities != expected pins")
    if type(cleanup) is not dict or cleanup.get("tmpLeft") != [] or cleanup.get("mountsLeft") != [] or cleanup.get("groupAlive") is not False:
        r.append(f"cleanup incomplete: {cleanup}")
    if verify_after is not True:
        r.append("verify_binaries failed after the run")
    if type(check) is not dict or check.get("outputValid") is not True:
        r.append(f"output check failed: {(check or {}).get('reasons')}")
    return (not r), r


def receipt_errors(rec, kind, expected):
    """for a CONSUMER: [] iff rec is a passing capture receipt of `kind` bound to `expected` identities and this stage's pins.
    The consumer must ALSO re-run check_fixture_capture on the capture file named here (sha-bound) - a receipt alone is a claim."""
    e = []
    if type(rec) is not dict or set(rec) != RECEIPT_KEYS:
        return ["receipt keys are not exact"]
    if rec["format"] != RECEIPT_FORMAT or rec["kind"] != kind:
        e.append("format/kind")
    if rec["pass"] is not True or rec["synthetic"] is not False or rec["authenticatedBy"] != "capture" or rec["reasons"] != []:
        e.append("not a passing capture-authenticated receipt")
    if rec["pins"] != {k: v[1] for k, v in PINS.items()}:
        e.append("pins differ from this stage")
    if rec["identitiesBefore"] != expected or rec["identitiesAfter"] != expected:
        e.append("identities differ from expected")
    c = rec["capture"]
    if not (type(c) is dict and type(c.get("sha256")) is str and type(c.get("path")) is str and c.get("truncated") is False
            and c.get("abandoned") is False and c.get("sinkError") is None and type(c.get("rc")) is int and c["rc"] == 0
            and c.get("timedOut") is False):
        e.append("capture record not clean")
    if type(rec["check"]) is not dict or rec["check"].get("outputValid") is not True or rec["verifyBinariesAfter"] is not True:
        e.append("check/verify not passing")
    cl = rec["cleanup"]
    if not (type(cl) is dict and cl.get("tmpLeft") == [] and cl.get("mountsLeft") == [] and cl.get("groupAlive") is False):
        e.append("cleanup not complete")
    sp = rec["spawn"]
    if not (type(sp) is dict and type(sp.get("pid")) is int and type(sp.get("argv")) is list):
        e.append("spawn record missing")
    return e


# ---- the one entry that spawns (never called by the tests) --------------------------------------------------------------------------
def observe(G, bd, script, receipt_path):
    return {"stageSums": sha(read_bytes(PINS["r11Sums"][0], 1 << 20)), "scriptSha256": sha(read_bytes(script, 1 << 20)),
            "helperSha256": G.file_sha(os.path.join(bd, "base-state-readonly"))[0],
            "mkFixtureSha256": G.file_sha(os.path.join(bd, "mk_fixture"))[0],
            "buildReceiptSha256": sha(read_bytes(receipt_path, 1 << 20))}


def verify_stage_sums(stage, sums_path, want):
    raw = read_bytes(sums_path, 1 << 20)
    if sha(raw) != want:
        refuse(f"{sums_path} is not the pinned {want[:12]}")
    for rel, h in parse_sums(raw.decode()).items():
        if sha(read_bytes(os.path.join(stage, rel), 64 << 20)) != h:
            refuse(f"{stage}/{rel} != its SHA256SUMS entry")
    return parse_sums(raw.decode())


def run(kind, bd, uid, gid):
    k = KINDS.get(kind) or refuse(f"kind must be one of {sorted(KINDS)}")
    t_start = time.time()
    # 1. pins: the wrapper itself, frozen r11, frozen acceptance r1 and its passing test receipt
    own = verify_stage_sums(HERE, os.path.join(HERE, "SHA256SUMS"), sha(read_bytes(os.path.join(HERE, "SHA256SUMS"), 1 << 20)))
    r11_list = verify_stage_sums(R11, PINS["r11Sums"][0], PINS["r11Sums"][1])
    verify_stage_sums(ACC, PINS["accSums"][0], PINS["accSums"][1])
    G = load_pinned("r11Gate", "bsro_gate_r11")
    A = load_pinned("acceptance", "acceptance_r1")
    at_raw = read_bytes(PINS["accTests"][0], 1 << 20)
    at = json.loads(at_raw)
    if sha(at_raw) != PINS["accTests"][1] or at.get("pass") is not True or at.get("stageSums") != PINS["accSums"][1] or at.get("ran") != ["38"]:
        refuse("the acceptance r1 38-test receipt is not the pinned passing one")
    script = os.path.join(R11, k["script"])
    if r11_list.get(k["script"]) != (A.R11_POSITIVE_SH_SHA256 if kind == "positive" else A.R11_FIXTURES_SH_SHA256):
        refuse("the r11 script pin of acceptance r1 differs from r11 SHA256SUMS")
    if G.BASE != BUILD_BASE:
        refuse("bsro_gate.BASE differs from this wrapper's build base")
    # 2. namespace: exactly `unshare -Urnm` for (uid, gid), private propagation, no IPv4 route
    G.maps_inside(G.read_all("/proc/self/uid_map", 4096).decode(), G.read_all("/proc/self/gid_map", 4096).decode(),
                  G.read_all("/proc/self/setgroups", 64).decode(), uid, gid)
    G.propagation_private(G.read_all("/proc/self/mountinfo", 4 << 20).decode())
    no_ipv4_routes(G.read_all("/proc/net/route", 1 << 20).decode())
    # 3. gates: r11 qualified, all 265 complete, no live session/stage mount, our 512 MiB lane + host floor, root and /vm floors
    G.qualified()
    fp = G.live_completion()
    G.no_live_sessions()
    cg = [l for l in G.read_all("/proc/self/cgroup", 4096).decode().splitlines() if l.startswith("0::")]
    if len(cg) != 1:
        refuse("not a single cgroup v2 entry")
    avail = [int(l.split()[1]) / 1024 for l in G.read_all("/proc/meminfo", 1 << 16).decode().splitlines() if l.startswith("MemAvailable:")]
    lane512_ok(G.read_all("/sys/fs/cgroup" + cg[0][3:] + "/memory.max", 64).decode(), avail[0] if avail else 0)
    G.root_floor_ok(G.free_bytes(R11) - ROOT_SCRIPT_EXTRA)
    # 4. the build output: exact /vm path, verified receipt (exactly one), binaries unchanged
    bd = out_dir_ok(bd)
    if os.path.realpath(bd) != bd:
        refuse(f"{bd} is not its own real path")
    if G.free_bytes(bd) < VM_FLOOR + CAPTURE_BUDGET:
        refuse("/vm free < 40 GiB floor + 64 MiB capture budget")
    G.verify_binaries(bd)
    runs = os.path.join(R11, "runs")
    cands = []
    for n in sorted(os.listdir(runs)):
        if n.startswith("build-"):
            try:
                raw = read_bytes(os.path.join(runs, n, "receipt.json"), 1 << 20)
                cands.append((n, sha(raw), json.loads(raw)))
            except (OSError, ValueError, Refused):
                continue
    m = matching_build_receipts(cands, PINS["r11Sums"][1], bd)
    if len(m) != 1:
        refuse(f"{len(m)} verified r11 build receipts name {bd} (need exactly one)")
    rname, rsha, rrec = m[0]
    rpath = os.path.join(runs, rname, "receipt.json")
    expected = expected_identities(kind, rrec, rsha, A)
    before = observe(G, bd, script, rpath)
    if before != expected:
        refuse(f"identities before the run differ from the pins/build receipt: {before} != {expected}")
    if tmp_leftovers(os.listdir("/tmp"), k["tmpPrefix"]) or mount_leftovers(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), k["tmpPrefix"]):
        refuse(f"/tmp/{k['tmpPrefix']}* or its mounts already exist: earlier leftovers must be inspected first")
    # 5. our output dir in the verified /vm build output (NEW per run)
    cd = os.path.join(bd, "fixture-captures")
    try:
        os.mkdir(cd, 0o700)
    except FileExistsError:
        pass
    cst = os.lstat(cd)
    if not stat.S_ISDIR(cst.st_mode) or cst.st_uid != os.getuid() or cst.st_dev != os.lstat(bd).st_dev or stat.S_IMODE(cst.st_mode) != 0o700:
        refuse(f"{cd} is not our real 0700 directory on the build filesystem")
    rd = os.path.join(cd, f"{kind}-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t_start)) + f"-{os.getpid()}")
    os.mkdir(rd, 0o700)
    # ---- from here on something runs: every failure yields exit 4 (and a pass:false receipt when possible) ----
    arg = bd if kind == "positive" else os.path.join(bd, "base-state-readonly")
    argv = ["/usr/bin/timeout", "-s", "TERM", "-k", str(KILL_AFTER), str(k["limit"]), "/usr/bin/bash", script, arg]
    cap_path = os.path.join(rd, "capture.txt")
    rec = {"format": RECEIPT_FORMAT, "kind": kind, "pass": False, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
           "pins": {n: v[1] for n, v in PINS.items()}, "wrapperSums": sha(read_bytes(os.path.join(HERE, "SHA256SUMS"), 1 << 20)),
           "buildOutDir": bd, "buildReceipt": {"path": rpath, "sha256": rsha}, "identitiesBefore": before, "identitiesAfter": None,
           "completionFingerprint": fp, "spawn": {"argv": argv, "pid": None}, "capture": None, "check": None, "cleanup": None,
           "verifyBinariesAfter": False, "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_start)), "seconds": None}
    rc_out = 4
    try:
        t0 = time.monotonic()
        cap = G.run_capture(argv, cap_path, cap=A.MAX_CAPTURE_BYTES, forward=True)
        rec["seconds"] = round(time.monotonic() - t0)
        rec["spawn"]["pid"] = cap.get("pid")
        timed_out = cap["rc"] in (124, 137) or cap["abandoned"] is True
        captured = read_bytes(cap_path, A.MAX_CAPTURE_BYTES)
        rec["capture"] = {"path": cap_path, "sha256": sha(captured), "rc": cap["rc"], "keptBytes": cap["kept"], "totalBytes": cap["total"],
                          "truncated": cap["total"] > cap["kept"], "abandoned": cap["abandoned"], "sinkError": cap["sinkError"],
                          "timedOut": timed_out}
        after = observe(G, bd, script, rpath)
        rec["identitiesAfter"] = after
        for stage, (p, want) in ((R11, PINS["r11Sums"]), (ACC, PINS["accSums"])):
            try:
                verify_stage_sums(stage, p, want)                       # every frozen source file still as listed after the run
            except Exception as e:                                      # noqa: BLE001
                rec["reasons"].append(f"{stage} changed during the run: {e}"[:300])
        try:
            rec["verifyBinariesAfter"] = G.verify_binaries(bd) is True
        except Exception as e:                                          # noqa: BLE001 - any failure is a failed run
            rec["reasons"].append(f"verify_binaries after: {type(e).__name__}: {e}"[:300])
        cleanup = {"tmpLeft": tmp_leftovers(os.listdir("/tmp"), k["tmpPrefix"]),
                   "mountsLeft": mount_leftovers(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), k["tmpPrefix"]),
                   "groupAlive": bool(cap.get("pid")) and G.group_alive(cap["pid"])}
        rec["cleanup"] = cleanup
        rec["check"] = A.check_fixture_capture(kind, captured, cap["rc"], timed_out, rec["capture"]["truncated"], after, expected)
        ok, reasons = decide(cap, timed_out, rec["check"], before, after, expected, cleanup, rec["verifyBinariesAfter"])
        rec["reasons"] += reasons
        rec["pass"] = ok and not rec["reasons"]
        rc_out = 0 if rec["pass"] else 4
    except Exception as e:                                              # noqa: BLE001 - recorded, never a pass
        rec["reasons"].append(f"{type(e).__name__}: {e}"[:400]); rec["pass"] = False; rc_out = 4
    finally:
        try:
            G.write_new(os.path.join(rd, "receipt.json"), (json.dumps(rec, indent=1, sort_keys=True, default=str) + "\n").encode())
        except Exception as e:                                          # noqa: BLE001
            print(f"## receipt write failed: {e}", file=sys.stderr); rc_out = 4
    print(json.dumps({"kind": kind, "pass": rec["pass"], "receipt": os.path.join(rd, "receipt.json"), "reasons": rec["reasons"][:5]}))
    return rc_out


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(prog="capture.py")
    ap.add_argument("cmd", choices=["run"]); ap.add_argument("kind", choices=sorted(KINDS)); ap.add_argument("build_out_dir")
    ap.add_argument("--uid", type=int, required=True); ap.add_argument("--gid", type=int, required=True)
    a = ap.parse_args(argv)
    try:
        return run(a.kind, a.build_out_dir, a.uid, a.gid)
    except Exception as e:                                              # noqa: BLE001 - before the spawn: nothing ran
        print(f"## REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
