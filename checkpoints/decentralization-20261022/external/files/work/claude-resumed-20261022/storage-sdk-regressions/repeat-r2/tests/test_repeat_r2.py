#!/usr/bin/env python3
"""repeat-r2 helper tests: FAKE docker only (tests/fake_docker_r2.py). No harness, driver, PostgreSQL, Docker, build or
network. The real config-r2.json groups and the real r2 case-group.sh hash are used; the binary pins are tiny
stand-ins, as in the r1 helper tests."""
import copy, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; PKG = H.parent; S = PKG.parent
RUNNER = PKG / "runner_r2.py"
REAL = json.loads((PKG / "config-r2.json").read_text()); BASECFG = json.loads((S / "config.json").read_text())
IMAGE = "sha256:" + "7" * 64
SHA = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
UNRELATED = "a" * 64
DRIVER_CASES = sorted({x for g in BASECFG["groups"] for x in g["cases"]})
BOOT = "real_indexd::real_bootstrap_after_an_acknowledged_but_unpublished_pin"

class Base(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="repeat-r2-test-")); t = self.t
        (t / "bin").mkdir(); fake = t / "bin" / "docker"
        fake.write_text(f"#!/bin/sh\nexec {sys.executable} {H / 'fake_docker_r2.py'} \"$@\"\n"); fake.chmod(0o755)
        cfg = copy.deepcopy(REAL); cfg["docker"] = str(fake); cfg["imageId"] = IMAGE
        cfg["timeouts"] = {"create": 3, "ready": 2, "harnessReady": 2, "groupInner": 2, "groupOuter": 4}
        for k in cfg["harnesses"]:
            p = t / f"harness-{k}"; p.write_text(f"fake harness {k}\n"); cfg["harnesses"][k].update(path=str(p), sha256=SHA(p))
        drv = t / "driver"; drv.write_text("fake driver\n"); man = t / "SNAPSHOT.sha256"; man.write_text("x\n")
        log = t / "sdkbuild4.out"; log.write_text(f"{SHA(drv)}  x\n")
        cfg["driver"].update(path=str(drv), sha256=SHA(drv), snapshotManifest=str(man), snapshotManifestSha256=SHA(man), buildLog=str(log), buildLogSha256=SHA(log))
        geo = t / "geo.mmdb"; geo.write_text("geo\n"); cfg["geoip"] = {"path": str(geo), "sha256": SHA(geo)}
        snaps = []
        for n in ("fence-enclave", "c2-enclave"):
            s = t / "snap" / n; s.mkdir(parents=True); (s / "a.go").write_text(n); inv = t / f"{n}.sha256"; inv.write_text(f"{SHA(s / 'a.go')}  ./a.go\n")
            snaps.append({"name": n, "snapshot": str(s), "pinnedInventory": str(inv), "pinnedInventorySha256": SHA(inv), "overrides": {}})
        cfg["snapshots"] = snaps; self.cfg = cfg
        self.cfgdir = t / "pkg"; self.cfgdir.mkdir(); self.write_cfg()
        (t / "driver-list.json").write_text(json.dumps(DRIVER_CASES))
        self.state, self.log = t / "state.json", t / "calls.log"
        self.state.write_text(json.dumps({"containers": {UNRELATED: {"name": "scsdk2-other", "labels": {"enclave.test.run": "other"}, "image": IMAGE, "mounts": [],
                                          "running": True, "memory": "64m", "cpus": "1", "cpuset": "0", "ro": False}}, "volumes": ["b" * 64]}))
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def write_cfg(self): (self.cfgdir / "config.json").write_text(json.dumps(self.cfg))
    def runr(self, *a, sc=""):
        env = dict(os.environ, FAKE_DOCKER_STATE=str(self.state), FAKE_DOCKER_LOG=str(self.log), FAKE_DOCKER_SCENARIO=sc, FAKE_DOCKER_IMAGE=IMAGE, FAKE_DRIVER_LIST=str(self.t / "driver-list.json"))
        return subprocess.run([sys.executable, "-B", str(RUNNER), "--config", str(self.cfgdir / "config.json"), *a], env=env, capture_output=True, text=True, timeout=120)
    def summary(self, p): return json.loads(p.stdout[p.stdout.index("{"):])
    def calls(self): return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []
    def execs(self): return [c for c in self.calls() if c[0] == "exec" and "/tools/case-group.sh" in c]
    def env_of(self, c): return dict(e.split("=", 1) for e in [c[i + 1] for i, x in enumerate(c[:-1]) if x == "-e"])
    def results(self): return next((self.cfgdir / "runs").glob("*-results"))

class Plan(unittest.TestCase):
    def test_config_r2_scope_and_pins(self):
        ids = [g["id"] for g in REAL["groups"]]; self.assertEqual(ids, ["c2eidxu1", "c2eidxfeed", "feidxu1"])
        self.assertEqual({g["id"]: (g["harness"], g["mode"], g["hosts"]) for g in REAL["groups"]}, {"c2eidxu1": ("c2e", "u1", 14), "c2eidxfeed": ("c2e", "v060", 14), "feidxu1": ("fe", "u1", 14)})
        idx7 = next(g for g in BASECFG["groups"] if g["id"] == "c2eindexd")["cases"]
        self.assertEqual(REAL["groups"][0]["cases"], idx7); self.assertEqual(REAL["groups"][2]["cases"], idx7)
        self.assertEqual(REAL["groups"][1]["cases"], [x for x in idx7 if x != BOOT], "only the stock-only bootstrap case is excluded, and only in feed mode")
        for k in ("baseRunner", "imageId", "harnesses", "driver", "geoip", "snapshots", "limits", "timeouts", "docker"):
            self.assertEqual(REAL[k], BASECFG[k], k)                    # every pin identical to the run root executed
        self.assertEqual(REAL["caseGroupSha256"], SHA(PKG / "case-group.sh"))

    def test_case_group_rejects_bad_hosts_before_anything(self):
        for h in ("", "11", "21", "14x", "1 4"):
            with self.subTest(h=h):
                p = subprocess.run(["bash", str(PKG / "case-group.sh")], env={"PATH": "/usr/bin:/bin", "HOSTS": h}, capture_output=True, text=True, timeout=10)
                self.assertEqual(p.returncode, 4); self.assertIn("not 12..20", p.stdout)
        diff = subprocess.run(["diff", str(S / "case-group.sh"), str(PKG / "case-group.sh")], capture_output=True, text=True).stdout
        changed = [l for l in diff.splitlines() if l.startswith(("<", ">")) and not l.startswith("> #")]
        self.assertEqual(len([l for l in changed if l.startswith("<")]), 2, diff)   # env comment + the -hosts line
        self.assertTrue(any('-hosts "$HOSTS"' in l for l in changed))

