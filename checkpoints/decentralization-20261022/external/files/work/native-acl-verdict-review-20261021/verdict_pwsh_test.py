#!/usr/bin/env python3
"""Run the EXACT expectedRefusal line of the v2 fixture (21d2bcf1, the one root ran) and of the patched v3 fixture, plus the
fixture's own Left(), in PowerShell 7.4 (local; the native host is Windows PowerShell 5.1, where @($null).Count is also 1).
'inherited' is built exactly the way the fixture's catch path builds it: $c.leftovers = (Left $dir) over a REAL temp dir."""
import json, pathlib, re, subprocess, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; W = H.parent
OLD = W / "node-hold-acl-normalization-20261021/fixture-v2-pathfix/acl-fixture.ps1"; NEW = H / "fixture-v3/acl-fixture.ps1"
PWSH = str(W / "node-hold-package-20261021/tools/pwsh/pwsh")
def line(p, start):
    ls = [l for l in p.read_text().splitlines() if l.startswith(start)]; assert len(ls) == 1, (p, start); return ls[0]
LEFT = line(OLD, "function Left("); assert LEFT == line(NEW, "function Left(")
OLD_V, NEW_V = line(OLD, "$ih.expectedRefusal = "), line(NEW, "$ih.expectedRefusal = ")
ERR = "the temp file does not carry the config ACL"
SCEN = {  # name: (files in the case dir, error, exactEqual or 'MISSING', equalExceptAiFlag, probeGone, leftovers recorded?)
 "captured: no temp left (native shape)":     ([], ERR, False, True, True, True),
 "a non-temp file only (target.txt)":         (["target.txt"], ERR, False, True, True, True),
 "one REAL leftover temp":                    (["target.txt", "target.txt.nh-edit-1a2b3c4d"], ERR, False, True, True, True),
 "two leftover temps":                        (["target.txt.nh-edit-1a2b3c4d", "target.txt.nh-0badc0de"], ERR, False, True, True, True),
 "leftovers never recorded (key missing)":    ([], ERR, False, True, True, False),
 "wrong error":                               ([], "CAS refused: x", False, True, True, True),
 "exactEqual true":                           ([], ERR, True, True, True, True),
 "exactEqual missing":                        ([], ERR, "MISSING", True, True, True),
 "equalExceptAiFlag false":                   ([], ERR, False, False, True, True),
 "probe not gone":                            ([], ERR, False, True, False, True)}
def ps_bool(v): return "$true" if v else "$false"
def run():
    root = pathlib.Path(tempfile.mkdtemp()); body = ["$ErrorActionPreference = 'Stop'", LEFT, "$out = [ordered]@{}"]
    for i, (name, (files, err, exact, eai, gone, rec)) in enumerate(SCEN.items()):
        d = root / f"case{i}"; d.mkdir()
        for f in files: (d / f).write_text("x")
        body += [f"$dir = '{d}'; $ih = [ordered]@{{}}; $ih.error = '{err}'; $ih.probe = [ordered]@{{}}",
                 *([] if exact == "MISSING" else [f"$ih.probe.exactEqual = {ps_bool(exact)}"]),
                 f"$ih.probe.equalExceptAiFlag = {ps_bool(eai)}; $ih.probe.probeGone = {ps_bool(gone)}",
                 *(["$ih.leftovers = (Left $dir)"] if rec else []),
                 OLD_V, "$old = $ih.expectedRefusal", NEW_V, "$new = $ih.expectedRefusal",
                 f"$out['{name}'] = [ordered]@{{ old = $old; new = $new; leftoversIsNull = ($ih.Contains('leftovers') -and $null -eq $ih.leftovers) }}"]
    # the positive cases' own terms (unchanged): '-not $c.t3.leftovers.Count' on the same assignment; t2's hashtable-literal form
    e, o = root / "pos-empty", root / "pos-one"; e.mkdir(); o.mkdir(); (o / "t.nh-1").write_text("x")
    body += [f"$c = [ordered]@{{ t3 = [ordered]@{{}} }}; $c.t3.leftovers = (Left '{e}'); $out['positive term, no temp'] = -not $c.t3.leftovers.Count",
             f"$c.t3.leftovers = (Left '{o}'); $out['positive term, one temp'] = -not $c.t3.leftovers.Count",
             f"$out['t2 literal form as JSON'] = ([ordered]@{{ leftovers = (Left '{e}') }} | ConvertTo-Json -Compress)",
             "$out['@($null).Count'] = @($null).Count", "$out | ConvertTo-Json -Compress"]
    f = root / "verdict.ps1"; f.write_text("\n".join(body) + "\n")
    r = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(f)], capture_output=True, text=True, timeout=120)
    if r.returncode: raise AssertionError(r.stderr[-800:])
    return json.loads(r.stdout)
class Verdict(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.o = run(); print(json.dumps(cls.o, indent=1), file=sys.stderr)
    def test_bug_reproduced_and_fixed_on_the_captured_shape(self):
        c = self.o["captured: no temp left (native shape)"]
        self.assertEqual(c, {"old": False, "new": True, "leftoversIsNull": True}, "old line = the raw expectedRefusal false; the patched line accepts it")
        self.assertEqual(self.o["@($null).Count"], 1)
        self.assertEqual(self.o["a non-temp file only (target.txt)"], {"old": False, "new": True, "leftoversIsNull": True})
    def test_every_negative_stays_false_on_the_patched_line(self):
        for k in ("one REAL leftover temp", "two leftover temps", "leftovers never recorded (key missing)", "wrong error", "exactEqual true",
                  "exactEqual missing", "equalExceptAiFlag false", "probe not gone"):
            self.assertIs(self.o[k]["new"], False, k); self.assertIs(self.o[k]["old"], False, k)
    def test_positive_terms_were_already_right(self):
        self.assertIs(self.o["positive term, no temp"], True); self.assertIs(self.o["positive term, one temp"], False)
        # OBSERVED locally (pwsh 7.4): null. The native receipt (Windows PowerShell 5.1) shows {} for t2. That serializer
        # difference is NOT verified here; either way it is not a file name, and the positive terms count it as 0.
        self.assertEqual(self.o["t2 literal form as JSON"], '{"leftovers":null}')
    def test_patch_is_only_the_verdict_line(self):
        a, b = OLD.read_text().splitlines(), NEW.read_text().splitlines()
        i = a.index(OLD_V); self.assertEqual(a[:i], b[:i]); self.assertEqual(a[i + 1:], b[i + 3:]); self.assertTrue(b[i].startswith("# ") and b[i + 1].startswith("# ")); self.assertEqual(b[i + 2], NEW_V)
        self.assertIn("ProtectedTemp", NEW.read_text()); fn = (H / "fixture-v3/functions.ps1").read_bytes(); self.assertIn(fn, NEW.read_bytes(), "Sha/ProtectedTemp/CasWrite verbatim")
if __name__ == "__main__": unittest.main()
