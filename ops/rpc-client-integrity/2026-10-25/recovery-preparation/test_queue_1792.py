#!/usr/bin/env python3
"""Admission regressions for the 1792 MiB queue candidate (python3 -m unittest -v test_queue_1792).

Each case runs a COPY of the original or candidate queue in a throwaway directory (so its lock files are private),
with exactly two harness substitutions, each asserted to occur once:
  "/proc/meminfo" -> a fixture with a chosen MemAvailable, and the 60 s admission deadline -> 3 s.
`systemd-run` is a fake on PATH that records its argv and exits 0, so no job, scope or guard ever runs.
Lanes are occupied by holding the real flock on the copy's own lock files from this process.
"""
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATE = os.environ.get('QUEUE_UNDER_TEST') or os.path.join(HERE, 'claude-test-queue.py')   # negative control: the original
ORIGINAL = os.path.join(HERE, 'original-claude-test-queue.py')
FLOOR, HEADROOM, SMALL = 16384, 256, 256
FAKE_SYSTEMD_RUN = """#!/usr/bin/env python3
import json, os, sys
open(os.environ['FAKE_ARGV_OUT'], 'w').write(json.dumps(sys.argv[1:]))
"""


class Queue:
    def __init__(self, script):
        self.d = tempfile.mkdtemp(prefix='q1792-', dir='/tmp')
        with open(script) as f:
            src = f.read()
        for a, b in (('Path("/proc/meminfo")', f'Path({os.path.join(self.d, "meminfo")!r})'),
                     ('deadline = time.monotonic() + 60', 'deadline = time.monotonic() + 3')):
            assert src.count(a) == 1, a
            src = src.replace(a, b)
        self.path = os.path.join(self.d, 'claude-test-queue.py')
        with open(self.path, 'w') as f:
            f.write(src)
        os.mkdir(os.path.join(self.d, 'bin'))
        fake = os.path.join(self.d, 'bin', 'systemd-run')
        with open(fake, 'w') as f:
            f.write(FAKE_SYSTEMD_RUN)
        os.chmod(fake, 0o755)
        self.held = []

    def hold(self, name):                       # 'main' = a running/admitting large job; 'small' = a running small job
        f = open(os.path.join(self.d, 'claude-test-queue.lock' if name == 'main' else 'claude-test-small-queue.lock'), 'a+')
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.held.append(f)

    def run(self, mib, available):
        with open(os.path.join(self.d, 'meminfo'), 'w') as f:
            f.write(f'MemTotal:       131072000 kB\nMemAvailable:   {available * 1024} kB\n')
        argv_out = os.path.join(self.d, 'argv.json')
        if os.path.exists(argv_out):
            os.unlink(argv_out)
        env = dict(os.environ, PATH=os.path.join(self.d, 'bin') + ':' + os.environ['PATH'], FAKE_ARGV_OUT=argv_out)
        r = subprocess.run([sys.executable, self.path, '--mib', str(mib), '--log', os.path.join(self.d, 'g.log'),
                            '--', 'true'], capture_output=True, text=True, env=env, timeout=30)
        argv = None
        if os.path.exists(argv_out):
            with open(argv_out) as f:
                argv = json.load(f)
        return r.returncode, r.stdout + r.stderr, argv

    def close(self):
        for f in self.held:
            f.close()
        shutil.rmtree(self.d, ignore_errors=True)


