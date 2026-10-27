#!/usr/bin/env python3
"""state-fixture-capture-stage/r3 capture.py (PREPARED by Claude 1889; NOT run by Claude). Standard library + PINNED frozen code only.

r3 = r2 (f07bd6da..., root 1886: HOLD on a test false positive) + binding (review 1884 B1-B5):
  - PARSER BOUND: acceptance r3 (state-helper-qualification-stage/r3, SUMS 1e7eb636..., acceptance.py b2c10534..., root's actual
    46-test receipt e2361fbb...: format r3, expected 46, ran ["46"], every check true) - its check_fixture_capture binds the r12
    scripts and r12 end markers. Not re-implemented here.
  - B4: the positive `## outputs` line must be EXACTLY `## outputs <run dir>/work/out` (acceptance r3 accepts any absolute path).
  - B3: a bounded manifest of work/out (regular nlink-1 files only, exact expected name set, size + sha256) is in the receipt; the
    positive binaries.sha256 must be exactly the expected helper / mk_fixture shas.
  - B2: BUILD_OUT_DIR must be on the pinned /vm filesystem (253:1, UUID aaae081c..., the multipart manifest's vm target pins).
  - B1: besides /home/steven and /tmp, /var/tmp, /dev/shm and /run/user/<uid> (each that exists) are bound read-only by inner.sh
    and verified here (ns_checks read_only + ro_tree_ok over all of them).
Runs ONE frozen base-state-readonly r12 fixture script (jobs/positive.sh 26 runs | jobs/fixtures.sh 6 cases) INSIDE `unshare -Urnm`
+ the pinned r12 ns_harden, with the ONLY writable target the NEW run dir <BUILD_OUT_DIR>/fixture-captures/<kind>-<UTC>-<pid>/ on
/vm: capture.txt, receipt.json, and WORK=work/ handed to the r12 script. NOTHING here runs automatically.

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
# r3: the frozen acceptance r3 (binds the r12 script shas + r12 end markers) and root's ACTUAL passing 46-test receipt, rehashed from the files
ACC = W + "/state-helper-qualification-stage/r3"
ACCEPTANCE = {
    "sums": (ACC + "/SHA256SUMS", "1e7eb6367e2cfbbf38c0f6debb92492421f3b9086dc3f8fd8236ce55319faadd"),
    "module": (ACC + "/acceptance.py", "b2c10534ac349a3233da06aed60374ae20762d2b1b8527bbb799e74078cfd0ec"),
    "tests": (ACC + "/runs/tests-20261027T103556Z-3089837/receipt.json", "e2361fbb5e49d14f7493f49e27346dcedeaf4b1b13d876f1fa985dff03ac6d29"),
}
ACC_TEST_CHECKS = frozenset({"rc0", "ranExactly", "lastLineOK", "stdoutEmpty", "noBadMarkers"})
VM_MAJMIN, VM_UUID = "253:1", "aaae081c-f829-4484-a50f-a9bbb87d31f9"   # multipart manifest f94807f7... targets.vm (majmin, uuid)
VM_BAD_FSTYPES = ("tmpfs", "ramfs", "overlay", "fuse", "nfs", "cifs", "9p")
EXTRA_RO = ("/var/tmp", "/dev/shm", "/run/user/{uid}")                # B1: each that exists is bound read-only by inner.sh
EVIDENCE_MAX_FILES, EVIDENCE_FILE_CAP = 256, (1 << 20) + 4096
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
RECEIPT_FORMAT = "bsro-fixture-capture-receipt/r3"
RECEIPT_KEYS = frozenset({"format", "kind", "pass", "synthetic", "authenticatedBy", "reasons", "pins", "acceptance", "wrapperSums",
                          "buildOutDir", "runDir", "workDir", "buildReceipt", "identitiesBefore", "identitiesAfter", "completionFingerprint",
                          "spawn", "capture", "check", "cleanup", "verifyBinariesAfter", "startedUtc", "seconds",
                          "roPaths", "vmBinding", "outputsLine", "evidence"})
IDENT_KEYS = frozenset({"stageSums", "scriptSha256", "helperSha256", "mkFixtureSha256", "buildReceiptSha256"})


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def parser_binding():
    """FIRST statement of precheck/run/gates: the pinned r12-aware acceptance parser must be bound (r3: acceptance r3)"""
    if ACCEPTANCE is None or set(ACCEPTANCE) != {"sums", "module", "tests"}:
        refuse("PARSER BINDING PENDING: no acceptance revision binding the r12 fixture scripts is pinned")
    return ACCEPTANCE


def acceptance_receipt_ok(t, sums_sha):
    """review 1884 B5: exactly a passing acceptance r3 46-test receipt of the pinned stage (not merely pass + stageSums)"""
    if not (type(t) is dict and t.get("format") == "state-acceptance-test-receipt/r3" and t.get("pass") is True
            and t.get("expected") == 46 and t.get("ran") == ["46"] and t.get("rc") == 0 and t.get("stageSums") == sums_sha
            and type(t.get("checks")) is dict and set(t["checks"]) == ACC_TEST_CHECKS and all(v is True for v in t["checks"].values())):
        refuse("the pinned acceptance test receipt is not a passing 46-test r3 receipt of the pinned acceptance stage")
    return True


def ro_paths(uid, exists=os.path.lexists, islink=os.path.islink):
    """B1: /home/steven and /tmp always; /var/tmp, /dev/shm, /run/user/<uid> when present (a symlink there refuses)"""
    out = ["/home/steven", "/tmp"]
    for p in (x.format(uid=uid) for x in EXTRA_RO):
        if islink(p):
            refuse(f"{p} is a symlink (cannot be bound read-only by path)")
        if exists(p):
            out.append(p)
    return out


def _unescape(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def vm_binding(bd, bd_dev, mountinfo, uuid_rdev):
    """B2: BUILD_OUT_DIR's filesystem is the pinned /vm (st_dev + the visible covering mount's maj:min + the by-uuid device)"""
    mm = f"{os.major(bd_dev)}:{os.minor(bd_dev)}"
    cover = None
    for l in mountinfo.splitlines():
        pre, _, post = l.partition(" - ")
        f, g = pre.split(), post.split()
        if len(f) < 6 or len(g) < 2:
            continue
        mp = _unescape(f[4])
        if bd == mp or bd.startswith(mp.rstrip("/") + "/"):
            if cover is None or len(mp) >= len(cover["mountPoint"]):       # the deepest, last-listed (visible) covering mount
                cover = {"mountPoint": mp, "majmin": f[2], "fstype": g[0], "source": _unescape(g[1])}
    if mm != VM_MAJMIN or cover is None or cover["majmin"] != VM_MAJMIN or cover["fstype"].startswith(VM_BAD_FSTYPES) \
            or uuid_rdev != os.makedev(*map(int, VM_MAJMIN.split(":"))):
        refuse(f"{bd} is not on the pinned /vm filesystem {VM_MAJMIN} UUID {VM_UUID}: dev {mm}, mount {cover}")
    return {"majmin": mm, "uuid": VM_UUID, **cover}


def outputs_line_errors(kind, captured, work):
    """B4: positive -> exactly one `## outputs` line, EXACTLY `## outputs <run dir>/work/out`; fixtures -> none"""
    try:
        lines = captured.decode("utf-8", errors="strict").split("\n")
    except (AttributeError, UnicodeDecodeError):
        return ["capture is not UTF-8 bytes"]
    got = [l for l in lines if l.startswith("## outputs")]
    if kind == "fixtures":
        return [] if not got else [f"fixtures printed an outputs line {got[:2]}"]
    want = f"## outputs {work}/out"
    return [] if got == [want] else [f"outputs line {got[:2]} != [{want!r}]"]


def expected_evidence_names(kind, A):
    """-> (required names, optional names) of work/out from the PINNED acceptance labels/cases and the r12 scripts' redirects"""
    if kind == "positive":
        req = {"binaries.sha256"} | {f"{l}.{s}" for l in A.POSITIVE_LABELS for s in ("mk.txt", "helper.txt", "expected.json")}
        return req, {f"{l}.result.json" for l in A.POSITIVE_LABELS}          # absent for refused (rc 3) cases
    return {f"{n}.out" for n, _e in A.NEGATIVE_CASES}, set()


