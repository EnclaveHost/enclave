#!/usr/bin/env python3
"""namespace-launch-guard-stage/r1 tests/test_guard.py (PREPARED by Claude 1901; NOT run by Claude). 9 unit tests with a MOCKED execve:
nothing is ever dispatched, mounted or spawned. They read the pinned frozen stages/receipts (pins) and write only in temp dirs. The cnq
receipt used by tests 6-7 is SYNTHETIC, created in a temp dir only: it is never an actual namespace qualification."""
import ast, copy, json, os, tempfile, unittest
from pathlib import Path

ST = Path(__file__).resolve().parent.parent
import importlib.util
SPEC = importlib.util.spec_from_file_location("guard", ST / "guard.py")
G = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(G)
BD = "/vm/enclave-volumes/rpc-recovery-validation-build/run-20261101T000000Z-1/out"
UID = 1000
CAP_ROOTS = ["/home/steven", "/tmp", "/var/tmp", "/dev/shm", f"/run/user/{UID}"]
ALL = {"exists": lambda p: True, "islink": lambda p: False, "isdir": lambda p: True}


def mi(*rows):
    return "".join(f"{i} 1 0:{i} / {mp} rw,relatime - {fs} src rw\n" for i, (mp, fs) in enumerate(rows, 30))


SAFE = mi(("/", "ext4"), ("/tmp", "tmpfs"), ("/dev/shm", "tmpfs"), ("/run/user/1000", "tmpfs"), ("/run/user/1000/doc", "fuse.portal"),
          ("/vm/enclave-volumes", "ext4"))
OBSERVED = [("/home/steven/Documents/Codex/2026-10-26/my/work/tr004-readonly", "fuseblk"),           # root 1901's actual observation shape
            ("/home/steven/x/recovery-multipart-stage/r3/runs/s/view", "fuse"), ("/home/steven/a/nbd", "fuse.nbdfuse"),
            ("/tmp/v", "fuse.fuse2fs"), ("/var/tmp/q", "fuseblk")]


def synthetic_cnq(d, **over):
    r = {"format": "capture-ns-qual-receipt/r1", "pass": True, "reasons": [], "stageSums": G.SUMS[G.CNQ],
         "inside": {"set": CAP_ROOTS, "r3RoPaths": CAP_ROOTS},
         "pins": {"r3Capture": G.CODE["capture"][1], "r3Sums": G.SUMS[G.R3], "r12Sums": G.SUMS[G.R12]}}
    r.update(over)
    os.makedirs(os.path.join(d, "ns-qual-20261101T000000Z-9"))
    Path(d, "ns-qual-20261101T000000Z-9", "receipt.json").write_text(json.dumps(r))


class T(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory(prefix="nlg-"); self.d = self.td.name
        self.calls = []
        self.runs, self.cnq = os.path.join(self.d, "runs"), os.path.join(self.d, "cnq-runs")
        os.mkdir(self.cnq)

    def tearDown(self):
        self.td.cleanup()

    def go(self, argv, mountinfo=SAFE, fs=None):
        rc = G.main(argv, execve=lambda *a: self.calls.append(a), mountinfo=mountinfo, uid=UID, fs=fs, runs_dir=self.runs, cnq_runs=self.cnq)
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
        for over in ({"format": "x"}, {"pass": False}, {"reasons": ["x"]}, {"stageSums": "0" * 64},
                     {"inside": {"set": CAP_ROOTS[:4], "r3RoPaths": CAP_ROOTS}}, {"pins": {"r3Capture": "0" * 64}}):
            with tempfile.TemporaryDirectory() as d:
                synthetic_cnq(d, **over)
                with self.assertRaises(G.Refused, msg=over):
                    G.find_cnq_receipt(d, CAP_ROOTS)

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


if __name__ == "__main__":
    unittest.main()
