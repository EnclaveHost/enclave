#!/usr/bin/env python3
"""recovery-multipart-stage/r2 END-TO-END tests with the REAL, frozen r9 reconstructed ext4 fixture (PREPARED by Claude 1748; root runs
them via jobs/e2e-tests.sh, NOT under unshare: FUSE needs the host fusermount3; NOT run by Claude).
r9's own fixture builder (debugfs-made ext4: /data/db/mdbx.dat of 3000 blocks, every odd block 1..2799 punched, deleted and the inode
number reused -> parent-clean.qcow2, 0444) and r9's overlay_plan.py (fixture mode) give the plan; orchestrate.py runs r9's
overlay_session.py (byte-identical private copy) with `multipart.py serve` as its exec, copies into two target dirs and verifies in a
SEPARATE session. The oracle is r9's model sha256 of the reconstructed file (plan target.expectedSha256), independent of this stage.
Environment (jobs/e2e-tests.sh): MULTIPART_E2E_WORK (0700 dir), MULTIPART_FUSE2FS, MULTIPART_FUSE2FS_SHA256. 6 tests."""
import contextlib, hashlib, io, json, os, signal, socket, subprocess, sys, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE = HERE.parent
sys.path.insert(0, str(STAGE)); sys.dont_write_bytecode = True
import multipart as MP   # noqa: E402
import orchestrate as O  # noqa: E402
sys.path.insert(0, O.R9); sys.path.insert(0, O.R9 + "/fixture")
import make_fixture as F   # noqa: E402  (frozen r9; the job verifies r9's SHA256SUMS)
import overlay_plan as P9  # noqa: E402

WORK = Path(os.environ["MULTIPART_E2E_WORK"])
FUSE2FS, FUSE2FS_SHA = os.environ["MULTIPART_FUSE2FS"], os.environ["MULTIPART_FUSE2FS_SHA256"]
TOOL, ORCH = str(STAGE / "multipart.py"), str(STAGE / "orchestrate.py")
PART = 4 << 20


