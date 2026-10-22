#!/usr/bin/env python3
"""Negative controls for adjudicate.py: every mutation of the CAPTURED native receipt that breaks a v2 criterion, or removes
a field, must NOT yield PASS. The raw receipt itself must yield PASS with its raw verdict false preserved."""
import copy, hashlib, importlib.util, json, pathlib, subprocess, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location("adj", H / "adjudicate.py"); A = importlib.util.module_from_spec(s); s.loader.exec_module(A)
RP, AP = H / "raw/result-20261021T231019Z.json", H / "raw/attempt-20261021T231019Z.json"
RAW_SHA = {"result": "c5c7bb2a7341c66424e16fedaa3989ce5c4ed6cd9593d274895a4f06c55583cf", "attempt": "36822f9d56de139737b9d4e47feeee9b15e9603a4b828d6d451cebe0a1d85026"}
RES, ATT = json.loads(RP.read_bytes()), json.loads(AP.read_bytes())
IH = ("fixture_result", "cases", "inherited")
def at(d, path):
    for k in path[:-1]: d = d[k]
    return d, path[-1]
def mutate(path, value=None, delete=False, att=False):
    r, a = copy.deepcopy(RES), copy.deepcopy(ATT); d, k = at(a if att else r, path)
    if delete: del d[k]
    else: d[k] = value
    return A.adjudicate(r, a)["verdict"]
class Captured(unittest.TestCase):
    def test_raw_bytes_are_the_native_receipt(self):
        self.assertEqual(hashlib.sha256(RP.read_bytes()).hexdigest(), RAW_SHA["result"]); self.assertEqual(hashlib.sha256(AP.read_bytes()).hexdigest(), RAW_SHA["attempt"])
        live = H.parent / "node-hold-acl-normalization-20261021/fixture-v2-pathfix/runs"
        self.assertEqual(hashlib.sha256((live / RP.name).read_bytes()).hexdigest(), RAW_SHA["result"], "root's receipt is untouched")
    def test_captured_evidence_passes_and_raw_false_is_preserved(self):
        a = A.adjudicate(copy.deepcopy(RES), copy.deepcopy(ATT)); self.assertEqual(a["verdict"], "PASS", [c for c in a["checks"] if c["ok"] is not True])
        self.assertEqual(a["raw"], {"verdict": False, "fixturePass": False, "inheritedExpectedRefusal": False, "originalExpressionUnderPowerShellSemantics": False, "reproducesRawExpectedRefusal": True})
        self.assertIsNone(RES["fixture_result"]["cases"]["inherited"]["leftovers"]); self.assertIn("leftovers", RES["fixture_result"]["cases"]["inherited"])
    def test_cli_writes_a_labelled_derived_receipt_once(self):
        d = pathlib.Path(tempfile.mkdtemp()) / "derived.json"
        r = subprocess.run([sys.executable, str(H / "adjudicate.py"), str(RP), str(AP), "--out", str(d)], capture_output=True, text=True); self.assertEqual(r.returncode, 0, r.stderr)
        rec = json.loads(d.read_text()); self.assertTrue(rec["what"].startswith("CORRECTED ADJUDICATION")); self.assertIn("NOT a native result", rec["what"])
        self.assertEqual(rec["rawVerdictPreserved"]["verdict"], False); self.assertEqual(rec["rawResult"]["sha256"], RAW_SHA["result"]); self.assertEqual(rec["correctedVerdict"], "PASS")
        r2 = subprocess.run([sys.executable, str(H / "adjudicate.py"), str(RP), str(AP), "--out", str(d)], capture_output=True, text=True); self.assertNotEqual(r2.returncode, 0, "never overwrites")
        self.assertEqual(hashlib.sha256(RP.read_bytes()).hexdigest(), RAW_SHA["result"], "the raw receipt is only read")
