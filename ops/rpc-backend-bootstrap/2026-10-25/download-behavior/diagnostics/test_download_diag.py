#!/usr/bin/env python3
"""Offline test of download_diag.py with a synthetic /proc, ss captures and a sparse .part (no network, no real PID)."""
import json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))

def ss(pid, received):
    lines = []
    for i, b in enumerate(received):
        lines.append(f'0      0      10.0.2.15:{40000+i}    104.18.0.{i}:443    users:(("base",pid={pid},fd={20+i}))')
        lines.append(f'\t cubic wscale:7,7 rto:204 rtt:{30+i}.5/2 mss:1448 cwnd:{40+i} bytes_received:{b} delivery_rate:8.1Mbps')
    lines.append('0      0      10.0.2.15:50000    1.1.1.1:443    users:(("other",pid=999,fd=3))')
    lines.append('\t bytes_received:5')
    return '\n'.join(lines) + '\n'

class Diag(unittest.TestCase):
    def test_report(self):
        d = tempfile.mkdtemp(prefix='dlg-')
        proc, data = os.path.join(d, 'proc'), os.path.join(d, 'data')
        os.makedirs(os.path.join(proc, '4242')); os.makedirs(os.path.join(data, '.download-cache'))
        open(os.path.join(proc, '4242', 'io'), 'w').write('rchar: 100\nwchar: 200\n')
        open(os.path.join(proc, 'net', 'dev') if os.makedirs(os.path.join(proc, 'net')) is None else '', 'w').write(
            'Inter-|\n face |\n  eth0: 1000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n')
        open(os.path.join(proc, 'diskstats'), 'w').write('   8 0 vda 1 0 0 0 1 0 0 0 0 500 0 0 0 0 0 0 0\n')
        with open(os.path.join(data, '.download-cache', 'state.tar.zst.part'), 'wb') as f:
            f.truncate(761228785915)                     # sparse: apparent size only
        a, b = os.path.join(d, 'ss0'), os.path.join(d, 'ss1')
        open(a, 'w').write(ss(4242, [0] * 16)); open(b, 'w').write(ss(4242, [1_000_000] * 16))
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag.py'), '--pid', '4242', '--datadir', data,
                            '--iface', 'eth0', '--disk', 'vda', '--seconds', '1', '--proc', proc, '--ss-file', a, b],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        j = json.loads(r.stdout)
        c = j['connections']
        self.assertEqual((c['established'], c['persistedBothSamples']), (16, 16))   # pid=999 socket excluded
        self.assertAlmostEqual(c['perConnMeanBps'], 1_000_000, delta=60_000)        # ~1 s window
        self.assertAlmostEqual(j['pieceSecondsAtMeanRate'], 67.1, delta=5)          # 64 MiB at ~1 MB/s
        self.assertTrue(any('TIMEOUT MARGIN' in h for h in j['hints']))
        self.assertTrue(any('per-connection cap' in h and 'inconclusive' in h for h in j['hints']))
        self.assertIn('upper bound', j['pieceTimeoutMarginNote'])
        self.assertEqual(j['parts']['state.tar.zst.part']['apparent'], 761228785915)
        self.assertEqual(j['parts']['state.tar.zst.part']['allocatedDeltaBps'], 0)
        self.assertEqual(j['connectionsDetail'][0]['rtt'], '30.5/2')

    def test_seconds_bound(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag.py'), '--pid', '1', '--datadir', '/x',
                            '--seconds', '500'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

if __name__ == '__main__':
    unittest.main()
