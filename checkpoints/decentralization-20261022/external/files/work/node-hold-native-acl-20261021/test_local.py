#!/usr/bin/env python3
"""Local checks (no remote): pwsh 7.4 parse of the fixture and every driver text; driver flow with a fake transport."""
import base64, importlib.util, json, pathlib, shutil, subprocess, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; PWSH = str(H.parent / "node-hold-package-20261021/tools/pwsh/pwsh")
spec = importlib.util.spec_from_file_location("d", H / "root-run-acl-fixture.py"); D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
REAL = subprocess.run
def parse(text):
    f = pathlib.Path(tempfile.mkdtemp()) / "x.ps1"; f.write_text(text)
    r = REAL([PWSH, "-NoProfile", "-Command", f"$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile('{f}',[ref]$null,[ref]$e);$e.Count"], capture_output=True, text=True, timeout=120)
    shutil.rmtree(f.parent); return r.stdout.strip()
class T(unittest.TestCase):
    def setUp(self):
        D.pins(); self.tmp = pathlib.Path(tempfile.mkdtemp()); D.OUT = self.tmp; self.calls = []
        def guard(argv, **k):
            if "ssh" in [str(a) for a in argv]: raise AssertionError("a test reached minipc")
            self.calls.append(("scp", str(argv[-1]))); return type("r", (), {"returncode": 0, "stderr": ""})()
        D.subprocess.run = guard; D.m.subprocess.run = guard; self.clean = None; self.clean_raises = False
    def tearDown(self): D.subprocess.run = REAL; shutil.rmtree(self.tmp)
    def fake(self, mk=None, fix=None):
        def ps(text, secs=150):
            self.assertLessEqual(len(base64.b64encode((D.m.HEAD.replace("SECS", str(secs)) + text).encode("utf-16-le"))), 7900)
            kind = "clean" if "Remove-Item -LiteralPath $d -Recurse" in text else "mkdir" if "CreateDirectory($d,$ds)" in text else "parent" if "$o=[ordered]@{exists=" in text else "verify" if "@{sha=(FileSha" in text else "run"
            self.calls.append((kind, text))
            if kind == "clean" and self.clean_raises: raise RuntimeError("transport lost")
            return {"clean": self.clean or {"existed": True, "owned": True, "gone": True, "parentSddl": "P", "decision": "removed (ownership marker matched)"}, "parent": {"exists": True, "sddl": "P"},
                    "mkdir": mk or {"decision": "created", "protected": True, "foreignRules": 0}, "verify": {"sha": D.FIX[1]}, "run": fix or {"pass": True}}[kind]
        D.m.ps = ps
    def test_parse_fixture_and_texts(self):
        self.assertEqual(parse(D.FIX[0].read_text()), "0", "the fixture parses")
        for t in (D.PARENT, D.MKDIR, D.VERIFY, D.RUN, D.CLEAN): self.assertEqual(parse(t.replace("DX", "'C:\\x'").replace("FX", "'C:\\x\\f'")), "0", t[:60])
    def test_default_is_local_only(self):
        self.fake(); self.assertEqual(D.main([]), 0); self.assertEqual(self.calls, [])
    def test_run_order_and_cleanup(self):
        self.fake(); self.assertEqual(D.main(["--run"]), 0)
        self.assertEqual([c[0] for c in self.calls], ["parent", "mkdir", "scp", "verify", "run", "clean"])
        res = json.loads(next(self.tmp.glob("result-*.json")).read_text()); self.assertTrue(res["parentUnchanged"]); self.assertTrue(res["cleanup"]["gone"])
        self.assertIn(D.FIX[1], self.calls[4][1]); self.assertIn("-Cfg 'C:\\ProgramData\\Enclave\\network\\privacy-config.json'", self.calls[4][1])
    def token(self): return json.loads(next(self.tmp.glob("attempt-*.json")).read_text())["token"]
    def test_mkdir_refusal_never_authorizes_a_deletion(self):
        self.clean = {"existed": True, "owned": False, "gone": False, "parentSddl": "P", "decision": "refused: not demonstrably created by this attempt"}
        self.fake(mk={"decision": "refused: stage exists"}); self.assertEqual(D.main(["--run"]), 3)
        self.assertEqual([c[0] for c in self.calls], ["parent", "mkdir", "clean"], "no upload/run after the refusal")
        t = self.calls[-1][1]; self.assertIn(self.token(), t); self.assertIn(".native-acl-owner", t); self.assertIn("ReparsePoint", t)
        self.assertLess(t.index("ReadAllText($mk) -eq"), t.index("Remove-Item -LiteralPath $d -Recurse"), "the marker is checked before any removal")
        self.assertIn(self.token(), self.calls[1][1], "the token is written by the mkdir that creates the stage")
    def test_verdict_requires_pass_gone_owned_and_parent_unchanged(self):
        for clean, why in (({"existed": True, "owned": True, "gone": False, "parentSddl": "P"}, "stage not gone"), ({"existed": True, "owned": True, "gone": True, "parentSddl": "CHANGED"}, "parent changed"),
                           ({"existed": False, "owned": False, "gone": True, "parentSddl": "P"}, "not proven ours")):
            self.calls.clear(); shutil.rmtree(self.tmp); self.tmp.mkdir(); D.OUT = self.tmp; self.clean = clean; self.fake(fix={"pass": True})
            self.assertEqual(D.main(["--run"]), 3, why); self.assertFalse(json.loads(next(self.tmp.glob("result-*.json")).read_text())["verdict"])
        self.calls.clear(); shutil.rmtree(self.tmp); self.tmp.mkdir(); D.OUT = self.tmp; self.clean = None; self.clean_raises = True; self.fake(fix={"pass": True})
        self.assertEqual(D.main(["--run"]), 3, "a cleanup that cannot be asked is a failure"); self.assertTrue(list(self.tmp.glob("result-*.json")))
    def test_fixture_failure_is_nonzero_and_still_cleans(self):
        self.fake(fix={"pass": False}); self.assertEqual(D.main(["--run"]), 3); self.assertEqual(self.calls[-1][0], "clean")
    def test_manual_cleanup_takes_an_attempt_receipt_only(self):
        self.fake()
        with self.assertRaises(Exception): D.main(["--cleanup", "C:\\ProgramData\\Enclave\\network"])
        a = self.tmp / "attempt-x.json"; a.write_text(json.dumps({"what": "attempt", "stage": "C:\\ProgramData\\Enclave\\network", "token": "0" * 32}))
        with self.assertRaises(SystemExit): D.main(["--cleanup", str(a)])
        self.assertEqual(self.calls, [], "nothing remote for a non-stage path")
    def test_node_is_the_proven_one(self):
        self.assertEqual(D.NODE, "C:\\Program Files\\nodejs\\node.exe"); self.assertEqual(D.NODE_SHA, "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3")
        self.fake(); D.main(["--run"]); run = [c for c in self.calls if c[0] == "run"][0][1]
        self.assertIn("-NodeExe 'C:\\Program Files\\nodejs\\node.exe' -NodeSha 'b3094d0b", run)
        self.assertIn("if ((Sha $NodeExe) -ne $NodeSha)", D.FIX[0].read_text(), "the fixture refuses any other node.exe")
    def test_clean_text_behaviour_in_pwsh(self):
        # the REAL CLEAN text, run by pwsh on scratch dirs (Get-Acl mocked: Linux has no NTFS ACL API)
        base = pathlib.Path(tempfile.mkdtemp()); tok = "a" * 32; out = {}
        try:
            for name, marker, link in (("ours", tok, False), ("other", "b" * 32, False), ("nomarker", None, False), ("link", tok, True)):
                d = base / name
                if link: real = base / "realtarget"; real.mkdir(); (real / ".native-acl-owner").write_text(tok); (real / "keep.txt").write_text("x"); d.symlink_to(real, target_is_directory=True)
                else:
                    d.mkdir(); (d / "f.txt").write_text("x")
                    if marker: (d / ".native-acl-owner").write_text(marker)
                text = "function Get-Acl { param($LiteralPath) [pscustomobject]@{ Sddl = 'P' } };function FileSha($f){'x'};" + D.CLEAN.replace("DX", "'" + str(d) + "'").replace("ROOTX", str(base)).replace("TOKENX", tok)
                r = REAL([PWSH, "-NoProfile", "-Command", text], capture_output=True, text=True, timeout=120); out[name] = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(out["ours"]["owned"] and out["ours"]["gone"])
            for n in ("other", "nomarker", "link"): self.assertFalse(out[n]["owned"], n); self.assertFalse(out[n]["gone"], n)
            self.assertTrue((base / "realtarget" / "keep.txt").exists(), "a reparse point is never followed")
        finally: shutil.rmtree(base)
    def test_clip_uses_the_sanitized_length(self):
        fx = D.FIX[0].read_text(); clip = next(l for l in fx.splitlines() if l.startswith("function Clip"))
        stage = "C:\\ProgramData\\Enclave\\staging\\native-acl-0123456789ab"
        text = "$Stage = '" + stage + "';" + clip + "\nClip ('Exception at ' + $Stage + '\\target.txt.nh-1234 refused')"
        r = REAL([PWSH, "-NoProfile", "-Command", text], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-300:]); self.assertEqual(r.stdout.strip(), "Exception at <stage>\\target.txt.nh-1234 refused")
if __name__ == "__main__": unittest.main()
