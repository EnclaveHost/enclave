#!/usr/bin/env python3
"""recovery-sequential-probe-stage/r2 tests (prepared by Claude 1738/1741; NOT run by Claude). 7 tiny fixtures; RECOVERY_SEQPROBE_WORK
from jobs/tests.sh; the pinned qemu-io/qemu-img; the QUALIFIED lifecycle (mdbx_check.py r4). Never touches the original.
1-2 selection/refusal (= r1); 3 the REAL `read -C` stats parse + a known-pattern positive and a wrong-pattern negative at exact offsets
(fixture only); 4 qualified-lifecycle bounds: timeout, stdout held by an orphan after exit, output cap; 5 original guard (= r1);
6 parent SIGTERM while a read is in flight: owned group killed + reaped, exit 128+15, nothing left; 7 explicit incomplete count."""
import hashlib, json, os, signal, subprocess, sys, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, STAGE)
import seqprobe as Q    # noqa: E402

WORK = os.environ["RECOVERY_SEQPROBE_WORK"]
MiB, GiB_BLOCKS = 1 << 20, (1 << 30) // 4096
BIG = 16 << 40                                                          # a 16 TiB synthetic filesystem for the selection fixtures


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def procs_named(marker):
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                with open(f"/proc/{d}/cmdline", "rb") as f:
                    if f.read(4096) == marker:
                        with open(f"/proc/{d}/stat") as g:
                            if g.read().rsplit(")", 1)[1].split()[0] != "Z":
                                out.append(int(d))
            except (OSError, IndexError):
                pass
    return out


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

    def test_3_read_C_stats_are_parsed_exactly_and_patterns_verify_expected_bytes_at_exact_offsets(self):
        raw, img = os.path.join(WORK, "fx.raw"), os.path.join(WORK, "fx.qcow2")
        with open(raw, "wb") as f:
            f.write(b"\xab" * (4 * MiB) + b"\x5c" * (4 * MiB))            # two known constant regions
        subprocess.run(["qemu-img", "convert", "-q", "-f", "raw", "-O", "qcow2", raw, img], check=True)
        os.chmod(img, 0o444); before = sha(img)
        picks = [{"virtualOffset": 0, "length": MiB}, {"virtualOffset": 4 * MiB, "length": MiB}]
        plain, _t = Q.run_ranges(picks, img, Q.QEMU_IO, budget=200, timeout=20)          # the REAL argv (no pattern)
        for r in plain:
            self.assertTrue(r["complete"], r); self.assertEqual(r["stats"]["bytes"], MiB, r); self.assertGreaterEqual(r["stats"]["ops"], 1)
            self.assertLess(len(r["outputTail"]), 1024)                                      # stats only, never data (no -v)
        right = lambda p: 0xab if p["virtualOffset"] < 4 * MiB else 0x5c
        pos, _t = Q.run_ranges(picks, img, Q.QEMU_IO, budget=200, timeout=20, pattern_for=right)
        self.assertEqual([r["complete"] for r in pos], [True, True], pos)
        neg, _t = Q.run_ranges(picks, img, Q.QEMU_IO, budget=200, timeout=20, pattern_for=lambda p: 0xab)   # wrong for the 2nd region
        self.assertEqual([r["complete"] for r in neg], [True, False], neg)
        self.assertIn("pattern verification failed", neg[1]["outputTail"].lower())
        self.assertEqual(Q.summarize(neg, 2 * MiB)["completeCount"], 1)
        self.assertEqual(sha(img), before)
        argv = Q.qemu_io_argv(Q.QEMU_IO, img, 0, MiB)
        self.assertEqual(argv[1], "-r"); self.assertIn("read-only=on", argv[3]); self.assertEqual(argv[5], f"read -C 0 {MiB}")

    def test_4_the_qualified_lifecycle_bounds_timeout_held_stdout_and_output(self):
        pick = [{"virtualOffset": 0, "length": 4096}]
        for argv, flag, kw in ((["sleep", "301"], "timedOut", {"timeout": 1}),
                               (["sh", "-c", "sleep 302 & exit 0"], "heldOpen", {"timeout": 30}),
                               (["sh", "-c", "yes"], "cut", {"timeout": 30, "cap": 65536})):
            t0 = time.monotonic()
            rows, _t = Q.run_ranges(pick, "/x.qcow2", Q.QEMU_IO, budget=200, argv_for=lambda *a, _v=argv: _v, **kw)
            r = rows[0]
            self.assertTrue(r[flag], (argv, r)); self.assertFalse(r["complete"]); self.assertFalse(r["escaped"], r)
            self.assertLess(time.monotonic() - t0, 20)
        self.assertEqual(procs_named(b"sleep\x00301\x00") + procs_named(b"sleep\x00302\x00"), [], "a child of ours survived")
        rows, _t = Q.run_ranges(pick * 4, "/x.qcow2", Q.QEMU_IO, budget=10, timeout=45, argv_for=lambda *a: ["true"])
        self.assertTrue(all(r.get("skipped") for r in rows))                                  # worst case 52 s > budget: never started
        with self.assertRaises(Q.Refused):
            Q.run_ranges([{"virtualOffset": 0, "length": 64 * MiB}] * 5, "/x.qcow2", Q.QEMU_IO)

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

    def test_6_parent_sigterm_during_a_read_kills_and_reaps_the_owned_group_then_exits_143(self):
        driver = os.path.join(WORK, "driver.py")
        with open(driver, "w") as f:
            f.write(f"""import json, signal, sys
sys.path.insert(0, {STAGE!r})
import seqprobe as Q
M = Q.lifecycle(); M._CANCEL["armed"], M._CANCEL["pending"] = True, None
for s in M.CANCEL_SIGNALS:
    signal.signal(s, M._on_signal)
try:
    Q.run_ranges([{{"virtualOffset": 0, "length": 4096}}], "/x.qcow2", "/bin/true", budget=200, timeout=100, argv_for=lambda *a: ["sleep", "3141"])
except M.Cancelled as c:
    print(json.dumps({{"cancelled": c.signum, "rows": len(c.rows)}})); sys.exit(128 + c.signum)
sys.exit(0)
""")
        p = subprocess.Popen([sys.executable, "-I", "-B", driver], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        end = time.monotonic() + 20
        while time.monotonic() < end and not procs_named(b"sleep\x003141\x00"):
            time.sleep(0.1)
        self.assertTrue(procs_named(b"sleep\x003141\x00"), "the read never started")
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 128 + signal.SIGTERM, err)
        self.assertEqual(json.loads(out)["cancelled"], signal.SIGTERM)
        self.assertEqual(procs_named(b"sleep\x003141\x00"), [], "the owned read outlived the cancelled parent")

    def test_7_any_incomplete_sample_makes_the_run_inconclusive_with_explicit_counts(self):
        rows = [{"complete": True, "length": 10}, {"complete": False, "length": 10}, {"complete": False, "skipped": "x", "length": 10}]
        s = Q.summarize(rows, 30)
        self.assertEqual((s["requested"], s["completeCount"], s["measuredBytes"], s["requestedBytes"]), (3, 1, 10, 30))
        self.assertTrue(s["status"].startswith("INCONCLUSIVE"))
        self.assertEqual(Q.summarize([{"complete": True, "length": 10}] * 4, 40)["status"], "complete")
        self.assertTrue(Q.summarize([], 0)["status"].startswith("INCONCLUSIVE"))


if __name__ == "__main__":
    unittest.main()
