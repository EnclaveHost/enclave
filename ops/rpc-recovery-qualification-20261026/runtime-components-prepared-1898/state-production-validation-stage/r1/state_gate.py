#!/usr/bin/env python3
"""state-production-validation-stage/r1 state_gate.py (PREPARED by Claude 1890; NOT run by Claude). The production state-helper runner:
the PROVEN composite r6 owned-session/view lifecycle (this stage's composite_session.py = r6 + ONE exec_plan seam) under the PROVEN
composite r10 memory gate (memory_gate.py loaded from its pinned bytes: resource gates, MemoryHigh scope, telemetry, soft stop, OOM
counters, stop/guard), classified ONLY by the frozen acceptance r3 (classify_state / final_state_status). No new framework.

    state_gate.py gate --view-dir V --run-dir O --max-hours H --tree-root-pid P   (the job runs this under `ulimit -f 32768`)
    state_gate.py runtime --tree-root-pid P -- <r6 arguments>                   (exec'd by gate only; nothing configurable)
    state_gate.py final O J RUNTIME_RC COLLECT_RC                               (-> the job's final exit code; acceptance r3)
    state_gate.py stop SESSION_DIR | guard

FAIL-CLOSED NOW: PRODUCTION_INPUTS is None, and the capture-r3 and extraction checks are BLOCKED (their interfaces are not final), so
`gate` and `runtime` REFUSE (rc 3) before touching anything. Nothing here is a synthesized receipt. See the report for the wiring.
Outcomes (runtime rc): 30 STATE-REFUSED, 34 STATE-FAILED, 35 STATE-PARTIAL-V2, 7 INCONCLUSIVE, 8 VOID; r6 lifecycle 3/4/5 first.
Final: 35 ONLY via acceptance r3 final_state_status with complete evidence, else 10; runtime 0 is NEVER success (-> 10).
35 = self-consistent PARTIAL v2 state at the DB's own Finish header: NOT canonical, NOT recovery acceptance, NOT reset authority. The
structural production CLEAN (cmv-r10) is a separate, required, pinned prerequisite.
"""
import argparse, hashlib, json, os, stat, sys, types

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
HERE = os.path.dirname(os.path.realpath(__file__))
THIS = os.path.realpath(__file__)
PY3 = "/usr/bin/python3"
C10, ACC, B12 = W + "/composite-mdbx-validation-stage/r10", W + "/state-helper-qualification-stage/r3", W + "/base-state-readonly-stage/r12"
PINS = {
    "memoryGate": (C10 + "/memory_gate.py", "d5abdd20f74d2e9039278e9a8fd3033a4c4ad187d5bcc902c913122988dcce84"),
    "r10Sums": (C10 + "/SHA256SUMS", "e39bc67d5a74c0aab922ac3cc8d2450603d9dcd0c193f698825f063b3e7c5051"),
    "r10JobReceipt": (C10 + "/jobs/job-receipt.py", "c4e235b0a5c4d47faac5a880697af09201f75042de9cd7f45579569d98857038"),
    "session": (HERE + "/composite_session.py", "52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a"),
    "acceptance": (ACC + "/acceptance.py", "b2c10534ac349a3233da06aed60374ae20762d2b1b8527bbb799e74078cfd0ec"),
    "acceptanceSums": (ACC + "/SHA256SUMS", "1e7eb6367e2cfbbf38c0f6debb92492421f3b9086dc3f8fd8236ce55319faadd"),
    "acceptanceTests": (ACC + "/runs/tests-20261027T103556Z-3089837/receipt.json",
                        "e2361fbb5e49d14f7493f49e27346dcedeaf4b1b13d876f1fa985dff03ac6d29"),
    "r12Sums": (B12 + "/SHA256SUMS", "2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea"),
    "r12Gate": (B12 + "/jobs/bsro_gate.py", "0641637ab6fa4bb007b7d97f4b1d1d3388b7815010f7b856e2f304b9cbb07dc4"),
    "r12GuardTests": (B12 + "/runs/guard-tests-20261027T103155Z-3085134/receipt.json",
                      "8038eebeffa33905a52c67bb0c14cf41c13af6577c3c7e6113ecc3ab0593f29d"),
    "r12NsTests": (B12 + "/runs/ns-tests-20261027T103547Z-3089579/receipt.json",
                   "90a01d77d0f2f3bd525990becf8580e6aea01985e609de92f5a9c70dc4dfe337"),
}
HELPER = "base-state-readonly"
MEMORY_KEYS = ("memoryDirty", "softStop", "eventsBefore", "eventsAfter")             # the native r10 receipt["memory"] fields
HELPER_CAP, SF_CAP, REPORT_CAP, RECEIPT_CAP = 1 << 30, 1 << 30, 32 << 20, 32 << 20

