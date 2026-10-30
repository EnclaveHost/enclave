#!/usr/bin/env python3
"""base-state-readonly-stage/r8 tests/test_ns.py (prepared by Claude 1839; NOT run by Claude). 4 tests that need a REAL private
`unshare -Urnm` namespace (jobs/ns-tests.sh). Outside one they FAIL (never skipped). Every mount is made in this namespace only, on a
TEST directory under $TEST_TMP, and is unmounted again; /home/steven and /tmp are never bound here."""
import errno, importlib.util, os, subprocess, tempfile, unittest
from pathlib import Path

STAGE = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("bsro_gate", STAGE / "jobs" / "bsro_gate.py")
G = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(G)
TMP = os.environ.get("TEST_TMP")


def rd(p):
    with open(p) as f:
        return f.read()


class Namespace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m = G.parse_map(rd("/proc/self/uid_map")); n = G.parse_map(rd("/proc/self/gid_map"))
        if len(m) != 1 or m[0][0] != 0 or m[0][2] != 1 or len(n) != 1:
            raise AssertionError("not inside an `unshare -Urnm` user namespace: these tests cannot pass here")
        cls.ouid, cls.ogid = m[0][1], n[0][1]

    def harden(self, d):
        p = subprocess.run(["/usr/bin/bash", "-c", 'source "$1"; ns_harden "$2"', "bash", str(STAGE / "jobs" / "ns.sh"), d],
                           capture_output=True, text=True, timeout=60, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def unmount(self, d):
        subprocess.run(["umount", d], capture_output=True, timeout=60)

    def test_1_inside_maps_are_exactly_root_to_the_real_user(self):
        self.assertTrue(G.maps_inside(rd("/proc/self/uid_map"), rd("/proc/self/gid_map"), rd("/proc/self/setgroups"), self.ouid, self.ogid))
        with self.assertRaises(G.Refused):
            G.maps_inside(rd("/proc/self/uid_map"), rd("/proc/self/gid_map"), rd("/proc/self/setgroups"), self.ouid + 1, self.ogid)

    def test_2_ns_harden_makes_propagation_private_then_the_bind_read_only(self):
        d = tempfile.mkdtemp(prefix="ro", dir=TMP)
        self.harden(d)
        try:
            self.assertTrue(G.propagation_private(rd("/proc/self/mountinfo")))
            self.assertTrue(G.read_only([d]))
            with self.assertRaises(OSError) as cm:
                with open(os.path.join(d, "x"), "w") as f:
                    f.write("x")
            self.assertEqual(cm.exception.errno, errno.EROFS)
        finally:
            self.unmount(d)

    def test_3_read_only_and_writable_checks_refuse_the_wrong_state(self):
        rw = tempfile.mkdtemp(prefix="rw", dir=TMP)
        with self.assertRaises(G.Refused):
            G.read_only([rw])                                            # not bound read-only
        ro = tempfile.mkdtemp(prefix="ro", dir=TMP)
        self.harden(ro)
        try:
            with self.assertRaises(G.Refused):
                G.read_only([], writable=[ro])                           # the /vm build dir role must stay writable
            self.assertTrue(G.read_only([ro], writable=[rw]))
        finally:
            self.unmount(ro)

    def test_4_the_outer_check_refuses_inside_a_user_namespace(self):
        with self.assertRaises(G.Refused):
            G.maps_outside(rd("/proc/self/uid_map"), rd("/proc/self/gid_map"), os.getuid(), os.getgid())


if __name__ == "__main__":
    unittest.main()
