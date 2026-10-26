"""Behavioural offline tests of the two runners (root runs them; Claude did not). They prove ORCHESTRATION only: preconditions refuse
before any unit/SSH, transient-unit properties (private mount namespace + read-only datadir only inside the origin unit, no host
mount), ordering, stop-at-first-refusal, signal handling with exact-ID unit cleanup, host floor breach, and exit codes. The fakes
(systemd-run, systemctl, fuser, pgrep, curl, mount, umount, ssh) only RECORD and create placeholder files; nothing here is capture
evidence or proof. The REAL bundle `verify` runs inside the guest runner (it executes from a relocated bundle copy).

env: BUNDLE (a relocated, verified bundle copy), STAGE (the stage dir, read-only). usage: python3 -B -m unittest test_capture_runners"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, textwrap, time, unittest

BUNDLE, STAGE = os.environ['BUNDLE'], os.environ['STAGE']
GUEST = os.path.join(BUNDLE, 'bin', 'guest-capture.sh')
RUNNER = os.path.join(STAGE, 'jobs', 'root-guest-capture-runner.sh')
ID = '20261026T130000Z-0a1b2c3d'

FAKE_SYSTEMD_RUN = r'''#!/usr/bin/python3 -I
import json, os, sys, time
a = sys.argv[1:]; unit = a[a.index('--unit') + 1]; props = [a[i + 1] for i, x in enumerate(a) if x == '-p']; cmd = a[a.index('--') + 1:]
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps({'tool': 'systemd-run', 'unit': unit, 'props': props, 'cmd': cmd, 'pid': os.getpid()}) + '\n')
step = unit.rsplit('-', 1)[1]
if step == os.environ.get('FAKE_SLEEP_STEP'):
    time.sleep(60); sys.exit(0)
if step == os.environ.get('FAKE_FAIL_STEP'):
    print('fake refusal'); sys.exit(3)
sub = cmd[1]; arg = lambda k: cmd[cmd.index(k) + 1]
if sub in ('origin', 'aggregate'):
    open(arg('--out'), 'x').write('{"placeholder": "not evidence"}')
elif sub == 'plan':
    open(arg('--out'), 'x').write(json.dumps({'segments': [{'index': 0}, {'index': 1}]}))
elif sub == 'run-segment':
    d = arg('--out-dir'); os.mkdir(d); open(f'{d}/segment.json', 'x').write('{}'); open(f'{d}/gate-report.json', 'x').write('{}')
print(f'fake {sub} ok' + (' COVERED_ALL_SEGMENTS' if False else ''))
'''
FAKE_SYSTEMCTL = r'''#!/bin/bash
echo "{\"tool\": \"systemctl\", \"args\": \"$*\"}" >> "$FAKE_LOG"
case "$1 $2 $3 $4 $5" in
  "show -p ActiveState --value enclave-rpc-base-snapshot.service") echo "$FAKE_SNAP_STATE";;
  "show -p Result --value enclave-rpc-base-snapshot.service") echo "$FAKE_SNAP_RESULT";;
esac
case "$1" in is-active) echo "$FAKE_HOLDER"; [ "$FAKE_HOLDER" = active ];; list-units) [ -n "${FAKE_LEFT:-}" ] && echo "$FAKE_LEFT"; exit 0;; *) exit 0;; esac
'''
RECORD_ONLY = '#!/bin/bash\necho "{\\"tool\\": \\"%s\\", \\"args\\": \\"$*\\"}" >> "$FAKE_LOG"\nexit %s\n'


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(dir=os.environ.get('TMPDIR', '/tmp'))
        self.addCleanup(shutil.rmtree, self.t, True)
        self.log = os.path.join(self.t, 'calls.jsonl'); open(self.log, 'w').close()

    def calls(self, tool=None):
        out = [json.loads(l) for l in open(self.log) if l.strip()]
        return [c for c in out if tool is None or c['tool'] == tool]

    def write(self, path, text, mode=0o755):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)
        os.chmod(path, mode)


class GuestCapture(Base):
    def setUp(self):
        super().setUp()
        self.root, self.bin = os.path.join(self.t, 'root'), os.path.join(self.t, 'bin')
        self.data = os.path.join(self.root, 'srv/enclave-base-holder/data')
        os.makedirs(os.path.join(self.data, 'db')); open(os.path.join(self.root, 'srv/enclave-base-holder/snapshot-complete'), 'w').close()
        self.write(os.path.join(self.root, 'proc/meminfo'), 'MemAvailable: 20000000 kB\n', 0o644)
        self.write(os.path.join(self.bin, 'systemd-run'), FAKE_SYSTEMD_RUN)
        self.write(os.path.join(self.bin, 'systemctl'), FAKE_SYSTEMCTL)
        for tool, rc in (('fuser', 1), ('pgrep', 1), ('mount', 1), ('umount', 1)):
            self.write(os.path.join(self.bin, tool), RECORD_ONLY % (tool, rc))
        self.write(os.path.join(self.bin, 'curl'), '#!/bin/bash\necho \'{"result": {"number": "0x190e3a0"}}\'\n')
        self.env = {'PATH': '/usr/bin:/bin', 'TMPDIR': self.t, 'HOME': self.t, 'HCAP_TEST_ROOT': self.root, 'HCAP_TEST_BIN': self.bin,
                    'HCAP_TEST_RUNAS': subprocess.run(['id', '-un'], capture_output=True, text=True).stdout.strip(),
                    'FAKE_LOG': self.log, 'FAKE_SNAP_STATE': 'inactive', 'FAKE_SNAP_RESULT': 'success', 'FAKE_HOLDER': 'inactive'}

    def run_guest(self, *args, **env):
        return subprocess.run([GUEST, *args], env={**self.env, **env}, capture_output=True, text=True, timeout=120)

    def test_refuses_before_any_unit_when_snapshot_not_terminal(self):
        r = self.run_guest('--run-id', ID, FAKE_SNAP_STATE='activating')
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn('snapshot unit is not terminal+success', r.stdout)
        self.assertEqual(self.calls('systemd-run'), []); self.assertEqual(self.calls('mount') + self.calls('umount'), [])

    def test_refuses_when_holder_active_or_mount_in_use(self):
        self.assertEqual(self.run_guest('--run-id', ID, FAKE_HOLDER='active').returncode, 2)
        self.write(os.path.join(self.bin, 'fuser'), RECORD_ONLY % ('fuser', 0))
        r = self.run_guest('--run-id', ID)
        self.assertEqual(r.returncode, 2); self.assertIn('holds files', r.stdout)
        self.assertEqual(self.calls('systemd-run'), [])

    def test_full_flow_units_private_namespace_and_order(self):
        r = self.run_guest('--run-id', ID)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        units = [c['unit'] for c in self.calls('systemd-run')]
        self.assertEqual(units, [f'enclave-hcap-{ID}-{s}' for s in ('origin', 'plan', 'seg0', 'seg1', 'aggregate')])
        by = {c['unit'].rsplit('-', 1)[1]: c for c in self.calls('systemd-run')}
        for s, c in by.items():
            p = c['props']
            for want in ('PrivateMounts=yes', 'ProtectSystem=strict', 'MemoryMax=4G', 'MemorySwapMax=0', 'NoNewPrivileges=yes'):
                self.assertIn(want, p, s)
            self.assertTrue(any(re.fullmatch(r'RuntimeMaxSec=\d+', x) for x in p), s)
            self.assertEqual(c['cmd'][0], os.path.join(os.path.realpath(BUNDLE), 'bin', 'historical-capture'))
        self.assertIn(f'BindReadOnlyPaths={self.data}', by['origin']['props'])
        self.assertIn('PrivateNetwork=yes', by['origin']['props'])
        self.assertEqual(by['origin']['cmd'][by['origin']['cmd'].index('--datadir') + 1], self.data)
        for s in ('plan', 'seg0', 'seg1', 'aggregate'):
            self.assertFalse(any(x.startswith('BindReadOnlyPaths=') for x in by[s]['props']), s)
        for s in ('seg0', 'seg1'):
            self.assertIn('IPAddressAllow=localhost', by[s]['props']); self.assertNotIn('PrivateNetwork=yes', by[s]['props'])
        self.assertEqual(by['plan']['cmd'][by['plan']['cmd'].index('--to-block') + 1], str(0x190e3a0))
        self.assertEqual(self.calls('mount') + self.calls('umount'), [], 'nothing may be mounted in the caller namespace')
        stops = [c['args'] for c in self.calls('systemctl') if c['args'].startswith('stop ')]
        self.assertEqual(stops, [f'stop enclave-hcap-{ID}-*'])
        self.assertTrue(os.path.exists(os.path.join(self.root, 'var/lib/enclave-rpc/historical-capture', ID, 'EVIDENCE.sha256')))

    def test_stops_at_first_refusal_and_keeps_evidence(self):
        r = self.run_guest('--run-id', ID, FAKE_FAIL_STEP='seg1')
        self.assertEqual(r.returncode, 2)
        self.assertEqual([c['unit'].rsplit('-', 1)[1] for c in self.calls('systemd-run')], ['origin', 'plan', 'seg0', 'seg1'])
        self.assertTrue(os.path.isdir(os.path.join(self.root, 'var/lib/enclave-rpc/historical-capture', ID, 'segment-0')))

    def test_sigterm_during_a_step_stops_exactly_this_runs_units_at_once(self):
        p = subprocess.Popen([GUEST, '--run-id', ID], env={**self.env, 'FAKE_SLEEP_STEP': 'seg0'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 60
        while not any(c['unit'].endswith('-seg0') for c in self.calls('systemd-run')):
            self.assertLess(time.time(), deadline, 'seg0 never started'); time.sleep(0.2)
        child = next(c['pid'] for c in self.calls('systemd-run') if c['unit'].endswith('-seg0'))
        t0 = time.time(); p.send_signal(signal.SIGTERM); out, _ = p.communicate(timeout=20)
        self.assertLess(time.time() - t0, 10, 'trap waited for the step instead of running at once')
        self.assertEqual(p.returncode, 143, out)
        self.assertIn(f'stop enclave-hcap-{ID}-*', [c['args'] for c in self.calls('systemctl')])
        time.sleep(0.5)
        try:
            alive = open(f'/proc/{child}/stat').read().split()[2] != 'Z'
        except OSError:
            alive = False
        self.assertFalse(alive, 'step client still running')
        self.assertFalse(any(c['unit'].endswith('-seg1') for c in self.calls('systemd-run')))

    def test_cleanup_entrypoint_exact_id_only(self):
        r = self.run_guest('--cleanup', ID)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, f'clean {ID}'))
        self.assertEqual([c['args'] for c in self.calls('systemctl')][:2], [f'stop enclave-hcap-{ID}-*', f'reset-failed enclave-hcap-{ID}-*'])
        open(self.log, 'w').close()
        for bad in ('*', '../x', f'{ID}-*', ''):
            self.assertEqual(self.run_guest('--cleanup', bad).returncode, 2, bad)
        self.assertEqual(self.calls('systemctl'), [])
        self.assertEqual(self.run_guest('--cleanup', ID, FAKE_LEFT=f'enclave-hcap-{ID}-seg0.service loaded active running').returncode, 21)


FAKE_SSH = r'''#!/usr/bin/python3 -I
import json, os, re, sys, time
cmd = sys.argv[-1]
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps({'tool': 'ssh', 'cmd': cmd, 'pid': os.getpid()}) + '\n')
if 'historical-capture verify' in cmd:
    print(json.dumps({'ok': True, 'bundleId': os.environ['FAKE_BID']})); sys.exit(0)
if '--cleanup' in cmd:
    i = re.search(r'--cleanup (\S+)', cmd)[1]
    if os.environ.get('FAKE_CLEANUP') == 'left':
        print('LEFT: x'); sys.exit(21)
    print(f'clean {i}'); sys.exit(0)
if '--run-id' in cmd:
    m = os.environ.get('FAKE_RUN', 'ok')
    if m == 'sleep':
        time.sleep(60)
    if m == 'ok':
        print('... COVERED_ALL_SEGMENTS: evidence (fake)'); sys.exit(0)
    if m == 'nocov':
        sys.exit(0)
    sys.exit(2)
sys.exit(9)
'''


class HostRunner(Base):
    def setUp(self):
        super().setUp()
        self.ssh, self.mem, self.guard = (os.path.join(self.t, n) for n in ('ssh', 'meminfo', 'guard.json'))
        self.write(self.ssh, FAKE_SSH)
        self.write(self.mem, 'MemAvailable: 30000000 kB\n', 0o644)
        self.write(self.guard, json.dumps({'state': 'armed', 'reasons': [], 'free': {'nvme': 600e9},
                                           'thresholds': {'nvme': {'start': 488719476736}}}), 0o644)
        self.bid = subprocess.run(['sha256sum'], stdin=open(os.path.join(STAGE, 'bundle/MANIFEST.json'), 'rb'), capture_output=True, text=True).stdout[:64]
        self.out = os.path.join(self.t, 'out'); os.mkdir(self.out)
        self.env = {'PATH': '/usr/bin:/bin', 'TMPDIR': self.t, 'HOME': self.t, 'FAKE_LOG': self.log, 'FAKE_BID': self.bid,
                    'HCAP_RUNNER_TEST_SSH': self.ssh, 'HCAP_RUNNER_TEST_MEMINFO': self.mem, 'HCAP_RUNNER_TEST_GUARD': self.guard,
                    'HCAP_OUT_ROOT': self.out, 'HCAP_RESOURCE_WINDOW': 'confirmed'}

    def run_runner(self, **env):
        return subprocess.run(['bash', RUNNER], env={**self.env, **env}, capture_output=True, text=True, timeout=120)

    def ids(self, kind):
        return [c['cmd'] for c in self.calls('ssh') if kind in c['cmd']]

    def test_admission_refuses_before_any_ssh(self):
        e = dict(self.env); del e['HCAP_RESOURCE_WINDOW']
        r = subprocess.run(['bash', RUNNER], env=e, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 20); self.assertEqual(self.calls('ssh'), [])
        self.write(self.guard, json.dumps({'state': 'paused', 'reasons': ['x'], 'free': {'nvme': 1}, 'thresholds': {'nvme': {'start': 2}}}), 0o644)
        self.assertEqual(self.run_runner().returncode, 20); self.assertEqual(self.calls('ssh'), [])
        self.write(self.mem, 'MemAvailable: 18000000 kB\n', 0o644)                           # < 16 GiB floor + 4096
        self.assertEqual(self.run_runner().returncode, 20); self.assertEqual(self.calls('ssh'), [])

    def test_success_runs_exact_id_cleanup(self):
        r = self.run_runner()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        run = self.ids('--run-id'); cl = self.ids('--cleanup')
        self.assertEqual(len(run), 1); self.assertEqual(len(cl), 1)
        rid = re.search(r'--run-id (\S+)', run[0])[1]
        self.assertTrue(cl[0].endswith(f'--cleanup {rid}')); self.assertIn(f'/opt/enclave-rpc/historical-capture/{self.bid}/', run[0])

    def test_rc0_without_covered_is_not_a_pass(self):
        self.assertEqual(self.run_runner(FAKE_RUN='nocov').returncode, 22)

    def test_cleanup_failure_is_21(self):
        self.assertEqual(self.run_runner(FAKE_CLEANUP='left').returncode, 21)

    def test_sigterm_kills_ssh_and_cleans_remote(self):
        p = subprocess.Popen(['bash', RUNNER], env={**self.env, 'FAKE_RUN': 'sleep'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 60
        while not self.ids('--run-id'):
            self.assertLess(time.time(), deadline); time.sleep(0.2)
        t0 = time.time(); p.send_signal(signal.SIGTERM); out, _ = p.communicate(timeout=60)
        self.assertLess(time.time() - t0, 30); self.assertEqual(p.returncode, 143, out)
        rid = re.search(r'--run-id (\S+)', self.ids('--run-id')[0])[1]
        self.assertEqual([c for c in self.ids('--cleanup')], [c for c in self.ids('--cleanup') if c.endswith(f'--cleanup {rid}')])
        self.assertTrue(self.ids('--cleanup'))

    def test_host_floor_breach_cleans_remote_and_is_20(self):
        p = subprocess.Popen(['bash', RUNNER], env={**self.env, 'FAKE_RUN': 'sleep'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 60
        while not self.ids('--run-id'):
            self.assertLess(time.time(), deadline); time.sleep(0.2)
        self.write(self.mem, 'MemAvailable: 1000000 kB\n', 0o644)
        out, _ = p.communicate(timeout=90)
        self.assertEqual(p.returncode, 20, out)
        self.assertGreaterEqual(len(self.ids('--cleanup')), 2)                   # once by the watchdog, once on exit


if __name__ == '__main__':
    unittest.main()
