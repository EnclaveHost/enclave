#!/usr/bin/env python3
"""state-fixture-capture-stage/r2 capture.py (PREPARED by Claude 1879; NOT run by Claude). Standard library + PINNED frozen code only.

r2 = r1 (178f4c3a..., HOLD by root) + confinement: runs ONE frozen base-state-readonly r12 fixture script (jobs/positive.sh 26 runs |
jobs/fixtures.sh 6 cases) INSIDE `unshare -Urnm` + `ns_harden /home/steven /tmp` (the reviewed build namespace; verified here by the
pinned r12 bsro_gate.ns_checks = private propagation + read_only + ro_tree_ok), with the ONLY writable target the NEW run dir
<BUILD_OUT_DIR>/fixture-captures/<kind>-<UTC>-<pid>/ on /vm:  capture.txt, receipt.json, and WORK=work/ handed to the r12 script
(which writes its trees and evidence ONLY there; no /tmp, no stage runs/, no root path). NOTHING here runs automatically.

PARSER BINDING IS PENDING. The only output parser (acceptance r1 check_fixture_capture) is pinned to the r11 scripts and r11 end markers;
it can never accept r12 output, and it is not re-implemented here. Until root pins an acceptance revision that binds the r12 scripts
(ACCEPTANCE below), `precheck` and `run` REFUSE FIRST (rc 3, nothing created, nothing spawned). See the report for the exact follow-up.

REUSE (pinned r12 jobs/bsro_gate.py, loaded from its hashed bytes; r12 = r11 gate with labels only): run_capture (the owned process
lifecycle: own session/group, bounded NEW capture, signal forwarding, deadlines, group cleanup, single reap), verify_binaries,
qualified, live_completion (all 265), no_live_sessions, root_floor_ok, maps_inside, ns_checks/ro_tree_ok, group_alive, file_sha,
write_new, read_all. LOCAL: the 512 MiB lane check (r12 own_lane is 4096-only), timeout(1) inside the owned group, the exactly-one
build receipt lookup, cleanup/confinement checks, the receipt.

  capture.py precheck KIND BUILD_OUT_DIR                        OUTSIDE the namespace (jobs/run.sh): every gate before any mount clone
  capture.py run KIND BUILD_OUT_DIR --uid UID --gid GID         INSIDE (jobs/inner.sh, after ns_harden): gates again, then the run
Exit: 0 pass receipt | 4 ran and failed (pass:false receipt when writable) | 3 refused, nothing ran.
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
R12 = W + "/base-state-readonly-stage/r12"
PINS = {
    "r12Sums": (R12 + "/SHA256SUMS", "2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea"),
    "r12Gate": (R12 + "/jobs/bsro_gate.py", "0641637ab6fa4bb007b7d97f4b1d1d3388b7815010f7b856e2f304b9cbb07dc4"),
    "r12Ns": (R12 + "/jobs/ns.sh", "b8b4560c160b68ce8f855e2ce2a7f52128c5d16a43d392c62ba6030a6fa28751"),
    "r12Positive": (R12 + "/jobs/positive.sh", "3ba4111792e0b3873bfa29e59726cf5b982ddecc421fd1260b6fd8828177e92a"),
    "r12Fixtures": (R12 + "/jobs/fixtures.sh", "4cf3d582510e8b6dfa5b3453691881e9a74faaae1579b385beb0fa98b7e74a77"),
}
# PENDING (root follow-up): {"sums": (<acc dir>/SHA256SUMS, sha), "module": (<acc dir>/acceptance.py, sha), "tests": (<receipt>, sha)}
# of an acceptance revision whose check_fixture_capture binds the r12 script shas and r12 end markers. None = refuse (fail closed).
ACCEPTANCE = None
KINDS = {
    "positive": {"script": "r12Positive", "limit": 12600},              # 26 x (120 + 300) s + margin
    "fixtures": {"script": "r12Fixtures", "limit": 900},                # 6 x 60 s + margin
}
BUILD_BASE = "/vm/enclave-volumes/rpc-recovery-validation-build"
OUT_RE = re.compile(re.escape(BUILD_BASE) + r"/run-\d{8}T\d{6}Z-\d+/out")
MIB, GIB = 1 << 20, 1 << 30
LANE_MIB, HOST_FLOOR_MIB, HEADROOM_MIB = 512, 16384, 256
VM_FLOOR, CAPTURE_BUDGET, CAPTURE_CAP = 40 * GIB, 256 * MIB, 1 * MIB
KILL_AFTER = 60
RO_PATHS = ("/home/steven", "/tmp")                                    # ns_harden'ed; ns_checks also requires R12 and HERE read-only
RECEIPT_FORMAT = "bsro-fixture-capture-receipt/r2"
RECEIPT_KEYS = frozenset({"format", "kind", "pass", "synthetic", "authenticatedBy", "reasons", "pins", "acceptance", "wrapperSums",
                          "buildOutDir", "runDir", "workDir", "buildReceipt", "identitiesBefore", "identitiesAfter", "completionFingerprint",
                          "spawn", "capture", "check", "cleanup", "verifyBinariesAfter", "startedUtc", "seconds"})
IDENT_KEYS = frozenset({"stageSums", "scriptSha256", "helperSha256", "mkFixtureSha256", "buildReceiptSha256"})


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def parser_binding():
    """FIRST statement of precheck/run: no pinned r12-aware acceptance parser -> refuse before anything is touched"""
    if ACCEPTANCE is None:
        refuse("PARSER BINDING PENDING: no acceptance revision binding the r12 fixture scripts is pinned (acceptance r1 is r11-only)")
    return ACCEPTANCE


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_bytes(path, cap):
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


def load_pinned(path, want, modname):
    raw = read_bytes(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{path} is not the pinned {want[:12]}")
    mod = types.ModuleType(modname)
    mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)                    # exactly the hashed bytes
    return mod


# ---- pure checks (tests/test_capture.py) ------------------------------------------------------------------------------------------
def parse_sums(text):
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
    if len([l for l in proc_net_route.splitlines() if l.strip()]) > 1:
        refuse("an IPv4 route exists: run inside `unshare -Urnm`")
    return True


def mounts_under(mountinfo, prefix):
    hits = []
    for l in mountinfo.splitlines():
        f = l.split(" ")
        if len(f) > 4 and (f[4] == prefix or f[4].startswith(prefix.rstrip("/") + "/")):
            hits.append(f[4])
    return hits


def out_dir_ok(bd):
    if type(bd) is not str or not OUT_RE.fullmatch(bd) or os.path.normpath(bd) != bd:
        refuse(f"{bd!r} is not {BUILD_BASE}/run-<UTC>-<pid>/out")
    return bd


def run_paths(bd, kind, started, pid):
    """the NEW run dir, the WORK dir handed to the r12 script (which creates it) and the script argument"""
    out_dir_ok(bd)
    if kind not in KINDS or type(pid) is not int or pid <= 0:
        refuse("bad kind/pid")
    rd = f"{bd}/fixture-captures/{kind}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(started))}-{pid}"
    if not re.fullmatch(r"[A-Za-z0-9_-]+", os.path.basename(rd)):
        refuse("run dir name")
    return rd, rd + "/work", (bd if kind == "positive" else bd + "/base-state-readonly")


def matching_build_receipts(receipts, sums, bd):
    out = []
    for name, rsha, r in receipts:
        g = r.get("guard") if type(r) is dict else None
        if (type(r) is dict and r.get("verified") is True and type(r.get("finalRc")) is int and r["finalRc"] == 0
                and r.get("stageSums") == sums and type(g) is dict and g.get("outDir") == bd and r.get("mode") == "build"):
            out.append((name, rsha, r))
    return out


def expected_identities(kind, build_receipt, build_receipt_sha):
    g = build_receipt["guard"]["binaries"]
    return {"stageSums": PINS["r12Sums"][1], "scriptSha256": PINS[KINDS[kind]["script"]][1],
            "helperSha256": g["base-state-readonly"]["sha256"], "mkFixtureSha256": g["mk_fixture"]["sha256"],
            "buildReceiptSha256": build_receipt_sha}


def cleanup_ok(c):
    return (type(c) is dict and c.get("mountsLeft") == [] and c.get("treesLeft") is False and c.get("evidenceKept") is True
            and c.get("groupAlive") is False and c.get("roStillOk") is True and c.get("stageRunsUnchanged") is True)


def decide(cap, timed_out, check, before, after, expected, cleanup, verify_after):
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
    if not cleanup_ok(cleanup):
        r.append(f"cleanup/confinement incomplete: {cleanup}")
    if verify_after is not True:
        r.append("verify_binaries failed after the run")
    if type(check) is not dict or check.get("outputValid") is not True:
        r.append(f"output check failed: {(check or {}).get('reasons') if type(check) is dict else check}")
    return (not r), r


def receipt_errors(rec, kind, expected):
    """for a CONSUMER: [] iff a passing capture receipt of `kind` bound to `expected`, this stage's pins and a pinned parser. The
    consumer must ALSO re-run the pinned parser on the sha-bound capture.txt - a receipt alone is a claim."""
    e = []
    if type(rec) is not dict or set(rec) != RECEIPT_KEYS:
        return ["receipt keys are not exact"]
    if rec["format"] != RECEIPT_FORMAT or rec["kind"] != kind:
        e.append("format/kind")
    if rec["pass"] is not True or rec["synthetic"] is not False or rec["authenticatedBy"] != "capture" or rec["reasons"] != []:
        e.append("not a passing capture-authenticated receipt")
    if rec["pins"] != {k: v[1] for k, v in PINS.items()}:
        e.append("pins differ from this stage")
    if ACCEPTANCE is None or rec["acceptance"] != {k: v[1] for k, v in ACCEPTANCE.items()}:
        e.append("no pinned r12-aware parser (PARSER BINDING PENDING) or a different parser")
    if rec["identitiesBefore"] != expected or rec["identitiesAfter"] != expected:
        e.append("identities differ from expected")
    c = rec["capture"]
    if not (type(c) is dict and type(c.get("sha256")) is str and type(c.get("path")) is str and c.get("truncated") is False
            and c.get("abandoned") is False and c.get("sinkError") is None and type(c.get("rc")) is int and c["rc"] == 0
            and c.get("timedOut") is False):
        e.append("capture record not clean")
    if type(rec["check"]) is not dict or rec["check"].get("outputValid") is not True or rec["verifyBinariesAfter"] is not True:
        e.append("check/verify not passing")
    if not cleanup_ok(rec["cleanup"]):
        e.append("cleanup/confinement not complete")
    sp = rec["spawn"]
    if not (type(sp) is dict and type(sp.get("pid")) is int and type(sp.get("argv")) is list):
        e.append("spawn record missing")
    return e


# ---- gates shared by precheck (outside) and run (inside) ---------------------------------------------------------------------------
def verify_stage_sums(stage, sums_path, want):
    raw = read_bytes(sums_path, 1 << 20)
    if sha(raw) != want:
        refuse(f"{sums_path} is not the pinned {want[:12]}")
    listed = parse_sums(raw.decode())
    for rel, h in listed.items():
        if sha(read_bytes(os.path.join(stage, rel), 64 << 20)) != h:
            refuse(f"{stage}/{rel} != its SHA256SUMS entry")
    return listed


def gates(kind, bd):
    """-> (G, A, fingerprint, build receipt (path, sha, dict), expected identities); refuses on any failure, writes nothing"""
    acc = parser_binding()
    verify_stage_sums(HERE, os.path.join(HERE, "SHA256SUMS"), sha(read_bytes(os.path.join(HERE, "SHA256SUMS"), 1 << 20)))
    listed = verify_stage_sums(R12, *PINS["r12Sums"])
    for n in ("r12Gate", "r12Ns", "r12Positive", "r12Fixtures"):
        if listed.get(os.path.relpath(PINS[n][0], R12)) != PINS[n][1]:
            refuse(f"{n} pin differs from r12 SHA256SUMS")
    adir = os.path.dirname(acc["sums"][0])
    verify_stage_sums(adir, *acc["sums"])
    A = load_pinned(*acc["module"], "acceptance_pinned")
    tr = read_bytes(acc["tests"][0], 1 << 20)
    t = json.loads(tr)
    if sha(tr) != acc["tests"][1] or t.get("pass") is not True or t.get("stageSums") != acc["sums"][1]:
        refuse("the pinned acceptance test receipt is not a passing receipt of the pinned acceptance stage")
    G = load_pinned(*PINS["r12Gate"], "bsro_gate_r12")
    if G.BASE != BUILD_BASE:
        refuse("bsro_gate.BASE differs from this wrapper's build base")
    G.qualified()
    fp = G.live_completion()
    G.no_live_sessions()
    cg = [l for l in G.read_all("/proc/self/cgroup", 4096).decode().splitlines() if l.startswith("0::")]
    if len(cg) != 1:
        refuse("not a single cgroup v2 entry")
    avail = [int(l.split()[1]) / 1024 for l in G.read_all("/proc/meminfo", 1 << 16).decode().splitlines() if l.startswith("MemAvailable:")]
    lane512_ok(G.read_all("/sys/fs/cgroup" + cg[0][3:] + "/memory.max", 64).decode(), avail[0] if avail else 0)
    G.root_floor_ok(G.free_bytes(R12))                                  # nothing of this run is written to root
    out_dir_ok(bd)
    if os.path.realpath(bd) != bd:
        refuse(f"{bd} is not its own real path")
    if G.free_bytes(bd) < VM_FLOOR + CAPTURE_BUDGET:
        refuse("/vm free < 40 GiB floor + 256 MiB capture budget")
    G.verify_binaries(bd)
    runs = os.path.join(R12, "runs")
    cands = []
    for n in sorted(os.listdir(runs)):
        if n.startswith("build-"):
            try:
                raw = read_bytes(os.path.join(runs, n, "receipt.json"), 1 << 20)
                cands.append((n, sha(raw), json.loads(raw)))
            except (OSError, ValueError, Refused):
                continue
    m = matching_build_receipts(cands, PINS["r12Sums"][1], bd)
    if len(m) != 1:
        refuse(f"{len(m)} verified r12 build receipts name {bd} (need exactly one)")
    rname, rsha, rrec = m[0]
    return G, A, fp, (os.path.join(runs, rname, "receipt.json"), rsha, rrec), expected_identities(kind, rrec, rsha)


def observe(G, bd, script, receipt_path):
    return {"stageSums": sha(read_bytes(PINS["r12Sums"][0], 1 << 20)), "scriptSha256": sha(read_bytes(script, 1 << 20)),
            "helperSha256": G.file_sha(os.path.join(bd, "base-state-readonly"))[0],
            "mkFixtureSha256": G.file_sha(os.path.join(bd, "mk_fixture"))[0], "buildReceiptSha256": sha(read_bytes(receipt_path, 1 << 20))}


def precheck(kind, bd):
    parser_binding()
    if kind not in KINDS:
        refuse("kind")
    G, _A, _fp, _br, _exp = gates(kind, bd)
    mi = G.read_all("/proc/self/mountinfo", 4 << 20).decode()
    if mounts_under(mi, bd):
        refuse(f"mounts already exist under {bd}")
    return 0


def run(kind, bd, uid, gid):
    acc = parser_binding()                                             # FIRST: nothing is touched while the parser is pending
    if kind not in KINDS:
        refuse("kind")
    t_start = time.time()
    G, A, fp, (rpath, rsha, _rrec), expected = gates(kind, bd)
    # the reviewed build namespace: exact maps, private propagation, /home/steven and /tmp (and so both stages) recursively read-only,
    # the build output writable (pinned r12 ns_checks = propagation_private + read_only + ro_tree_ok)
    G.maps_inside(G.read_all("/proc/self/uid_map", 4096).decode(), G.read_all("/proc/self/gid_map", 4096).decode(),
                  G.read_all("/proc/self/setgroups", 64).decode(), uid, gid)
    no_ipv4_routes(G.read_all("/proc/net/route", 1 << 20).decode())   # inside the namespace only (the host has routes)
    G.ns_checks(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), [*RO_PATHS, R12, HERE], [bd], G.RO_ROOTS)
    script = PINS[KINDS[kind]["script"]][0]
    before = observe(G, bd, script, rpath)
    if before != expected:
        refuse(f"identities before the run differ from the pins/build receipt: {before} != {expected}")
    if mounts_under(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), bd):
        refuse(f"mounts already exist under {bd}")
    runs_before = sorted(os.listdir(os.path.join(R12, "runs")))
    cd = os.path.join(bd, "fixture-captures")
    try:
        os.mkdir(cd, 0o700)
    except FileExistsError:
        pass
    cst = os.lstat(cd)
    if not stat.S_ISDIR(cst.st_mode) or cst.st_uid != os.getuid() or cst.st_dev != os.lstat(bd).st_dev or stat.S_IMODE(cst.st_mode) != 0o700:
        refuse(f"{cd} is not our real 0700 directory on the build filesystem")
    rd, work, arg = run_paths(bd, kind, t_start, os.getpid())
    os.mkdir(rd, 0o700)                                                 # NEW; the r12 script creates WORK=rd/work itself
    # ---- from here on something runs: every failure is exit 4 (pass:false receipt when writable) ----
    argv = ["/usr/bin/timeout", "-s", "TERM", "-k", str(KILL_AFTER), str(KINDS[kind]["limit"]), "/usr/bin/bash", script, arg, work]
    cap_path = os.path.join(rd, "capture.txt")
    rec = {"format": RECEIPT_FORMAT, "kind": kind, "pass": False, "synthetic": False, "authenticatedBy": "capture", "reasons": [],
           "pins": {n: v[1] for n, v in PINS.items()}, "acceptance": {n: v[1] for n, v in acc.items()},
           "wrapperSums": sha(read_bytes(os.path.join(HERE, "SHA256SUMS"), 1 << 20)), "buildOutDir": bd, "runDir": rd, "workDir": work,
           "buildReceipt": {"path": rpath, "sha256": rsha}, "identitiesBefore": before, "identitiesAfter": None, "completionFingerprint": fp,
           "spawn": {"argv": argv, "pid": None}, "capture": None, "check": None, "cleanup": None, "verifyBinariesAfter": False,
           "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_start)), "seconds": None}
    rc_out = 4
    try:
        t0 = time.monotonic()
        cap = G.run_capture(argv, cap_path, cap=CAPTURE_CAP, forward=True)
        rec["seconds"] = round(time.monotonic() - t0)
        rec["spawn"]["pid"] = cap.get("pid")
        timed_out = cap["rc"] in (124, 137) or cap["abandoned"] is True
        captured = read_bytes(cap_path, CAPTURE_CAP)
        rec["capture"] = {"path": cap_path, "sha256": sha(captured), "rc": cap["rc"], "keptBytes": cap["kept"], "totalBytes": cap["total"],
                          "truncated": cap["total"] > cap["kept"], "abandoned": cap["abandoned"], "sinkError": cap["sinkError"],
                          "timedOut": timed_out}
        after = observe(G, bd, script, rpath)
        rec["identitiesAfter"] = after
        try:
            verify_stage_sums(R12, *PINS["r12Sums"])
            verify_stage_sums(os.path.dirname(acc["sums"][0]), *acc["sums"])
        except Exception as e:                                          # noqa: BLE001
            rec["reasons"].append(f"a frozen stage changed during the run: {e}"[:300])
        try:
            rec["verifyBinariesAfter"] = G.verify_binaries(bd) is True
        except Exception as e:                                          # noqa: BLE001
            rec["reasons"].append(f"verify_binaries after: {type(e).__name__}: {e}"[:300])
        mi = G.read_all("/proc/self/mountinfo", 4 << 20).decode()
        try:
            ro = G.ns_checks(mi, [*RO_PATHS, R12, HERE], [bd], G.RO_ROOTS) is True
        except Exception:                                               # noqa: BLE001
            ro = False
        rec["cleanup"] = {"mountsLeft": mounts_under(mi, rd), "treesLeft": os.path.lexists(os.path.join(work, "trees")),
                          "evidenceKept": os.path.isdir(os.path.join(work, "out")) and not os.path.islink(os.path.join(work, "out")),
                          "groupAlive": bool(cap.get("pid")) and G.group_alive(cap["pid"]), "roStillOk": ro,
                          "stageRunsUnchanged": sorted(os.listdir(os.path.join(R12, "runs"))) == runs_before}
        rec["check"] = A.check_fixture_capture(kind, captured, cap["rc"], timed_out, rec["capture"]["truncated"], after, expected)
        ok, reasons = decide(cap, timed_out, rec["check"], before, after, expected, rec["cleanup"], rec["verifyBinariesAfter"])
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
    ap.add_argument("cmd", choices=["precheck", "run"]); ap.add_argument("kind", choices=sorted(KINDS)); ap.add_argument("build_out_dir")
    ap.add_argument("--uid", type=int); ap.add_argument("--gid", type=int)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "precheck":
            return precheck(a.kind, a.build_out_dir)
        if a.uid is None or a.gid is None:
            refuse("run needs --uid and --gid")
        return run(a.kind, a.build_out_dir, a.uid, a.gid)
    except Exception as e:                                              # noqa: BLE001 - before the spawn: nothing ran
        print(f"## REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
