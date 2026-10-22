#!/usr/bin/env python3
"""The native-parse step (postflight.parse_text) and the default P0 recipe (run-postflight.py --pre): the exact text is parsed,
never run, by the host's PowerShell; only a clean parse with the same sha256 lets P0 execute. pwsh 7 (Linux) here, not 5.1."""
import base64, copy, gzip, hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; W = H.parents[2]
spec = importlib.util.spec_from_file_location("pf", H / "postflight.py"); P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
PWSH = os.environ.get("PWSH", str(W / "node-hold-package-20261021/tools/pwsh/pwsh"))
R = "0x" + "2f" * 32; IDS = ["0x" + f"{i + 1:02x}" * 32 for i in range(9)]
RECEIPT = {"params": {"runId": "r", "runner": R, "expectedIds": IDS, "cfgSha": "1" * 64},
           "journal": {"lines": [json.dumps({"step": "pins", "nodeLogOffset": 10}), json.dumps({"step": "privacy-restart", "newPid": 30716, "newStart": "2026-10-22T03:00:00.0000000Z"}),
                                 json.dumps({"step": "start-node", "agent": {"pid": 8888, "start": "2026-10-22T03:01:00.0000000Z"}, "channelGeneration": "ab" * 16}), json.dumps({"final": "DONE: x"})]}}
def all_texts():
    ts = P.post_texts(RECEIPT); ts["logs"] = ts["logs"]({"networkLog": 5}); ts["p0"] = (P.fill(P.P0), 60); return ts

class Parse(unittest.TestCase):
    def test_wrappers_fit_and_are_read_only(self):
        m = P.head()
        for k, (t, s) in all_texts().items():
            w = P.parse_text(t); self.assertLessEqual(P.enc_len(m.HEAD, w, 60), P.LIMIT, k)
            self.assertEqual(gzip.decompress(base64.b64decode(re.search(r"FromBase64String\('([^']+)'\)", w).group(1))).decode(), t, "carries the exact text")
            for bad in ("Invoke-Expression", "iex ", "[scriptblock]::Create", "& (", "Invoke-Command", "Set-", "Remove-", "Start-Process"):
                self.assertNotIn(bad, w, (k, bad))
    @unittest.skipUnless(pathlib.Path(PWSH).exists(), "no pwsh")
    def test_pwsh_parses_every_exact_text_without_running_it(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        try:
            marker = tmp / "ran"
            cases = {k: t for k, (t, _) in all_texts().items()}
            cases["broken"] = "$x = @{ a = 1 ; foreach("                                  # a syntax error
            cases["side-effect"] = f"Set-Content -LiteralPath '{marker}' -Value ran"           # parses, and would write if RUN
            for k, t in cases.items():
                f = tmp / "w.ps1"; f.write_text(P.parse_text(t))
                r = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(f)], capture_output=True, text=True, timeout=120)
                self.assertEqual(r.returncode, 0, r.stderr[-800:]); out = json.loads(r.stdout.strip().splitlines()[-1])
                with self.subTest(k):
                    if k == "broken": self.assertGreater(out["errors"], 0); self.assertFalse(P.parsed_ok(out, t))
                    else: self.assertTrue(P.parsed_ok(out, t), out)
            self.assertFalse(marker.exists(), "parsing never executes the text")
        finally: shutil.rmtree(tmp)

class PreRecipe(unittest.TestCase):
    """run-postflight.py --pre with a FAKE transport: parse first; a refused parse never executes P0."""
    def run_pre(self, parse_answer, p0_answer):
        spec = importlib.util.spec_from_file_location("rp", H / "run-postflight.py"); RP = importlib.util.module_from_spec(spec); spec.loader.exec_module(RP)
        real = P.head(); sent = []
        class M: HEAD = real.HEAD
        def ps(text, secs=150):
            sent.append(text)
            if "what='parse'" in text:
                inner = gzip.decompress(base64.b64decode(re.search(r"FromBase64String\('([^']+)'\)", text).group(1))).decode()
                return parse_answer(inner)
            return copy.deepcopy(p0_answer)
        M.ps = staticmethod(ps); RP.P.head = lambda: M
        tmp = pathlib.Path(tempfile.mkdtemp()); RP.OUT = tmp
        try: rc = RP.main(["--pre"]); return rc, sent, sorted(x.name.rsplit("-", 1)[0] for x in tmp.iterdir())
        finally: shutil.rmtree(tmp)
    GOOD_P0 = {"what": "p0", "nodeLog": 100, "networkLog": 50, "blocks": {"present": True, "cfgSha": "1" * 64, "keys": ["relay"], **{k: "absent" for k in P.BLOCKS}}}
    def test_clean_parse_then_execute(self):
        rc, sent, files = self.run_pre(lambda t: {"what": "parse", "sha256": hashlib.sha256(t.encode()).hexdigest(), "chars": len(t), "errors": 0, "ids": []}, self.GOOD_P0)
        self.assertEqual((rc, len(sent), files), (0, 2, ["p0"]))
        self.assertIn("what='p0'", sent[1]); self.assertIn("what='parse'", sent[0])
    def test_parse_errors_or_wrong_sha_refuse_without_executing(self):
        for name, ans in (("errors", lambda t: {"what": "parse", "sha256": hashlib.sha256(t.encode()).hexdigest(), "errors": 1, "ids": ["MissingEndCurlyBrace"]}),
                          ("sha", lambda t: {"what": "parse", "sha256": "0" * 64, "errors": 0}), ("transport", lambda t: {"error": "ssh rc 255"})):
            with self.subTest(name):
                rc, sent, files = self.run_pre(ans, self.GOOD_P0)
                self.assertEqual((rc, len(sent), files), (3, 1, ["p0-parse-refused"]), "P0 is never sent after a refused parse")
    def test_unreadable_config_p0_is_flagged_not_a_baseline(self):
        bad = copy.deepcopy(self.GOOD_P0); bad["blocks"].update(present=False, keys=[])
        rc, sent, files = self.run_pre(lambda t: {"what": "parse", "sha256": hashlib.sha256(t.encode()).hexdigest(), "errors": 0}, bad)
        self.assertEqual((rc, files), (3, ["p0"]), "saved for the record, but the recipe exits non-zero")
if __name__ == "__main__": unittest.main()
