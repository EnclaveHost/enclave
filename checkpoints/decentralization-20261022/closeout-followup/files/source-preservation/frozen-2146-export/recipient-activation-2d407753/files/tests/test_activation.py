"""Focused tests of the activation adaptation, all with stubs: no production file, service, SSH or network is touched.
   python3 -m unittest discover -s tests -v   (from this directory)"""
import hashlib, json, os, stat, subprocess, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common as C

M = lambda c: c * 96
OLD, NEWM = C.CURRENT['measurement'], C.NEW['measurement']
EXISTING = [OLD] + [hashlib.sha384(str(n).encode()).hexdigest() for n in range(34)]   # 35 distinct well-formed measurements
assert len(EXISTING) == 35 and NEWM not in EXISTING


class RewriteDist(unittest.TestCase):
    raw = ('{\n  "name": "metal0",\n  "dist": "/home/steven/enclave-prod/dist-leasegas-deabf8f90",\n  "leaseGas": {"rpcs": ["x"]},\n'
           '    "odd":   [1,2 , 3]\n}\n').encode()

    def test_only_dist_changes_every_other_byte_preserved(self):
        new = C.rewrite_dist(self.raw, C.CURRENT['dist'], C.NEW['dist'])
        self.assertEqual(new, self.raw.replace(b'dist-leasegas-deabf8f90', b'dist-leasegas-a6b1378cd'))
        self.assertEqual(json.loads(new), {**json.loads(self.raw), 'dist': C.NEW['dist']})

    def test_refuses_missing_duplicate_or_ambiguous(self):
        for bad in [self.raw.replace(b'"dist"', b'"distx"'),
                    self.raw.replace(b'"odd"', b'"other": "/home/steven/enclave-prod/dist-leasegas-deabf8f90", "odd"'),
                    self.raw.replace(b'deabf8f90', b'51516b778')]:
            with self.assertRaises(AssertionError): C.rewrite_dist(bad, C.CURRENT['dist'], C.NEW['dist'])


class Protected(unittest.TestCase):
    def setUp(self):
        self.cfg = json.dumps({'dist': C.CURRENT['dist'], 'mode': 'snp', 'leaseGas': {'rpcs': ['a']}}).encode()
        self.cur = {**C.CURRENT, 'configSha256': C.sha(self.cfg), 'leaseGasDigest': C.sha(json.dumps({'rpcs': ['a']}, sort_keys=True).encode())}
        self.unit = {'ActiveState': 'active', 'WorkingDirectory': C.CURRENT['workingDirectory'], 'KillMode': 'control-group'}
        self.drops = dict(C.CURRENT['dropins'])

    def test_baseline_passes(self):
        self.assertEqual(C.protected_problems(self.cfg, self.unit, self.drops, self.cur), [])

    def test_every_protected_field_refuses(self):
        cases = [
            (json.dumps({'dist': C.CURRENT['dist'], 'mode': 'snp', 'leaseGas': {'rpcs': ['b']}}).encode(), self.unit, self.drops),
            (self.cfg, {**self.unit, 'WorkingDirectory': '/home/steven/enclave-prod/metal-a6b1378cd'}, self.drops),
            (self.cfg, {**self.unit, 'KillMode': 'process'}, self.drops),
            (self.cfg, {**self.unit, 'ActiveState': 'failed'}, self.drops),
            (self.cfg, self.unit, {**self.drops, '95-app-funded-leases.conf': '0' * 64}),
            (self.cfg, self.unit, {**self.drops, '99-new.conf': '1' * 64}),
            (self.cfg, self.unit, {'80-shield-inference.conf': self.drops['80-shield-inference.conf']}),
        ]
        for cfg, unit, drops in cases:
            self.assertTrue(C.protected_problems(cfg, unit, drops, self.cur), (unit, drops))


class Admission(unittest.TestCase):
    body = 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING) + '\n'

    def test_additive_in_installed_order(self):
        existing, text = C.admission_body(self.body, list(reversed(EXISTING)))
        self.assertEqual(existing, EXISTING)
        self.assertEqual(text, 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n')

    def test_refusals(self):
        cases = [(self.body + 'X=1\n', EXISTING), (self.body.replace('\n', ''), EXISTING),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:34]) + '\n', EXISTING[:34]),       # not the reviewed 35
                 (self.body, EXISTING[:34] + [M('f')]),                                                   # public != installed
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[1:] + [M('e')]) + '\n', EXISTING[1:] + [M('e')]),  # running absent
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:34] + [NEWM]) + '\n', EXISTING[:34] + [NEWM]),    # already admitted
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:34] + [EXISTING[3]]) + '\n', EXISTING)]           # duplicate
        why = ['not exactly one', 'not exactly one', 'reviewed state is 35', 'not the public allowlist', 'running measurement is not admitted',
               'already admitted', 'duplicate']
        for (body, pub), w in zip(cases, why):
            with self.assertRaisesRegex(AssertionError, w): C.admission_body(body, pub)