class NegativeControls(unittest.TestCase):
    def no_pass(self, v, why): self.assertNotEqual(v, "PASS", why)
    def test_leftovers(self):
        self.assertEqual(mutate(IH + ("leftovers",), "target.txt.nh-edit-1a2b3c4d"), "FAIL", "a REAL leftover name (one name = a string)")
        self.assertEqual(mutate(IH + ("leftovers",), ["target.txt.nh-edit-1a2b3c4d", "target.txt.nh-0badc0de"]), "FAIL", "two names")
        self.assertEqual(mutate(IH + ("leftovers",), delete=True), "UNKNOWN", "missing key: Left's output not recorded -> never accepted")
        self.assertEqual(mutate(IH + ("leftovers",), 5), "UNKNOWN"); self.assertEqual(mutate(IH + ("leftovers",), [1]), "UNKNOWN")
    def test_error(self):
        self.assertEqual(mutate(IH + ("error",), "CAS refused: <stage>\\inherited\\target.txt is not the expected sha"), "FAIL", "wrong error")
        self.assertEqual(mutate(IH + ("error",), "the temp file does not carry the config ACL "), "FAIL", "not exact")
        self.no_pass(mutate(IH + ("error",), delete=True), "no error recorded")
        self.assertEqual(mutate(IH + ("pass",), True), "FAIL", "the inherited form must not pass")
    def test_sddl_relation(self):
        t = RES["fixture_result"]["cases"]["inherited"]["probe"]["targetSddl"]
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t), "FAIL", "temp == target: no refusal cause")
        self.assertEqual(mutate(IH + ("probe", "exactEqual"), True), "FAIL")
        self.no_pass(mutate(IH + ("probe", "exactEqual"), delete=True), "exactEqual missing")
        self.assertEqual(mutate(IH + ("probe", "exactEqual"), "false"), "UNKNOWN", "a string is not a boolean")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t.replace("D:(", "D:PAI(")), "FAIL", "flags differ by MORE than AI")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t.replace("D:(", "D:AR(")), "FAIL", "a different flag, not AI")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t.replace("D:(", "D:AI(").replace("(A;ID;FA;;;BA)", "(A;ID;FA;;;BU)")), "FAIL", "an ACE changed")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t.replace("D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)", "D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)")), "FAIL", "ACE order changed")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), t.replace("O:BA", "O:SY").replace("D:(", "D:AI(")), "FAIL", "owner changed")
        r = copy.deepcopy(RES); p = r["fixture_result"]["cases"]["inherited"]["probe"]; p["targetSddl"] = p["tempAfterSetAcl"]
        self.assertEqual(A.adjudicate(r, ATT)["verdict"], "FAIL", "a target that already carries AI is not the failing form")
        self.assertEqual(mutate(IH + ("probe", "equalExceptAiFlag"), False), "FAIL")
        self.assertEqual(mutate(IH + ("probe", "tempAfterSetAcl"), "garbage"), "UNKNOWN")
        self.assertEqual(mutate(IH + ("probe", "probeGone"), False), "FAIL", "probe left behind")
    def test_any_positive_case_failure(self):
        for n in A.POSITIVE:
            C = ("fixture_result", "cases", n)
            for path, val in ((("pass",), False), (("t1", "gone"), False), (("t1", "lengthAtReturn"), 3), (("t1", "nodeRc"), 1), (("t2", "bytesExact"), False),
                              (("t2", "leftovers"), "target.txt.nh-1a2b3c4d"), (("t3", "leftovers"), ["x.nh-1"]), (("t4", "sddlEqual"), False), (("t5", "leftovers"), "y.nh-2"),
                              (("probe", "probeGone"), False), (("probe", "tempAfterSetAcl"), "O:BAG:BAD:AI(A;ID;FA;;;SY)"), (("error",), "boom")):
                self.assertEqual(mutate(C + path, val), "FAIL", (n, path, val))
            self.assertEqual(mutate(C + ("t3", "threw"), delete=True), "UNKNOWN", n); self.no_pass(mutate(C, delete=True), n + " missing")
        self.assertEqual(mutate(("fixture_result", "cases", "ai-parent", "target", "sddl"), RES["fixture_result"]["cases"]["inherited"]["target"]["sddl"]), "FAIL", "ai-parent target without AI")
    def test_cleanup_and_parent(self):
        self.assertEqual(mutate(("cleanup", "gone"), False), "FAIL", "stage not gone"); self.assertEqual(mutate(("cleanup", "owned"), False), "FAIL")
        self.assertEqual(mutate(("cleanup", "reparse"), True), "FAIL"); self.assertEqual(mutate(("cleanup",), delete=True), "UNKNOWN")
        self.assertEqual(mutate(("cleanup", "parentSddl"), RES["parentBefore"]["sddl"].replace("D:AI", "D:PAI")), "FAIL", "parent changed")
        self.assertEqual(mutate(("parentUnchanged",), False), "FAIL"); self.assertEqual(mutate(("parentBefore",), delete=True), "UNKNOWN")
    def test_pins_and_receipts(self):
        self.assertEqual(mutate(("fixture",), "0" * 64), "FAIL"); self.assertEqual(mutate(("verify", "sha"), "0" * 64), "FAIL")
        self.assertEqual(mutate(("stage",), "C:\\ProgramData\\Enclave\\staging\\native-acl-000000000000", att=True), "FAIL", "attempt/result stage mismatch")
        self.assertEqual(mutate(("fixture_result", "node"), "1" * 64), "FAIL"); self.assertEqual(mutate(("mkdir", "foreignRules"), 1), "FAIL")
        self.no_pass(mutate(("fixture_result",), delete=True), "no fixture output")
if __name__ == "__main__": unittest.main()
