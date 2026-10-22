"""Mock failure-path tests of runner/vm_fresh_backup.py. A fake root filesystem (FB_ROOT) and fake systemctl/docker/pgrep
(test/fakes, state in FAKE_DIR) stand in for the VM; nothing real is stopped, dumped or copied. Run inside
`unshare --user --map-root-user` (euid 0, as on the VM) - tools/run-tests.sh does that."""
import fcntl, hashlib, json, os, shutil, signal, subprocess, sys, time, unittest
def _rd(p, mode="r"):
    with open(p, mode) as f:
        return f.read()
def _wr(p, data, mode="w"):
    with open(p, mode) as f:
        f.write(data)
def _jload(p):
    with open(p) as f:
        return json.load(f)
def _jdump(v, p):
    with open(p, "w") as f:
        json.dump(v, f)

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
RUNNER = os.environ.get("FB_RUNNER") or os.path.join(PKG, "runner", "vm_fresh_backup.py")   # FB_RUNNER: negative controls
FAKES = os.path.join(HERE, "fakes")
SENTINEL = "SENTINEL-CONFIG-SECRET-7f3a9c"         # stands for indexd.yml content; must never appear in any output
sha = lambda b: hashlib.sha256(b).hexdigest()


class Fixture:
    n = 0

    def __init__(self, unit=None, behavior=None, allow=True):
        Fixture.n += 1
        self.base = os.path.join(HERE, f"tmp-{os.getpid()}-{Fixture.n}")
        os.mkdir(self.base)
        self.root, self.fake = os.path.join(self.base, "root"), os.path.join(self.base, "fake")
        os.mkdir(self.fake)
        for d in ("etc/enclave-indexd", "var/lib/enclave-indexd/state", "opt/enclave-indexd", "run"):
            os.makedirs(os.path.join(self.root, d))
        self.files = {"etc/enclave-indexd/indexd.yml": ("recoveryPhrase: " + SENTINEL + "\n").encode(),
                      "var/lib/enclave-indexd/state/consensus.db": os.urandom(3 << 20),
                      "var/lib/enclave-indexd/state/GeoLite2-City.mmdb": os.urandom(1 << 20),
                      "opt/enclave-indexd/indexd": b"\x7fELF" + os.urandom(65536)}
        for p, b in self.files.items():
            _wr(os.path.join(self.root, p), b, "wb")
        if allow:
            _wr(os.path.join(self.root, "etc/enclave-indexd/ALLOW_LIVE_START"), "")
        _jdump(unit or {"ActiveState": "active", "SubState": "running", "MainPID": "4242", "UnitFileState": "enabled"}, os.path.join(self.fake, "unit.json"))
        if (unit or {}).get("ActiveState", "active") == "active":
            _wr(os.path.join(self.fake, "proc"), "")
        self.behave(**(behavior or {}))
        self.bin_sha = sha(self.files["opt/enclave-indexd/indexd"])
        self.geo_sha = sha(self.files["var/lib/enclave-indexd/state/GeoLite2-City.mmdb"])

    def behave(self, **b):
        _jdump(b, os.path.join(self.fake, "behavior.json"))

    def env(self):
        return {"PATH": FAKES + ":/usr/bin:/bin", "FB_ROOT": self.root, "FAKE_DIR": self.fake, "LC_ALL": "C"}

    def run(self, mode="capture", run_id="20261022T080000Z-0a1b2c3d", extra=(), popen=False, **kw):
        # the runner needs euid 0 (as on the VM): enter a user namespace unless this process already is uid 0 there
        args = ([] if os.geteuid() == 0 else ["unshare", "--user", "--map-root-user"]) + [sys.executable, RUNNER, mode, "--run-id", run_id]
        if mode == "capture":
            args += ["--confirm", "fresh-backup", "--expect-db-version", "26", "--expect-binary-sha256", kw.get("bin", self.bin_sha),
                     "--expect-geoip-sha256", kw.get("geo", self.geo_sha), "--quiesce-budget", "20", "--dump-timeout", "2"]
        args += list(extra)
        if popen:
            return subprocess.Popen(args, env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        r = subprocess.run(args, env=self.env(), capture_output=True, timeout=120)
        self.out = r.stdout.decode() + r.stderr.decode()
        return r.returncode

    def kv(self, key):
        return [l.split("=", 1)[1] for l in self.out.splitlines() if l.startswith(key + "=")]

    def calls(self):
        p = os.path.join(self.fake, "calls.log")
        return [l.split()[:2] for l in _rd(p).splitlines()] if os.path.exists(p) else []

    def unit(self):
        return _jload(os.path.join(self.fake, "unit.json"))

    @property
    def parent(self):
        return os.path.join(self.root, "var/lib/enclave-indexd/fresh-backup")

    def receipt(self, run_id="20261022T080000Z-0a1b2c3d"):
        return _jload(os.path.join(self.parent, run_id + ".receipt.json"))

    def phases(self, run_id="20261022T080000Z-0a1b2c3d"):
        return [json.loads(l)["phase"] for l in _rd(os.path.join(self.parent, run_id + ".journal.jsonl")).splitlines()]

    def no_secret_anywhere(self, tc):
        tc.assertNotIn(SENTINEL, self.out)
        if os.path.isdir(self.parent):
            for dp, _, fs in os.walk(self.parent):
                for f in fs:
                    if f != "indexd.yml":
                        tc.assertNotIn(SENTINEL.encode(), _rd(os.path.join(dp, f), "rb"), f)

    def close(self):
        shutil.rmtree(self.base)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.fx = []

    def tearDown(self):
        for f in self.fx:
            f.no_secret_anywhere(self)
            f.close()

    def F(self, **kw):
        f = Fixture(**kw); self.fx.append(f); return f

    def stop_start(self, f):
        return [c[1] for c in f.calls() if c[0] == "systemctl" and c[1] in ("stop", "start")]

    # ---------- the normal paths ----------
    def test_active_writer_is_stopped_captured_and_resumed(self):
        f = self.F()
        self.assertEqual(f.run(), 0, f.out)
        self.assertEqual(f.kv("fb.outcome"), ["complete"]); self.assertEqual(f.kv("fb.root"), [f.root])
        self.assertEqual(self.stop_start(f), ["stop", "start"])
        self.assertEqual(f.unit()["ActiveState"], "active")
        r = f.receipt(); d = os.path.join(f.parent, r["runId"])
        self.assertTrue(r["backupComplete"] and r["coupled"] and r["sourceResumed"] and r["stoppedByRun"])
        self.assertEqual(oct(os.stat(d).st_mode & 0o777), "0o700")
        m = _jload(os.path.join(d, "manifest.json"))
        for name, src in [("indexd.yml", "etc/enclave-indexd/indexd.yml"), ("consensus.db", "var/lib/enclave-indexd/state/consensus.db"),
                          ("indexd", "opt/enclave-indexd/indexd"), ("GeoLite2-City.mmdb", "var/lib/enclave-indexd/state/GeoLite2-City.mmdb")]:
            self.assertEqual(m["files"][name]["sha256"], sha(f.files[src]), name)
            self.assertEqual(oct(os.stat(os.path.join(d, name)).st_mode & 0o777), "0o600")
        self.assertEqual(m["dbVersion"], 26); self.assertTrue(m["coupled"] and m["quiesced"] and m["sourceResumed"])
        self.assertEqual(f.phases()[:3], ["prestate", "preflight-ok", "created"])
        self.assertIn("resumed", f.phases()); self.assertLess(f.phases().index("dumped"), f.phases().index("starting"))
        self.assertEqual(len(f.kv("fb.token")[0]), 32)

    def test_previously_inactive_writer_is_never_started(self):
        f = self.F(unit={"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "UnitFileState": "enabled"})
        self.assertEqual(f.run(), 0, f.out)
        self.assertEqual(self.stop_start(f), [], "neither stopped nor started")
        self.assertEqual(f.unit()["ActiveState"], "inactive")
        r = f.receipt(); self.assertFalse(r["writerWasActive"]); self.assertFalse(r["stoppedByRun"]); self.assertTrue(r["sourceResumed"])

    # ---------- refused before any change ----------
    def assertRefusedUnchanged(self, f, code=5):
        self.assertEqual(f.run(), code, f.out)
        self.assertTrue(f.kv("fb.outcome")[0].startswith("refused:"), f.out)
        self.assertEqual(self.stop_start(f), [])
        self.assertFalse(any(n for n in (os.listdir(f.parent) if os.path.isdir(f.parent) else []) if not n.endswith((".journal.jsonl", ".receipt.json"))))

    def test_refusals(self):
        cases = [
            dict(unit={"ActiveState": "failed", "SubState": "failed", "MainPID": "0", "UnitFileState": "enabled"}),
            dict(unit={"ActiveState": "activating", "SubState": "start-pre", "MainPID": "0", "UnitFileState": "enabled"}),
            dict(allow=False),
            dict(behavior={"db_version": 27}),
            dict(behavior={"pg_running": False}),
            dict(behavior={"timeout_in_container": False}),
        ]
        for kw in cases:
            with self.subTest(**{k: str(v)[:40] for k, v in kw.items()}):
                self.assertRefusedUnchanged(self.F(**kw))
        f = self.F(); self.assertEqual(f.run(bin="0" * 64), 5); self.assertEqual(self.stop_start(f), [])
        f = self.F(); self.assertEqual(f.run(geo="0" * 64), 5); self.assertEqual(self.stop_start(f), [])
        f = self.F(unit={"ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "UnitFileState": "enabled"})
        _wr(os.path.join(f.fake, "proc"), "")          # inactive unit, but a stray indexd process
        self.assertRefusedUnchanged(f)

    def test_run_id_is_never_reused_and_the_lock_is_exclusive(self):
        f = self.F(); self.assertEqual(f.run(), 0)
        before = sorted(os.listdir(f.parent)); m = _rd(os.path.join(f.parent, "20261022T080000Z-0a1b2c3d", "manifest.json"))
        self.assertEqual(f.run(), 5); self.assertIn("already used", f.out)
        self.assertEqual(sorted(os.listdir(f.parent)), before)
        self.assertEqual(_rd(os.path.join(f.parent, "20261022T080000Z-0a1b2c3d", "manifest.json")), m)
        g = self.F()
        fd = os.open(os.path.join(g.root, "run/enclave-indexd-snapshot.lock"), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.assertEqual(g.run(), 5); self.assertIn("lock", g.out); self.assertEqual(self.stop_start(g), [])
        finally:
            os.close(fd)
        for bad in ("latest", "20261022T080000Z", "../x"):
            self.assertEqual(g.run(run_id=bad), 5)

    def test_parent_must_be_root_0700_directory_not_symlink(self):
        f = self.F(); os.makedirs(os.path.dirname(f.parent), exist_ok=True)
        os.symlink(os.path.join(f.root, "run"), f.parent)
        self.assertEqual(f.run(), 5); self.assertEqual(self.stop_start(f), [])
        g = self.F(); os.mkdir(g.parent, 0o755)
        self.assertEqual(g.run(), 5)

    # ---------- failures after the stop: prior state restored, partial removed only when owned ----------
    def assertRestoredFailure(self, f, extra_phase=None):
        r = f.receipt()
        self.assertEqual(r["exit"], 3); self.assertTrue(r["outcome"].startswith("failed"), r["outcome"])
        self.assertFalse(r["backupComplete"]); self.assertTrue(r["sourceResumed"])
        self.assertEqual(f.unit()["ActiveState"], "active")
        self.assertFalse(os.path.exists(os.path.join(f.parent, r["runId"])), "own partial plaintext removed")
        self.assertIn("discarded", f.phases())
        if extra_phase:
            self.assertIn(extra_phase, f.phases())

    def test_dump_failure_restores_the_writer(self):
        f = self.F(behavior={"dump": "fail"}); self.assertEqual(f.run(), 3, f.out)
        self.assertEqual(self.stop_start(f), ["stop", "start"]); self.assertRestoredFailure(f, "capture-failed")

    def test_dump_hang_is_bounded_and_restores_the_writer(self):
        f = self.F(behavior={"dump": "hang"}); t0 = time.monotonic()
        self.assertEqual(f.run(), 3, f.out); self.assertLess(time.monotonic() - t0, 40)
        self.assertRestoredFailure(f)

    def test_not_a_custom_archive_is_rejected(self):
        f = self.F(behavior={"dump": "notpgdmp"}); self.assertEqual(f.run(), 3); self.assertRestoredFailure(f)

    def test_writer_started_by_another_actor_is_not_a_coupled_backup(self):
        f = self.F(behavior={"dump": "foreign-start"}); self.assertEqual(f.run(), 3, f.out)
        r = f.receipt(); self.assertFalse(r["coupled"]); self.assertRestoredFailure(f, "coupling")

    def test_stop_not_confirmed_never_captures(self):
        for m in ("fail", "noop"):
            with self.subTest(stop=m):
                f = self.F(behavior={"stop": m}); self.assertEqual(f.run(), 3, f.out)
                self.assertNotIn("pg_dump", _rd(os.path.join(f.fake, "calls.log")))
                self.assertRestoredFailure(f)

    def test_sigterm_mid_dump_still_restores_the_writer(self):
        f = self.F(behavior={"dump": "slow", "slow_s": 30})
        p = f.run(popen=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and "pg_dump" not in (_rd(os.path.join(f.fake, "calls.log")) if os.path.exists(os.path.join(f.fake, "calls.log")) else ""):
            time.sleep(0.1)
        time.sleep(0.5); p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=60); f.out = out.decode() + err.decode()
        self.assertEqual(p.returncode, 3, f.out); self.assertRestoredFailure(f)

    def test_lost_stdout_reader_does_not_break_capture_or_resume(self):
        f = self.F(behavior={"dump": "slow", "slow_s": 2})
        p = f.run(popen=True); p.stdout.close()                  # the reader goes away (a dropped transport)
        p.wait(timeout=60); f.out = p.stderr.read().decode(); p.stderr.close()
        self.assertEqual(p.returncode, 0, f.out); r = f.receipt()
        self.assertEqual(r["outcome"], "complete"); self.assertTrue(r["sourceResumed"]); self.assertEqual(f.unit()["ActiveState"], "active")

    # ---------- the prior state could NOT be restored: explicit, never success ----------
    def test_failed_resume_is_reported_unrestored(self):
        for m in ("fail", "condition"):
            with self.subTest(start=m):
                f = self.F(behavior={"start": m}); self.assertEqual(f.run(), 4, f.out)
                r = f.receipt(); self.assertFalse(r["sourceResumed"]); self.assertEqual(r["outcome"], "UNRESTORED:backup-complete")
                self.assertIn("RESUME-FAILED", f.phases()); self.assertEqual(f.kv("fb.outcome"), ["UNRESTORED:backup-complete"])
                self.assertTrue(os.path.exists(os.path.join(f.parent, r["runId"], "manifest.json")), "a valid backup is kept for root")
        f = self.F(behavior={"start": "fail", "dump": "fail"}); self.assertEqual(f.run(), 4)
        self.assertEqual(f.receipt()["outcome"], "UNRESTORED:backup-failed")

    # ---------- confirmed-ownership cleanup ----------
    def test_foreign_entry_in_run_dir_is_preserved_not_deleted(self):
        rid = "20261022T080000Z-0a1b2c3d"
        f = self.F(behavior={"dump": "extra-file", "run_id": rid}); self.assertEqual(f.run(), 3, f.out)
        self.assertTrue(f.kv("fb.partial")[0].startswith("preserved:foreign entries present"), f.out)
        hidden = [n for n in os.listdir(f.parent) if n.startswith(".discard-")]
        self.assertEqual(len(hidden), 1); self.assertIn("foreign.txt", os.listdir(os.path.join(f.parent, hidden[0])))
        self.assertIn("discard-preserved", f.phases())

    # ---------- status (lost transport) and plaintext removal ----------
    def test_status_and_confirmed_removal(self):
        f = self.F(); self.assertEqual(f.run(), 0); token = f.kv("fb.token")[0]; rid = "20261022T080000Z-0a1b2c3d"
        self.assertEqual(f.run("status"), 0)
        self.assertEqual(f.kv("fb.status.outcome"), ["complete"]); self.assertIn("resumed", f.kv("fb.status.journal_phases")[0])
        self.assertEqual(f.run("status", run_id="20261022T090000Z-ffffffff"), 0)
        self.assertTrue(f.kv("fb.status.receipt")[0].startswith("absent"))
        self.assertEqual(f.run("remove", extra=["--token", "0" * 32, "--confirm", "remove-plaintext"]), 6)
        self.assertEqual(f.run("remove", extra=["--token", token]), 6)                      # no --confirm
        self.assertTrue(os.path.isdir(os.path.join(f.parent, rid)))
        self.assertEqual(f.run("remove", extra=["--token", token, "--confirm", "remove-plaintext"]), 0, f.out)
        self.assertFalse(os.path.exists(os.path.join(f.parent, rid)))
        self.assertTrue(os.path.exists(os.path.join(f.parent, rid + ".receipt.json")), "receipt and journal kept")

    def test_removal_refuses_a_swapped_directory(self):
        f = self.F(); self.assertEqual(f.run(), 0); token = f.kv("fb.token")[0]; rid = "20261022T080000Z-0a1b2c3d"
        d = os.path.join(f.parent, rid); os.rename(d, d + ".moved"); os.mkdir(d, 0o700)
        shutil.copy(os.path.join(d + ".moved", ".owner"), d)                              # even with a copied marker
        self.assertEqual(f.run("remove", extra=["--token", token, "--confirm", "remove-plaintext"]), 6)
        self.assertIn("identity", f.out); self.assertTrue(os.path.isdir(d) and os.path.isdir(d + ".moved"))


if __name__ == "__main__":
    unittest.main()
