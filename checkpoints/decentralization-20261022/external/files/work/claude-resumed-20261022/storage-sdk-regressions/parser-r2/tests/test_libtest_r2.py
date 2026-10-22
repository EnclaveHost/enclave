#!/usr/bin/env python3
"""parser-r2 tests: offline, no services.
  - The REAL redacted c2epos driver.log (fixtures/c2epos-driver.log fcc47434, a byte copy) must parse r2-PASS, while
    the pinned r1 parser (sdk_regression_runner.py 8138486d, loaded from its exact bytes) reports every case missing:
    the negative control for the bug.
  - Synthetic serial libtest outputs cover the inline, multiline and mixed formats, real failures, and every
    strictness rule.
  - reevaluate.py is tested on fake terminal run directories, never the live one."""
import hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; P = H.parent; S = P.parent
sys.path.insert(0, str(P)); import libtest_r2 as L  # noqa: E402
FIX = P / "fixtures" / "c2epos-driver.log"
CFG = json.loads((S / "config.json").read_text())
C2POS = next(g for g in CFG["groups"] if g["id"] == "c2epos")["cases"]
A, B = "real_indexd::case_a", "real_indexd::case_b"

def load_r1():
    data = (S / "sdk_regression_runner.py").read_bytes(); assert hashlib.sha256(data).hexdigest().startswith("8138486d")
    spec = importlib.util.spec_from_loader("r1", loader=None); m = importlib.util.module_from_spec(spec); m.__file__ = str(S / "sdk_regression_runner.py")
    exec(compile(data, "r1", "exec"), m.__dict__); return m

def out(*body, running=None, summary=None, n=2):
    lines = ["", f"running {n if running is None else running} tests", *body]
    if summary is not False: lines += ["", summary or "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"]
    return "\n".join(lines) + "\n"

class RealEvidence(unittest.TestCase):
    def test_fixture_is_the_byte_copy(self):
        self.assertEqual(hashlib.sha256(FIX.read_bytes()).hexdigest()[:16], "fcc47434f87b7ffb")

    def test_r1_negative_control_reports_all_missing(self):
        ok, d = load_r1().parse_libtest(FIX.read_text(), C2POS)
        self.assertFalse(ok); self.assertEqual(set(map(tuple, d["cases"].values())), {("missing",)})

    def test_r2_parses_the_real_nocapture_log(self):
        r = L.parse(FIX.read_text(), C2POS)
        self.assertTrue(r["ok"], r["errors"]); self.assertEqual(set(r["cases"].values()), {"ok"}); self.assertEqual(r["summary"], ["ok", 5, 0, 0])
        self.assertEqual(r["errors"], [])

    def test_real_log_mutations_fail(self):
        t = FIX.read_text()
        for what, mutated in (("one ok removed (unclosed)", t.replace("\nok\n", "\n", 1)),
                              ("summary count off", t.replace("5 passed", "4 passed")),
                              ("a case missing", t.replace(C2POS[2], "real_fencing::something_else")),
                              ("a duplicate stray ok", t.replace("\nok\n", "\nok\nok\n", 1))):
            with self.subTest(what): self.assertFalse(L.parse(mutated, C2POS)["ok"])

class Formats(unittest.TestCase):
    def test_inline_multiline_mixed(self):
        for body in ([f"test {A} ... ok", f"test {B} ... ok"],
                     [f"test {A} ... first output", "more", "ok", f"test {B} ... x", "ok"],
                     [f"test {A} ... ok", f"test {B} ... ", "line", "test {B} has been running for over 60 seconds", "ok"]):
            with self.subTest(body=body[:2]):
                r = L.parse(out(*body), [A, B]); self.assertTrue(r["ok"], r["errors"])

    def test_trailing_whitespace_on_outcome(self):
        self.assertTrue(L.parse(out(f"test {A} ... x", "ok   ", f"test {B} ... ok"), [A, B])["ok"])

    def test_real_failure_stays_failure(self):
        t = out(f"test {A} ... out", "thread 'real_indexd::case_a' panicked at src/x.rs:1:2:", "boom", "FAILED", f"test {B} ... ok", "",
                "failures:", "", "failures:", f"    {A}", summary="test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s")
        r = L.parse(t, [A, B]); self.assertFalse(r["ok"]); self.assertEqual(r["errors"], []); self.assertEqual(r["cases"][A], "FAILED"); self.assertEqual(r["failed"], [A])

    def test_failure_list_must_match(self):
        t = out(f"test {A} ... FAILED", f"test {B} ... ok", "", "failures:", "    real_indexd::other",
                summary="test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s")
        self.assertTrue(any("failures list" in e for e in L.parse(t, [A, B])["errors"]))

    def test_ignored_is_not_a_pass(self):
        r = L.parse(out(f"test {A} ... ignored", f"test {B} ... ok", summary="test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 9 filtered out; finished in 1.00s"), [A, B])
        self.assertFalse(r["ok"]); self.assertEqual(r["errors"], []); self.assertEqual(r["cases"][A], "ignored")

