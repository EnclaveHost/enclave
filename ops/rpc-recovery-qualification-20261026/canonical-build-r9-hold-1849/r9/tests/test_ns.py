#!/usr/bin/env python3
"""base-state-readonly-stage/r9 tests/test_ns.py (prepared by Claude 1839/1844; NOT run by Claude). 5 tests that need a REAL private
`unshare -Urnm` namespace (jobs/ns-tests.sh). Outside one they FAIL (never skipped). Tests 1-4 bind only TEST directories under $TEST_TMP in
this namespace and unmount them again. Test 5 (review 1841 PB1) runs the PRODUCTION hardening `ns_harden /home/steven /tmp` and the
production checks in a NESTED private mount namespace child (`unshare -m --propagation private`): the inherited, locked submounts under
/home/steven and the tmpfs /tmp are exercised for real, while this test's own namespace - and the host - stay unchanged, so its outputs
and receipt can still be written under /home/steven afterwards. No file contents are read; nothing is written to USB or the original."""
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

    def test_5_production_hardening_of_home_and_tmp_in_a_nested_private_namespace(self):
        probe_home = os.path.join(TMP, "nested-probe")                   # under /home/steven: must be refused inside the child
        probe_tmp = f"/tmp/bsro-r9-ns-probe-{os.getpid()}"
        child = ('source "$1"; ns_harden /home/steven /tmp || exit 21; '
                 'python3 -I -B "$2" ns-check --ro /home/steven --ro /tmp --ro-root /home/steven --ro-root /tmp || exit 22; '
                 '( : > "$3" ) 2>/dev/null && exit 23; ( : > "$4" ) 2>/dev/null && exit 24; exit 0')
        try:
            p = subprocess.run(["unshare", "-m", "--propagation", "private", "/usr/bin/bash", "-c", child, "bash", str(STAGE / "jobs" / "ns.sh"),
                                str(STAGE / "jobs" / "bsro_gate.py"), probe_home, probe_tmp], capture_output=True, text=True, timeout=120,
                               env={"PATH": "/usr/bin:/bin"})
            self.assertEqual(p.returncode, 0, p.stdout[-2000:] + p.stderr[-2000:])
            self.assertFalse(os.path.exists(probe_home)); self.assertFalse(os.path.exists(probe_tmp))
            with open(probe_home, "w") as f:                             # back in OUR namespace: /home/steven is still writable
                f.write("parent still writable\n")
            self.assertFalse(os.statvfs(TMP).f_flag & os.ST_RDONLY)
        finally:
            for x in (probe_home, probe_tmp):
                if os.path.lexists(x):
                    os.unlink(x)

    def test_4_the_outer_check_refuses_inside_a_user_namespace(self):
        with self.assertRaises(G.Refused):
            G.maps_outside(rd("/proc/self/uid_map"), rd("/proc/self/gid_map"), os.getuid(), os.getgid())


if __name__ == "__main__":
    unittest.main()
