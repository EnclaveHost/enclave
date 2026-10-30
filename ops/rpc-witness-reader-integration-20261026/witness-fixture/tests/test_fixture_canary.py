"""witness-rpc-live-canary-stage/r2: OFFLINE tests (no guest, no ssh, no systemd). The REAL host runner from a private stage copy with a FAKE ssh
(the guest) and a FAKE host meminfo; the REAL property checker against systemctl-show spellings. The guest script itself needs systemd and is
exercised only by root's live run (not claimed here)."""
import hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, tempfile, unittest

S = pathlib.Path(__file__).resolve().parents[1]; P = S.parents[1]; R14 = P / 'base-finality-proof-stage/r14-witness'
spec = importlib.util.spec_from_file_location('check_props', S / 'guest/check_props.py'); CP = importlib.util.module_from_spec(spec); spec.loader.exec_module(CP)
UNIT = (R14 / 'units/enclave-witness-bridge-base.service').read_text()
SHOW = '\n'.join(['User=rpcbase', 'Group=rpcbase', 'CapabilityBoundingSet=', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
                  'PrivateDevices=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'IPAddressDeny=0.0.0.0/0 ::/0', 'IPAddressAllow=127.0.0.0/8 ::1/128',
                  'MemoryMax=536870912', 'MemorySwapMax=0', 'TasksMax=32', 'UMask=0077'])


