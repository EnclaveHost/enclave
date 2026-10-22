#!/usr/bin/env python3
"""Helper tests for contracts_pg_runner.py with a FAKE docker (tests/fake_docker.py). No real Docker, Go or PostgreSQL.
Each test runs the real runner as a subprocess on tiny snapshot trees whose inventories are pinned exactly like the real
config's, with an unrelated pre-existing container + volume (and a look-alike 'scpg-' name) that must survive."""
import hashlib, json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time, unittest
H = pathlib.Path(__file__).resolve().parent
RUNNER = H.parent / "contracts_pg_runner.py"
IMAGE = "sha256:" + "7" * 64
GOVER = "go version go1.27.2-X:nodwarf5 linux/amd64"
UNRELATED = "a" * 64
SHA = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

class Base(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="scpg-test-")); t = self.t
        (t / "bin").mkdir(); fake = t / "bin" / "docker"; fake.write_text(f"#!/bin/sh\nexec {sys.executable} {H / 'fake_docker.py'} \"$@\"\n"); fake.chmod(0o755)
        (t / "goroot" / "bin").mkdir(parents=True); (t / "goroot" / "bin" / "go").write_text("fake go\n"); (t / "modcache").mkdir()
        suites = []
        for n in ("fence-enclave", "c2-enclave"):
            s = t / "snap" / n / "contracts"; s.mkdir(parents=True)
            (s / "form_test.go").write_text(f"accepted test {n}\n"); (s / "form.go").write_text(f"production {n}\n")
            inv = t / f"{n}.sha256"
            inv.write_text(f"{SHA(s / 'form.go')}  ./contracts/form.go\n{hashlib.sha256(b'pinned old test').hexdigest()}  ./contracts/form_test.go\n")
            suites.append({"name": n, "snapshot": str(t / "snap" / n), "pinnedInventory": str(inv), "pinnedInventorySha256": SHA(inv),
                           "overrides": {"./contracts/form_test.go": SHA(s / "form_test.go")}, "dbPrefix": n[:2]})
        self.cfgdir = t / "pkg"; self.cfgdir.mkdir()
        self.cfg = {"docker": str(fake), "imageId": IMAGE, "goroot": str(t / "goroot"), "goBinarySha256": SHA(t / "goroot" / "bin" / "go"), "goVersion": GOVER,
                    "gomodcache": str(t / "modcache"), "namePrefix": "scpg",
                    "limits": {"memory": "1024m", "memoryBytes": 1073741824, "cpus": 2, "cpuset": "0-1", "pids": 1024, "goMemLimit": "600MiB"},
                    "timeouts": {"create": 3, "ready": 2, "goTestInner": 2, "goTestOuter": 4, "goTestFlag": "1m"},
                    "packages": ["./contracts/...", "./cmd/..."], "suites": suites}
        (self.cfgdir / "config.json").write_text(json.dumps(self.cfg))
        self.state, self.log = t / "state.json", t / "calls.log"
        self.unrelated_vol = "b" * 64
        self.state.write_text(json.dumps({"containers": {UNRELATED: {"name": "scpg-someone-else", "labels": {"enclave.test.run": "other"}, "image": IMAGE, "mounts": [],
                                          "running": True, "memory": "64m", "cpus": "1", "cpuset": "0", "ro": False}}, "volumes": [self.unrelated_vol]}))
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)

    def env(self, scenario=""):
        return dict(os.environ, FAKE_DOCKER_STATE=str(self.state), FAKE_DOCKER_LOG=str(self.log), FAKE_DOCKER_SCENARIO=scenario, FAKE_DOCKER_IMAGE=IMAGE, FAKE_GO_VERSION=GOVER)
    def run_runner(self, *args, scenario="", timeout=60):
        p = subprocess.run([sys.executable, "-B", str(RUNNER), "--config", str(self.cfgdir / "config.json"), *args], env=self.env(scenario), capture_output=True, text=True, timeout=timeout)
        return p
    def summary(self, p):
        return json.loads(p.stdout[p.stdout.index("{"):])
    def calls(self): return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []
    def st(self): return json.loads(self.state.read_text())
    def journal(self): return json.loads(next((self.cfgdir / "runs").glob("*.journal.json")).read_text())
    def scratch_dirs(self): return list((self.cfgdir / "runs").glob("scratch-*"))
    def assert_unrelated_intact(self):
        s = self.st(); self.assertIn(UNRELATED, s["containers"]); self.assertIn(self.unrelated_vol, s["volumes"])
        self.assertFalse(any(UNRELATED in c for c in self.calls() if c[0] in ("rm", "volume")), "unrelated container/volume touched")
    def assert_no_secret_leak(self, *texts):
        sec = pathlib.Path(str(self.state) + ".secret")
        if not sec.exists(): return
        pw = sec.read_text()
        blobs = list(texts) + [p.read_text() for p in (self.cfgdir / "runs").rglob("*") if p.is_file() and "secrets" not in p.parts] + [self.log.read_text()]
        self.assertFalse(any(pw in b for b in blobs), "the generated password leaked into output/journal/results/argv")
    def owned(self):
        return [cid for cid, c in self.st()["containers"].items() if cid != UNRELATED]

