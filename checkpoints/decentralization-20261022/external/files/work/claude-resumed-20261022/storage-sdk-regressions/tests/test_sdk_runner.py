#!/usr/bin/env python3
"""Helper tests for sdk_regression_runner.py with a FAKE docker (tests/fake_docker_sdk.py). No Docker, Go, Rust,
PostgreSQL, harness or driver runs.
  - The real config's 7 groups and 19 case names are used unchanged.
  - The real case-group.sh hash is used unchanged.
  - The real pinned base runner (storage-contracts-pg/contracts_pg_runner.py ed8e0fdd) is loaded read-only.
  - Harness/driver/geoip/snapshot files are tiny stand-ins with pins computed like the real config's.
  - An unrelated container and volume must survive every scenario."""
import copy, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent; PKG = H.parent
RUNNER = PKG / "sdk_regression_runner.py"
REAL = json.loads((PKG / "config.json").read_text())
IMAGE = "sha256:" + "7" * 64
SHA = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
UNRELATED = "a" * 64
ALL_CASES = sorted({x for g in REAL["groups"] for x in g["cases"]})

class Base(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="sdkreg-test-")); t = self.t
        (t / "bin").mkdir(); fake = t / "bin" / "docker"
        fake.write_text(f"#!/bin/sh\nexec {sys.executable} {H / 'fake_docker_sdk.py'} \"$@\"\n"); fake.chmod(0o755)
        cfg = copy.deepcopy(REAL); cfg["docker"] = str(fake); cfg["imageId"] = IMAGE
        cfg["timeouts"] = {"create": 3, "ready": 2, "harnessReady": 2, "groupInner": 2, "groupOuter": 4}
        for k in cfg["harnesses"]:
            p = t / f"harness-{k}"; p.write_text(f"fake harness {k}\n"); cfg["harnesses"][k].update(path=str(p), sha256=SHA(p))
        drv = t / "driver"; drv.write_text("fake driver\n"); man = t / "SNAPSHOT.sha256"; man.write_text("x  ./src/lib.rs\n")
        log = t / "sdkbuild4.out"; log.write_text(f"{SHA(drv)}  /x/bin/sdk-c2-4-driver\n")
        cfg["driver"].update(path=str(drv), sha256=SHA(drv), snapshotManifest=str(man), snapshotManifestSha256=SHA(man), buildLog=str(log), buildLogSha256=SHA(log))
        geo = t / "GeoLite2-City.mmdb"; geo.write_text("geo\n"); cfg["geoip"] = {"path": str(geo), "sha256": SHA(geo)}
        snaps = []
        for n in ("fence-enclave", "c2-enclave"):
            s = t / "snap" / n / "contracts"; s.mkdir(parents=True); (s / "form_test.go").write_text(f"accepted {n}\n"); (s / "form.go").write_text(f"prod {n}\n")
            inv = t / f"{n}.sha256"; inv.write_text(f"{SHA(s / 'form.go')}  ./contracts/form.go\n{'0' * 64}  ./contracts/form_test.go\n")
            snaps.append({"name": n, "snapshot": str(t / "snap" / n), "pinnedInventory": str(inv), "pinnedInventorySha256": SHA(inv),
                          "overrides": {"./contracts/form_test.go": SHA(s / "form_test.go")}})
        cfg["snapshots"] = snaps
        self.cfgdir = t / "pkg"; self.cfgdir.mkdir(); self.cfg = cfg; self.write_cfg()
        (t / "driver-list.json").write_text(json.dumps(ALL_CASES))
        self.state, self.log = t / "state.json", t / "calls.log"; self.unrelated_vol = "b" * 64
        self.state.write_text(json.dumps({"containers": {UNRELATED: {"name": "scsdk-someone-else", "labels": {"enclave.test.run": "other"}, "image": IMAGE, "mounts": [],
                                          "running": True, "memory": "64m", "cpus": "1", "cpuset": "0", "ro": False}}, "volumes": [self.unrelated_vol]}))
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def write_cfg(self): (self.cfgdir / "config.json").write_text(json.dumps(self.cfg))
    def env(self, sc=""):
        return dict(os.environ, FAKE_DOCKER_STATE=str(self.state), FAKE_DOCKER_LOG=str(self.log), FAKE_DOCKER_SCENARIO=sc, FAKE_DOCKER_IMAGE=IMAGE, FAKE_DRIVER_LIST=str(self.t / "driver-list.json"))
    def runr(self, *args, sc="", timeout=120):
        return subprocess.run([sys.executable, "-B", str(RUNNER), "--config", str(self.cfgdir / "config.json"), *args], env=self.env(sc), capture_output=True, text=True, timeout=timeout)
    def summary(self, p): return json.loads(p.stdout[p.stdout.index("{"):])
    def calls(self): return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []
    def group_execs(self): return [next(e.split("=", 1)[1] for e in c if e.startswith("GROUP=")) for c in self.calls() if c[0] == "exec" and "/tools/case-group.sh" in c]
    def owned(self): return [k for k in json.loads(self.state.read_text())["containers"] if k != UNRELATED]
    def scratch(self): return list((self.cfgdir / "runs").glob("scratch-*"))
    def results(self): return next((self.cfgdir / "runs").glob("*-results"))
    def intact(self):
        s = json.loads(self.state.read_text()); self.assertIn(UNRELATED, s["containers"]); self.assertIn(self.unrelated_vol, s["volumes"])
        self.assertFalse(any(UNRELATED in c for c in self.calls() if c[0] in ("rm", "volume")))
    def no_secret_leak(self, p):
        sec = pathlib.Path(str(self.state) + ".secret")
        if not sec.exists(): return
        pw = sec.read_text(); blobs = [p.stdout, p.stderr, self.log.read_text()] + [x.read_text(errors="replace") for x in (self.cfgdir / "runs").rglob("*") if x.is_file() and "secrets" not in x.parts]
        self.assertFalse(any(pw in b for b in blobs), "generated password leaked")

