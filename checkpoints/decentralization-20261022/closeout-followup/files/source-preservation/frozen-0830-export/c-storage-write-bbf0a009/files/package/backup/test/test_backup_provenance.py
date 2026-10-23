"""Backup provenance for the T1 preflight (root's cutover review, 2026-10-23): the REAL chain on a v28-shaped fake VM.
  runner (v3 = B2 foreground 62f43690 + the running-release path) on a fake root (fake systemctl/docker/pgrep, as the pinned
  storage-fresh-backup tests) -> the PINNED pull_encrypt.py (ad297d48) with REAL gpg (throwaway GNUPGHOME and passphrase)
  over a fake ssh -> verify_archive.v2.py -> tools/cutover.py t1_preflight.
No receipt field is edited: every time, count and hash comes out of the runner's authenticated manifest. Negative controls
run the ORIGINAL runner 62f43690 and the ORIGINAL verifier b4f71bbb on the same layout.
Run as the normal user (gpg-agent); the runner enters a user namespace itself (euid 0, as on the VM). No network is used."""
import datetime, hashlib, json, os, shutil, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUP = os.path.dirname(HERE)
PACKAGE = os.path.dirname(BACKUP)
WORK = os.path.abspath(os.path.join(PACKAGE, "..", "..", ".."))
FRESH = os.path.join(WORK, "claude-resumed-20261022", "storage-fresh-backup")
RUNNER_V3 = os.path.join(BACKUP, "runner", "vm_fresh_backup.v3.py")
RUNNER_B2 = os.path.join(WORK, "resume-after-checkpoint-20261022", "controller-bounds-validation", "b2", "vm_fresh_backup.foreground.py")
VERIFY_V2 = os.path.join(BACKUP, "local", "verify_archive.v2.py")
VERIFY_V1 = os.path.join(FRESH, "local", "verify_archive.py")
PULL = os.path.join(FRESH, "local", "pull_encrypt.py")
FAKES = os.path.join(HERE, "fakes")
PINS = {RUNNER_B2: "62f4369029f6f66d1811ce25f9358a326b030913f67e1592df0f367600c67eb4", VERIFY_V1: "b4f71bbb83ac7db0d0f0d5a06a57729cb63dd81c6129cefc3f987f4cc3fb7e78",
        PULL: "ad297d480cdd282875b55b7cacc55ac27713b9c0c495a364d3375d2d87c4a073",
        os.path.join(FRESH, "local", "common.py"): "be0a9b0cd45ebcc5df1691c7169ceb7eb83c1e0ff1973d3cb56a60124fff9ba3"}
sys.path.insert(0, os.path.join(PACKAGE, "tools"))
import cutover as C  # noqa: E402

SENTINEL = "SENTINEL-CONFIG-SECRET-7f3a9c"
COUNTS = {"objects": 1491, "slabs": 562, "contracts": 78, "accounts": 1}        # the live primary's counts at its last backup
RID = "20261023T080000Z-0a1b2c3d"
sha = lambda b: hashlib.sha256(b).hexdigest()


def read(p, mode="r"):
    with open(p, mode) as f:
        return f.read()


def write(p, data, mode="w"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode) as f:
        f.write(data)


class V28Vm:
    """the minipc VM's layout after the 26->28 migration: the v26 binary still at /opt/enclave-indexd/indexd, the running
    release at /opt/enclave-indexd/releases/current/indexd (current -> <release dir>)"""
    n = 0

    def __init__(self, counts=COUNTS):
        V28Vm.n += 1
        self.base = os.path.join(HERE, f"tmp-{os.getpid()}-{V28Vm.n}")
        os.mkdir(self.base)
        self.root, self.fake = os.path.join(self.base, "root"), os.path.join(self.base, "fake")
        os.mkdir(self.fake)
        self.old_bin, self.new_bin = b"\x7fELF-v26-" + os.urandom(65536), b"\x7fELF-c2-enclave-" + os.urandom(65536)
        self.release = sha(self.new_bin)
        files = {"etc/enclave-indexd/indexd.yml": ("recoveryPhrase: " + SENTINEL + "\n").encode(),
                 "var/lib/enclave-indexd/state/consensus.db": os.urandom(2 << 20),
                 "var/lib/enclave-indexd/state/GeoLite2-City.mmdb": os.urandom(1 << 20),
                 "opt/enclave-indexd/indexd": self.old_bin,
                 f"opt/enclave-indexd/releases/{self.release}/indexd": self.new_bin}
        for p, b in files.items():
            write(os.path.join(self.root, p), b, "wb")
        os.makedirs(os.path.join(self.root, "run"))
        os.symlink(self.release, os.path.join(self.root, "opt/enclave-indexd/releases/current"))
        write(os.path.join(self.root, "etc/enclave-indexd/ALLOW_LIVE_START"), "")
        write(os.path.join(self.fake, "unit.json"), json.dumps({"ActiveState": "active", "SubState": "running", "MainPID": "4242", "UnitFileState": "enabled"}))
        write(os.path.join(self.fake, "proc"), "")
        write(os.path.join(self.fake, "behavior.json"), json.dumps({"db_version": 28, "counts": counts}))
        self.geo = sha(files["var/lib/enclave-indexd/state/GeoLite2-City.mmdb"])

    def capture(self, runner, expect_bin):
        args = ["unshare", "--user", "--map-root-user", sys.executable, runner, "capture", "--run-id", RID, "--confirm", "fresh-backup",
                "--expect-db-version", "28", "--expect-binary-sha256", expect_bin, "--expect-geoip-sha256", self.geo,
                "--quiesce-budget", "20", "--dump-timeout", "2"]
        r = subprocess.run(args, env={"PATH": FAKES + ":/usr/bin:/bin", "FB_ROOT": self.root, "FAKE_DIR": self.fake, "LC_ALL": "C"},
                           capture_output=True, timeout=120)
        return r.returncode, r.stdout.decode() + r.stderr.decode()

    def close(self):
        shutil.rmtree(self.base)


