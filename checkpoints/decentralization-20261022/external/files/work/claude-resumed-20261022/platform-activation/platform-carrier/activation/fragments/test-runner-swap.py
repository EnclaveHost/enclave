class SwapPath(unittest.TestCase):     # platform-carrier D1
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="rpa-swap-")); R.OUT = self.tmp; CALLS.clear()
        R.subprocess = types.SimpleNamespace(run=lambda a, **k: types.SimpleNamespace(returncode=0, stderr=""))
    def tearDown(self): R.subprocess = subprocess
    def stage(self, full=True):
        s = r"C:\ProgramData\Enclave\staging\policyact-0123456789ab"; v = {s + "\\node-policy-activation.ps1": "x"}
        if full: v.update({s + "\\bundle-swap.ps1": R.SWAP[1], s + "\\" + R.CAND_NAME: R.BUNDLE_SHA})
        p = self.tmp / "stage.json"; p.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": s, "ok": True, "verify": v})); return str(p)
    def test_pins_and_params(self):
        self.assertEqual(R.SWAP[1], "21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103"); self.assertEqual(R.BUNDLE_SHA, sha(R.CAND_FILE.read_bytes()))
        self.assertEqual(R.BUNDLE_SHA, "40e8ba71d83c627e85af21d58b9ab0d8b3052504a0e7d9ee47b429948c40bd25")
        a = R.swap_params("S", "apply"); self.assertEqual((a["OldSha"], a["NewSha"], a["Target"]), (R.LIVE_BUNDLE_SHA, R.BUNDLE_SHA, R.BUNDLE))
        b = R.swap_params("S", "rollback"); self.assertEqual((b["OldSha"], b["ExpectCurrent"]), (R.LIVE_BUNDLE_SHA, R.BUNDLE_SHA)); self.assertNotIn("NewFile", b)
    def test_apply_runs_the_pinned_script_once(self):
        global FAKE
        FAKE = lambda s: {"decision": "applied (no effect until the coordinated node restart)"} if "bundle-swap.ps1" in s else {"error": "unexpected"}
        st = self.stage(); self.assertEqual(R.main(["--swap-bundle", "--stage-receipt", st]), 0)
        call = next(c for c in CALLS if "bundle-swap.ps1" in c)
        for frag in ("21d85c69b2b70564cc04f7ea7d72e9f763ef8ae65059fdb9972f0413f042b103", "Mode='apply'", "OldSha='" + R.LIVE_BUNDLE_SHA + "'", "NewSha='" + R.BUNDLE_SHA + "'"): self.assertIn(frag, call)
        n = len(CALLS); self.assertEqual(R.main(["--swap-bundle", "--stage-receipt", st]), 4); self.assertEqual(len(CALLS), n, "an attempt is never retried")
    def test_refused_outcomes_and_stage_without_files(self):
        global FAKE
        FAKE = lambda s: {"decision": "refused: CAS (the target is not -OldSha)"}
        self.assertEqual(R.main(["--swap-inspect", "--stage-receipt", self.stage()]), 3)
        with self.assertRaises(SystemExit): R.main(["--swap-back", "--stage-receipt", self.stage(full=False)])
