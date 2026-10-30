#!/usr/bin/env python3
"""capture-namespace-qualification-stage/r1 tests/test_cnq.py (PREPARED by Claude 1895; NOT run by Claude). 8 PURE unit tests: no namespace,
mount, probe or write; they read only this stage and the pinned frozen sources. The ACTUAL namespace test is jobs/ns-qual.sh."""
import importlib.util, os, re, unittest
from pathlib import Path

ST = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("cnq", ST / "cnq.py")
Q = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(Q)
R3 = Path(Q.PINS["r3Inner"][0]).parent.parent
UID = 1000
RS = Q.roots(UID)


def mi(*rows):
    return "".join(f"{i} 1 0:{i} / {mp} rw,relatime - {fs} src rw\n" for i, (mp, fs) in enumerate(rows, 30))


def good():
    return ({"set": RS, "bashSet": RS, "r3RoPaths": RS, "nsChecks": True, "workWritable": True, "symlinkRefused": True, "heredocOk": True,
             "probes": {r: "EROFS" for r in RS}},
            {"writable": {r: True for r in RS}, "mountsUnchanged": True, "innerAlive": True})


class T(unittest.TestCase):
    def test_1_pins_match(self):
        self.assertTrue(Q.check_pins())

    def test_2_set_equals_pinned_r3_ro_paths(self):
        C = Q.load_pinned("r3Capture", "capture_r3_test")
        self.assertEqual(C.ro_paths(UID, exists=lambda p: True, islink=lambda p: False), RS)
        for p in RS[2:]:
            with self.assertRaises(Exception):
                C.ro_paths(UID, exists=lambda q: True, islink=lambda q, p=p: q == p)       # r3 refuses a symlinked root
            self.assertNotIn(p, C.ro_paths(UID, exists=lambda q, p=p: q != p, islink=lambda q: False))   # r3 skips a missing one ...
        self.assertEqual(len(RS), 5)                                     # ... which THIS qualification refuses (no skip-as-pass)

    def test_3_clone_hazards_before_any_namespace(self):
        G = Q.load_pinned("r12Gate", "bsro_gate_r12_test")
        ok = mi(("/", "ext4"), ("/tmp", "tmpfs"), ("/run/user/1000", "tmpfs"), ("/run/user/1000/doc", "fuse.portal"),
                ("/run/user/1000/gvfs", "fuse.gvfsd-fuse"), ("/vm/enclave-volumes", "ext4"))
        self.assertEqual(Q.clone_hazards(ok, RS, G.STAGE_MARKERS), [])
        for row in (("/home/steven/Documents/Codex/2026-10-26/my/work/tr004/base-view", "fuse"),
                    ("/home/steven/x/nbd", "fuse.nbdfuse"), ("/tmp/v", "fuse.fuse2fs"), ("/var/tmp/b", "fuseblk"),
                    ("/dev/shm/z", "fuse.anything"), ("/run/user/1000/other", "fuse.sshfs"),
                    ("/vm/x/recovery-overlay-stage/r9/runs/a/mnt", "ext4"), ("/x/composite-mdbx-validation-stage/r10/runs/p/db", "fuse"),
                    ("/x/compact-header-extraction-stage/r2/runs/y", "tmpfs")):
            self.assertTrue(Q.clone_hazards(ok + mi(row), RS, G.STAGE_MARKERS), row)

    def test_4_receipt_requires_every_check_of_every_root(self):
        ins, par = good()
        self.assertEqual(Q.receipt_pass(ins, par, UID), [])
        muts = [("set", RS[:4]), ("bashSet", RS[:4]), ("r3RoPaths", RS[:2]), ("nsChecks", 1), ("workWritable", False), ("symlinkRefused", False),
                ("heredocOk", None), ("probes", {r: "EROFS" for r in RS[:4]}), ("probes", dict({r: "EROFS" for r in RS}, **{"/tmp": "CREATED"}))]
        for k, v in muts:
            i, p = good(); i[k] = v
            self.assertTrue(Q.receipt_pass(i, p, UID), k)
        for k, v in (("writable", {r: True for r in RS[:4]}), ("writable", dict({r: True for r in RS}, **{"/dev/shm": False})),
                     ("mountsUnchanged", False), ("innerAlive", None)):
            i, p = good(); p[k] = v
            self.assertTrue(Q.receipt_pass(i, p, UID), k)
        self.assertTrue(Q.receipt_pass(None, good()[1], UID)); self.assertTrue(Q.receipt_pass(good()[0], None, UID))

    def test_5_loop_is_r3_verbatim_and_the_symlink_probe_reuses_its_body(self):
        pat = lambda t: re.search(r'^RO="/home/steven /tmp"\nfor d in /var/tmp /dev/shm "/run/user/\$OUID"; do\n.*?\ndone$', t, re.M | re.S).group(0)
        r3, me = (R3 / "jobs/inner.sh").read_text(), (ST / "jobs/ns-inner.sh").read_text()
        self.assertEqual(pat(r3), pat(me))
        body = pat(r3).split("\n")[2:4]
        probe = me[me.index('( for d in "$WORK/sl"; do'):]
        for l in body:
            self.assertIn(l, probe)

    def test_6_inner_order(self):
        t = (ST / "jobs/ns-inner.sh").read_text()
        idx = [t.index(s) for s in ('sha256sum < "$R12/jobs/ns.sh"', 'source "$R12/jobs/ns.sh"', 'RO="/home/steven /tmp"', '( for d in "$WORK/sl"',
                                    "ns_harden $RO ||", "CNQ_HEREDOC=$HDOK python3 -I -B \"$S/cnq.py\" inside", ': > "$WORK/HARDENED"',
                                    '[ -e "$WORK/RELEASE" ]')]
        self.assertEqual(idx, sorted(idx))
        self.assertIn("ns_harden $RO || { echo \"## REFUSED: namespace hardening failed\"; exit 9; }", (R3 / "jobs/inner.sh").read_text())

    def test_7_outer_order_and_lane(self):
        t = (ST / "jobs/ns-qual.sh").read_text()
        idx = [t.index(s) for s in ('cnq.py" precheck', "trap ':' TERM INT HUP", 'unshare -Urnm bash "$S/jobs/ns-inner.sh"', 'cnq.py" parent',
                                    ': > "$WORK/RELEASE"', 'wait $IP', 'cnq.py" receipt')]
        self.assertEqual(idx, sorted(idx))
        self.assertIn("cnq-r1 512 bash capture-namespace-qualification-stage/r1/jobs/ns-qual.sh", t)
        for bad in ("pkill", "kill -9", "kill -KILL", "umount", "--fixture"):
            self.assertNotIn(bad, t)

    def test_8_work_dir_shape(self):
        ok = Q.WORK_PARENT + "/capture-ns-qual-20261101T000000Z-77"
        self.assertTrue(Q.WORK_RE.fullmatch(ok))
        for b in (ok + "/", ok + "/x", "/tmp/capture-ns-qual-20261101T000000Z-77", Q.WORK_PARENT + "/capture-ns-qual-x"):
            self.assertIsNone(Q.WORK_RE.fullmatch(b), b)


if __name__ == "__main__":
    unittest.main()
