#!/usr/bin/env python3
"""namespace-launch-guard-stage/r2 tests/test_guard.py (PREPARED by Claude 1901/1903; NOT run by Claude). 12 unit tests with a MOCKED execve:
nothing is ever dispatched, mounted or spawned. They read the pinned frozen stages/receipts (pins) and write only in temp dirs. The cnq
receipt used by tests 6-7 is SYNTHETIC, created in a temp dir only: it is never an actual namespace qualification."""
import ast, contextlib, copy, io, json, os, tempfile, unittest
from pathlib import Path

ST = Path(__file__).resolve().parent.parent
import importlib.util
SPEC = importlib.util.spec_from_file_location("guard", ST / "guard.py")
G = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(G)
BD = "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261101T000000Z-1/out"
UID = 1000
Q = G.load("cnq")                                                        # the pinned cnq r1 (receipt_pass, PINS, roots)
CAP_ROOTS = ["/home/steven", "/tmp", "/var/tmp", "/dev/shm", f"/run/user/{UID}"]
ALL = {"exists": lambda p: True, "islink": lambda p: False, "isdir": lambda p: True}


def mi(*rows):
    return "".join(f"{i} 1 0:{i} / {mp} rw,relatime - {fs} src rw\n" for i, (mp, fs) in enumerate(rows, 30))


SAFE = mi(("/", "ext4"), ("/tmp", "tmpfs"), ("/dev/shm", "tmpfs"), ("/run/user/1000", "tmpfs"), ("/run/user/1000/doc", "fuse.portal"),
          ("/vm/enclave-volumes", "ext4"))
OBSERVED = [("/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly", "fuseblk"),           # root 1901's actual observation shape
            ("/home/steven/x/recovery-multipart-stage/r3/runs/s/view", "fuse"), ("/home/steven/a/nbd", "fuse.nbdfuse"),
            ("/tmp/v", "fuse.fuse2fs"), ("/var/tmp/q", "fuseblk")]


def complete_cnq():
    """a COMPLETE synthetic receipt in cnq r1's exact shape (both phases, every probe/check of every root) - test input only"""
    return {"format": "capture-ns-qual-receipt/r1", "pass": True, "reasons": [], "stageSums": G.SUMS[G.CNQ],
            "inside": {"set": list(CAP_ROOTS), "bashSet": list(CAP_ROOTS), "r3RoPaths": list(CAP_ROOTS), "nsChecks": True, "workWritable": True,
                       "symlinkRefused": True, "heredocOk": True, "probes": {r: "EROFS" for r in CAP_ROOTS}},
            "parent": {"writable": {r: True for r in CAP_ROOTS}, "mountsUnchanged": True, "innerAlive": True},
            "pins": {k: v[1] for k, v in Q.PINS.items()}, "scope": "x"}


def synthetic_cnq(d, rec=None, raw=None, name="ns-qual-20261101T000000Z-9"):
    os.makedirs(os.path.join(d, name))
    Path(d, name, "receipt.json").write_bytes(raw if raw is not None else json.dumps(rec if rec is not None else complete_cnq()).encode())