class Strictness(unittest.TestCase):
    def assertFails(self, text, want, cases=(A, B)):
        r = L.parse(text, list(cases)); self.assertFalse(r["ok"], r); self.assertTrue(any(want in e for e in r["errors"]), r["errors"])

    def test_missing_duplicate_unexpected(self):
        self.assertFails(out(f"test {A} ... ok", running=1, summary="test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"), "missing")
        self.assertFails(out(f"test {A} ... ok", f"test {A} ... ok", f"test {B} ... ok", summary="test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"), "reported 2 times")
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", "test real_indexd::extra ... ok", summary="test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"), "unexpected")

    def test_unclosed(self):
        self.assertFails(out(f"test {A} ... out", f"test {B} ... ok"), "still open")                      # next header while open
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... out", "more"), "still open")             # summary while open
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... out", summary=False), "still open")      # EOF while open

    def test_stray_terminal(self):
        self.assertFails(out("ok", f"test {A} ... ok", f"test {B} ... ok"), "stray terminal")
        self.assertFails(out(f"test {A} ... ok", "FAILED", f"test {B} ... ok"), "stray terminal")

    def test_output_line_that_is_exactly_ok_cannot_pass(self):
        # documented limit: an early close yields a stray terminal, so the result is a false FAIL, never a false PASS
        self.assertFails(out(f"test {A} ... out", "ok", "more output", "ok", f"test {B} ... ok"), "stray terminal")

    def test_outcome_glued_to_output_cannot_pass(self):
        self.assertFails(out(f"test {A} ... out", "textok", f"test {B} ... ok"), "still open")

    def test_aggregate_alone_is_not_enough(self):
        self.assertFails(out(), "missing")                                   # summary "2 passed" with no case lines
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", summary="test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"), "summary says")
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", summary="test result: FAILED. 2 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"), "summary status")

    def test_summary_and_running_cardinality(self):
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", summary=False), "test result:")
        two = out(f"test {A} ... ok", f"test {B} ... ok") + "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s\n"
        self.assertFails(two, "`test result:` lines")
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", running=3), "running 3 tests")
        self.assertFails("\n".join([f"test {A} ... ok", f"test {B} ... ok", "", "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.00s"]), "running")
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok") + f"test {A} ... ok\n", "after the summary")

    def test_failures_section_without_failure(self):
        self.assertFails(out(f"test {A} ... ok", f"test {B} ... ok", "", "failures:", f"    {A}"), "no FAILED case")

