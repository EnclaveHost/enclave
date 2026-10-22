#!/usr/bin/env python3
"""The ONLY change vs fixture-v2: W = H.parent.parent. W must be work/ itself, and the transport must be the REAL
work/nucbox-tls-20261021/root-activate-reviewed.py (c50aac8e), never reached through the nested symlink
node-hold-acl-normalization-20261021/nucbox-tls-20261021 that the original v2 path silently depended on. Plan mode: no remote."""
import contextlib, hashlib, importlib.util, io, json, os, pathlib, subprocess, unittest
H = pathlib.Path(__file__).resolve().parent; WORK = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work")
REAL_T = WORK / "nucbox-tls-20261021/root-activate-reviewed.py"; T_SHA = "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f"
def load(p, name):
    s = importlib.util.spec_from_file_location(name, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
class PathFix(unittest.TestCase):
    def test_w_is_work_and_transport_is_the_real_pinned_file(self):
        D = load(H / "root-run-acl-fixture.py", "fixed")
        self.assertEqual(D.W, WORK); self.assertEqual(D.T[0], REAL_T)
        self.assertFalse(any(p.is_symlink() for p in [D.T[0], *D.T[0].parents]), "no symlink on the transport path")
        self.assertEqual(D.T[0].resolve(), D.T[0]); self.assertEqual(hashlib.sha256(D.T[0].read_bytes()).hexdigest(), T_SHA); self.assertEqual(D.T[1], T_SHA)
        D.pins(); self.assertEqual(pathlib.Path(D.m.__file__), REAL_T, "the transport module is loaded from work/nucbox-tls-20261021")
    def test_original_v2_resolved_through_the_nested_symlink(self):
        O = load(H.parent / "fixture-v2/root-run-acl-fixture.py", "orig")       # loaded only; main() never called
        self.assertEqual(O.W, H.parent); self.assertEqual(O.T[0], H.parent / "nucbox-tls-20261021/root-activate-reviewed.py")
        self.assertTrue((H.parent / "nucbox-tls-20261021").is_symlink(), "the original only worked through this symlink")
    def test_only_the_path_line_differs_from_v2(self):
        a = (H.parent / "fixture-v2/root-run-acl-fixture.py").read_text().splitlines(); b = (H / "root-run-acl-fixture.py").read_text().splitlines()
        self.assertEqual(len(a), len(b)); d = [(x, y) for x, y in zip(a, b) if x != y]
        self.assertEqual(d, [('H = pathlib.Path(__file__).resolve().parent; W = H.parent; OUT = H / "runs"', 'H = pathlib.Path(__file__).resolve().parent; W = H.parent.parent; OUT = H / "runs"')])
        for f in ("acl-fixture.ps1", "functions.ps1", "functions.json", "acl-fixture.template.ps1", "build-fixture-v2.py"):
            self.assertEqual((H / f).read_bytes(), (H.parent / "fixture-v2" / f).read_bytes(), f)
    def test_plan_mode_makes_no_remote_call(self):
        D = load(H / "root-run-acl-fixture.py", "plan"); D.pins()
        def no(*a, **k): raise AssertionError("plan mode reached the transport / a subprocess")
        D.m.ps = no; D.subprocess.run = no; D.m.subprocess.run = no; D.OUT = H / "runs-must-not-exist"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf): rc = D.main([])
        self.assertEqual(rc, 0); out = json.loads(buf.getvalue()); self.assertEqual(out["pins"], "ok"); self.assertEqual(out["fixture"], D.FIX[1])
        self.assertFalse(D.OUT.exists(), "no receipt written in plan mode")
    def test_plan_mode_as_a_process_from_another_cwd(self):
        r = subprocess.run(["python3", str(H / "root-run-acl-fixture.py")], cwd="/", capture_output=True, text=True, timeout=60, env={**os.environ, "PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 0, r.stderr[-400:]); self.assertEqual(json.loads(r.stdout)["pins"], "ok"); self.assertFalse((H / "runs").exists())
if __name__ == "__main__": unittest.main()