class RemoteScripts(unittest.TestCase):
    """The SAME remote script text admit/unadmit/prepare send over SSH, run locally against temp files and a stub systemctl."""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.env, self.drop, self.log = self.d/'m.env', self.d/'drop.conf', self.d/'systemctl.log'
        self.env.write_text('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING) + '\n'); self.drop.write_text('[Service]\nEnvironmentFile=x\n')
        self.ctl = self.d/'systemctl'
        self.ctl.write_text(f'#!/bin/sh\necho "$@" >> {self.log}\nif [ "$1" = restart ] && [ -e {self.d}/fail-restart ]; then rm {self.d}/fail-restart; exit 1; fi\n'
                            f'if [ "$1" = is-active ]; then echo active; fi\nexit 0\n')
        self.ctl.chmod(0o755)

    def run_script(self, template, args):
        return subprocess.run([sys.executable, '-'], input=C.remote(template, args), text=True, capture_output=True)

    def cas(self, body, expect=None, backup=None):
        backup = backup or self.d/'m.env.before-a6b1378cd'
        args = (str(self.env), str(self.drop), str(backup), body, expect or C.sha(self.env.read_bytes()), C.sha(self.drop.read_bytes()),
                'a6b1378cd', str(self.ctl), 'enclave-api-relay.service')
        return self.run_script(C.REMOTE_CAS, args), backup

    def test_read_reports_hashes_and_body(self):
        r = self.run_script(C.REMOTE_READ, (str(self.env), str(self.drop), str(self.ctl), 'enclave-api-relay.service'))
        out = json.loads(r.stdout); self.assertEqual(out['envSha256'], C.sha(self.env.read_bytes())); self.assertEqual(out['envBody'], self.env.read_text())
        self.assertEqual(out['serviceActive'], 'active')

    def test_cas_success_writes_backup_and_restarts(self):
        old = self.env.read_bytes(); new = 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n'
        r, backup = self.cas(new)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.env.read_text(), new); self.assertEqual(backup.read_bytes(), old)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600); self.assertIn('restart enclave-api-relay.service', self.log.read_text())

    def test_cas_refuses_changed_env_dropin_or_existing_backup(self):
        old = self.env.read_bytes()
        r, _ = self.cas('X', expect='0' * 64); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.env.read_bytes(), old)
        (self.d/'m.env.before-a6b1378cd').write_text('earlier'); r, _ = self.cas('X'); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.env.read_bytes(), old)
        self.assertFalse(self.log.exists() and 'restart' in self.log.read_text(), 'no restart on a refused CAS')

    def test_cas_failed_restart_restores_previous_bytes(self):
        old = self.env.read_bytes(); (self.d/'fail-restart').write_text('')
        r, _ = self.cas('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n')
        self.assertNotEqual(r.returncode, 0); self.assertEqual(self.env.read_bytes(), old)
        self.assertEqual(self.log.read_text().count('restart enclave-api-relay.service'), 2, 'the restore restarts the relay again')

    def test_restore_is_cas_on_both_versions(self):
        old = self.env.read_bytes(); new = 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n'
        r, backup = self.cas(new); self.assertEqual(r.returncode, 0)
        args = (str(self.env), str(backup), C.sha(new.encode()), C.sha(old), 'a6b1378cd', str(self.ctl), 'enclave-api-relay.service')
        bad = self.run_script(C.REMOTE_RESTORE, (args[0], args[1], '0' * 64) + args[3:]); self.assertNotEqual(bad.returncode, 0); self.assertEqual(self.env.read_text(), new)
        ok = self.run_script(C.REMOTE_RESTORE, args); self.assertEqual(ok.returncode, 0, ok.stderr); self.assertEqual(self.env.read_bytes(), old)