# ---- the production inputs: NOT YET AVAILABLE (fail closed) ---------------------------------------------------------------------------
# Filled ONLY in a later reviewed revision, from ACTUAL receipts (never synthesized). Exact shape (input_shape_errors):
#   {"helperDir": "/vm/enclave-volumes/rpc-recovery-validation-build/run-<UTC>-<pid>/out",   # a verified r12 build output
#    "helperSha256": <64 hex>, "buildReceipt": [<r12 runs/build-*/receipt.json>, <sha>],
#    "positiveCapture": [<capture r3 positive receipt.json>, <sha>], "fixturesCapture": [<capture r3 fixtures receipt.json>, <sha>],
#    "extraction": [<header extraction receipt>, <sha>], "staticFilesDir": <abs dir on /vm>,
#    "staticFiles": [{"name", "size", "sha256"}, ...]  (the exact, complete directory content, in order),
#    "structural": {"job": [<cmv-r10 prod job receipt.json>, <sha>], "session": [<its session/receipt.json>, <sha>]},
#    "view": {"dir", "kind": "production", "manifestSha256", "descriptorSha256", "logicalSize", "parts": 265, "receiptSha256"}}
PRODUCTION_INPUTS = None
BLOCKED = {
    "captureReceipts": "capture r3 (task 1889) is not final: pin its SUMS/capture.py + its passing tests receipt, load it pinned, and "
                       "require receipt_errors(rec, kind, expected) == [] for BOTH kinds with expected = {stageSums: r12 SUMS, "
                       "scriptSha256: r12 positive/fixtures pin, helperSha256, mkFixtureSha256, buildReceiptSha256} and rec.buildOutDir "
                       "== helperDir",
    "extractionReceipt": "the compact header extraction (under review) has no qualified receipt format: pin its stage + tests receipt, "
                         "require its per-file name/size/sha256 list == staticFiles and its destination dir == staticFilesDir",
}


class Refused(Exception):
    pass