class Groups(Base):
    def test_happy_path_all_groups(self):
        p = self.runr("--run"); s = self.summary(p)
        self.assertEqual(p.returncode, 0, p.stdout[-2000:] + p.stderr[-2000:])
        self.assertEqual(self.group_execs(), [g["id"] for g in REAL["groups"]], "sequential, in the configured order")
        for g in REAL["groups"]:
            r = s["groups"][g["id"]]; self.assertEqual((r["verdict"], r["groupReturnCode"], r["harnessExit"]), ("PASS", 0, "0"), g["id"])
            self.assertEqual(r["resultLine"], [["ok", len(g["cases"]), 0]])
        self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch(), [])
        res = self.results(); txt = (res / "c2epos" / "driver.log").read_text() + (res / "c2epos" / "events.jsonl").read_text()
        self.assertNotIn("SIGNEDSECRET", txt); self.assertNotIn("SECRET3", txt); self.assertIn("sc=<redacted>", txt)
        run = next(c for c in self.calls() if c[0] == "run")
        for flag in (["--network", "none"], ["--sysctl", "net.ipv6.conf.lo.disable_ipv6=0"], ["--memory-swap", "1280m"], ["--pull", "never"]):
            self.assertTrue(any(run[i:i + 2] == flag for i in range(len(run))), flag)
        rw = [m for m in run if m.startswith("type=bind") and "readonly" not in m]; self.assertEqual(len(rw), 1); self.assertTrue(rw[0].endswith("dst=/scratch"))
        modes = {next(e.split("=", 1)[1] for e in c if e.startswith("GROUP=")): next(e.split("=", 1)[1] for e in c if e.startswith("MODE=")) for c in self.calls() if c[0] == "exec" and "/tools/case-group.sh" in c}
        self.assertEqual(modes, {g["id"]: g["mode"] for g in REAL["groups"]})
        self.intact(); self.no_secret_leak(p)

    def test_certain_failures_do_not_stop_later_groups(self):
        p = self.runr("--run", sc="fail:c2efence,notready:fec2neg,harnessbad:c2eblock"); s = self.summary(p)
        self.assertEqual(p.returncode, 1); self.assertEqual(self.group_execs(), [g["id"] for g in REAL["groups"]])
        self.assertEqual(s["groups"]["c2efence"]["groupReturnCode"], 101); self.assertEqual(s["groups"]["c2efence"]["verdict"], "FAIL")
        self.assertEqual(s["groups"]["fec2neg"]["groupReturnCode"], 3); self.assertEqual(s["groups"]["c2eblock"]["verdict"], "FAIL")
        self.assertEqual(s["groups"]["feindexd"]["verdict"], "PASS"); self.assertTrue(s["cleanup"]["confirmed"])

    def test_zero_tests_matched_is_not_a_pass(self):
        p = self.runr("--run", sc="zero:c2eindexd"); s = self.summary(p); r = s["groups"]["c2eindexd"]
        self.assertEqual((r["groupReturnCode"], r["verdict"]), (0, "FAIL")); self.assertEqual(set(map(tuple, r["cases"].values())), {("missing",)}); self.assertEqual(p.returncode, 1)

    def test_extra_tests_or_inconsistent_summary_are_not_a_pass(self):
        p = self.runr("--run", sc="extra:c2eindexd,summary:feindexd"); s = self.summary(p)
        e, m = s["groups"]["c2eindexd"], s["groups"]["feindexd"]
        self.assertEqual((e["groupReturnCode"], e["verdict"], e["unexpected"]), (0, "FAIL", ["real_indexd::some_unconfigured_case"]))
        self.assertEqual(m["verdict"], "FAIL"); self.assertEqual(set(map(tuple, m["cases"].values())), {("ok",)}); self.assertEqual(p.returncode, 1)

    def test_uncertain_group_end_stops_scheduling(self):
        for sc, want in (("hang:fec2neg", "outer-timeout"), ("x125:fec2neg", 125)):
            with self.subTest(sc):
                self.tearDown(); self.setUp()
                p = self.runr("--run", sc=sc); s = self.summary(p)
                self.assertEqual(self.group_execs(), ["c2epos", "fec2neg"], "no further group in the same container")
                self.assertEqual(s["groups"]["fec2neg"]["groupReturnCode"], want)
                self.assertEqual({s["groups"][g["id"]]["verdict"] for g in REAL["groups"][2:]}, {"NOT_RUN"})
                self.assertEqual(p.returncode, 1); self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.intact()

    def test_uncertain_end_with_unconfirmed_removal_keeps_state_then_second_process(self):
        p = self.runr("--run", sc="hang:c2epos,rm-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertEqual(self.group_execs(), ["c2epos"]); self.assertEqual(len(self.scratch()), 1); self.assertEqual(len(self.owned()), 1)
        j = next((self.cfgdir / "runs").glob("*.journal.json"))
        q = self.runr("--cleanup", str(j)); self.assertEqual(q.returncode, 0, q.stdout + q.stderr)
        self.assertEqual(self.owned(), []); self.assertEqual(self.scratch(), []); self.intact()

class Preconditions(Base):
    def test_unbuilt_harness_refused_before_any_docker_call(self):
        self.cfg["harnesses"]["fe"]["sha256"] = "UNBUILT"; self.write_cfg()
        for mode in ("--check", "--run"):
            p = self.runr(mode); self.assertEqual(p.returncode, 2, p.stdout); self.assertIn("not built/pinned yet", p.stdout)
        self.assertEqual(self.calls(), []); self.assertFalse(list((self.cfgdir / "runs").glob("scratch-*")))

    def test_real_config_refuses_until_built(self):
        p = subprocess.run([sys.executable, "-B", str(RUNNER), "--config", str(PKG / "config.json"), "--check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 2); self.assertIn("not built/pinned yet", p.stdout)

    def test_pin_mismatches_refused(self):
        for what, mutate in (("driver", lambda: pathlib.Path(self.cfg["driver"]["path"]).write_text("other driver\n")),
                             ("harness", lambda: pathlib.Path(self.cfg["harnesses"]["c2e"]["path"]).write_text("other\n")),
                             ("snapshot", lambda: pathlib.Path(self.cfg["snapshots"][1]["snapshot"], "contracts", "form.go").write_text("drift\n")),
                             ("build log", lambda: pathlib.Path(self.cfg["driver"]["buildLog"]).write_text("unrelated\n"))):
            with self.subTest(what):
                self.tearDown(); self.setUp(); mutate()
                p = self.runr("--run"); self.assertEqual(p.returncode, 2, p.stdout); self.assertEqual([c[0] for c in self.calls()], [])

    def test_base_runner_pin_enforced(self):
        self.cfg["baseRunner"]["sha256"] = "0" * 64; self.write_cfg()
        p = self.runr("--run"); self.assertNotEqual(p.returncode, 0); self.assertIn("not the accepted", p.stdout + p.stderr); self.assertEqual(self.calls(), [])

    def test_in_container_checks(self):
        for sc, want in (("no-ipv6", "IPv6 loopback"), ("driver-missing-case", "lacks cases")):
            with self.subTest(sc):
                self.tearDown(); self.setUp()
                p = self.runr("--run", sc=sc); s = self.summary(p)
                self.assertEqual(p.returncode, 4); self.assertIn(want, s["error"]); self.assertEqual(self.group_execs(), [])
                self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.intact()

    def test_dry_run_touches_nothing(self):
        p = self.runr("--dry-run"); self.assertEqual(p.returncode, 0); plan = json.loads(p.stdout)
        self.assertEqual(self.calls(), []); self.assertEqual(sorted(plan["groups"]), sorted(g["id"] for g in REAL["groups"]))

if __name__ == "__main__": unittest.main()
