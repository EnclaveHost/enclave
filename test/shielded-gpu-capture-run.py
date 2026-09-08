#!/usr/bin/env python3
"""Owned subprocess integration: real sampler/supervisor, fake query-only SMI."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent.parent/'shielded/anchor/avf/host'
SAMPLER = HERE/'gpu-util-sample.py'
U1 = 'GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c'
U2 = 'GPU-042eb279-e6e6-9866-5823-015b8d26946a'
MOCK = '''#!/usr/bin/env python3
import os,signal,sys,time
from pathlib import Path
Path(os.environ['PID_LOG']).write_text(str(os.getpid()))
mode=os.environ.get('MOCK_MODE','normal'); start=time.monotonic()
signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
while True:
 if mode=='early' and time.monotonic()-start > .35: sys.exit(7)
 if mode=='invalid': print('not a GPU CSV record',flush=True)
 else:
  for i,u in enumerate(os.environ['GPUS'].split(',')):
   if mode=='missing' and i==1: continue
   print(f'2026/09/08 00:00:00.000, {i}, {u}, 0, 0, 100, 32768, 20, 135, 30',flush=True)
 time.sleep(.07)
'''


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gpu-supervise-test-')
        self.root = Path(self.tmp.name)
        self.smi = self.root/'smi'
        self.smi.write_text(MOCK)
        self.smi.chmod(0o700)
        self.prefix = self.root/'capture'
        self.env = dict(os.environ, SMI_CMD=str(self.smi), PID_LOG=str(self.root/'smi.pid'))

    def tearDown(self):
        for name in ['smi.pid', 'runner.pid', 'descendant.pid']:
            path = self.root/name
            if path.exists():
                pid = int(path.read_text())
                proc = Path(f'/proc/{pid}/stat')
                # An orphan zombie awaits init's reap, but cannot execute.
                self.assertTrue(not proc.exists() or proc.read_text().split(') ',1)[1].startswith('Z '), name+' still executing')
        self.tmp.cleanup()

    def command(self, seconds=.7, rc=0, descendant=False):
        code = 'import os,time,sys,subprocess; from pathlib import Path; '
        code += f'Path({str(self.root/"runner.pid")!r}).write_text(str(os.getpid())); '
        if descendant:
            code += f'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); Path({str(self.root/"descendant.pid")!r}).write_text(str(p.pid)); '
        code += f'time.sleep({seconds}); Path({str(self.root/"finished")!r}).touch(); sys.exit({rc})'
        return [sys.executable, '-c', code]

    def argv(self, command, extra=()):
        return [sys.executable, str(HERE/'gpu-capture-run.py'), '--prefix', str(self.prefix),
                '--gpus', U1+','+U2, '--sampler', str(SAMPLER), '--interval-ms', '70',
                '--ready-secs', '.8', '--post-roll', '.2', '--max-gap', '.4',
                '--max-secs', '5', *extra, '--', *command]

    def run_case(self, mode='normal', seconds=.7, rc=0, extra=()):
        self.env['MOCK_MODE'] = mode
        r = subprocess.run(self.argv(self.command(seconds, rc), extra), env=self.env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, text=True)
        summary = Path(str(self.prefix)+'.capture.json')
        return r, json.loads(summary.read_text()) if summary.exists() else None

    def test_success_brackets_command_and_reaps(self):
        r, s = self.run_case()
        self.assertEqual(r.returncode, 0, r.stdout+r.stderr)
        self.assertEqual(s['status'], 'PASS')
        self.assertEqual(s['scope'], 'host-command-lifetime')
        self.assertEqual(s['capture_rc'], 0)
        self.assertEqual(s['command_rc'], 0)
        self.assertEqual(s['observations']['status'], 'VALID_OBSERVATIONS')
        for obs in s['observations']['gpus'].values():
            self.assertTrue(obs['window_bracketed'])
            self.assertGreaterEqual(obs['samples_in_window'], 2)

    def test_failed_command_keeps_capture_and_exit(self):
        r, s = self.run_case(rc=7)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(s['command_rc'], 7)
        self.assertEqual(s['capture_rc'], 0)
        self.assertEqual(s['observations']['status'], 'VALID_OBSERVATIONS')

    def test_missing_second_gpu_never_launches_command(self):
        r, s = self.run_case(mode='missing')
        self.assertEqual(r.returncode, 2)
        self.assertIsNone(s['command_rc'])
        self.assertFalse((self.root/'runner.pid').exists())

    def test_bad_readings_never_launch(self):
        r, s = self.run_case(mode='invalid')
        self.assertEqual(r.returncode, 2)
        self.assertIsNone(s['command_rc'])

    def test_sampler_failure_retains_command_result(self):
        r, s = self.run_case(mode='early')
        self.assertEqual(r.returncode, 2)
        self.assertEqual(s['command_rc'], 0)
        self.assertNotEqual(s['capture_rc'], 0)
        self.assertTrue((self.root/'finished').exists())

    def test_existing_prefix_refused_without_change(self):
        csv = Path(str(self.prefix)+'.csv')
        csv.write_bytes(b'historical trace\n')
        r, s = self.run_case()
        self.assertEqual(r.returncode, 2)
        self.assertIsNone(s)
        self.assertEqual(csv.read_bytes(), b'historical trace\n')
        self.assertFalse((self.root/'smi.pid').exists())

    def test_deadline_stops_own_command(self):
        r, s = self.run_case(seconds=60, extra=['--max-secs', '1'])
        self.assertEqual(r.returncode, 2)
        self.assertNotEqual(s['command_rc'], 0)
        self.assertFalse((self.root/'finished').exists())

    def test_signal_cleans_owned_descendants(self):
        p = subprocess.Popen(self.argv(self.command(60, descendant=True)), env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic()+4
            while not (self.root/'descendant.pid').exists() and time.monotonic() < deadline:
                time.sleep(.03)
            self.assertTrue((self.root/'descendant.pid').exists())
            p.send_signal(signal.SIGTERM)
            out, err = p.communicate(timeout=12)
            self.assertEqual(p.returncode, 2, out+err)
            s = json.loads(Path(str(self.prefix)+'.capture.json').read_text())
            self.assertEqual(s['status'], 'FAIL')
            self.assertFalse((self.root/'finished').exists())
        finally:
            if p.poll() is None:
                p.kill()
            p.wait()


if __name__ == '__main__':
    unittest.main()