def sha_path(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def run(argv, **kw):
    return subprocess.run([sys.executable, "-I", "-B", *argv], capture_output=True, text=True, timeout=900, env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"}, **kw)


def no_mount_of(path):
    with open("/proc/self/mountinfo") as f:
        return str(path) not in f.read()


class E2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.n = 0
        cls.fx = F.build(str(WORK / "fixture"))
        cls.plan_dir = WORK / "plan"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = P9.main(["fixture", "--capture", cls.fx["capture"], "--name", "mdbx.dat", "--path", MP.TARGET_PATH, "--out", str(cls.plan_dir)])
        assert rc == 0, "r9 fixture plan failed"
        plan = json.loads((cls.plan_dir / "plan.json").read_text())
        cls.L, cls.expected = plan["target"]["size"], plan["target"]["expectedSha256"]
        ext = [[b, 1, 0, False] for b in range(0, 2800, 2)] + [[2800, 200, 0, False]]     # r9 fixture: odd blocks 1..2799 punched
        assert cls.L == 3000 * 4096 and plan["map"]["extents"] == len(ext) == 1401, "r9 fixture shape changed"
        cls.map = WORK / "map.json"; cls.map.write_text(json.dumps({"map": {"extentList": ext, "extents": len(ext)}}))
        cls.journal = WORK / "journal.bin"; cls.journal.write_bytes(b"fixture journal stand-in\n")
        cls.parent = WORK / "fixture" / "parent-clean.qcow2"
        cls.parent_sha = cls.fx["parents"]["parent-clean.qcow2"]
        cls.plan_sha = sha_path(cls.plan_dir / "plan.json")

    def setUp(self):
        type(self).n += 1
        self.d = WORK / f"t{self.n:02d}"; self.d.mkdir(mode=0o700)
        self.ta, self.tb = self.d / "a", self.d / "b"
        self.ta.mkdir(mode=0o700); self.tb.mkdir(mode=0o700)
        self.k = 0

    def tearDown(self):
        self.assertEqual(sha_path(self.parent), self.parent_sha, "the parent changed")
        self.assertTrue(no_mount_of(self.d), "a mount of this test survived")

    def manifest(self, chunk=1 << 20, ckpt=2 << 20):
        r = run([TOOL, "plan", "--original", str(self.parent), "--map", str(self.map), "--overlay-plan", str(self.plan_dir / "plan.json"),
                 "--journal", str(self.journal), "--out", str(self.d / "manifest.json"), "--target", f"a={self.ta}", "--target", f"b={self.tb}",
                 "--assign", "a:0-1", "--assign", "b:2-2", "--logical-size", str(self.L), "--part-size", str(PART),
                 "--chunk-bytes", str(chunk), "--checkpoint-bytes", str(ckpt)])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.msha = json.loads(r.stdout)["manifestSha256"]

    def request(self, mode, **over):
        req = {"format": O.REQ_FORMAT, "purpose": O.PURPOSE, "kind": "fixture", "mode": mode, "recoveryAccepted": False, "productionUse": False,
               "raidReset": False, "manifestSha256": self.msha, "planSha256": self.plan_sha, "parentPath": str(self.parent),
               "multipartSha256": sha_path(TOOL), "orchestrateSha256": sha_path(ORCH), "overlaySessionSha256": O.PINS["overlaySessionSha256"]}
        req.update(over)
        self.k += 1
        p = self.d / f"request-{self.k}.json"; p.write_text(json.dumps(req))
        return str(p), sha_path(p)

    def orch_args(self, mode, *extra, req=None, parent=None, plan_dir=None):
        rp, rs = req or self.request(mode)
        self.k += 1
        self.run_dir = self.d / f"run-{self.k}"
        return [ORCH, "run", "--request", rp, "--request-sha256", rs, "--manifest", str(self.d / "manifest.json"), "--manifest-sha256", self.msha,
                "--run-dir", str(self.run_dir), "--mode", mode, "--accept-timeout", "300", "--fixture-plan-dir", str(plan_dir or self.plan_dir),
                "--fixture-parent", str(parent or self.parent), "--fixture-parent-sha256", self.parent_sha,
                "--fuse2fs", FUSE2FS, "--fuse2fs-sha256", FUSE2FS_SHA, *extra]

    def orch(self, mode, *extra, **kw):
        r = run(self.orch_args(mode, *extra, **kw))
        try:
            out = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            out = {}
        return r.returncode, out, r

    def receipt(self):
        return json.loads((self.run_dir / "session" / "receipt.json").read_text())

    def assert_clean_session(self, rc_expected=None):
        r = self.receipt()
        self.assertTrue(r["cleanupComplete"]); self.assertTrue(r["parentUnchanged"])
        if rc_expected is not None:
            self.assertEqual(r["rc"], rc_expected)
        self.assertTrue(no_mount_of(self.run_dir))

    def reassembled_sha(self):
        h = hashlib.sha256()
        for p in (self.ta / "part-0000.bin", self.ta / "part-0001.bin", self.tb / "part-0002.bin"):
            h.update(p.read_bytes())
        return h.hexdigest()

    def status(self):
        return MP.status(json.loads((self.d / "manifest.json").read_text()), self.msha)

    # ------------------------------------------------------------------------------------------------------------------------
    def test_e1_copy_then_verify_in_a_separate_session_equals_the_r9_model(self):
        self.manifest()
        rc, out, r = self.orch("copy")
        self.assertEqual(rc, 0, r.stdout + r.stderr); self.assertEqual(out["session"]["status"], "CONFIRMED")
        self.assert_clean_session(0); copy_sid = out["session"]["id"]
        self.assertEqual(self.reassembled_sha(), self.expected)                       # r9's independent model of the file
        rec = json.loads((self.ta / "part-0000.json").read_text())
        self.assertEqual((rec["source"]["kind"], rec["source"]["sessionId"], rec["source"]["target"]),
                         ("session", copy_sid, str(self.run_dir / "session/work/mnt") + MP.TARGET_PATH))
        st = self.status(); self.assertEqual((st["copyComplete"], st["verificationCompleteRecorded"]), (True, False))
        rc, out, r = self.orch("verify")
        self.assertEqual(rc, 0, r.stdout + r.stderr); self.assertEqual(out["session"]["status"], "CONFIRMED")
        self.assertNotEqual(out["session"]["id"], copy_sid)                          # a separate session
        self.assertTrue(all(v["freshlyMeasured"] for v in out["verified"]))
        st = self.status(); self.assertEqual((st["copyComplete"], st["verificationCompleteRecorded"]), (True, True))

    def test_e2_wrong_plan_parent_request_or_mode_refused_before_any_session(self):
        self.manifest()
        other_plan = self.d / "plan-other"; other_plan.mkdir(mode=0o700); (other_plan / "sources").mkdir(mode=0o700)
        (other_plan / "plan.json").write_text((self.plan_dir / "plan.json").read_text() + "\n")
        cases = [("plan sha", dict(req=self.request("copy", planSha256="0" * 64))),
                 ("production kind", dict(req=self.request("copy", kind="production"))),
                 ("mode", dict(req=self.request("verify"))),
                 ("recoveryAccepted", dict(req=self.request("copy", recoveryAccepted=True))),
                 ("other parent", dict(parent=WORK / "fixture" / "parent-reused.qcow2")),
                 ("other plan dir", dict(plan_dir=other_plan))]
        for name, kw in cases:
            with self.subTest(name):
                rc, out, r = self.orch("copy", **kw)
                self.assertEqual(rc, 3, (name, r.stdout, r.stderr))
                self.assertFalse(self.run_dir.exists(), "a refused run created its run dir")
        self.assertEqual(os.listdir(self.ta), [])

    def test_e3_an_impostor_peer_is_refused_and_the_session_cleans_up(self):
        self.manifest()
        p = subprocess.Popen([sys.executable, "-I", "-B", *self.orch_args("copy")], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
        sock = self.run_dir / "sock" / "mp.sock"
        end = time.monotonic() + 120
        while not sock.exists() and time.monotonic() < end:
            time.sleep(0.01)
        dfd = os.open(self.run_dir / "sock", os.O_RDONLY | os.O_DIRECTORY)
        s = socket.socket(socket.AF_UNIX); s.connect(f"/proc/self/fd/{dfd}/mp.sock"); os.close(dfd)
        s.sendall((json.dumps({"proto": MP.FMT["proto"], "size": self.L, "sourceKind": "recovery-target"}) + "\n").encode())
        o, e = p.communicate(timeout=900); s.close()
        self.assertEqual(p.returncode, 3, o + e); self.assertIn("not a child of our session", o)
        self.assertFalse(any(n.endswith(".json") and n.startswith("part-") for n in os.listdir(self.ta)))
        self.assert_clean_session()
        self.assertFalse((self.run_dir / "session-confirmation.json").exists())      # nothing was ever bound to this session

    def test_e4_cancel_while_waiting_for_the_server_cleans_socket_and_session(self):
        self.manifest()
        p = subprocess.Popen([sys.executable, "-I", "-B", *self.orch_args("copy")], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
        end = time.monotonic() + 120                                                 # the session is running (its work dir exists)
        while not ((self.run_dir / "sock" / "mp.sock").exists() and (self.run_dir / "session" / "work").exists()) and time.monotonic() < end:
            time.sleep(0.01)
        p.send_signal(signal.SIGTERM); o, e = p.communicate(timeout=900)
        self.assertEqual(p.returncode, 5, o + e)
        self.assertEqual(os.listdir(self.run_dir / "sock"), [])
        self.assert_clean_session()

    def test_e5_budget_stop_then_resume_in_a_new_session(self):
        self.manifest()
        rc, out, r = self.orch("copy", "--max-bytes", str(6 << 20))
        self.assertEqual(rc, 5, r.stdout + r.stderr); self.assertEqual(out["session"]["status"], "CONFIRMED"); self.assert_clean_session(0)
        self.assertTrue((self.ta / "part-0000.json").exists()); self.assertTrue((self.ta / "part-0001.ckpt.json").exists())
        rc, out, r = self.orch("copy")
        self.assertEqual(rc, 0, r.stdout + r.stderr); self.assert_clean_session(0)
        self.assertEqual(self.reassembled_sha(), self.expected)
        rc, out, r = self.orch("verify"); self.assertEqual(rc, 0, r.stdout + r.stderr)
        self.assertTrue(self.status()["verificationCompleteRecorded"])

    def test_e6_server_killed_mid_copy_unconfirms_the_session_until_a_fresh_verify(self):
        self.manifest(chunk=4096, ckpt=8192)                                          # slow enough to stop deterministically
        args = self.orch_args("copy")
        p = subprocess.Popen([sys.executable, "-I", "-B", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C"})
        ck = self.ta / "part-0001.ckpt.json"                                          # part 0 committed, part 1 under way
        end = time.monotonic() + 300
        while time.monotonic() < end:
            try:
                if (self.ta / "part-0000.json").exists() and json.loads(ck.read_text())["committedBytes"] >= 8192:
                    break
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(0.005)
        os.kill(p.pid, signal.SIGSTOP)
        want = str(self.run_dir / "multipart.py")
        servers = []
        for d in os.listdir("/proc"):
            if d.isdigit():
                with contextlib.suppress(OSError):
                    cmd = Path(f"/proc/{d}/cmdline").read_bytes().split(b"\0")
                    if len(cmd) > 4 and cmd[3].decode() == want and cmd[4] == b"serve":
                        servers.append(int(d))
        self.assertEqual(len(servers), 1, servers)
        os.kill(servers[0], signal.SIGKILL); os.kill(p.pid, signal.SIGCONT)
        o, e = p.communicate(timeout=900)
        self.assertEqual(p.returncode, 4, o + e)
        self.assertEqual(json.loads(o.strip().splitlines()[-1])["session"]["status"], "UNCONFIRMED")
        self.assert_clean_session(6)                                                  # the exec failed; cleanup still complete
        st = self.status(); self.assertFalse(st["copyComplete"]); self.assertEqual(st["unconfirmed"], [0])
        rc, out, r = self.orch("copy"); self.assertEqual(rc, 0, r.stdout + r.stderr)
        self.assertEqual(self.status()["unconfirmed"], [0])                         # still bound to the UNCONFIRMED session
        rc, out, r = self.orch("verify"); self.assertEqual(rc, 0, r.stdout + r.stderr)
        st = self.status(); self.assertEqual((st["copyComplete"], st["verificationCompleteRecorded"]), (True, True))
        self.assertEqual(self.reassembled_sha(), self.expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
