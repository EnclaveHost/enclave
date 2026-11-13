"""rpc/snp/memprobe.py: the working-set probe asks only a quiet slice, a little at a time, for a bounded time, and
never sets a limit.

python3 -m unittest test/rpc-snp/test_memprobe.py
"""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import memprobe as M  # noqa: E402

GIB = 1 << 30
QUIET = 'some avg10=0.00 avg60=0.02 avg300=0.40 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
BUSY10 = 'some avg10=0.35 avg60=0.02 avg300=0.00 total=2\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=1\n'
BUSY60 = 'some avg10=0.00 avg60=0.10 avg300=0.00 total=3\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n'


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='memprobe-test-'))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.group = M.slice_dir(self.dir, M.SLICE)

    def slice(self, current=50*GIB, pressure=QUIET, reclaim=True):
        self.group.mkdir(parents=True, exist_ok=True)
        (self.group/'memory.current').write_text('%d\n' % current)
        (self.group/'memory.pressure').write_text(pressure)
        (self.group/'memory.stat').write_text('anon %d\nfile %d\nshmem 0\n' % (20*GIB, current - 20*GIB))
        if reclaim:
            (self.group/'memory.reclaim').write_text('')
        return self.group

    def asked(self):
        return (self.group/'memory.reclaim').read_text()

    def test_the_slice_is_where_systemd_puts_it(self):
        self.assertEqual(self.group.relative_to(self.dir), Path('enclave.slice/enclave-rpc.slice/enclave-rpc-clients.slice'))
        self.assertEqual(M.slice_dir(self.dir, 'system.slice'), self.dir/'system.slice')

    def test_it_waits_for_the_clients_and_the_clock_starts_when_they_do(self):
        p = M.Probe(self.group, 1000)
        self.assertEqual(p.tick(1060)['phase'], 'waiting')
        self.assertEqual((p.state['ticks'], p.state['asked']), (0, 0))
        self.slice()
        s = p.tick(5000)
        self.assertEqual((s['phase'], s['measuringSince'], s['startedAt'], s['asked']), ('measuring', 5000, 1000, 1))
        self.assertEqual(p.tick(5000 + M.MEASURE_SEC - 1)['phase'], 'measuring')
        self.assertEqual(p.tick(5000 + M.MEASURE_SEC)['phase'], 'done')

    def test_a_quiet_slice_is_asked_for_a_small_part_of_what_it_holds(self):
        self.slice(current=50*GIB)
        p = M.Probe(self.group, 0)
        s = p.tick(60)
        self.assertEqual(self.asked(), str(int(50*GIB*M.STEP)))
        self.assertEqual((s['asked'], s['askedBytes'], s['held'], s['short'], s['lastError']), (1, int(50*GIB*M.STEP), 0, 0, None))
        self.assertLessEqual(int(self.asked()), 128 << 20, 'one step stays small against a 50 GiB slice')
        self.slice(current=40*GIB)
        p.tick(120)
        self.assertEqual(self.asked(), str(int(40*GIB*M.STEP)))

    def test_pressure_in_either_window_holds_it_and_the_hold_is_recorded(self):
        p = M.Probe(self.group, 0)
        for n, busy in enumerate((BUSY10, BUSY60), 1):
            self.slice(pressure=busy)
            s = p.tick(60*n)
            self.assertEqual(self.asked(), '')
            self.assertEqual((s['asked'], s['held'], len(s['holds'])), (0, n, n))
        self.assertEqual(p.state['holds'][0], [60, 50*GIB, 20*GIB, 0.35, 0.02])
        self.slice(pressure=QUIET)
        self.assertEqual(p.tick(180)['asked'], 1)

    def test_it_only_ever_writes_the_reclaim_file(self):
        self.slice()
        before = {f.name: f.read_text() for f in self.group.iterdir() if f.name != 'memory.reclaim'}
        p = M.Probe(self.group, 0)
        for n in range(1, 30):
            p.tick(60*n)
        self.assertEqual({f.name: f.read_text() for f in self.group.iterdir() if f.name != 'memory.reclaim'}, before)
        self.assertEqual(sorted(f.name for f in self.group.iterdir()), ['memory.current', 'memory.pressure', 'memory.reclaim', 'memory.stat'])

    def test_a_kernel_without_reclaim_or_pressure_is_reported_and_left_alone(self):
        self.slice(reclaim=False)
        p = M.Probe(self.group, 0)
        self.assertEqual(p.tick(60)['phase'], 'unsupported')
        (self.group/'memory.reclaim').write_text('')
        self.assertEqual(p.tick(120)['phase'], 'unsupported')
        self.assertEqual(self.asked(), '')

    def test_a_short_reclaim_is_counted_and_the_probe_goes_on(self):
        self.slice(reclaim=False)
        (self.group/'memory.reclaim').mkdir()        # a write fails as it does with EAGAIN
        p = M.Probe(self.group, 0)
        s = p.tick(60)
        self.assertEqual((s['phase'], s['asked'], s['short']), ('measuring', 1, 1))
        self.assertIn('Error', s['lastError'])
        self.assertEqual(p.tick(120)['short'], 2)

    def test_a_small_slice_is_not_asked_and_a_done_probe_asks_nothing(self):
        self.slice(current=100 << 20)
        p = M.Probe(self.group, 0)
        self.assertEqual((p.tick(60)['asked'], self.asked()), (0, ''))
        self.slice()
        p.tick(M.MEASURE_SEC + 60)
        self.assertEqual(p.state['phase'], 'done')
        for n in range(5):
            p.tick(M.MEASURE_SEC + 120 + 60*n)
        self.assertEqual((p.state['asked'], self.asked()), (0, ''))

    def test_samples_and_holds_are_bounded_and_the_state_file_is_whole(self):
        self.slice(pressure=BUSY10)
        p = M.Probe(self.group, 0)
        for n in range(1, 400):
            s = p.tick(60*n)
        self.assertEqual((s['held'], len(s['holds'])), (399, M.KEEP))
        self.assertEqual([x[0] for x in s['samples']], list(range(60, 60*400, M.SAMPLE_SEC)))
        self.assertEqual(s['samples'][0], [60, 50*GIB, 20*GIB, 30*GIB, 0.02])
        out = self.dir/'run/state.json'
        out.parent.mkdir()
        M.publish(s, out)
        self.assertEqual(json.loads(out.read_text()), s)
        self.assertEqual([f.name for f in out.parent.iterdir()], ['state.json'])
        self.assertEqual(out.stat().st_mode & 0o777, 0o644)

    def test_an_unreadable_slice_is_an_error_line_not_a_crash(self):
        self.slice()
        (self.group/'memory.pressure').write_text('garbage\n')
        p = M.Probe(self.group, 0)
        s = p.tick(60)
        self.assertEqual((s['phase'], s['ticks'], s['asked']), ('measuring', 0, 0))
        self.assertIn('Error', s['lastError'])


if __name__ == '__main__':
    unittest.main()