class Provenance(unittest.TestCase):
    def setUp(self):
        for p, want in PINS.items():
            self.assertEqual(sha(read(p, "rb")), want, f"pinned input changed: {p}")
        self.vm = V28Vm()
        self.ws = os.path.join(self.vm.base, "ws")
        self.private, self.outputs = os.path.join(self.ws, "private"), os.path.join(self.ws, "outputs")
        os.makedirs(self.private, 0o700); os.chmod(self.private, 0o700); os.makedirs(self.outputs)
        self.gnupg = os.path.join(self.vm.base, "gnupg"); os.mkdir(self.gnupg, 0o700)
        self.passfile = os.path.join(self.private, "test-only.pass")
        write(self.passfile, "throwaway-test-passphrase\n"); os.chmod(self.passfile, 0o600)

    def tearDown(self):
        subprocess.run(["gpgconf", "--kill", "all"], env=self.env(), capture_output=True)
        for dp, _, fs in os.walk(self.ws):
            for f in fs:
                if f.endswith((".json", ".log")):
                    self.assertNotIn(SENTINEL.encode(), read(os.path.join(dp, f), "rb"), f)
        self.vm.close()

    def env(self):
        return {"PATH": "/usr/bin:/bin", "GNUPGHOME": self.gnupg, "FB_SSH": os.path.join(FAKES, "ssh"), "FAKE_REMOTE": self.vm.root,
                "FAKE_DIR": self.vm.fake, "LC_ALL": "C"}

    def tool(self, path, *extra):
        r = subprocess.run([sys.executable, path, "--run-id", RID, "--passphrase-file", self.passfile, "--private-dir", self.private,
                            "--outputs-dir", self.outputs, *extra], env=self.env(), capture_output=True, timeout=300, cwd=self.ws)
        out = r.stdout.decode() + r.stderr.decode()
        self.assertNotIn(SENTINEL, out)
        return r.returncode, out

    def backup(self, runner=RUNNER_V3, expect=None):
        rc, out = self.vm.capture(runner, expect or self.vm.release)
        self.assertEqual(rc, 0, out)
        rc, out = self.tool(PULL); self.assertEqual(rc, 0, out)
        rc, out = self.tool(VERIFY_V2); self.assertEqual(rc, 0, out)
        return json.loads(read(os.path.join(self.outputs, f"storage-fresh-backup-{RID}-integrity-v2.json")))

    def vm_state(self, cas="0", fenced="0"):
        r = self.vm.release
        return "\n".join([f"current={r}", f"currentSha={r}", "unit.ActiveState=active", "unit.SubState=running", "unit.NeedDaemonReload=no",
                          f"runningExeSha={r}", "dbVersion=28", f"fencedAccounts={fenced}", f"casEnrolledAccounts={cas}", "scratchDatabases=",
                          "controllerSessions=", "toolSessions=", "lockHeld=no"]) + "\n"

    def preflight(self, rec, minutes_after_capture=5, stopped_minutes_before=5, live=None, vm_text=None, **kw):
        cap = C.when(rec["capturedAt"], "capturedAt")
        now = cap + datetime.timedelta(minutes=minutes_after_capture)
        stopped = (cap - datetime.timedelta(minutes=stopped_minutes_before)).isoformat()
        live = {"objects": COUNTS["objects"], "accounts": COUNTS["accounts"]} if live is None else live
        return C.t1_preflight(vm_text or self.vm_state(), rec, now, stopped, live, release=self.vm.release, **kw)

    def test_the_v3_backup_binds_the_running_release_and_its_capture_time(self):
        rec = self.backup()
        self.assertTrue(rec["pass"]); self.assertEqual(rec["format"], "storage-fresh-backup-integrity/v2")
        self.assertEqual(rec["binarySha256"], self.vm.release, "the RUNNING release is bundled")
        self.assertNotEqual(rec["binarySha256"], sha(self.vm.old_bin))
        self.assertEqual((rec["manifestRunId"], rec["runId"], rec["source"], rec["dbVersion"], rec["counts"]), (RID, RID, "minipc / enclave-storage", 28, COUNTS))
        self.assertTrue(rec["manifestBoundToRun"] and rec["captureTimeAuthenticated"])
        self.assertLessEqual(C.when(rec["capturedAt"], "c"), C.when(rec["verifiedAt"], "v"))
        r = self.preflight(rec)
        self.assertEqual(r["verdict"], "GO", r["reasons"])
        self.assertEqual(r["dataLossBoundary"], rec["capturedAt"])

        def nogo(why, **kw):
            x = self.preflight(rec, **kw)
            self.assertEqual(x["verdict"], "NO-GO", why)
            return x["reasons"]
        # capture age is judged on the AUTHENTICATED capture time, whatever the verification age allows
        rs = nogo("captured 3 h ago", minutes_after_capture=180, max_verify_age_h=1000)
        self.assertTrue(any("CAPTURED 3.00 h ago" in x for x in rs), rs)
        rs = nogo("captured in the future", minutes_after_capture=-60)
        self.assertTrue(any("captured in the future" in x for x in rs), rs)
        rs = nogo("the legacy writer stopped AFTER the capture", stopped_minutes_before=-2)
        self.assertTrue(any("AFTER the capture" in x for x in rs), rs)
        rs = nogo("a write after the capture", live={"objects": COUNTS["objects"] + 1, "accounts": 1})
        self.assertTrue(any("something wrote after the capture" in x for x in rs), rs)
        nogo("an enrolled account", vm_text=self.vm_state(cas="1"))
        nogo("a fenced account", vm_text=self.vm_state(fenced="1"))
        with self.assertRaises(C.Refused):
            C.when("2026-10-23T07:00:00", "--now")                                  # the CLI refuses a time without its zone
        x = C.t1_preflight(self.vm_state(), rec, C.when(rec["capturedAt"], "c") + datetime.timedelta(minutes=5), "2026-10-23T07:00:00",
                           {"objects": 1491, "accounts": 1}, release=self.vm.release)
        self.assertTrue(any("has no time zone" in y for y in x["reasons"]), x["reasons"])

    def test_the_original_verifier_has_no_capture_time_so_its_receipt_is_never_go(self):
        rc, out = self.vm.capture(RUNNER_V3, self.vm.release); self.assertEqual(rc, 0, out)
        rc, out = self.tool(PULL); self.assertEqual(rc, 0, out)
        rc, out = self.tool(VERIFY_V1); self.assertEqual(rc, 0, out)
        v1 = json.loads(read(os.path.join(self.outputs, f"storage-fresh-backup-{RID}-integrity.json")))
        self.assertTrue(v1["pass"]); self.assertNotIn("capturedAt", v1, "the counterexample: v1 drops the authenticated capture time")
        now = C.when(v1["verifiedAt"], "v")
        r = C.t1_preflight(self.vm_state(), v1, now, (now - datetime.timedelta(hours=1)).isoformat(), {"objects": 1491, "accounts": 1}, release=self.vm.release)
        self.assertEqual(r["verdict"], "NO-GO")
        self.assertTrue(any("format None" in x for x in r["reasons"]) and any("capturedAt None" in x for x in r["reasons"]), r["reasons"])

    def test_the_original_b2_runner_cannot_back_up_the_running_release(self):
        other = V28Vm()                       # its own fake VM: a refused run id stays used (the runner never reuses one)
        try:
            rc, out = other.capture(RUNNER_B2, other.release)
            self.assertEqual(rc, 5, "62f43690 reads /opt/enclave-indexd/indexd (the v26 binary): it refuses the running release's hash\n" + out)
            self.assertIn("binary", out)
        finally:
            other.close()
        rc, out = self.vm.capture(RUNNER_B2, sha(self.vm.old_bin))
        self.assertEqual(rc, 0, out)
        rc, out = self.tool(PULL); self.assertEqual(rc, 0, out)
        rc, out = self.tool(VERIFY_V2); self.assertEqual(rc, 0, out)
        rec = json.loads(read(os.path.join(self.outputs, f"storage-fresh-backup-{RID}-integrity-v2.json")))
        self.assertEqual(rec["binarySha256"], sha(self.vm.old_bin), "it bundles the v26 binary with the v28 database")
        r = self.preflight(rec)
        self.assertEqual(r["verdict"], "NO-GO")
        self.assertTrue(any("is not the running release" in x for x in r["reasons"]), r["reasons"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