def evidence_manifest(out_dir):
    """B3: [{name, size, sha256}] of work/out: regular nlink-1 files only, no subdir/symlink, bounded count and size"""
    dfd = os.open(out_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        names = sorted(os.listdir(dfd))
        if len(names) > EVIDENCE_MAX_FILES:
            refuse(f"{out_dir}: {len(names)} entries > {EVIDENCE_MAX_FILES}")
        out = []
        for n in names:
            try:
                fd = os.open(n, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
            except OSError as e:
                refuse(f"{out_dir}/{n}: cannot open without following a link ({e.strerror})")
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > EVIDENCE_FILE_CAP:
                    refuse(f"{out_dir}/{n}: not a regular nlink-1 file <= {EVIDENCE_FILE_CAP} bytes")
                h, size = hashlib.sha256(), 0
                while True:
                    b = os.read(fd, 1 << 20)
                    if not b:
                        break
                    size += len(b); h.update(b)
                    if size > EVIDENCE_FILE_CAP:
                        refuse(f"{out_dir}/{n} grew past {EVIDENCE_FILE_CAP} bytes")
                out.append({"name": n, "size": size, "sha256": h.hexdigest()})
            finally:
                os.close(fd)
        return out
    finally:
        os.close(dfd)


def evidence_errors(kind, manifest, required, optional, binaries_text, bd, expected):
    e = []
    names = [m["name"] for m in manifest] if type(manifest) is list else []
    if not names or len(set(names)) != len(names):
        e.append("evidence manifest missing or duplicated")
    if required - set(names):
        e.append(f"evidence missing {sorted(required - set(names))[:5]}")
    if set(names) - required - optional:
        e.append(f"unexpected evidence {sorted(set(names) - required - optional)[:5]}")
    if kind == "positive":
        want = f"{expected['helperSha256']}  {bd}/base-state-readonly\n{expected['mkFixtureSha256']}  {bd}/mk_fixture\n"
        if binaries_text != want:
            e.append("binaries.sha256 is not exactly the expected helper / mk_fixture shas")
    return e


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
        e.append("not the pinned acceptance r3 parser binding")
    if not (type(rec["roPaths"]) is list and rec["roPaths"][:2] == ["/home/steven", "/tmp"]):
        e.append("read-only path set missing")
    vb = rec["vmBinding"]
    if not (type(vb) is dict and vb.get("majmin") == VM_MAJMIN and vb.get("uuid") == VM_UUID):
        e.append("not bound to the pinned /vm filesystem")
    if not (type(rec["outputsLine"]) is dict and rec["outputsLine"].get("errors") == []
            and rec["outputsLine"].get("want") == (rec["workDir"] + "/out" if kind == "positive" else None)):
        e.append("outputs line not bound to <run dir>/work/out")
    ev = rec["evidence"]
    if not (type(ev) is dict and ev.get("errors") == [] and type(ev.get("manifest")) is list and ev["manifest"]
            and all(type(m) is dict and set(m) == {"name", "size", "sha256"} for m in ev["manifest"])):
        e.append("evidence manifest missing or not clean")
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
    alisted = verify_stage_sums(adir, *acc["sums"])
    if alisted.get(os.path.relpath(acc["module"][0], adir)) != acc["module"][1]:
        refuse("the acceptance module pin differs from its SHA256SUMS entry")
    A = load_pinned(*acc["module"], "acceptance_pinned")
    tr = read_bytes(acc["tests"][0], 1 << 20)
    if sha(tr) != acc["tests"][1]:
        refuse("the acceptance test receipt is not the pinned bytes")
    acceptance_receipt_ok(json.loads(tr), acc["sums"][1])
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
    vm_live(G, bd)
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


def vm_live(G, bd):
    return vm_binding(bd, os.stat(bd).st_dev, G.read_all("/proc/self/mountinfo", 4 << 20).decode(),
                      os.stat("/dev/disk/by-uuid/" + VM_UUID).st_rdev)


def observe(G, bd, script, receipt_path):
    return {"stageSums": sha(read_bytes(PINS["r12Sums"][0], 1 << 20)), "scriptSha256": sha(read_bytes(script, 1 << 20)),
            "helperSha256": G.file_sha(os.path.join(bd, "base-state-readonly"))[0],
            "mkFixtureSha256": G.file_sha(os.path.join(bd, "mk_fixture"))[0], "buildReceiptSha256": sha(read_bytes(receipt_path, 1 << 20))}


def precheck(kind, bd):
    parser_binding()
    if kind not in KINDS:
        refuse("kind")
    out_dir_ok(bd)                                                      # r3: argument shape before any read
    G, _A, _fp, _br, _exp = gates(kind, bd)
    mi = G.read_all("/proc/self/mountinfo", 4 << 20).decode()
    if mounts_under(mi, bd):
        refuse(f"mounts already exist under {bd}")
    return 0


def run(kind, bd, uid, gid):
    acc = parser_binding()                                             # FIRST: nothing is touched without the pinned parser
    if kind not in KINDS:
        refuse("kind")
    out_dir_ok(bd)
    t_start = time.time()
    G, A, fp, (rpath, rsha, _rrec), expected = gates(kind, bd)
    # the reviewed build namespace: exact maps, private propagation, /home/steven, /tmp (and so both stages) and r3's /var/tmp, /dev/shm,
    # /run/user/<uid> recursively read-only, the build output writable (pinned r12 ns_checks = propagation_private + read_only + ro_tree_ok)
    G.maps_inside(G.read_all("/proc/self/uid_map", 4096).decode(), G.read_all("/proc/self/gid_map", 4096).decode(),
                  G.read_all("/proc/self/setgroups", 64).decode(), uid, gid)
    no_ipv4_routes(G.read_all("/proc/net/route", 1 << 20).decode())   # inside the namespace only (the host has routes)
    ro_list = ro_paths(uid)
    G.ns_checks(G.read_all("/proc/self/mountinfo", 4 << 20).decode(), [*ro_list, R12, HERE], [bd], tuple(ro_list))
    vmb = vm_live(G, bd)
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
           "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_start)), "seconds": None,
           "roPaths": ro_list, "vmBinding": vmb, "outputsLine": None, "evidence": None}
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
            ro = G.ns_checks(mi, [*ro_list, R12, HERE], [bd], tuple(ro_list)) is True and ro_paths(uid) == ro_list
        except Exception:                                               # noqa: BLE001
            ro = False
        ol = outputs_line_errors(kind, captured, work)                  # B4
        rec["outputsLine"] = {"want": work + "/out" if kind == "positive" else None, "errors": ol}
        rec["reasons"] += ol
        try:                                                            # B3: bounded manifest of the kept evidence
            man = evidence_manifest(os.path.join(work, "out"))
            req, opt = expected_evidence_names(kind, A)
            btxt = read_bytes(os.path.join(work, "out", "binaries.sha256"), 4096).decode() if kind == "positive" else None
            ee = evidence_errors(kind, man, req, opt, btxt, bd, expected)
        except Exception as e:                                          # noqa: BLE001
            man, ee = None, [f"evidence: {type(e).__name__}: {e}"[:300]]
        rec["evidence"] = {"manifest": man, "errors": ee}
        rec["reasons"] += ee
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