class Runs(Base):
    def test_happy_path_nocapture_format(self):
        p = self.runr("--run"); s = self.summary(p)
        self.assertEqual(p.returncode, 0, p.stdout[-2500:] + p.stderr[-1500:])
        self.assertEqual([self.env_of(c)["GROUP"] for c in self.execs()], ["c2eidxu1", "c2eidxfeed", "feidxu1"])
        for c in self.execs():
            e = self.env_of(c); self.assertEqual(e["HOSTS"], "14"); self.assertEqual(e["MODE"], {"c2eidxu1": "u1", "c2eidxfeed": "v060", "feidxu1": "u1"}[e["GROUP"]])
        for g in REAL["groups"]:
            r = s["groups"][g["id"]]; self.assertEqual((r["verdict"], r["groupReturnCode"]), ("PASS", 0), g["id"]); self.assertEqual(r["parserErrors"], [])
            self.assertEqual(set(r["cases"].values()), {"ok"}); self.assertEqual(r["resultLine"], ["ok", len(g["cases"]), 0, 0])
        res = self.results(); zap = (res / "c2eidxu1" / "harness-zap.tail.log").read_text()
        self.assertIn("sc=<redacted>", zap); self.assertNotIn("ZAPSECRET", zap)
        self.assertIn("sha256", json.loads((res / "c2eidxu1" / "harness-zap.meta.json").read_text()))
        self.assertTrue(s["cleanup"]["confirmed"])

    def test_r1_parser_negative_control_on_the_same_logs(self):
        self.runr("--run"); text = (self.results() / "feidxu1" / "driver.log").read_text()
        data = (S / "sdk_regression_runner.py").read_bytes(); spec = importlib.util.spec_from_loader("r1", loader=None); m = importlib.util.module_from_spec(spec)
        m.__file__ = str(S / "sdk_regression_runner.py"); exec(compile(data, "r1", "exec"), m.__dict__)
        ok, d = m.parse_libtest(text, REAL["groups"][2]["cases"]); self.assertFalse(ok); self.assertEqual(set(map(tuple, d["cases"].values())), {("missing",)})

    def test_real_failure_stays_failure_and_next_groups_run(self):
        p = self.runr("--run", sc="fail:c2eidxu1"); s = self.summary(p)
        self.assertEqual(p.returncode, 1); g = s["groups"]["c2eidxu1"]
        self.assertEqual((g["groupReturnCode"], g["verdict"]), (101, "FAIL")); self.assertEqual(g["failed"], [REAL["groups"][0]["cases"][0]]); self.assertEqual(g["parserErrors"], [])
        self.assertEqual(s["groups"]["feidxu1"]["verdict"], "PASS"); self.assertEqual(len(self.execs()), 3)

    def test_zap_log_tail_is_bounded(self):
        p = self.runr("--run", sc="bigzap:c2eidxfeed"); res = self.results() / "c2eidxfeed"
        meta = json.loads((res / "harness-zap.meta.json").read_text())
        self.assertEqual((meta["bytes"], meta["tailBytes"]), ((9 << 20) + 1, 8 << 20)); self.assertEqual(len((res / "harness-zap.tail.log").read_bytes()), 8 << 20)

    def test_bad_hosts_refused_before_any_docker_call(self):
        for bad in (None, 11, 21, "14", True):
            with self.subTest(bad=bad):
                self.tearDown(); self.setUp()
                if bad is None: del self.cfg["groups"][1]["hosts"]
                else: self.cfg["groups"][1]["hosts"] = bad
                self.write_cfg(); p = self.runr("--run")
                self.assertEqual(p.returncode, 2, p.stdout); self.assertIn("not an integer 12..20", p.stdout); self.assertEqual([c[0] for c in self.calls()], [])

    def test_pins_enforced(self):
        bad = self.t / "r1copy.py"; bad.write_text((S / "sdk_regression_runner.py").read_text() + "\n# changed\n")
        src = (PKG / "runner_r2.py").read_text().replace('R1 = HERE.parent / "sdk_regression_runner.py"', f'R1 = __import__("pathlib").Path("{bad}")')
        r2 = self.t / "runner_r2_badpin.py"; r2.write_text(src)
        p = subprocess.run([sys.executable, "-B", str(r2), "--config", str(self.cfgdir / "config.json"), "--dry-run"], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(p.returncode, 0); self.assertIn("not the pinned", p.stdout + p.stderr)

    def test_dry_run_touches_nothing(self):
        p = self.runr("--dry-run"); self.assertEqual(p.returncode, 0); self.assertEqual(self.calls(), [])

if __name__ == "__main__": unittest.main()
