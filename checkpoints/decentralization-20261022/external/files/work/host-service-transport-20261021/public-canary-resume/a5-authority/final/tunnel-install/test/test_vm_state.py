#!/usr/bin/env python3
"""vm/vm-state.py (the control VM half: install + rollback by receipt and exact hashes) against a temp root (TEST_ROOT).
No systemctl, no real path. ROLLBACK=old runs the SAME scenarios through v1's rollback (test/old/vm-rollback-v1.sh): the
B5 tests must then FAIL (equal-line-count clobber, deleting files a refused apply never installed, conflicts unseen)."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE.parent / "vm" / "vm-state.py"
OLD = HERE / "old" / "vm-rollback-v1.sh"
MODE = os.environ.get("ROLLBACK", "v2")
sha = lambda b: hashlib.sha256(b).hexdigest()
LINE = "minipc-hyperv ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinnedMinipcHostKeyForTheTestOnly0000000000"
KH0 = (b"10.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFrontOneOldKey00000000000000000000000000000\n"
       b"10.0.0.2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFrontTwoKey000000000000000000000000000000000\n")


class VmStateTests(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="vm-state-test-"))
        self.kh = self.t / "var/lib/enclave-control-tunnel/known_hosts"; self.kh.parent.mkdir(parents=True)
        self.kh.write_bytes(KH0); os.chmod(self.kh, 0o640)
        self.unit = self.t / "etc/systemd/system/enclave-control-tunnel-minipc.service"
        self.script = self.t / "usr/local/libexec/enclave-control-tunnel-minipc.sh"
        (self.t / "payload").mkdir()
        (self.t / "payload/script").write_bytes(b"#!/bin/sh\necho tunnel\n"); (self.t / "payload/unit").write_bytes(b"[Unit]\nDescription=t\n")

    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)

    def tool(self, *a):
        r = subprocess.run([sys.executable, str(TOOL), *a], env={**os.environ, "TEST_ROOT": str(self.t)}, capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])

    def apply(self, kh_sha=None):
        return self.tool("apply", str(self.t / "payload/script"), str(self.t / "payload/unit"), LINE, kh_sha or sha(self.kh.read_bytes()))

    def rollback(self):
        if MODE == "old":
            # v1 kept its copy in .backup/known_hosts.orig (written by v1 apply before the append): same bytes as v2's copy
            orig = self.t / "var/lib/enclave-control-tunnel-minipc.state/known_hosts.orig"
            if orig.exists():
                b = self.t / "var/lib/enclave-control-tunnel-minipc.backup"; b.mkdir(exist_ok=True); shutil.copy2(orig, b / "known_hosts.orig")
                os.chmod(b / "known_hosts.orig", 0o640)                    # v1 apply used cp -p: the original's mode
            r = subprocess.run(["bash", str(OLD)], env={**os.environ, "T": str(self.t)}, capture_output=True, text=True)
            return r.returncode, {"decision": "(v1 has no decision)", "out": r.stdout}
        return self.tool("rollback")

    def test_unchanged_rollback_is_byte_identical(self):
        rc, a = self.apply(); self.assertEqual(rc, 0, a)
        self.assertTrue(self.unit.exists() and self.script.exists()); self.assertIn(LINE.encode(), self.kh.read_bytes())
        rc, r = self.rollback()
        self.assertEqual(self.kh.read_bytes(), KH0); self.assertEqual(self.kh.stat().st_mode & 0o777, 0o640)
        self.assertFalse(self.unit.exists() or self.script.exists())
        self.assertEqual([x.name for x in self.kh.parent.iterdir()], ["known_hosts"], "no temp file left beside the shared file")
        if MODE != "old": self.assertEqual((rc, r["decision"]), (0, "rolled-back"), r)

    def test_equal_line_count_host_key_rotation_survives(self):
        """B5: a legitimate rotation of ANOTHER host's key after apply keeps the line count equal; it must survive"""
        rc, a = self.apply(); self.assertEqual(rc, 0, a)
        rotated = self.kh.read_bytes().replace(b"FrontOneOldKey", b"FrontOneNEWKey")
        self.kh.write_bytes(rotated)
        rc, r = self.rollback()
        want = KH0.replace(b"FrontOneOldKey", b"FrontOneNEWKey")
        self.assertEqual(self.kh.read_bytes(), want, "every byte but this run's ONE line is kept (the rotation survives)")
        if MODE != "old": self.assertEqual((rc, r["decision"]), (0, "rolled-back"), r)

    def test_refused_apply_leaves_pre_existing_files_and_rollback_touches_nothing(self):
        """B5: a unit/script that this run did NOT install (e.g. another installer's) is never deleted"""
        self.unit.parent.mkdir(parents=True); self.unit.write_bytes(b"[Unit]\nDescription=someone else's\n")
        self.script.parent.mkdir(parents=True); self.script.write_bytes(b"#!/bin/sh\n# someone else's\n")
        before = {p: p.read_bytes() for p in (self.unit, self.script, self.kh)}
        rc, a = self.apply(); self.assertEqual(rc, 3, a); self.assertTrue(a["decision"].startswith("refused"), a)
        rc, r = self.rollback()
        for p, b in before.items(): self.assertEqual(p.read_bytes() if p.exists() else None, b, f"{p} untouched")
        if MODE != "old": self.assertEqual((rc, r["decision"][:20]), (0, "nothing-to-roll-back"), r)

    def test_changed_unit_is_a_conflict_not_success(self):
        rc, a = self.apply(); self.assertEqual(rc, 0, a)
        self.unit.write_bytes(b"[Unit]\nDescription=edited by root after apply\n")
        rc, r = self.rollback()
        self.assertEqual(self.unit.read_bytes(), b"[Unit]\nDescription=edited by root after apply\n", "a changed unit is left in place")
        self.assertFalse(self.script.exists()); self.assertEqual(self.kh.read_bytes(), KH0)
        if MODE != "old":
            self.assertEqual(rc, 4); self.assertEqual(r["decision"], "rollback-conflict: manual review"); self.assertTrue(r["conflicts"])
            self.assertTrue((self.t / "var/lib/enclave-control-tunnel-minipc.state/receipt.json").exists(), "the receipt stays for the manual review")

    def test_a_second_copy_of_the_line_is_a_conflict(self):
        rc, a = self.apply(); self.assertEqual(rc, 0, a)
        with open(self.kh, "ab") as f: f.write(LINE.encode() + b"\n")
        cur = self.kh.read_bytes()
        rc, r = self.rollback()
        self.assertEqual(self.kh.read_bytes(), cur, "ambiguous ownership: left exactly as found")
        if MODE != "old": self.assertEqual((rc, r["decision"]), (4, "rollback-conflict: manual review"), r)

    def test_a_crash_before_the_record_is_a_conflict_not_success(self):
        """apply died after writing the script but before recording it: rollback must not delete it on a guess, nor say done"""
        st = self.t / "var/lib/enclave-control-tunnel-minipc.state"; st.mkdir(parents=True)
        (st / "receipt.json").write_text(json.dumps({"knownHostsBefore": sha(KH0), "line": LINE, "scriptInstalled": None,
                                                     "unitInstalled": None, "knownHostsAfter": None}))
        shutil.copy2(self.kh, st / "known_hosts.orig")
        self.script.parent.mkdir(parents=True); self.script.write_bytes(b"#!/bin/sh\necho tunnel\n")
        rc, r = self.rollback()
        self.assertTrue(self.script.exists(), "an unrecorded file is left for review"); self.assertEqual(self.kh.read_bytes(), KH0)
        if MODE != "old": self.assertEqual((rc, r["decision"]), (4, "rollback-conflict: manual review"), r)

    def test_apply_refuses_unpinned_known_hosts_and_existing_alias(self):
        rc, a = self.apply(kh_sha="0" * 64); self.assertEqual(rc, 3); self.assertIn("not the pinned file", a["decision"])
        self.kh.write_bytes(KH0 + LINE.encode() + b"\n")
        rc, a = self.apply(); self.assertEqual(rc, 3); self.assertIn("alias already present", a["decision"])
        self.assertFalse((self.t / "var/lib/enclave-control-tunnel-minipc.state/receipt.json").exists())
        self.assertFalse(self.unit.exists() or self.script.exists())

    def test_a_second_apply_is_refused(self):
        self.assertEqual(self.apply()[0], 0)
        rc, a = self.tool("apply", str(self.t / "payload/script"), str(self.t / "payload/unit"), LINE, sha(self.kh.read_bytes()))
        self.assertEqual(rc, 3); self.assertIn("a receipt exists", a["decision"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