class SafeRollback(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp()); self.cfg = self.d/'config.json'
        self.old, self.new = b'{"dist": "old"}\n', b'{"dist": "new"}\n'
        self.cfg.write_bytes(self.new); self.cfg.chmod(0o640)
        self.calls = []
        test = self
        class Ops:
            lines = ['[lease-gas] renew 0xab sponsored deadline 1790000000 sent']
            drops = dict(C.CURRENT['dropins'])
            @staticmethod
            def systemctl(*a, **k): test.calls.append(('systemctl', a, test.cfg.read_bytes()))
            @staticmethod
            def journal(since):
                if Ops.lines is None: raise RuntimeError('unreadable')
                return Ops.lines
            @staticmethod
            def verified_block_after(ts, rpcs, limit): test.calls.append(('block', ts, limit)); return {'number': 1, 'timestamp': ts + 1}
            now = staticmethod(lambda: 1789999000)
            @staticmethod
            def read_dropins(): return Ops.drops
        self.ops = Ops; self.result = {}

    def roll(self):
        C.safe_rollback(self.result, lambda: None, since='x', old_config=self.old, new_config=self.new, config=self.cfg, ops=self.ops)

    def test_stop_first_wait_deadline_then_restore_and_start(self):
        self.roll()
        self.assertEqual(self.calls[0][:2], ('systemctl', ('stop', C.UNIT))); self.assertEqual(self.calls[0][2], self.new, 'stopped before any config write')
        self.assertEqual(self.calls[1][:2], ('block', 1790000000)); self.assertEqual(self.calls[2][:2], ('systemctl', ('start', C.UNIT)))
        self.assertEqual(self.calls[2][2], self.old, 'started only after the exact old bytes were restored')
        self.assertEqual(self.cfg.read_bytes(), self.old); self.assertEqual(stat.S_IMODE(self.cfg.stat().st_mode), 0o640)
        self.assertIs(self.result['productionActivated'], False)

    def test_unreadable_journal_waits_the_ttl_bound(self):
        self.ops.lines = None; self.roll()
        self.assertEqual(self.result['pendingSponsoredDeadlines'], [1789999000 + 360]); self.assertEqual(self.calls[1][1], 1789999360)

    def test_refuses_concurrent_config_or_dropin_change(self):
        self.cfg.write_bytes(b'{"dist": "someone else"}\n')
        with self.assertRaises(AssertionError): self.roll()
        self.assertEqual(self.cfg.read_bytes(), b'{"dist": "someone else"}\n'); self.assertNotIn(('systemctl', ('start', C.UNIT)), [c[:2] for c in self.calls])
        self.cfg.write_bytes(self.new); self.calls.clear(); self.ops.drops = {**C.CURRENT['dropins'], '99-x.conf': 'f' * 64}
        with self.assertRaises(AssertionError): self.roll()
        self.assertEqual(self.cfg.read_bytes(), self.new); self.assertNotIn(('systemctl', ('start', C.UNIT)), [c[:2] for c in self.calls])


class Preconditions(unittest.TestCase):
    ids = list(C.APPS)
    def pre(self, **over):
        rows = [{'id': i, 'active': True, 'runner': '0xR', 'leaseRemainingSeconds': '1500', 'hostActive': True,
                 'reserve': {'enabled': True, 'balanceWei': '100'}} for i in self.ids]
        for r in rows: r.update(over)
        return {'block': {'timestamp': '1000'}, 'rows': rows}

    def test_preflight(self):
        self.assertEqual(C.preflight_problems(self.pre(), self.ids, 1010), [])
        self.assertTrue(C.preflight_problems(self.pre(), self.ids, 1400))                         # stale
        self.assertTrue(C.preflight_problems(self.pre(leaseRemainingSeconds='700'), self.ids, 1010))   # margin
        self.assertTrue(C.preflight_problems(self.pre(reserve={'enabled': False, 'balanceWei': '1'}), self.ids, 1010))
        self.assertTrue(C.preflight_problems(self.pre(hostActive=False), self.ids, 1010))
        p = self.pre(); p['rows'][1]['runner'] = '0xS'; self.assertTrue(C.preflight_problems(p, self.ids, 1010))
        p = self.pre(); p['rows'].pop(); self.assertTrue(C.preflight_problems(p, self.ids, 1010))

    def test_baseline_must_equal_root_record(self):
        rec = json.loads((Path(C.EVIDENCE)/'baseline.json').read_text())   # root's actual 21:13Z record (read-only)
        fresh = {i: dict(rec['baseline'][i]) for i in self.ids}
        titles = {'0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9': 'image generator'}
        self.assertEqual(C.baseline_problems(rec, fresh, titles), [])
        moved = {**fresh, self.ids[0]: {'guest': 'gd00000000', 'history': []}}
        self.assertTrue(C.baseline_problems(rec, moved, titles))
        self.assertTrue(C.baseline_problems(rec, fresh, {self.ids[0]: 'Not Found'}))
        self.assertTrue(C.baseline_problems({**rec, 'readyForPlan': False}, fresh, titles))


if __name__ == '__main__':
    unittest.main()