class Reevaluate(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="parser-r2-test-")); self.run = self.t / "x-results"; self.run.mkdir()
        self.groups = {}
        for g in CFG["groups"]:
            d = self.run / g["id"]; d.mkdir()
            lines = []
            for c in g["cases"]: lines += [f"test {c} ... [sia-s3] output", "EVIDENCE x {}", "ok"]
            (d / "driver.log").write_text(out(*lines, running=len(g["cases"]), summary=f"test result: ok. {len(g['cases'])} passed; 0 failed; 0 ignored; 0 measured; 100 filtered out; finished in 1.00s"))
            (self.run / f"{g['id']}.out").write_text("GROUP-RESULT driver=0 harness=0\n")
            self.groups[g["id"]] = {"verdict": "FAIL", "groupReturnCode": 0, "harnessExit": "0", "cases": {c: ["missing"] for c in g["cases"]}}
        self.write_summary()
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def write_summary(self): (self.run / "summary.json").write_text(json.dumps({"runId": "x", "groups": self.groups, "cleanup": {"confirmed": True}}))
    def reeval(self, out_name="re.json", run=None):
        return subprocess.run([sys.executable, "-B", str(P / "reevaluate.py"), "--run-dir", str(run or self.run), "--config", str(S / "config.json"), "--out", str(self.t / out_name)],
                              capture_output=True, text=True, timeout=60)

    def test_corrects_r1_false_fail_without_touching_inputs(self):
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.run.rglob("*") if p.is_file()}
        r = self.reeval(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = json.loads((self.t / "re.json").read_text())
        self.assertIn("NO test was re-run", res["kind"]); self.assertTrue(res["correctedAllPass"])
        for gid, g in res["groups"].items():
            self.assertEqual((g["original"]["verdict"], g["corrected"]), ("FAIL", "PASS"), gid); self.assertIn(f"{gid}/driver.log", g["inputs"])
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.run.rglob("*") if p.is_file()}, "raw evidence unchanged")

    def test_real_failures_and_incomplete_stay(self):
        self.groups["c2efence"].update(groupReturnCode=101)                                  # real driver failure
        (self.run / "c2efence.out").write_text("GROUP-RESULT driver=101 harness=0\n")
        self.groups["fefence"].update(harnessExit="2"); (self.run / "fefence.out").write_text("GROUP-RESULT driver=0 harness=2\n")
        self.groups["feindexd"] = {"verdict": "NOT_RUN", "reason": "previous group ended uncertainly"}
        (self.run / "c2eindexd.out").write_text("")                                         # no full result
        self.groups["c2eblock"].update(groupReturnCode="outer-timeout"); (self.run / "c2eblock.out").write_text("")
        self.write_summary()
        r = self.reeval(); self.assertEqual(r.returncode, 1); g = json.loads((self.t / "re.json").read_text())["groups"]
        self.assertEqual(g["c2efence"]["corrected"], "FAIL"); self.assertEqual(g["fefence"]["corrected"], "FAIL")
        self.assertEqual(g["feindexd"]["corrected"], "NOT_RUN"); self.assertEqual(g["c2eindexd"]["corrected"], "INCOMPLETE"); self.assertEqual(g["c2eblock"]["corrected"], "INCOMPLETE")
        self.assertEqual(g["c2epos"]["corrected"], "PASS")

    def test_rc_disagreement_and_bad_log_fail(self):
        (self.run / "c2epos.out").write_text("GROUP-RESULT driver=101 harness=0\n")               # recorded rc 0 but script said 101
        (self.run / "fec2neg" / "driver.log").write_text((self.run / "fec2neg" / "driver.log").read_text().replace("\nok\n", "\n", 1))
        r = self.reeval(); g = json.loads((self.t / "re.json").read_text())["groups"]
        self.assertEqual(g["c2epos"]["corrected"], "FAIL"); self.assertTrue(any("disagrees" in x for x in g["c2epos"]["reasons"]))
        self.assertEqual(g["fec2neg"]["corrected"], "FAIL"); self.assertTrue(any("still open" in x for x in g["fec2neg"]["reasons"]))

    def test_refusals(self):
        (self.run / "summary.json").unlink(); r = self.reeval(); self.assertEqual(r.returncode, 2); self.assertIn("not terminal", r.stdout)
        self.write_summary()
        r = subprocess.run([sys.executable, "-B", str(P / "reevaluate.py"), "--run-dir", str(self.run), "--config", str(S / "config.json"), "--out", str(self.run / "re.json")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2); self.assertIn("outside the run directory", r.stdout)
        (self.t / "exists.json").write_text("x"); self.assertNotEqual(self.reeval("exists.json").returncode, 0); self.assertEqual((self.t / "exists.json").read_text(), "x")
        bad = self.t / "cfg.json"; bad.write_text((S / "config.json").read_text() + " ")
        r = subprocess.run([sys.executable, "-B", str(P / "reevaluate.py"), "--run-dir", str(self.run), "--config", str(bad), "--out", str(self.t / "y.json")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2); self.assertIn("root-reviewed", r.stdout)

if __name__ == "__main__": unittest.main()