class T(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(prefix="nlg-"); self.d = self.td.name
        self.calls = []
        self.runs, self.cnq = os.path.join(self.d, "runs"), os.path.join(self.d, "cnq-runs")
        os.mkdir(self.cnq)

    def tearDown(self):
        self.td.cleanup()

    def go(self, argv, mountinfo=SAFE, fs=None):
        out, err = io.StringIO(), io.StringIO()                         # r2: the guard's own (intentional) output, kept for the asserts
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = G.main(argv, execve=lambda *a: self.calls.append(a), mountinfo=mountinfo, uid=UID, fs=fs, runs_dir=self.runs, cnq_runs=self.cnq)
        self.out, self.err = out.getvalue(), err.getvalue()
        return rc

    def refused(self, argv, **k):
        self.assertEqual(self.go(argv, **k), 3, argv)
        self.assertEqual(self.calls, [], "a process was dispatched despite the refusal")
        self.assertFalse(os.path.isdir(self.runs) and os.listdir(self.runs), "a record was written despite the refusal")

    def test_1_pins_are_the_actual_files(self):
        for d, s in G.SUMS.items():
            G.verify_stage(d, s)
        for k, (p, h) in G.CODE.items():
            self.assertEqual(G.sha(Path(p).read_bytes()), h, k)
        for k in G.RECEIPTS:
            self.assertIs(G.receipt(k)["pass"], True, k)

    def test_2_build_routes_dispatch_exactly_the_pinned_entry(self):
        for route, mode in (("build", "build"), ("build-preflight", "preflight")):
            self.calls.clear()
            self.assertEqual(self.go([route]), 0)
            self.assertEqual(self.calls, [("/usr/bin/bash", ["/usr/bin/bash", G.R12 + "/jobs/build-outer.sh", mode], G.ENV)])
        recs = [json.loads(Path(self.runs, n).read_text()) for n in sorted(os.listdir(self.runs))]
        self.assertEqual([r["check"] for r in recs], [{"roots": ["/home/steven", "/tmp"], "cloneHazards": [], "clear": True}] * 2)

    def test_3_hazardous_mounts_refuse_before_any_process(self):
        for row in OBSERVED:
            self.refused(["build"], mountinfo=SAFE + mi(row))
        self.refused(["build"], mountinfo=SAFE + mi(("/vm/x/composite-mdbx-validation-stage/r10/runs/p/db", "fuse")))   # a stage mount anywhere

    def test_4_symlinked_or_missing_roots_refuse_before_any_process(self):
        self.refused(["build"], fs=dict(ALL, islink=lambda p: p == "/tmp"))
        self.refused(["build"], fs=dict(ALL, exists=lambda p: p != "/home/steven"))
        synthetic_cnq(self.cnq)
        self.refused(["capture-positive", BD], fs=dict(ALL, islink=lambda p: p == "/dev/shm"))    # r3 ro_paths' own symlink refusal

    def test_5_capture_waits_for_an_actual_cnq_receipt(self):
        self.refused(["capture-positive", BD], fs=ALL)                    # PENDING: none exists
        self.refused(["capture-fixtures", BD], fs=ALL)

    def test_6_capture_routes_dispatch_exactly_the_pinned_entry(self):
        synthetic_cnq(self.cnq)
        for route, kind in (("capture-positive", "positive"), ("capture-fixtures", "fixtures")):
            self.calls.clear()
            self.assertEqual(self.go([route, BD], fs=ALL), 0)
            self.assertEqual(self.calls, [("/usr/bin/bash", ["/usr/bin/bash", G.R3 + "/jobs/run.sh", kind, BD], G.ENV)])
        rec = json.loads(Path(self.runs, sorted(os.listdir(self.runs))[0]).read_text())
        self.assertEqual(rec["check"]["roots"], CAP_ROOTS); self.assertEqual(rec["receipts"]["r3Tests"], G.RECEIPTS["r3Tests"][1])
        for row in OBSERVED:
            self.calls.clear()
            self.assertEqual(self.go(["capture-positive", BD], mountinfo=SAFE + mi(row), fs=ALL), 3)
            self.assertEqual(self.calls, [])

    def test_7_cnq_receipt_must_be_exactly_a_passing_qualification_of_this_set(self):
        with tempfile.TemporaryDirectory() as d:
            synthetic_cnq(d)
            self.assertTrue(G.find_cnq_receipt(d, CAP_ROOTS, UID, Q)["sha256"])
        for over in ({"format": "x"}, {"pass": False}, {"pass": 1}, {"reasons": ["x"]}, {"stageSums": "0" * 64},
                     {"pins": dict(complete_cnq()["pins"], r3Capture="0" * 64)}, {"pins": {}}):
            with tempfile.TemporaryDirectory() as d:
                synthetic_cnq(d, dict(complete_cnq(), **over))
                with self.assertRaises(G.Refused, msg=over):
                    G.find_cnq_receipt(d, CAP_ROOTS, UID, Q)

    def test_8_strict_arguments_no_arbitrary_command(self):
        for argv in ([], ["build", "x"], ["capture-positive"], ["capture-positive", BD, "x"], ["capture-positive", "/tmp/out"],
                     ["capture-positive", BD + "/"], ["capture-positive", BD.replace("/out", "/../out")], ["rm", "-rf", "/"],
                     ["build;id"], ["/usr/bin/bash", "-c", "id"], ["capture-positive", BD + ";id"]):
            self.refused(argv, fs=ALL)

    def test_9_execve_is_the_only_dispatch_and_argv_is_constant(self):
        tree = ast.parse((ST / "guard.py").read_text())
        imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        self.assertFalse(imports & {"subprocess", "shutil", "pty", "multiprocessing"})
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and n.func.attr in ("system", "popen", "spawnv", "spawnve", "fork", "execv", "execvp", "execl")]
        self.assertEqual(calls, [])
        mains = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"][0]
        self.assertEqual(sum(1 for n in ast.walk(mains) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "execve"), 1)

    # ---- r2 (root 1903) ------------------------------------------------------------------------------------------------------------
    def test_10_any_fuse_anywhere_refuses_both_routes_desktop_exceptions_only(self):
        synthetic_cnq(self.cnq)
        routes = (["build"], ["capture-positive", BD])
        for row in (("/opt/peer", "fuse.nbdfuse"), ("/var/tmp/q", "fuseblk"), ("/mnt/x", "fuse.sshfs"), ("/media/u", "fuseblk"),
                    ("/opt/peer/v", "fuse"), ("/run/user/1001/doc", "fuse.portal"), ("/opt/doc", "fuse.portal"),
                    ("/run/user/1000/x", "fuse.sshfs"), ("/run/user/10000/gvfs", "fuse.gvfsd-fuse"), ("/srv/a/recovery-overlay-stage/r9/m", "ext4")):
            for argv in routes:
                self.calls.clear()
                self.assertEqual(self.go(argv, mountinfo=SAFE + mi(row), fs=ALL), 3, (row, argv))
                self.assertEqual(self.calls, [], (row, argv))
                self.assertIn("REFUSED", self.err)
        for argv in routes:                                                  # the desktop exceptions, under the ACTUAL /run/user/1000
            self.calls.clear()
            ok = SAFE + mi(("/run/user/1000/gvfs", "fuse.gvfsd-fuse"), ("/run/user/1000/doc/by-app", "fuse.portal"))
            self.assertEqual(self.go(argv, mountinfo=ok, fs=ALL), 0, argv)
            self.assertEqual(len(self.calls), 1); self.assertIn('"clear": true', self.out)
        self.assertTrue(G.all_namespace_hazards(mi(("/opt/peer", "fuse.nbdfuse")), UID, (), Q))
        with self.assertRaises(G.Refused):
            G.all_namespace_hazards(SAFE, True, (), Q)

    def test_11_every_probe_and_parent_check_is_required(self):
        muts = []
        for r in CAP_ROOTS:
            muts += [("probes", r, "errno 13"), ("probes", r, "CREATED (not read-only!)"), ("probes", r, None), ("writable", r, False),
                     ("writable", r, None)]
        for k in ("nsChecks", "workWritable", "symlinkRefused", "heredocOk"):
            muts.append(("inside", k, False))
        for k in ("mountsUnchanged", "innerAlive"):
            muts.append(("parent", k, False))
        muts += [("inside", "bashSet", CAP_ROOTS[:4]), ("inside", "set", CAP_ROOTS[::-1]), ("drop", "parent", None), ("drop", "inside", None)]
        for where, k, v in muts:
            rec = complete_cnq()
            if where == "probes":
                rec["inside"]["probes"].pop(k) if v is None else rec["inside"]["probes"].__setitem__(k, v)
            elif where == "writable":
                rec["parent"]["writable"].pop(k) if v is None else rec["parent"]["writable"].__setitem__(k, v)
            elif where == "drop":
                rec.pop(k)
            else:
                rec[where][k] = v
            self.assertTrue(G.cnq_receipt_errors(rec, UID, CAP_ROOTS, Q), (where, k, v))
        self.assertEqual(G.cnq_receipt_errors(complete_cnq(), UID, CAP_ROOTS, Q), [])

    def test_12_strict_json_at_the_discovered_boundary(self):
        good = json.dumps(complete_cnq())
        for raw in (good[:-1] + ', "pass": true}', good.replace('"heredocOk": true', '"heredocOk": NaN'),
                    good.replace('"innerAlive": true', '"innerAlive": Infinity'), b"[]", b"\xff{}"):
            raw = raw if type(raw) is bytes else raw.encode()
            with self.assertRaises(ValueError, msg=raw[:40]):
                G.strict_json(raw)
            with tempfile.TemporaryDirectory() as d:
                synthetic_cnq(d, raw=raw)
                with self.assertRaisesRegex(G.Refused, "PENDING"):
                    G.find_cnq_receipt(d, CAP_ROOTS, UID, Q)


if __name__ == "__main__":
    unittest.main()