class CheckProps(unittest.TestCase):
    def test_the_shipped_constraints_match_realistic_show_output(self):
        r = CP.check(UNIT, SHOW); self.assertTrue(all(v['ok'] for v in r.values()), r); self.assertEqual(len(r), 15)
        alt = SHOW.replace('IPAddressDeny=0.0.0.0/0 ::/0', 'IPAddressDeny=any').replace('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'RestrictAddressFamilies=AF_INET6 AF_UNIX AF_INET')
        self.assertTrue(all(v['ok'] for v in CP.check(UNIT, alt).values()))

    def test_every_deviation_fails_and_names_the_property(self):
        for old, new, prop in (('MemorySwapMax=0', '', 'MemorySwapMax'), ('MemorySwapMax=0', 'MemorySwapMax=1048576', 'MemorySwapMax'),
                               ('IPAddressAllow=127.0.0.0/8 ::1/128', 'IPAddressAllow=127.0.0.0/8 ::1/128 10.0.0.0/8', 'IPAddressAllow'),
                               ('CapabilityBoundingSet=', 'CapabilityBoundingSet=cap_net_raw', 'CapabilityBoundingSet'), ('User=rpcbase', 'User=root', 'User'),
                               ('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'RestrictAddressFamilies=AF_UNIX AF_INET', 'RestrictAddressFamilies'),
                               ('UMask=0077', 'UMask=0022', 'UMask'), ('MemoryMax=536870912', 'MemoryMax=infinity', 'MemoryMax'), ('TasksMax=32', 'TasksMax=4915', 'TasksMax'),
                               ('PrivateDevices=yes', 'PrivateDevices=no', 'PrivateDevices'), ('ProtectHome=yes', 'ProtectHome=read-only', 'ProtectHome'),
                               ('IPAddressDeny=0.0.0.0/0 ::/0', 'IPAddressDeny=', 'IPAddressDeny')):
            with self.subTest(prop=prop, new=new):
                r = CP.check(UNIT, SHOW.replace(old, new)); self.assertFalse(r[prop]['ok'], r[prop])
                self.assertTrue(all(v['ok'] for k, v in r.items() if k != prop))


class GuestScript(unittest.TestCase):
    def test_an_invalid_id_yields_a_structured_failing_verdict_before_anything_runs(self):
        r = subprocess.run(['bash', str(S / 'guest/fixture_canary.sh'), '../etc'], capture_output=True, text=True, timeout=30, env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(r.returncode, 20); v = json.loads(r.stdout.strip().split('WBC-VERDICT ', 1)[1]); self.assertEqual((v['pass'], v['stage']), (False, 'setup'))


FAKE_SSH = r'''L=$FAKE_DIR/ssh.log; cmd="$*"; echo "CMD $cmd" >> $L
case "$cmd" in
  *"install -d"*) exit ${FAKE_STAGE_RC:-0};;
  *" tee "*) cat > /dev/null; exit ${FAKE_UPLOAD_RC:-0};;
  *"rm -rf"*) echo CLEANUP >> $L; exit ${FAKE_CLEANUP_RC:-0};;
  *"list-units"*) echo POSTCHECK >> $L; [ -n "${FAKE_LEFTOVER:-}" ] && echo "$FAKE_LEFTOVER"; exit 0;;
  *"systemctl stop 'enclave-wbcanary-"*) echo STOPOWN >> $L; exit 0;;
  *"bash -s"*) cat > /dev/null; echo GUEST >> $L; [ -n "${FAKE_LOWER_MEM:-}" ] && printf 'MemAvailable: 1024000 kB\n' > $FAKE_MEMINFO
     sleep ${FAKE_GUEST_SEC:-0}; [ -n "${FAKE_GUEST_OUT:-}" ] && cat "$FAKE_GUEST_OUT"; exit ${FAKE_GUEST_RC:-0};;
  *) exit 0;;
esac
'''


class Runner(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='wbc-')); self.addCleanup(shutil.rmtree, self.t, True)
        proj = self.t / 'proj'; self.st = proj / 'witness-rpc-live-canary-stage/r2'
        shutil.copytree(S, self.st, ignore=shutil.ignore_patterns('logs', '__pycache__'))
        self.r14 = self.t / 'r14'; (self.r14 / 'witness').mkdir(parents=True); (self.r14 / 'units').mkdir()
        shutil.copyfile(R14 / 'witness/witness_rpc_bridge.py', self.r14 / 'witness/witness_rpc_bridge.py')
        shutil.copyfile(R14 / 'units/enclave-witness-bridge-base.service', self.r14 / 'units/enclave-witness-bridge-base.service')
        self.freeze_r14()
        self.mem = self.t / 'meminfo'; self.mem.write_text('MemAvailable: 20480000 kB\n'); self.fd = self.t / 'fake'; self.fd.mkdir()
        b = self.t / 'bin'; b.mkdir(); (b / 'fake-ssh').write_text('#!/bin/bash\n' + FAKE_SSH); (b / 'fake-ssh').chmod(0o755); self.ssh = b / 'fake-ssh'

    def freeze_r14(self):
        subprocess.run(['bash', '-c', 'find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS'], cwd=self.r14, check=True)
        self.r14sums = hashlib.sha256((self.r14 / 'SHA256SUMS').read_bytes()).hexdigest()

    def guest_out(self, verdict=None, n=1, extra=''):
        f = self.t / f'g{len(list(self.t.glob("g*")))}.txt'
        v = verdict if verdict is not None else {'pass': True, 'cleanup': {'ok': True, 'leftUnits': [], 'leftPaths': []}, 'stage': 'done'}
        f.write_text('setup ok\n' + ''.join('WBC-VERDICT ' + json.dumps(v) + '\n' for _ in range(n)) + extra); return f

    def run_(self, **env):
        e = {'PATH': '/usr/bin:/bin', 'TMPDIR': os.environ.get('TMPDIR', '/tmp'), 'WBC_TEST_FAKE_SSH': str(self.ssh), 'WBC_TEST_R14': str(self.r14),
             'WBC_TEST_R14_SUMS': self.r14sums, 'WBC_TEST_MEMINFO': str(self.mem), 'FAKE_DIR': str(self.fd), 'FAKE_MEMINFO': str(self.mem), **env}
        r = subprocess.run(['bash', str(self.st / 'jobs/root-witness-fixture-canary.sh')], env=e, capture_output=True, text=True, timeout=120)
        runs = sorted((self.st / 'logs').glob('run-*'), key=lambda q: q.stat().st_mtime_ns) if (self.st / 'logs').exists() else []
        rec = json.loads((runs[-1] / 'PUBLIC-RECEIPT.json').read_text()) if runs and (runs[-1] / 'PUBLIC-RECEIPT.json').exists() else None
        log = (self.fd / 'ssh.log').read_text() if (self.fd / 'ssh.log').exists() else ''
        return r, rec, log, (runs[-1] if runs else None)

    def owned_only(self, log, o):
        ident = o.name.removeprefix('run-')
        names = set(re.findall(r'enclave-[A-Za-z0-9-]+', log))
        self.assertTrue(names and all(n.startswith((f'enclave-wbcanary-{ident}', f'enclave-wbcanary-in-{ident}')) for n in names), names)

    def test_success_is_a_pass_with_independent_cleanup_and_owned_names_only(self):
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out()), FAKE_GUEST_SEC='0')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertTrue(rec['pass'], rec)
        self.assertEqual(log.count('CLEANUP'), 1); self.assertEqual(log.count('POSTCHECK'), 1); self.owned_only(log, o)
        rows = [l.split() for l in (o / 'host-memavail.txt').read_text().splitlines()]; self.assertEqual([x[2] for x in rows][0::len(rows) - 1], ['start', 'end'])

    def test_unreviewed_bridge_refuses_before_any_guest_contact(self):
        p = self.r14 / 'witness/witness_rpc_bridge.py'; p.write_text(p.read_text() + '\n# changed\n'); self.freeze_r14()
        r, rec, log, o = self.run_()
        self.assertEqual(r.returncode, 20); self.assertIn('not the reviewed cb976541', r.stdout); self.assertEqual(log, '')

    def test_upload_failure_after_staging_still_cleans_and_rechecks(self):
        r, rec, log, o = self.run_(FAKE_UPLOAD_RC='1')
        self.assertEqual(r.returncode, 20); self.assertFalse(rec['pass']); self.assertNotIn('GUEST', log)
        self.assertIn('CLEANUP', log); self.assertIn('POSTCHECK', log); self.owned_only(log, o)

    def test_guest_failure_and_missing_or_duplicate_verdict_are_failures(self):
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out({'pass': False, 'cleanup': {'ok': True}})), FAKE_GUEST_RC='1')
        self.assertEqual(r.returncode, 1); self.assertFalse(rec['pass'])
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out(n=0)))
        self.assertEqual(r.returncode, 22); self.assertFalse(rec['checks']['exactly one guest WBC-VERDICT'])
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out(n=2)))
        self.assertEqual(r.returncode, 22)
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out({'pass': True, 'cleanup': {'ok': False}})))
        self.assertEqual(r.returncode, 22); self.assertFalse(rec['checks']['guest owned cleanup ok'])

    def test_cleanup_failure_or_owned_leftovers_exit_21(self):
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out()), FAKE_CLEANUP_RC='1')
        self.assertEqual(r.returncode, 21, r.stdout); self.assertFalse(rec['pass'])
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out()), FAKE_LEFTOVER='enclave-wbcanary-x-bridge.service loaded active running')
        self.assertEqual(r.returncode, 21); self.assertIn('OWNED LEFTOVERS', r.stdout)

    def test_host_floor_breach_stops_own_units_and_is_never_a_pass(self):
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out()), FAKE_LOWER_MEM='1', FAKE_GUEST_SEC='3')
        self.assertEqual(r.returncode, 20); self.assertFalse(rec['pass']); self.assertIn('STOPOWN', log); self.assertTrue((o / 'floor.txt').exists())

    def test_guest_timeout_is_a_failure_with_cleanup(self):
        r, rec, log, o = self.run_(FAKE_GUEST_OUT=str(self.guest_out()), FAKE_GUEST_SEC='20', WBC_TEST_GUEST_TIMEOUT='2')
        self.assertNotEqual(r.returncode, 0); self.assertFalse(rec['pass']); self.assertIn('CLEANUP', log); self.assertIn('POSTCHECK', log)


if __name__ == '__main__':
    unittest.main(verbosity=2)
