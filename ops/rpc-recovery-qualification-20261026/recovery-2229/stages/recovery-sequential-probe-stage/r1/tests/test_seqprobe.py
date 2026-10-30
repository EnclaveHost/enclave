#!/usr/bin/env python3
"""recovery-sequential-probe-stage/r1 tests (prepared by Claude 1738; NOT run by Claude). 5 tiny fixtures; RECOVERY_SEQPROBE_WORK from
jobs/tests.sh; the pinned qemu-io/qemu-img. Never touches the original."""
import hashlib, os, signal, subprocess, sys, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import seqprobe as Q    # noqa: E402

WORK = os.environ["RECOVERY_SEQPROBE_WORK"]
MiB, GiB_BLOCKS = 1 << 20, (1 << 30) // 4096
BIG = 16 << 40                                                          # a 16 TiB synthetic filesystem for the selection fixtures


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class SeqProbe(unittest.TestCase):
    def test_1_selection_is_deterministic_separated_and_wholly_inside_written_extents(self):
        ext, phys = [], 1000
        for i in range(40):                                              # written 128 MiB extents, short ones and big UNWRITTEN ones
            n = 32768 if i % 3 == 0 else (8 if i % 3 == 1 else 65536)
            ext.append([i * 100000, n, phys, i % 3 == 2]); phys += n + GiB_BLOCKS // 2
        a, b = Q.select(ext, fs_bytes=BIG), Q.select(ext, fs_bytes=BIG)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 4)
        for p in a:
            e = p["extent"]
            self.assertFalse(e[3]); self.assertEqual(p["length"], 64 * MiB)
            self.assertLessEqual(e[2] * 4096, p["virtualOffset"]); self.assertLessEqual(p["virtualOffset"] + p["length"], (e[2] + e[1]) * 4096)
            self.assertEqual(p["virtualOffset"] % MiB, 0)
        for x, y in zip(a, a[1:]):
            self.assertGreaterEqual(y["virtualOffset"] - x["virtualOffset"] - x["length"], 1 << 30)

    def test_2_unwritten_short_overlapping_malformed_or_crowded_maps_are_refused(self):
        only_bad = [[0, 65536, 10, True], [1, 100, 70000, False], [2, 16384 - 1, 200000, False], [3, 32768, 400000, False]]
        for ext, why in ((only_bad, "written extents"), ([[0, 100, 10, False], [1, 100, 50, False]], "overlap"),
                         ([[0, 100, 10, "no"]], "malformed"), ([[0, -1, 10, False]], "malformed"),
                         ([[i, 16384, 10 + i * 16384, False] for i in range(8)], "apart")):
            with self.assertRaises(Q.Refused) as cm:
                Q.select(ext, fs_bytes=BIG)
            self.assertIn(why, str(cm.exception))
        with self.assertRaises(Q.Refused):
            Q.select([[0, 1 << 20, 10, False]] * 1, n=5, fs_bytes=BIG)    # 5 x 64 MiB > 256 MiB aggregate

    def test_3_read_only_qemu_io_reads_a_known_pattern_fixture_without_printing_data_or_changing_it(self):
        raw, img = os.path.join(WORK, "fx.raw"), os.path.join(WORK, "fx.qcow2")
        with open(raw, "wb") as f:
            f.write(b"SEQPROBE-FIXTURE-SECRET!" * (8 * MiB // 24) + bytes(8 * MiB % 24))
        subprocess.run(["qemu-img", "convert", "-q", "-f", "raw", "-O", "qcow2", raw, img], check=True)
        os.chmod(img, 0o444); before = sha(img)
        picks = [{"virtualOffset": 0, "length": MiB, "extent": [0, 256, 1, False], "logicalOffset": 0},
                 {"virtualOffset": 4 * MiB, "length": MiB, "extent": [0, 256, 1024, False], "logicalOffset": 0}]
        rows, total = Q.run_ranges(picks, img, Q.QEMU_IO, budget=60, timeout=20, grace=2)
        for r in rows:
            self.assertTrue(r["complete"], r); self.assertEqual(r["rc"], 0); self.assertIsNotNone(r["MiBps"]); self.assertTrue(r["groupEmpty"])
            self.assertNotIn("SECRET", r["stdoutTail"] + r["stderrTail"])                      # timings only, never data
        self.assertEqual(sha(img), before)
        self.assertIn("read-only=on", Q.qemu_io_argv(Q.QEMU_IO, img, 0, MiB)[3]); self.assertEqual(Q.qemu_io_argv(Q.QEMU_IO, img, 0, MiB)[1], "-r")

    def test_4_a_hung_child_and_its_group_are_ended_term_then_kill_and_reaped(self):
        for argv in (["sh", "-c", "sleep 300 & exec sleep 300"], ["sh", "-c", "trap '' TERM; sleep 300 & sleep 300; wait"]):
            t0 = time.monotonic()
            r = Q.run_bounded(argv, timeout=1, grace=1)
            self.assertTrue(r["timedOut"]); self.assertTrue(r["groupEmpty"], r); self.assertLess(time.monotonic() - t0, 15)
        with self.assertRaises(Q.Refused):
            Q.run_ranges([{"virtualOffset": 0, "length": 64 * MiB}] * 5, "/x.qcow2", Q.QEMU_IO)     # > 256 MiB aggregate

    def test_5_any_process_naming_the_original_is_seen_and_a_writable_original_is_refused(self):
        name = "seqprobe-fixture-original.qcow2"
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", name])
        try:
            time.sleep(0.5); self.assertIn(p.pid, Q.namers(name))
        finally:
            p.send_signal(signal.SIGKILL); p.wait()
        self.assertNotIn(p.pid, Q.namers(name))
        w = os.path.join(WORK, name)
        with open(w, "wb") as f:
            f.write(b"x")
        with self.assertRaises(Q.Refused):
            Q.require_read_only(w)                                                             # a writable fs / file is never the original


if __name__ == "__main__":
    unittest.main()