class Runs(Base):
    def test_happy_path(self):
        p = self.run_runner("--run"); s = self.summary(p)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for n in ("fence-enclave", "c2-enclave"):
            self.assertEqual((s["suites"][n]["goTestReturnCode"], s["suites"][n]["verdict"], s["suites"][n]["snapshotUnchanged"]), (0, "PASS", True))
        self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), [])
        j = self.journal(); self.assertEqual(j["stage"], "cleaned")
        rm = [c for c in self.calls() if c[0] == "rm"]; self.assertEqual(rm, [["rm", "-f", "-v", j["containerId"]]])
        self.assertEqual(len(self.st()["volumes"]), 1)                       # only the unrelated volume is left
        run = next(c for c in self.calls() if c[0] == "run")
        for flag in (["--network", "none"], ["--pull", "never"], ["--memory-swap", "1024m"], ["--cpuset-cpus", "0-1"]): self.assertTrue(any(run[i:i + 2] == flag for i in range(len(run))), flag)
        self.assertFalse(any(x in ("-p", "--publish", "-P") for x in run)); self.assertNotIn("POSTGRES_PASSWORD", " ".join(run))
        execs = [c for c in self.calls() if c[0] == "exec" and "test" in c]
        self.assertEqual([c[c.index("--workdir") + 1] for c in execs], ["/src/fence-enclave", "/src/c2-enclave"])   # sequential, in order
        prefixes = [next(x for x in c if x.startswith("POSTGRES_DB_PREFIX=")) for c in execs]; self.assertEqual(len(set(prefixes)), 2, prefixes)   # separate DB prefixes
        caches = [next(x for x in c if x.startswith("GOCACHE=")) for c in execs]; self.assertEqual(len(set(caches)), 2, caches)                  # separate GOCACHE
        self.assert_unrelated_intact(); self.assert_no_secret_leak(p.stdout, p.stderr)

    def test_suite_failure_keeps_real_rc(self):
        p = self.run_runner("--run", scenario="suite-fail:c2-enclave"); s = self.summary(p)
        self.assertEqual(p.returncode, 1); self.assertEqual(s["suites"]["fence-enclave"]["verdict"], "PASS")
        self.assertEqual((s["suites"]["c2-enclave"]["goTestReturnCode"], s["suites"]["c2-enclave"]["verdict"]), (1, "FAIL"))
        self.assertEqual(s["suites"]["c2-enclave"]["failureClasses"], {"TEST": ["TestB"]}); self.assertTrue(s["cleanup"]["confirmed"]); self.assert_unrelated_intact()

    def test_classifier_never_upgrades_nonzero_rc(self):
        p = self.run_runner("--run", scenario="suite-lie:fence-enclave"); s = self.summary(p)
        self.assertEqual(p.returncode, 1); f = s["suites"]["fence-enclave"]
        self.assertEqual((f["goTestReturnCode"], f["fail"], f["verdict"]), (1, 0, "FAIL"))

    def suite_execs(self): return [c[c.index("--workdir") + 1] for c in self.calls() if c[0] == "exec" and "test" in c]

    def test_outer_timeout_stops_scheduling(self):
        p = self.run_runner("--run", scenario="suite-hang:fence-enclave"); s = self.summary(p)
        self.assertEqual(s["suites"]["fence-enclave"]["goTestReturnCode"], "outer-timeout"); self.assertEqual(p.returncode, 1)
        self.assertEqual(s["suites"]["c2-enclave"]["verdict"], "NOT_RUN"); self.assertIn("uncertainly", s["suites"]["c2-enclave"]["reason"])
        self.assertEqual(self.suite_execs(), ["/src/fence-enclave"], "no second suite may start in the same container")
        self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), [])

    def test_exec_transport_error_stops_scheduling(self):
        p = self.run_runner("--run", scenario="exec-125:fence-enclave"); s = self.summary(p)
        self.assertEqual(s["suites"]["fence-enclave"]["goTestReturnCode"], 125); self.assertEqual(s["suites"]["c2-enclave"]["verdict"], "NOT_RUN")
        self.assertEqual(self.suite_execs(), ["/src/fence-enclave"]); self.assertEqual(p.returncode, 1); self.assertTrue(s["cleanup"]["confirmed"])

    def test_certain_failure_continues_to_next_suite(self):
        p = self.run_runner("--run", scenario="suite-fail:fence-enclave"); s = self.summary(p)   # rc 1 is a certain end
        self.assertEqual(self.suite_execs(), ["/src/fence-enclave", "/src/c2-enclave"]); self.assertEqual(s["suites"]["c2-enclave"]["verdict"], "PASS")

    def test_outer_timeout_with_unconfirmed_removal_keeps_scratch(self):
        p = self.run_runner("--run", scenario="suite-hang:fence-enclave,rm-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertEqual(self.suite_execs(), ["/src/fence-enclave"])
        self.assertFalse(s["cleanup"]["confirmed"]); self.assertEqual(len(self.scratch_dirs()), 1); self.assertEqual(len(self.owned()), 1)
        self.assertEqual(self.journal()["stage"], "cleanup-unconfirmed")

class Create(Base):
    def test_lost_create_response_adopts_only_run_labelled(self):
        for sc in ("lost-create", "create-hang"):
            with self.subTest(sc):
                self.tearDown(); self.setUp()
                p = self.run_runner("--run", scenario=sc); s = self.summary(p)
                # the run-labelled container (created after the empty pre-create check) is adopted and the run completes
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr); self.assertEqual({v["verdict"] for v in s["suites"].values()}, {"PASS"})
                self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), [])
                j = self.journal(); self.assertRegex(j["containerAdoptedByRunLabel"], r"^[0-9a-f]{64}$"); self.assertEqual(j["containerAdoptedByRunLabel"], j["containerId"])
                self.assert_unrelated_intact()

    def test_create_fails_nothing_removed(self):
        p = self.run_runner("--run", scenario="create-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 4); self.assertTrue(s["cleanup"]["confirmed"])
        self.assertFalse([c for c in self.calls() if c[0] in ("rm", "volume")], "nothing may be removed when nothing was created")
        self.assertEqual(self.scratch_dirs(), []); self.assert_unrelated_intact()

    def test_collision_refuses_and_touches_nothing(self):
        p = self.run_runner("--run", scenario="collision"); s = self.summary(p)
        self.assertEqual(p.returncode, 2); self.assertIn("already in use", s["refused"])
        self.assertFalse([c for c in self.calls() if c[0] in ("run", "rm", "volume")])
        self.assertIn("skipped", s["cleanup"]["containerLookup"]); self.assertEqual(self.scratch_dirs(), []); self.assert_unrelated_intact()

    def test_unreachable_docker_after_lost_create_preserves_state_then_cross_process_cleanup(self):
        p = self.run_runner("--run", scenario="lost-create,ps-fails-after-create"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertFalse(s["cleanup"]["confirmed"])
        self.assertEqual(len(self.owned()), 1, "the created container is preserved, not guessed at"); self.assertEqual(len(self.scratch_dirs()), 1)
        self.assertFalse([c for c in self.calls() if c[0] in ("rm", "volume")])
        jp = next((self.cfgdir / "runs").glob("*.journal.json"))
        q = self.run_runner("--cleanup", str(jp)); out = json.loads(q.stdout)
        self.assertEqual(q.returncode, 0, q.stdout + q.stderr); self.assertTrue(out["confirmed"]); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), [])
        self.assert_unrelated_intact()

    def test_docker_unreachable_from_start_creates_and_touches_nothing(self):
        p = self.run_runner("--run", scenario="ps-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 4); self.assertTrue(s["cleanup"]["confirmed"])
        self.assertFalse([c for c in self.calls() if c[0] in ("run", "rm", "volume")]); self.assertEqual(self.scratch_dirs(), []); self.assert_unrelated_intact()

class Cleanup(Base):
    def test_rm_fails_keeps_scratch_then_second_process_cleans(self):
        p = self.run_runner("--run", scenario="rm-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertEqual(s["cleanup"]["scratchRemoved"], False); self.assertEqual(len(self.scratch_dirs()), 1)
        jp = next((self.cfgdir / "runs").glob("*.journal.json"))
        q = self.run_runner("--cleanup", str(jp)); self.assertEqual(q.returncode, 0, q.stdout); self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), [])
        self.assertEqual(self.run_runner("--cleanup", str(jp)).returncode, 0)    # idempotent: already cleaned
        self.assert_unrelated_intact()

    def test_leftover_owned_volume_removed_by_exact_name(self):
        p = self.run_runner("--run", scenario="rm-keeps-volume"); s = self.summary(p)
        self.assertEqual(p.returncode, 0, p.stdout); vols = self.journal()["ownedVolumes"]
        self.assertEqual(len(vols), 1); self.assertIn(["volume", "rm", vols[0]], self.calls()); self.assertEqual(self.st()["volumes"], [self.unrelated_vol])
        self.assert_unrelated_intact()

    def test_scratch_identity_mismatch_refused(self):
        for kind in ("replaced", "symlink"):
            with self.subTest(kind):
                self.tearDown(); self.setUp()
                p = self.run_runner("--run", scenario="rm-fails"); self.assertEqual(p.returncode, 3)
                sd = self.scratch_dirs()[0]; moved = self.t / "moved"; os.rename(sd, moved)
                if kind == "replaced": sd.mkdir(); (sd / "keep").write_text("someone else's")
                else: sd.symlink_to(moved)
                jp = next((self.cfgdir / "runs").glob("*.journal.json"))
                q = self.run_runner("--cleanup", str(jp)); out = json.loads(q.stdout)
                self.assertEqual(q.returncode, 3); self.assertEqual(self.owned(), [], "the confirmed container is still removed")
                self.assertIn("refused", out["scratchDetail"]); self.assertTrue(sd.exists() or sd.is_symlink()); self.assertTrue(moved.exists())
                if kind == "replaced": self.assertEqual((sd / "keep").read_text(), "someone else's")

    def test_volume_inspect_error_is_not_absence(self):
        p = self.run_runner("--run", scenario="volume-inspect-fails"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertFalse(s["cleanup"]["confirmed"]); self.assertIn("state unknown", s["cleanup"]["dockerError"])
        self.assertEqual(len(self.scratch_dirs()), 1); self.assertEqual(self.journal()["stage"], "cleanup-unconfirmed")
        jp = next((self.cfgdir / "runs").glob("*.journal.json"))
        q = self.run_runner("--cleanup", str(jp)); self.assertEqual(q.returncode, 0, q.stdout); self.assertEqual(self.scratch_dirs(), [])
        self.assertEqual(self.st()["volumes"], [self.unrelated_vol]); self.assert_unrelated_intact()

    def test_socket_error_after_rm_is_not_absence(self):
        p = self.run_runner("--run", scenario="inspect-conn-error-after-rm"); s = self.summary(p)
        self.assertEqual(p.returncode, 3); self.assertFalse(s["cleanup"]["confirmed"]); self.assertEqual(len(self.scratch_dirs()), 1)

    def test_adopted_container_volume_captured_and_failed_removal_not_hidden(self):
        p = self.run_runner("--run", scenario="lost-create,ps-fails-after-create"); self.assertEqual(p.returncode, 3)
        jp = next((self.cfgdir / "runs").glob("*.journal.json")); j0 = json.loads(jp.read_text())
        self.assertNotIn("containerId", j0); self.assertNotIn("ownedVolumes", j0)            # nothing was known about the container
        vol = next(m["Name"] for c in self.st()["containers"].values() for m in c["mounts"] if m["Type"] == "volume")
        q = self.run_runner("--cleanup", str(jp), scenario="rm-keeps-volume,volume-rm-fails"); out = json.loads(q.stdout)
        self.assertEqual(q.returncode, 3, q.stdout); self.assertEqual(out["volumesLeft"], [vol]); self.assertFalse(out["confirmed"])
        self.assertEqual(json.loads(jp.read_text())["ownedVolumes"], [vol], "the adopted container's volume was recorded before removal")
        self.assertEqual(len(self.scratch_dirs()), 1); self.assertIn(vol, self.st()["volumes"])
        r = self.run_runner("--cleanup", str(jp)); self.assertEqual(r.returncode, 0, r.stdout); self.assertNotIn(vol, self.st()["volumes"]); self.assertEqual(self.scratch_dirs(), [])
        self.assert_unrelated_intact()

    def test_vanished_container_with_unrecorded_volumes_is_unconfirmed(self):
        p = self.run_runner("--run", scenario="rm-fails"); self.assertEqual(p.returncode, 3)
        jp = next((self.cfgdir / "runs").glob("*.journal.json")); j = json.loads(jp.read_text()); del j["ownedVolumes"]; jp.write_text(json.dumps(j))
        st = self.st(); cid = j["containerId"]; del st["containers"][cid]; self.state.write_text(json.dumps(st))   # gone, volumes never known
        q = self.run_runner("--cleanup", str(jp)); out = json.loads(q.stdout)
        self.assertEqual(q.returncode, 3); self.assertIn("volumesUnknown", out); self.assertEqual(len(self.scratch_dirs()), 1)

    def test_bad_isolation_never_ready_toolchain(self):
        for sc in ("bad-isolation", "never-ready", "toolchain-bad"):
            with self.subTest(sc):
                self.tearDown(); self.setUp()
                p = self.run_runner("--run", scenario=sc); s = self.summary(p)
                self.assertEqual(p.returncode, 4, s); self.assertEqual(s["suites"], {}); self.assertTrue(s["cleanup"]["confirmed"]); self.assertEqual(self.owned(), [])
                self.assertFalse([c for c in self.calls() if c[0] == "exec" and "test" in c], "no go test after a failed precondition")
                self.assert_unrelated_intact()

    def test_snapshot_drift_refused_before_any_docker_change(self):
        pathlib.Path(self.cfg["suites"][0]["snapshot"], "contracts", "form.go").write_text("changed\n")
        p = self.run_runner("--run"); s = self.summary(p)
        self.assertEqual(p.returncode, 2); self.assertIn("inventory differs", s["refused"])
        self.assertEqual([c[0] for c in self.calls()], []); self.assertEqual(self.scratch_dirs(), [])

    def test_sigterm_during_suite_cleans_up(self):
        proc = subprocess.Popen([sys.executable, "-B", str(RUNNER), "--config", str(self.cfgdir / "config.json"), "--run"], env=self.env("suite-hang:fence-enclave"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            if any(c[0] == "exec" and "test" in c for c in self.calls()): break
            time.sleep(0.05)
        jp = next((self.cfgdir / "runs").glob("*.journal.json"))
        q = self.run_runner("--cleanup", str(jp)); self.assertEqual(q.returncode, 2); self.assertIn("still running", q.stdout)   # owner alive: refuse
        proc.send_signal(signal.SIGTERM); out, err = proc.communicate(timeout=30)
        s = json.loads(out[out.index("{"):]); self.assertIn("signal", s.get("error", "")); self.assertTrue(s["cleanup"]["confirmed"])
        self.assertEqual(self.owned(), []); self.assertEqual(self.scratch_dirs(), []); self.assert_unrelated_intact()

    def test_check_mode_is_read_only(self):
        p = self.run_runner("--check"); self.assertEqual(p.returncode, 0, p.stdout); self.assertEqual(set(json.loads(p.stdout)["preflight"]), {"fence-enclave", "c2-enclave"})
        self.assertEqual([c[:2] for c in self.calls()], [["image", "inspect"]]); self.assertFalse((self.cfgdir / "runs").exists())

    def test_dry_run_touches_nothing(self):
        p = self.run_runner("--dry-run"); self.assertEqual(p.returncode, 0); plan = json.loads(p.stdout)
        self.assertEqual(self.calls(), []); self.assertFalse((self.cfgdir / "runs").exists())
        self.assertIn("--network", plan["create"]); self.assertEqual(len(plan["suites"]), 2)

if __name__ == "__main__": unittest.main()
