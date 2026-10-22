"""Workstation half: pull_encrypt -> verify_archive -> rehearsal_input, with REAL gpg (throwaway GNUPGHOME and a throwaway
passphrase file - never the production one) and a fake ssh that maps the VM paths onto a fixture run produced by the real
runner on the fake VM (test_runner.Fixture). The extracted input is checked by root's real
indexd-c2-production-rehearsal/preflight-fresh-backup.sh (layout + receipt sections; the sections about frozen binaries,
docker images and capacity depend on this machine and are not asserted)."""
import json, os, shutil, subprocess, sys, tarfile, unittest, io
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
sys.path.insert(0, HERE)
from test_runner import Fixture, SENTINEL  # noqa: E402

LOCAL = os.path.join(PKG, "local")
WORK = os.path.abspath(os.path.join(PKG, "..", ".."))
PREFLIGHT = os.path.join(WORK, "indexd-c2-production-rehearsal", "preflight-fresh-backup.sh")
RID = "20261022T080000Z-0a1b2c3d"


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.vm = Fixture()
        self.assertEqual(self.vm.run(), 0, self.vm.out)
        self.ws = os.path.join(self.vm.base, "ws")
        self.private = os.path.join(self.ws, "private"); self.outputs = os.path.join(self.ws, "outputs")
        os.makedirs(self.private, 0o700); os.chmod(self.private, 0o700); os.makedirs(self.outputs)
        self.gnupg = os.path.join(self.vm.base, "gnupg"); os.mkdir(self.gnupg, 0o700)
        self.passfile = os.path.join(self.private, "test-only.pass")
        _wr(self.passfile, "throwaway-test-passphrase\n"); os.chmod(self.passfile, 0o600)

    def tearDown(self):
        subprocess.run(["gpgconf", "--kill", "all"], env=self.env(), capture_output=True)
        for dp, _, fs in os.walk(self.ws):
            for f in fs:
                if f.endswith((".json", ".log")):
                    self.assertNotIn(SENTINEL.encode(), _rd(os.path.join(dp, f), "rb"), f)
        self.vm.close()

    def env(self, **kw):
        return {"PATH": "/usr/bin:/bin", "GNUPGHOME": self.gnupg, "FB_SSH": os.path.join(HERE, "fakes", "ssh"),
                "FAKE_REMOTE": self.vm.root, "FAKE_DIR": self.vm.fake, "LC_ALL": "C", **kw}

    def tool(self, name, *args, **envkw):
        r = subprocess.run([sys.executable, os.path.join(LOCAL, name), "--run-id", RID, "--passphrase-file", self.passfile,
                            "--private-dir", self.private, "--outputs-dir", self.outputs, *args],
                           env=self.env(**envkw), capture_output=True, timeout=300, cwd=self.ws)
        out = r.stdout.decode() + r.stderr.decode()
        self.assertNotIn(SENTINEL, out)
        return r.returncode, out

    def archive(self):
        return os.path.join(self.private, f"indexd-minipc-fresh-{RID}.tar.gpg")

    def test_pull_verify_extract_and_rehearsal_preflight(self):
        rc, out = self.tool("pull_encrypt.py"); self.assertEqual(rc, 0, out)
        self.assertEqual(oct(os.stat(self.archive()).st_mode & 0o777), "0o600")
        self.assertNotIn(SENTINEL.encode(), _rd(self.archive(), "rb"), "the archive is encrypted")
        rec = _jload(os.path.join(self.outputs, f"storage-fresh-backup-{RID}.json"))
        self.assertFalse(rec["decryptionKeyReplicated"]); self.assertEqual(rec["replicas"], [])
        rc, out = self.tool("verify_archive.py"); self.assertEqual(rc, 0, out)
        self.assertTrue(json.loads(out)["pass"])
        inp = os.path.join(self.ws, "rehearsal-input")
        rc, out = self.tool("rehearsal_input.py", "--out-dir", inp); self.assertEqual(rc, 0, out)
        self.assertNotIn("indexd.yml", os.listdir(os.path.join(inp, "retirement-snapshot")))
        for dp, _, fs in os.walk(inp):
            for f in fs:
                self.assertNotIn(SENTINEL.encode(), _rd(os.path.join(dp, f), "rb"), f)
        rr = _jload(os.path.join(inp, "retirement-extraction-receipt.json"))
        self.assertIs(rr["configAndOperationsSecretsExtracted"], False)
        pf = subprocess.run(["bash", PREFLIGHT, inp], capture_output=True, text=True, timeout=120)
        sections = pf.stdout.split("== frozen binaries")[0]
        self.assertIn("== receipts (hashes only)", sections)
        self.assertNotIn("FAIL", sections, sections)
        # layout: dir + 6 files = 7; receipts: 4 snapshot hashes + live dump + 2 pg_dump magics + receipt keys = 8
        self.assertEqual(sections.count("  ok   "), 15, sections)
        self.assertIn("configAndOperationsSecretsExtracted = False", sections)

    def test_transport_dying_mid_stream_publishes_nothing(self):
        rc, out = self.tool("pull_encrypt.py", FAKE_SSH_MODE="die-mid-stream"); self.assertEqual(rc, 1, out)
        self.assertEqual(sorted(os.listdir(self.private)), ["fresh-backup-%s.log" % RID, "test-only.pass"])
        self.assertEqual(os.listdir(self.outputs), [], "no receipt without a complete archive")

    def test_refuses_a_vm_run_that_is_not_complete(self):
        rp = os.path.join(self.vm.parent, RID + ".receipt.json"); r = _jload(rp)
        for k, v in (("outcome", "UNRESTORED:backup-complete"), ("sourceResumed", False), ("coupled", False)):
            with self.subTest(k=k):
                _jdump({**r, k: v}, rp)
                rc, out = self.tool("pull_encrypt.py"); self.assertNotEqual(rc, 0); self.assertIn("refused", out)
                self.assertFalse(os.path.exists(self.archive()))
        _jdump(r, rp)
        os.unlink(rp)
        rc, out = self.tool("pull_encrypt.py"); self.assertIn("UNKNOWN", out)

    def test_existing_outputs_are_never_overwritten(self):
        _wr(self.archive(), "older archive")
        rc, out = self.tool("pull_encrypt.py"); self.assertNotEqual(rc, 0); self.assertIn("already exists", out)
        self.assertEqual(_rd(self.archive()), "older archive")

    def test_tampered_or_wrong_key_archive_fails_and_cannot_be_extracted(self):
        self.assertEqual(self.tool("pull_encrypt.py")[0], 0)
        b = bytearray(_rd(self.archive(), "rb")); b[len(b) // 2] ^= 1
        _wr(self.archive(), bytes(b), "wb")
        rc, out = self.tool("verify_archive.py"); self.assertEqual(rc, 1, out)
        res = json.loads(out); self.assertFalse(res["pass"]); self.assertFalse(res["archiveSha256MatchesReceipt"])
        rc, out = self.tool("rehearsal_input.py", "--out-dir", os.path.join(self.ws, "inp")); self.assertNotEqual(rc, 0)
        self.assertFalse(os.path.exists(os.path.join(self.ws, "inp")))

    def test_extra_member_or_manifest_mismatch_fails_verification(self):
        self.assertEqual(self.tool("pull_encrypt.py")[0], 0)
        rp = os.path.join(self.outputs, f"storage-fresh-backup-{RID}.json"); rec = _jload(rp)
        # re-encrypt the same members plus one extra with the same test key; keep the receipt's archive hash in step
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as t:
            d = os.path.join(self.vm.parent, RID)
            for n in ["indexd.pgdump", "consensus.db", "indexd", "indexd.yml", "GeoLite2-City.mmdb", "counts.json", "manifest.json"]:
                t.add(os.path.join(d, n), arcname=n)
            extra = tarfile.TarInfo("operations.tar.gz"); extra.size = 3; t.addfile(extra, io.BytesIO(b"abc"))
        os.unlink(self.archive())
        subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-file", self.passfile, "--symmetric",
                        "--cipher-algo", "AES256", "--output", self.archive()], input=buf.getvalue(), env=self.env(), check=True, capture_output=True)
        import hashlib
        rec["sha256"] = hashlib.sha256(_rd(self.archive(), "rb")).hexdigest(); os.unlink(rp); _jdump(rec, rp)
        rc, out = self.tool("verify_archive.py"); self.assertEqual(rc, 1, out)
        self.assertFalse(json.loads(out)["authenticatedDecryptionPassed"])
        os.unlink(os.path.join(self.outputs, f"storage-fresh-backup-{RID}-integrity.json"))
        rec2 = {**rec, "sourceSnapshot": {**rec["sourceSnapshot"], "counts": {"objects": 999}}}; os.unlink(rp); _jdump(rec2, rp)
        rc, out = self.tool("verify_archive.py"); self.assertEqual(rc, 1)
        self.assertFalse(json.loads(out)["manifestEqualsPullTimeManifest"])


if __name__ == "__main__":
    unittest.main()
