class RcOnlyAndPins(unittest.TestCase):     # platform-carrier round 4
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="rpa-rc-")); R.OUT = self.tmp; CALLS.clear()
    def tearDown(self): R.EXPECT.update(local=R.LOCAL_NOW, runNode=R.RUN_NODE_NOW)
    def files(self, pre_extra=None):
        st = self.tmp / "stage.json"; st.write_text(json.dumps({"what": "stage", "at": R.now(), "stage": "S", "ok": True}))
        p = good_pre(at=R.now()); (pre_extra or (lambda x: None))(p)
        pre = self.tmp / "pre.json"; pre.write_text(json.dumps({"what": "preflight", "at": R.now(), **p}))
        g = self.tmp / "gate.json"; g.write_text(json.dumps({**good_gate(), "at": R.now()})); return str(st), str(pre), str(g)
    def test_only_rc_is_offered(self):
        st, pre, g = self.files()
        for opt in ("P", "R", "PC"):
            with self.subTest(opt): self.assertEqual(R.main(["--activate", "--option", opt, "--stage-receipt", st, "--preflight", pre, "--gate-receipt", g]), 2)
        self.assertEqual(list(self.tmp.glob("attempt-*")), []); self.assertFalse([c for c in CALLS if "Register-ScheduledTask" in c])
        self.assertEqual(R.gate_opts(("RC",))[1].count("@('"), 1); self.assertIn("@('RC',$R4,$C)", R.gate_opts(("RC",))[1])
    def test_post_migration_pins_are_exact_and_explicit(self):
        moved = lambda p: p["configs"]["node-config.local.cmd"].update(sha="d" * 64)
        self.assertTrue(any("node-config.local.cmd" in x for x in R.refusals((lambda p: (moved(p), p)[1])(good_pre()), "activate", good_gate(), "RC")))
        R.EXPECT["local"] = "d" * 64
        self.assertFalse(any("node-config.local.cmd is not" in x for x in R.refusals((lambda p: (moved(p), p)[1])(good_pre()), "activate", good_gate(), "RC")))
        st, pre, g = self.files(moved)
        with self.assertRaises(SystemExit): R.main(["--activate", "--option", "RC", "--expect-local", "D" * 64, "--stage-receipt", st, "--preflight", pre, "--gate-receipt", g])