class Candidate1792(unittest.TestCase):
    def setUp(self):
        self.q = Queue(CANDIDATE)

    def tearDown(self):
        self.q.close()

    def test_choices_accept_1792_reject_other(self):
        rc, out, argv = self.q.run(1792, FLOOR + 1792 + HEADROOM)
        self.assertEqual(rc, 0, out)
        rc, out, _ = self.q.run(2048, 10**6)
        self.assertEqual(rc, 2, out)               # argparse: not a grantable size

    def test_large_1792_alone_boundary_and_unchanged_child_limits(self):
        need = FLOOR + 1792 + HEADROOM             # 18432: no small lane held
        rc, out, argv = self.q.run(1792, need - 1)
        self.assertEqual(rc, 98, out)
        self.assertIn(f'NOT STARTED: available={need - 1}MiB required={need}MiB cap=1792MiB', out)
        self.assertIsNone(argv)                    # nothing launched
        rc, out, argv = self.q.run(1792, need)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'START available={need}MiB required={need}MiB cap=1792MiB floor={FLOOR}MiB concurrentSmall=0MiB', out)
        for a in ('MemoryMax=1792M', 'MemorySwapMax=0', '--scope'):
            self.assertIn(a, argv)
        self.assertEqual(argv[argv.index('--max-rss-mib') + 1], '1792')
        self.assertEqual(argv[argv.index('--floor-available-mib') + 1], str(FLOOR))
        self.assertEqual(argv[-1], 'true')

    def test_small_joining_occupied_large_lane_reserves_1792(self):
        self.q.hold('main')                        # a large job owns the main lane
        need = FLOOR + SMALL + HEADROOM + 1792     # 18688
        rc, out, argv = self.q.run(256, need - 1)
        self.assertEqual(rc, 98, out)
        self.assertIn(f'required={need}MiB cap=256MiB', out)
        self.assertIsNone(argv)
        rc, out, argv = self.q.run(256, need)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'required={need}MiB cap=256MiB floor={FLOOR}MiB concurrentLargeReserve=1792MiB', out)
        self.assertIn('MemoryMax=256M', argv)

    def test_large_1792_with_running_small_keeps_existing_rules(self):
        self.q.hold('small')                       # existing small -> large: reserve the whole small cap
        need = FLOOR + 1792 + HEADROOM + SMALL     # 18688, also the yield threshold
        rc, out, argv = self.q.run(1792, need - 1)
        self.assertEqual(rc, 98, out)
        self.assertIn('NOT STARTED: yielding to reserved small allocation', out)
        self.assertIsNone(argv)
        rc, out, argv = self.q.run(1792, need)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'required={need}MiB cap=1792MiB floor={FLOOR}MiB concurrentSmall=256MiB', out)

    def test_large_1536_with_running_small_now_yields_by_the_1792_reserve(self):
        # deliberate, stricter: the small job's conservative admission now assumes a 1792 large neighbour
        self.q.hold('small')
        rc, out, _ = self.q.run(1536, FLOOR + 1536 + HEADROOM + SMALL)          # 18432: enough for itself...
        self.assertEqual(rc, 98, out)
        self.assertIn('yielding to reserved small allocation', out)           # ...but yields below 18688
        rc, out, _ = self.q.run(1536, FLOOR + 1792 + HEADROOM + SMALL)          # 18688
        self.assertEqual(rc, 0, out)
        self.assertIn(f'required={FLOOR + 1536 + HEADROOM + SMALL}MiB cap=1536MiB', out)

    def test_small_alone_unchanged(self):
        need = FLOOR + SMALL + HEADROOM            # 16896
        rc, out, _ = self.q.run(256, need - 1)
        self.assertEqual(rc, 98, out)
        rc, out, _ = self.q.run(256, need)
        self.assertEqual(rc, 0, out)
        self.assertIn('concurrentSmall=0MiB', out)


class OriginalBaseline(unittest.TestCase):
    """The installed queue's behaviour that the candidate changes (evidence, not a requirement)."""

    def setUp(self):
        self.q = Queue(ORIGINAL)

    def tearDown(self):
        self.q.close()

    def test_original_refuses_1792(self):
        rc, out, argv = self.q.run(1792, 10**6)
        self.assertEqual(rc, 2, out)
        self.assertIsNone(argv)

    def test_original_small_joining_large_reserves_only_1536(self):
        self.q.hold('main')
        rc, out, _ = self.q.run(256, FLOOR + SMALL + HEADROOM + 1536)
        self.assertEqual(rc, 0, out)
        self.assertIn('concurrentLargeReserve=1536MiB', out)


if __name__ == '__main__':
    unittest.main()