def refuse(m):
    raise Refused(m)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_all(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            refuse(f"{path} is not a regular file")
        out = b""
        while True:
            b = os.read(fd, min(1 << 20, cap + 1 - len(out)))
            if not b:
                return out
            out += b
            if len(out) > cap:
                refuse(f"{path} exceeds {cap} bytes")
    finally:
        os.close(fd)


def sha_file(path, cap):
    """(sha256, st) of a regular non-symlink file, streamed (no symlink follow), size-capped"""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            refuse(f"{path}: not a regular file <= {cap} bytes")
        h, n = hashlib.sha256(), 0
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            h.update(b); n += len(b)
        if n != st.st_size:
            refuse(f"{path} changed size while hashed")
        return h.hexdigest(), st
    finally:
        os.close(fd)


def load_exact(name, modname, pins=None):
    """a pinned module compiled from exactly the hashed bytes (no second read, no bytecode)"""
    path, want = (pins or PINS)[name]
    raw = read_all(path, 4 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the pinned file")
    mod = types.ModuleType(modname); mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)
    return mod


def pinned_json(name, pins=None):
    path, want = (pins or PINS)[name]
    raw = read_all(path, 1 << 20)
    if sha(raw) != want:
        refuse(f"{name}: {path} is not the exact pinned receipt")
    return json.loads(raw)


def verify_sums(stage_dir, sums_name, pins=None):
    """the pinned SHA256SUMS bytes, and every listed file re-hashed == listed"""
    raw = read_all((pins or PINS)[sums_name][0], 1 << 20)
    if sha(raw) != (pins or PINS)[sums_name][1]:
        refuse(f"{sums_name} differs from its pin")
    for line in raw.decode().splitlines():
        h, _, rel = line.partition("  ")
        if len(h) != 64 or not rel or rel.startswith("/") or ".." in rel.split("/"):
            refuse(f"{sums_name}: malformed line")
        if sha_file(os.path.join(stage_dir, rel), 64 << 20)[0] != h:
            refuse(f"{sums_name}: {rel} changed")
    return raw


# ---- pure checks (unit-tested) -------------------------------------------------------------------------------------------------------
def is_sha(x):
    return type(x) is str and len(x) == 64 and all(c in "0123456789abcdef" for c in x)


def is_pin(x):
    return type(x) in (list, tuple) and len(x) == 2 and type(x[0]) is str and x[0].startswith("/") and is_sha(x[1])


def input_shape_errors(inp, A):
    """[] iff inp has EXACTLY the documented PRODUCTION_INPUTS shape (exact types; no truthiness)"""
    e = []
    keys = {"helperDir", "helperSha256", "buildReceipt", "positiveCapture", "fixturesCapture", "extraction", "staticFilesDir",
            "staticFiles", "structural", "view"}
    if type(inp) is not dict or set(inp) != keys:
        return ["PRODUCTION_INPUTS: not exactly " + ", ".join(sorted(keys))]
    if not (A.is_abs_path(inp["helperDir"]) and inp["helperDir"].startswith("/vm/enclave-volumes/rpc-recovery-validation-build/run-")
            and inp["helperDir"].endswith("/out")):
        e.append("helperDir: not a /vm guard build out dir")
    if not is_sha(inp["helperSha256"]):
        e.append("helperSha256")
    for k in ("buildReceipt", "positiveCapture", "fixturesCapture", "extraction"):
        if not is_pin(inp[k]):
            e.append(f"{k}: not [abs path, sha256]")
    st = inp["structural"]
    if not (type(st) is dict and set(st) == {"job", "session"} and is_pin(st["job"]) and is_pin(st["session"])):
        e.append("structural: not {job, session} pins")
    pins = {"stageSums": PINS["r12Sums"][1], "helperSha256": inp["helperSha256"], "buildReceiptSha256": "0" * 64,
            "positiveReceiptSha256": "0" * 64, "fixturesReceiptSha256": "0" * 64, "helperPath": f"{inp['helperDir']}/{HELPER}"
            if type(inp["helperDir"]) is str else None, "runDir": "/vm/x", "staticFilesDir": inp["staticFilesDir"],
            "staticFiles": inp["staticFiles"], "view": inp["view"]}
    e += [x for x in A.pins_errors(pins) if not x.startswith("pins.staticFilesDir is inside")]   # same typed rules as the final check
    return e


def acceptance_pins(inp, run_dir):
    """the acceptance r3 pins for THIS run (the same dict the runtime argv and the final check use)"""
    return {"stageSums": PINS["r12Sums"][1], "helperSha256": inp["helperSha256"], "buildReceiptSha256": inp["buildReceipt"][1],
            "positiveReceiptSha256": inp["positiveCapture"][1], "fixturesReceiptSha256": inp["fixturesCapture"][1],
            "helperPath": f"{inp['helperDir']}/{HELPER}", "runDir": run_dir, "staticFilesDir": inp["staticFilesDir"],
            "staticFiles": [dict(f) for f in inp["staticFiles"]], "view": dict(inp["view"])}


def static_identities(sf_dir, expected):
    """the COMPLETE static-files dir content, in the pinned order: name/size/sha256 == pinned, plus dev/ino/mtime/ctime"""
    names = [f["name"] for f in expected]
    if sorted(os.listdir(sf_dir)) != sorted(names):
        refuse("the static-files dir does not hold EXACTLY the pinned files")
    out = []
    for f in expected:
        h, st = sha_file(os.path.join(sf_dir, f["name"]), SF_CAP)
        if (h, st.st_size) != (f["sha256"], f["size"]):
            refuse(f"static file {f['name']} != pinned size/sha256")
        out.append({"name": f["name"], "size": st.st_size, "sha256": h, "dev": st.st_dev, "ino": st.st_ino,
                    "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns})
    return out


def state_exec_plan(a, db, inp, A):
    """-> (argv, report path, provenance BEFORE). The argv is acceptance r3 expected_argv of the pinned inputs: nothing configurable"""
    if a.expect_kind != "production" or a.fixture_exec or a.fixture_unmount_exe:
        refuse("the state runner runs the production kind only, never a fixture exec / unmount")
    rd = a.run_dir
    if db != rd + A.DB_SUFFIX:
        refuse("the exposed db dir is not <run_dir>/work/db")
    pins = acceptance_pins(inp, rd)
    argv = A.expected_argv(pins)
    report, rocks = rd + A.REPORT_SUFFIX, rd + A.ROCKSDB_SUFFIX
    if os.path.lexists(report) or os.path.lexists(rocks):
        refuse("state-report.json or rocksdb-absent already exists in the run dir")
    hb = sha_file(argv[0], HELPER_CAP)[0]
    if hb != inp["helperSha256"]:
        refuse("the helper binary is not the pinned build output")
    prov = {"stageSums": PINS["r12Sums"][1], "helperSha256Before": hb, "buildReceiptSha256": inp["buildReceipt"][1],
            "positiveReceiptSha256": inp["positiveCapture"][1], "fixturesReceiptSha256": inp["fixturesCapture"][1],
            "staticFilesBefore": static_identities(inp["staticFilesDir"], inp["staticFiles"]), "rocksdbAbsentBefore": True}
    return argv, report, prov


def provenance_after(prov, argv0, rd, inp, A):
    """complete the acceptance PROV record after the exec; any read failure is recorded as a mismatch (never raised)"""
    p = dict(prov)
    try:
        p["helperSha256After"] = sha_file(argv0, HELPER_CAP)[0]
    except Exception as e:                                              # noqa: BLE001
        p["helperSha256After"] = f"unreadable: {type(e).__name__}"
    try:
        p["staticFilesAfter"] = static_identities(inp["staticFilesDir"], inp["staticFiles"])
    except Exception as e:                                              # noqa: BLE001
        p["staticFilesAfter"] = f"unreadable: {type(e).__name__}"
    p["rocksdbAbsentAfter"] = not os.path.lexists(rd + A.ROCKSDB_SUFFIX)
    return p


def provenance_ok(p, A):
    return (type(p) is dict and set(p) == set(A.PROV_KEYS) and p["helperSha256Before"] == p["helperSha256After"]
            and p["staticFilesBefore"] == p["staticFilesAfter"] and p["rocksdbAbsentBefore"] is True and p["rocksdbAbsentAfter"] is True)


def lifecycle_of(exec_info, post_ok):
    """r6 exec_info names, exact passthrough (acceptance validates the types) + postUseOk"""
    e = exec_info if type(exec_info) is dict else {}
    return {"postUseOk": post_ok is True, **{k: e.get(k) for k in ("timedOut", "groupLeftovers", "groupEmpty", "orphansGone", "escapedKilled")}}


def memory_of(mem):
    """the native r10 fields, exact; a missing field makes the WHOLE record malformed (never read as 'no soft stop') -> 7 / 10"""
    if type(mem) is not dict or not all(k in mem for k in MEMORY_KEYS):
        return {"memoryDirty": None, "softStop": "memory record missing a field", "eventsBefore": None, "eventsAfter": None}
    return {k: mem[k] for k in MEMORY_KEYS}


def make_state_classify(A, dirty, sample_events, holder):
    """replaces r6 classify (same signature, r6 main calls it AFTER its 4/5/3 lifecycle precedence). OOM counters sampled as r10
    memory_classify does, then acceptance r3 classify_state decides (30/34/35/7/8; dirty/soft-stop downgrade 34/35 -> 7)"""
    def classify(exec_info, report, post_ok, fixture_exec, expected_bytes=None):
        s = holder.get("s")
        if fixture_exec or s is None:
            return "INCONCLUSIVE", 7, ["no state session / a fixture exec is never classified"]
        before = s.mem.get("eventsBefore")
        try:
            after = sample_events()
        except Exception:                                               # noqa: BLE001 - unreadable counters are dirty
            after = None
        s.mem.update(eventsAfter=after, memoryDirty=dirty(before, after))
        r = A.classify_state(lifecycle_of(exec_info, post_ok), (exec_info or {}).get("rc") if type(exec_info) is dict else None,
                             getattr(s, "report_raw", None), memory_of(s.mem))
        s.receipt["stateClassification"] = r
        return r["outcome"], r["code"], list(r["reasons"])
    return classify


def make_state_session(Base, A, inp, grace):
    class StateSession(Base):
        def exec_plan(self):
            argv, report, prov = state_exec_plan(self.a, self.db, inp, A)
            self._state_prov, self._state_argv0 = prov, argv[0]
            self.receipt["stateProvenance"] = prov
            return argv, self.a.validator_timeout + grace, report

        def use(self):
            super().use()                                               # r6: held, exec in own group, reap, report bytes, post-use
            p = provenance_after(self._state_prov, self._state_argv0, self.a.run_dir, inp, A)
            ok = provenance_ok(p, A)
            self.receipt["stateProvenance"] = p
            self.receipt["checks"]["stateProvenance"] = {"ok": ok}
            self.post_ok = self.post_ok is True and ok                  # any change -> VOID 8
    return StateSession


def snapshot_checks(JR, J, arc):
    """the r10 job-receipt rules (pinned status_ok/text), unchanged"""
    import pathlib
    J = pathlib.Path(J)
    before, after, mounts, procs = (JR.text(J / n) for n in ("peers-before.txt", "peers-after.txt", "mounts-left.txt", "processes-left.txt"))
    snap = arc == 0 and JR.status_ok(J, "before") and JR.status_ok(J, "after")
    return {"snapshotsOk": snap, "peersUnchanged": snap and before is not None and before == after,
            "noMountLeft": snap and mounts == "", "noProcessLeft": snap and procs == ""}


def report_info(path):
    """(evidence.report record, bytes or None) for the fixed report path; a symlink / non-regular file is recorded, never followed"""
    try:
        st = os.lstat(path)
    except OSError:
        return {"path": path, "sha256": None, "regularFile": False, "symlink": False, "size": None}, None
    if not stat.S_ISREG(st.st_mode):
        return {"path": path, "sha256": None, "regularFile": False, "symlink": stat.S_ISLNK(st.st_mode), "size": st.st_size}, None
    raw = read_all(path, REPORT_CAP)
    return {"path": path, "sha256": sha(raw), "regularFile": True, "symlink": False, "size": len(raw)}, raw


def build_evidence(rec, runtime_rc, snap, rep, A):
    """acceptance r3 state-final-evidence/r2 from the session receipt (native r6/r10 fields, exact), the job snapshots and the report"""
    r = rec if type(rec) is dict else {}
    checks = r.get("checks") if type(r.get("checks")) is dict else {}
    pu = checks.get("postUseRecheck") if type(checks.get("postUseRecheck")) is dict else {}
    sp = checks.get("stateProvenance") if type(checks.get("stateProvenance")) is dict else {}
    ex = r.get("exec") if type(r.get("exec")) is dict else {}
    ch = r.get("children") if type(r.get("children")) is dict else {}
    ce = ch.get("exec") if type(ch.get("exec")) is dict else {}
    return {"format": A.EVIDENCE_FORMAT, "runtimeRc": runtime_rc, "outcome": r.get("outcome"), "childRc": ex.get("rc"),
            "lifecycle": lifecycle_of(ex, pu.get("ok") is True and sp.get("ok") is True), "memory": memory_of(r.get("memory")),
            "cleanupComplete": r.get("cleanupComplete"), "interrupted": r.get("interrupted", "missing"),
            **snap, "report": rep, "provenance": r.get("stateProvenance"), "helperArgv": ce.get("argv"), "view": r.get("view")}


def final_code(rc, A, rec, snap, rep, raw, inp, run_dir):
    if inp is None or input_shape_errors(inp, A):
        return A.final_state_status(rc, None, None, None)             # 35 -> 10; 0 -> 10; other 1..255 preserved
    ev = build_evidence(rec, rc, snap, rep, A)
    r = rec if type(rec) is dict else {}
    if r.get("reportSha256") != rep.get("sha256") or r.get("reportPath") != rep.get("path"):
        ev["report"] = dict(rep, sha256=None)                           # the bytes read now != the bytes the runtime classified
    return A.final_state_status(rc, ev, raw, acceptance_pins(inp, run_dir))


# ---- verification of the pinned prerequisites (impure; refuses) ---------------------------------------------------------------------
def require_inputs():
    if PRODUCTION_INPUTS is None:
        refuse("PRODUCTION_INPUTS not pinned: no authenticated r12 build output, capture receipts, header extraction or structural CLEAN "
               "receipt exists yet (fail closed; nothing synthesized)")
    return PRODUCTION_INPUTS


def verify_acceptance():
    verify_sums(ACC, "acceptanceSums")
    t = pinned_json("acceptanceTests")
    if not (t.get("format") == "state-acceptance-test-receipt/r3" and t.get("pass") is True and t.get("ran") == ["46"]
            and t.get("expected") == 46 and t.get("stageSums") == PINS["acceptanceSums"][1]):
        refuse("acceptance r3 has no exact passing 46-test receipt")
    return load_exact("acceptance", "acceptance_r3")


def verify_r12():
    verify_sums(B12, "r12Sums")
    for n, fmt in (("r12GuardTests", "bsro-guard-test-receipt/r12"), ("r12NsTests", "bsro-ns-test-receipt/r12")):
        t = pinned_json(n)
        if not (t.get("format") == fmt and t.get("pass") is True and t.get("stageSums") == PINS["r12Sums"][1]):
            refuse(f"{n}: not a passing receipt of the pinned r12")
    return load_exact("r12Gate", "bsro_gate_r12")


def verify_structural(MG, st, view):
    """the cmv-r10 production run: final evidence rc 0 (memory_gate.evidence) + CLEAN over THIS production view"""
    for k in ("job", "session"):
        if sha(read_all(st[k][0], RECEIPT_CAP)) != st[k][1]:
            refuse(f"structural {k} receipt is not the pinned bytes")
    if MG.evidence(st["job"][0], 0, 0) != 0:
        refuse("the structural cmv-r10 job receipt is not a structurally-clean final-0 receipt")
    s = json.loads(read_all(st["session"][0], RECEIPT_CAP))
    v = s.get("view") if type(s.get("view")) is dict else {}
    if not (s.get("outcome") == "CLEAN" and s.get("rc") == 0 and s.get("cleanupComplete") is True and v == view):
        refuse("the structural session receipt is not a CLEAN run over the pinned production view")


def verify_production_inputs(inp, A, G, MG):
    e = input_shape_errors(inp, A)
    if e:
        refuse(f"PRODUCTION_INPUTS malformed: {e[:4]}")
    if G.verify_binaries(inp["helperDir"]) is not True:
        refuse("helperDir is not a verified r12 build output")
    b = json.loads(read_all(inp["buildReceipt"][0], RECEIPT_CAP))
    if sha(read_all(inp["buildReceipt"][0], RECEIPT_CAP)) != inp["buildReceipt"][1] or b.get("stageSums") != PINS["r12Sums"][1] \
            or (b.get("guard") or {}).get("outDir") != inp["helperDir"] \
            or ((b.get("guard") or {}).get("binaries") or {}).get(HELPER, {}).get("sha256") != inp["helperSha256"]:
        refuse("the build receipt does not bind helperDir / helperSha256 / r12")
    if sha_file(f"{inp['helperDir']}/{HELPER}", HELPER_CAP)[0] != inp["helperSha256"]:
        refuse("the helper binary is not the pinned bytes")
    verify_structural(MG, inp["structural"], inp["view"])
    for k in ("captureReceipts", "extractionReceipt"):                 # interfaces not final: ALWAYS refuse (never assume)
        refuse(f"BLOCKED {k}: {BLOCKED[k]}")


# ---- gate / runtime / final / guard / stop ----------------------------------------------------------------------------------------
def gate(argv):
    ap = argparse.ArgumentParser(prog="state_gate.py gate")
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
    if not ours:
        print(json.dumps({"gate": "REFUSED", "reason": "--run-dir must be an existing, EMPTY, private, real absolute directory"})); return 3
    g = {"format": "state-production-gate/r1", "viewDir": a.view_dir, "maxHours": a.max_hours, "checks": {},
         "meaning": "gate only; a later 35 is PARTIAL v2 state self-consistency at the DB's own Finish header, NOT canonical"}
    MG = None
    try:
        inp = require_inputs()                                          # FIRST: nothing below runs while the inputs are unpinned
        if not 1 <= a.max_hours <= 168:
            refuse("--max-hours must be 1..168")
        MG = load_exact("memoryGate", "memory_gate_r10")
        verify_sums(C10, "r10Sums")
        A, G = verify_acceptance(), verify_r12()
        load_exact("session", "state_composite_session")
        verify_production_inputs(inp, A, G, MG)
        g["checks"]["rlimitFsize"] = MG.fsize_ok()
        R7 = MG.load_exact("r7Gate", "r7_production_gate")
        g["checks"]["qualifications"] = MG.check_qualifications(R7)
        M4 = MG.load_exact("r4Fixture", "r4_memory_fixture")
        M4.LANE_MIB, M4.HIGH_MIB = MG.LANE_MIB, MG.HIGH_MIB
        rel, unit, g["checks"]["lane"] = MG.bind_scope(M4, a.tree_root_pid)      # 4096 MiB lane, MemAvailable >= 16 GiB floor + lane
        g["checks"]["reservation"] = MG.reservation(M4, rd)                       # root: remaining + 40 GiB + 8 GiB native + budget; /vm
        g["checks"]["view"] = R7.check_view(a.view_dir)                           # ALL 265 CONFIRMED, the incident production view
        g["scope"] = M4.set_memory_high(rel, unit, M4.systemctl_runner(os.getuid()))   # the ONLY mutation, last
        d = os.path.join(M4.CG, rel.lstrip("/"))
        if str(os.getpid()) not in MG.read_all(d + "/cgroup.procs", 1 << 20).decode().split() \
                or MG.read_all(d + "/memory.max", 64).decode().strip() != str(MG.LANE_MIB * (1 << 20)):
            refuse("after MemoryHigh: we are no longer in the bound 4096 MiB scope")
    except Exception as e:                                              # noqa: BLE001 - every failure refuses; nothing was started
        g["refused"] = f"{type(e).__name__}: {e}"[:900]
        _write_new(rd, "gate-refused.json", g)
        print(json.dumps({"gate": "REFUSED", "reason": g["refused"]})); return 3
    session = os.path.join(rd, "session")
    os.mkdir(session, 0o700)
    argv2 = [PY3, "-I", "-B", THIS, "runtime", "--tree-root-pid", str(a.tree_root_pid), "--", "--view-dir", a.view_dir,
             "--run-dir", session, "--expect-kind", "production", "--validator-timeout", str(a.max_hours * 3600)]
    g["session"] = {"runDir": session, "argv": argv2}
    _write_new(rd, "gate.json", g)
    print(json.dumps({"gate": "PASSED", "exec": argv2}), flush=True)
    os.execv(PY3, argv2)


def runtime(argv):
    if "--" not in argv:
        print("REFUSED: runtime --tree-root-pid PID -- <r6 arguments>", file=sys.stderr); return 3
    i = argv.index("--")
    ap = argparse.ArgumentParser(prog="state_gate.py runtime"); ap.add_argument("--tree-root-pid", type=int, required=True)
    a, rest = ap.parse_args(argv[:i]), argv[i + 1:]
    try:
        if "--fixture-exec" in rest or "--fixture-unmount-exe" in rest or rest.count("--expect-kind") != 1 \
                or rest[rest.index("--expect-kind") + 1] != "production":
            refuse("the state runtime runs the production kind only, never a fixture exec")
        inp = require_inputs()
        MG = load_exact("memoryGate", "memory_gate_r10")
        MG.fsize_ok()
        A, G = verify_acceptance(), verify_r12()
        verify_production_inputs(inp, A, G, MG)
        M4 = MG.load_exact("r4Fixture", "r4_memory_fixture")
        C = load_exact("session", "state_composite_session")
        rel, _unit = M4.scope_of(MG.read_all("/proc/self/cgroup", 4096).decode(), os.getuid())
        d = os.path.join(M4.CG, rel.lstrip("/"))
        if MG.read_all(d + "/memory.max", 64).decode().strip() != str(MG.LANE_MIB * (1 << 20)) \
                or MG.read_all(d + "/memory.high", 64).decode().strip() != str(MG.HIGH_MIB * (1 << 20)):
            refuse("our scope is not the gate-bound 4096 MiB lane with MemoryHigh 3712 MiB")
        MG.ancestor_in_cgroup(a.tree_root_pid)
    except Exception as e:                                              # noqa: BLE001 - nothing claimed or written
        print(f"REFUSED: {type(e).__name__}: {e}"[:900], file=sys.stderr); return 3
    holder = {}
    C.CHILD_FSIZE = MG.CHILD_LOG_CAP
    Base = MG.make_memory_session(C, M4, {"rel": rel, "root": a.tree_root_pid}, holder)   # built on C.Session = the seam copy
    C.Session = make_state_session(Base, A, inp, C.VALIDATOR_GRACE)
    C.classify = make_state_classify(A, MG.dirty, lambda: M4.cg_sample(rel)["events"], holder)
    return C.main(rest)                                                 # the r6 lifecycle, cleanup, receipt


def final(O, J, rc_text, arc_text):
    """the job's final exit code: acceptance r3 final_state_status over the bound evidence; any failure -> 10 (or the preserved
    nonzero non-35 runtime code); runtime 0 is never success"""
    rc = int(rc_text) if rc_text.isdigit() else None
    out = {"format": "state-production-final/r1", "runtimeRc": rc_text}
    try:
        A = verify_acceptance()
        JR = load_exact("r10JobReceipt", "r10_job_receipt")
        arc = int(arc_text) if arc_text.isdigit() else 1
        run_dir = os.path.join(O, "session")
        try:
            rec = json.loads(read_all(os.path.join(run_dir, "receipt.json"), RECEIPT_CAP))
        except Exception:                                               # noqa: BLE001 - missing / malformed: the evidence fails
            rec = None
        rep, raw = report_info(run_dir + A.REPORT_SUFFIX)
        r = final_code(rc, A, rec, snapshot_checks(JR, J, arc), rep, raw, PRODUCTION_INPUTS, run_dir)
        code = r["final"]
        out.update(result=r)
    except Exception as e:                                              # noqa: BLE001
        code = rc if type(rc) is int and 1 <= rc <= 255 and rc != 35 else 10
        out.update(error=f"{type(e).__name__}: {e}"[:600], final=code)
    _write_new(J, "final.json", out)
    print(json.dumps({"final": code, "usable": code == 35}))
    return code


def guard():
    MG = load_exact("memoryGate", "memory_gate_r10")
    SG = MG.load_exact("r6SessionGuard", "r6_session_guard")
    live, excl = [], SG.ancestors(os.getpid())
    for ent in os.listdir("/proc"):
        if not ent.isdigit() or int(ent) in excl:
            continue
        try:
            if os.stat(f"/proc/{ent}").st_uid != os.getuid():
                continue
            argv, _ppid, start, _comm = SG.info(int(ent))
        except (OSError, ValueError, IndexError):
            continue
        s = SG.script_of(argv)
        if s is not None and os.path.basename(s) == "state_gate.py":
            k = argv.index(s)
            if k + 1 < len(argv) and argv[k + 1] in ("gate", "runtime"):
                live.append({"pid": int(ent), "startTime": start, "argv": argv[:6]})
    for x in live:
        print("## guard LIVE state_gate session process: " + json.dumps(x, sort_keys=True))
    return 1 if live else MG.guard()


def _write_new(d, name, obj):
    fd = os.open(os.path.join(d, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(obj, indent=1, sort_keys=True, default=str) + "\n")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["gate"]:
        return gate(argv[1:])
    if argv[:1] == ["runtime"]:
        return runtime(argv[1:])
    try:
        if argv[:1] == ["final"] and len(argv) == 5:
            return final(*argv[1:])
        if argv[:1] == ["stop"] and len(argv) == 2:
            MG = load_exact("memoryGate", "memory_gate_r10")
            print(json.dumps(MG.stop_session(argv[1], script=THIS))); return 0
        if argv == ["guard"]:
            return guard()
    except Exception as e:                                              # noqa: BLE001
        print(f"REFUSED: {type(e).__name__}: {e}"[:600], file=sys.stderr); return 10 if argv[:1] == ["final"] else 3
    print(__doc__, file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main())
