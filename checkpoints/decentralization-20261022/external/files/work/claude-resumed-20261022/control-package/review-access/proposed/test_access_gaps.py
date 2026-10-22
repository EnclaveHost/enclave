#!/usr/bin/env python3
"""review-access: three gaps in the r3 config_file_access exception (storage-migration-r3/controller/replicactl.py 90a325b0).
Each is shown on the r3 controller (the gap is ACCEPTED) and on the proposed copy here (REFUSED). The clean production-shaped
layout stays accepted by both. Real files, real modes, real ACLs (setfacl) and real lstat. Only the passwd/group databases
are the same injected fakes as r3's test_access.py: 'root' maps to this test user.
  G1: a read ACL for another user leaves the mode at 0640.
  G2: a symlinked config directory is followed by r3's os.stat(dirname).
  G3: a group/other-writable ANCESTOR of the config directory is not checked by r3."""
import importlib.util, os, pathlib, shutil, subprocess, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent
R3 = H.parents[1] / "storage-migration-r3" / "controller"
def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
C3, CP = load("r3", R3 / "replicactl.py"), load("proposed", H / "replicactl.py")
T = load("t", R3 / "test_access.py")      # lookups()/SPEC fixtures only
SPEC, lookups = T.SPEC, T.lookups

class Gaps(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="review-access-"); os.chmod(self.t, 0o755); self.root = pathlib.Path(self.t)
    def tearDown(self): shutil.rmtree(self.t)
    def layout(self, base):
        d = base / "etc-enclave-indexd"; d.mkdir(parents=True); os.chmod(d, 0o755)
        f = d / "indexd.yml"; f.write_text("x: 1\n"); os.chmod(f, 0o640); return f
    def check(self, mod, f): return mod.check_trusted_group_access(str(f), SPEC, **lookups())

    def test_baseline_production_shape_accepted_by_both(self):
        f = self.layout(self.root)
        self.assertEqual(self.check(C3, f), []); self.assertEqual(self.check(CP, f), [])

    def test_g1_read_acl_for_another_user(self):
        if not shutil.which("setfacl"): self.skipTest("setfacl not installed")
        f = self.layout(self.root)
        r = subprocess.run(["setfacl", "-m", "u:nobody:r", str(f)], capture_output=True, text=True)
        if r.returncode: self.skipTest("filesystem without POSIX ACLs: " + r.stderr.strip())
        self.assertEqual(oct(os.lstat(f).st_mode & 0o7777), "0o640", "the ACL is invisible in the mode")
        self.assertEqual(self.check(C3, f), [], "r3 GAP: accepts a file another user can read")
        self.assertTrue(any("POSIX access ACL" in b for b in self.check(CP, f)), self.check(CP, f))

    def test_g2_symlinked_config_directory(self):
        real = self.layout(self.root / "real").parent
        link = self.root / "etc-link"; link.symlink_to(real)
        f = link / "indexd.yml"
        self.assertEqual(self.check(C3, f), [], "r3 GAP: follows the symlinked directory")
        self.assertTrue(any("is not a directory" in b for b in self.check(CP, f)), self.check(CP, f))

    def test_g3_writable_ancestor(self):
        a = self.root / "ancestor"; a.mkdir(); os.chmod(a, 0o777)          # anyone could rename the config directory away
        f = self.layout(a)
        self.assertEqual(self.check(C3, f), [], "r3 GAP: only the immediate parent is checked")
        self.assertTrue(any("ancestor" in b and str(a) in b for b in self.check(CP, f)), self.check(CP, f))
        os.chmod(a, 0o1777)                                                   # sticky but NOT root-owned: still refused
        self.assertTrue(any("ancestor" in b for b in self.check(CP, f)))
        os.chmod(a, 0o755); self.assertEqual(self.check(CP, f), [])

    def test_existing_refusals_unchanged(self):
        f = self.layout(self.root)
        for m in (0o600, 0o644, 0o660):
            os.chmod(f, m)
            with self.subTest(mode=oct(m)): self.assertTrue(any("mode" in b for b in self.check(CP, f)))
        os.chmod(f, 0o640)
        lnk = f.parent / "l.yml"; lnk.symlink_to(f)
        self.assertTrue(any("regular file" in b for b in self.check(CP, lnk)))
        os.chmod(f.parent, 0o775); self.assertTrue(any("config directory" in b for b in self.check(CP, f)))

if __name__ == "__main__": unittest.main()
