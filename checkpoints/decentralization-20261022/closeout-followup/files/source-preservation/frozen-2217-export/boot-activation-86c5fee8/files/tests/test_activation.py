"""Focused tests of the second activation attempt, all with stubs: no production file, service, SSH or network is touched.
   python3 -m unittest discover -s tests -v   (from this directory)"""
import ast, copy, hashlib, json, os, stat, subprocess, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common as C
import guestrows, prebaseline

HERE = Path(__file__).resolve().parent; FX = HERE / 'fixtures'
FIRST = C.W / 'work/custody-recipient-activation-20261023'          # the first attempt, commit 7426b29 (reviewed)
M = lambda c: c * 96
OLD, PRIOR = C.CURRENT['measurement'], C.PRIOR['measurement']
NEWM = hashlib.sha384(b'approved candidate').hexdigest()
NEWDIST = '/home/steven/enclave-prod/dist-leasegas-9f6d37bd8'
EXISTING = [OLD] + [hashlib.sha384(str(n).encode()).hexdigest() for n in range(34)] + [PRIOR]   # the 36 installed at 21:30Z
assert len(EXISTING) == 36 and NEWM not in EXISTING
IG, EO = list(C.APPS)   # image-generator, EyesOff


class FirstAttemptCodeUnchanged(unittest.TestCase):
    """'Use the prior strict gate/rollback unchanged': byte copies and source-identical shared functions."""
    def test_gate_files_are_the_reviewed_byte_copies(self):
        pins = json.loads((FIRST/'REVIEWED-COPIES.json').read_text())
        self.assertEqual(sorted(pins), ['apphealth.py', 'guestrows.py', 'verify-operational.py'])
        for f, p in pins.items(): self.assertEqual(C.sha((C.A/f).read_bytes()), p['sha256'], f)
        self.assertEqual(C.sha((C.A/'verify-operational.py').read_bytes()), '5ef6fa9d59087a757e5e21911ec033b78c2b6fd06e6d9724c49d64e43ab1f067')
        for f in ('preflight.mjs', 'renewal-watch.py'): self.assertEqual((C.A/f).read_bytes(), (FIRST/f).read_bytes(), f)

    def test_shared_functions_are_the_first_attempts_source(self):
        old_src = subprocess.check_output(['git', '-C', str(FIRST), 'show', '7426b29:common.py'], text=True)
        new_src = (C.A/'common.py').read_text()
        def defs(src):
            t = ast.parse(src); out = {}
            for n in t.body:
                if isinstance(n, (ast.FunctionDef, ast.ClassDef)): out[n.name] = ast.get_source_segment(src, n)
                elif isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name): out[n.targets[0].id] = ast.get_source_segment(src, n)
            return out
        o, n = defs(old_src), defs(new_src)
        same = ['rewrite_dist', 'protected_problems', 'read_unit', 'read_dropins', 'atomic_config', 'REMOTE_READ', 'REMOTE_CAS', 'REMOTE_RESTORE',
                'remote', 'run_remote', 'public_attestation', 'get', 'PREFIXES', 'journal', 'pending_deadlines', 'rpc', 'verified_block_after',
                'systemctl', 'Ops', 'safe_rollback', 'ROLLBACK_MARGIN_S', 'preflight_problems', 'CURRENT', 'APPS', 'SSH', 'RPCS', 'CONFIG', 'UNIT', 'DROPIN_DIR']
        for k in same: self.assertEqual(n.get(k), o[k], k)
        self.assertIn('ATTACH_S, ADOPT_S = 120, 300', new_src)

    def test_activation_after_the_write_is_the_first_attempts(self):
        """Everything from the write on (restart, attach, adoption of the SAME guests, gate v4, renewals, rollback) is unchanged
        but for the state text naming the measurement."""
        cut = "save(); mutated = False"
        old = (FIRST/'activate.py').read_text(); new = (C.A/'activate.py').read_text()
        old_tail = old[old.index(cut):].replace("result.update(state='PROVISIONAL: attached ee5df6b8,", "result.update(state=f'PROVISIONAL: attached {NEW[\"measurement\"][:8]},")
        self.assertEqual(new[new.index(cut):], old_tail)
        self.assertLess(new.index("fund, probs = boot_funding("), new.index("atomic_config(new, mode)"), 'the funding preflight precedes the write')
        self.assertLess(new.index("pb = prebaseline.collect("), new.index("fund, probs = boot_funding("))


class RewriteDist(unittest.TestCase):
    raw = ('{\n  "name": "metal0",\n  "dist": "/home/steven/enclave-prod/dist-leasegas-deabf8f90",\n  "leaseGas": {"rpcs": ["x"]},\n'
           '    "odd":   [1,2 , 3]\n}\n').encode()

    def test_only_dist_changes_every_other_byte_preserved(self):
        new = C.rewrite_dist(self.raw, C.CURRENT['dist'], NEWDIST)
        self.assertEqual(new, self.raw.replace(b'dist-leasegas-deabf8f90', b'dist-leasegas-9f6d37bd8'))
        self.assertEqual(json.loads(new), {**json.loads(self.raw), 'dist': NEWDIST})


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

    def test_additive_36_to_37_in_installed_order(self):
        existing, text = C.admission_body(self.body, list(reversed(EXISTING)), NEWM)
        self.assertEqual(existing, EXISTING)
        self.assertEqual(text, 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n')
        self.assertEqual(len(text.strip().split('=')[1].split(',')), 37)
        self.assertEqual(C.RELAY['installedSha256'], json.loads((FIRST/'admission.json').read_text())['environmentSha256'], 'CAS from the 21:30Z admission')

    def test_refusals(self):
        w35 = [x for x in EXISTING if x != PRIOR] + [M('d')]
        cases = [(self.body + 'X=1\n', EXISTING, NEWM, 'not exactly one'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:35]) + '\n', EXISTING[:35], NEWM, 'reviewed state is 36'),
                 (self.body, EXISTING[:35] + [M('f')], NEWM, 'not the public allowlist'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[1:] + [M('e')]) + '\n', EXISTING[1:] + [M('e')], NEWM, 'running measurement is not admitted'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(w35) + '\n', w35, NEWM, 'ee5df6b8 is not admitted'),
                 (self.body, EXISTING, PRIOR, 'already admitted'),
                 (self.body, EXISTING, 'x' * 96, 'malformed candidate'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:35] + [EXISTING[3]]) + '\n', EXISTING, NEWM, 'duplicate')]
        for body, pub, new, w in cases:
            with self.assertRaisesRegex(AssertionError, w): C.admission_body(body, pub, new)


class RemoteScripts(unittest.TestCase):
    """The SAME remote script text admit/unadmit/prepare send over SSH, run locally against temp files and a stub systemctl."""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.env, self.drop, self.log = self.d/'m.env', self.d/'drop.conf', self.d/'systemctl.log'
        self.env.write_text('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING) + '\n'); self.drop.write_text('[Service]\nEnvironmentFile=x\n')
        (self.d/'m.env.before-a6b1378cd').write_text('the first attempt\'s backup')
        self.ctl = self.d/'systemctl'
        self.ctl.write_text(f'#!/bin/sh\necho "$@" >> {self.log}\nif [ "$1" = restart ] && [ -e {self.d}/fail-restart ]; then rm {self.d}/fail-restart; exit 1; fi\n'
                            f'if [ "$1" = is-active ]; then echo active; fi\nexit 0\n')
        self.ctl.chmod(0o755)

    def run_script(self, template, args):
        return subprocess.run([sys.executable, '-'], input=C.remote(template, args), text=True, capture_output=True)

    def cas(self, body, expect=None, backup=None):
        backup = backup or self.d/'m.env.before-9f6d37bd8'
        args = (str(self.env), str(self.drop), str(backup), body, expect or C.sha(self.env.read_bytes()), C.sha(self.drop.read_bytes()),
                '9f6d37bd8', str(self.ctl), 'enclave-api-relay.service')
        return self.run_script(C.REMOTE_CAS, args), backup

    def test_cas_success_keeps_the_first_backup(self):
        old = self.env.read_bytes(); new = 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n'
        r, backup = self.cas(new)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.env.read_text(), new); self.assertEqual(backup.read_bytes(), old)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600); self.assertIn('restart enclave-api-relay.service', self.log.read_text())
        self.assertEqual((self.d/'m.env.before-a6b1378cd').read_text(), 'the first attempt\'s backup')

    def test_cas_refuses_changed_env_or_existing_backup_and_restores_on_failed_restart(self):
        old = self.env.read_bytes()
        r, _ = self.cas('X', expect='0' * 64); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.env.read_bytes(), old)
        self.assertFalse(self.log.exists() and 'restart' in self.log.read_text(), 'no restart on a refused CAS')
        (self.d/'fail-restart').write_text('')
        r, b = self.cas('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n')
        self.assertNotEqual(r.returncode, 0); self.assertEqual(self.env.read_bytes(), old)
        self.assertEqual(self.log.read_text().count('restart enclave-api-relay.service'), 2, 'the restore restarts the relay again')
        r, _ = self.cas('X', backup=b); self.assertNotEqual(r.returncode, 0)   # its backup now exists: refuse


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
        self.assertEqual(self.calls[0][:2], ('systemctl', ('stop', C.UNIT))); self.assertEqual(self.calls[0][2], self.new)
        self.assertEqual(self.calls[1][:2], ('block', 1790000000)); self.assertEqual(self.calls[2][:2], ('systemctl', ('start', C.UNIT)))
        self.assertEqual(self.calls[2][2], self.old); self.assertEqual(stat.S_IMODE(self.cfg.stat().st_mode), 0o640)

    def test_refuses_concurrent_config_change(self):
        self.cfg.write_bytes(b'{"dist": "someone else"}\n')
        with self.assertRaises(AssertionError): self.roll()
        self.assertNotIn(('systemctl', ('start', C.UNIT)), [c[:2] for c in self.calls])
        self.cfg.write_bytes(self.new); self.calls.clear(); self.ops.drops = {**C.CURRENT['dropins'], '99-x.conf': 'f' * 64}
        with self.assertRaises(AssertionError): self.roll()
        self.assertEqual(self.cfg.read_bytes(), self.new); self.assertNotIn(('systemctl', ('start', C.UNIT)), [c[:2] for c in self.calls])

    def test_unreadable_journal_waits_the_ttl_bound(self):
        self.ops.lines = None; self.roll()
        self.assertEqual(self.result['pendingSponsoredDeadlines'], [1789999000 + 360]); self.assertEqual(self.calls[1][1], 1789999360)


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


# ---- the reviewed build -------------------------------------------------------------------------------------------------------
class Build(unittest.TestCase):
    def setUp(self):
        self.log = (FX/'root-build-approved.out').read_text(); self.appr = (FX/'APPROVED-COMMIT.txt').read_text()
        self.inv = (FX/'INVENTORY.sha256').read_text(); self.meas = (FX/'MEASUREMENT').read_text()

    def bp(self, log=None, appr=None, inv=None, meas=None):
        return C.build_problems(self.log if log is None else log, self.appr if appr is None else appr,
                                self.inv if inv is None else inv, self.meas if meas is None else meas)

    def test_the_actual_completed_build_passes(self):
        rec, probs = self.bp()
        self.assertEqual(probs, [])
        self.assertEqual(rec['measurement'], '08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000')
        self.assertEqual(rec['files']['initramfs.cpio.gz'], '02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf')
        self.assertEqual(rec['commit'], C.REVIEWED['commit'])

    def test_refusals(self):
        L = self.log
        ia = 'f' * 64 + '  dist-leasegas-9f6d37bd8/initramfs.cpio.gz'
        cases = [
            (dict(appr='commit ' + 'a' * 40 + '\nextra NONE\n'), 'APPROVED-COMMIT'),
            (dict(appr=self.appr.replace('NONE', 'metal/x.mjs')), 'APPROVED-COMMIT'),
            (dict(log=L.replace('CONTROL-IDENTICAL manifest.json\n', '')), 'CONTROL-IDENTICAL manifest.json'),
            (dict(log=L.replace('REPRODUCIBLE vmlinuz\n', 'REPRODUCIBLE vmlinuz\nREPRODUCIBLE vmlinuz\n')), 'REPRODUCIBLE vmlinuz'),
            (dict(log=L.replace("MANIFEST-DELTA-EXACT ['/app/supervisor.js']", "MANIFEST-DELTA-EXACT ['/app/supervisor.js', '/app/x.js']")), 'MANIFEST-DELTA'),
            (dict(log=L.replace('MEASURE-RECIPE-REPRODUCES-A6', 'MEASURE-MISMATCH a6')), 'MEASURE-RECIPE-REPRODUCES-A6'),
            (dict(log=L.replace('[queue] EXIT 0', '[queue] EXIT 1')), 'EXIT 0'),
            (dict(log=L + 'REFUSED: x\n'), 'refusal'),
            (dict(log=L.replace('APPROVED 9f6d37bd', 'APPROVED 0f6d37bd')), 'APPROVED'),
            (dict(meas=PRIOR + '\n', log=L.replace(self.meas.strip(), PRIOR)), 'previous image'),
            (dict(meas=M('a') + '\n'), 'MEASUREMENT file'),
            (dict(inv=self.inv + '0' * 64 + '  dist-leasegas-9f6d37bd8/extra\n'), 'inventory files'),
            (dict(inv=self.inv.replace('dist-leasegas-9f6d37bd8/cmdline', 'dist-leasegas-0f6d37bd8/cmdline')), 'inventory line'),
            (dict(inv=self.inv.replace('02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf', '5ce61b6f590ed6b84f6d463a949234562c4a6fd8646b74b3de69d6e2e442f1de')), 'equals a6b1378cd'),
            (dict(inv=self.inv.replace('1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7', 'e' * 64)), 'vmlinuz changed'),
            (dict(inv=self.inv.replace('64bd025db3ed62b82f016ed25f1bd24ab300dbe7520ca81498d3ccd293e43b16', 'c' * 64)), 'logged inventory'),
        ]
        for kw, why in cases:
            rec, probs = self.bp(**kw)
            self.assertTrue(probs, why); self.assertRegex('; '.join(probs), why)

    def test_source_is_the_reviewed_commit(self):
        self.assertEqual(C.source_problems(), [])                       # the real H repo, git objects only
        real = C.git
        def stub(**over):
            def g(*args):
                k = args[0]
                if k in over: return over[k]
                return real(*args)
            return g
        self.assertRegex('; '.join(C.source_problems(stub(**{'rev-parse': b'deabf8f90f64902d20d48620fd911d34c445859d\n'}))), 'not a child')
        self.assertRegex('; '.join(C.source_problems(stub(diff=b'supervisor.js\nmetal/guest/gsup.mjs\ntest/registry-advertise-retry.test.mjs\n'))), 'changes')
        self.assertRegex('; '.join(C.source_problems(stub(show=b'// other bytes\n'))), 'not the reviewed bytes')
        self.assertRegex('; '.join(C.source_problems(rev={**C.REVIEWED, 'commit': 'a6b1378cdf430217025987d90c040d0e25a9993d'})), 'not a child|changes|reviewed bytes')

    def test_approval_and_plan(self):
        d = Path(tempfile.mkdtemp()); rec, _ = self.bp(); raw = (json.dumps(rec) + '\n').encode(); (d/'build.json').write_bytes(raw)
        with self.assertRaisesRegex(AssertionError, 'root review'): C.approved_build(d/'build.json', FX/'MEASUREMENT')
        (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw)}\n')
        got, h = C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt'); self.assertEqual(h, C.sha(raw))
        (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw + b" ")}\n')
        with self.assertRaisesRegex(AssertionError, 'root review'): C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt')
        other = {**rec, 'commit': 'a6b1378cdf430217025987d90c040d0e25a9993d'}; raw2 = (json.dumps(other) + '\n').encode()
        (d/'build.json').write_bytes(raw2); (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw2)}\n')
        with self.assertRaisesRegex(AssertionError, 'not a build of the reviewed commit'): C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt')
        (d/'build.json').write_bytes(raw); (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw)}\n')
        plan = {'buildSha256': C.sha(raw), 'measurement': rec['measurement'], 'files': rec['files'], 'image': NEWDIST}
        (d/'plan.json').write_text(json.dumps(plan)); self.assertEqual(C.load_new(d)['measurement'], rec['measurement'])
        (d/'plan.json').write_text(json.dumps({**plan, 'measurement': PRIOR}))
        with self.assertRaisesRegex(AssertionError, 'not the approved build'): C.load_new(d)

    def test_staged_dir_hashes(self):
        d = Path(tempfile.mkdtemp()); files = {}
        for f in C.FILES: (d/f).write_bytes(f.encode()); files[f] = C.sha(f.encode())
        self.assertEqual(C.staged_problems(d, files), [])
        (d/'cmdline').write_bytes(b'x'); self.assertTrue(C.staged_problems(d, files))
        (d/'cmdline').write_bytes(b'cmdline'); (d/'extra').write_bytes(b''); self.assertTrue(C.staged_problems(d, files))


# ---- the pre-cutover baseline from root's guestd listing ------------------------------------------------------------------------
def listing(over=None):
    rows = [{'id': 'gd9d4a391d', 'name': IG, 'status': 'running', 'recordSha256': 'a' * 64, 'createdAt': 1, 'hostData': 'h', 'transportKeySha256': 't'},
            {'id': 'gdd0646f2c', 'name': EO, 'status': 'running', 'recordSha256': 'b' * 64, 'createdAt': 2},
            {'id': 'gdcustody01', 'name': '0x' + 'c' * 64, 'status': 'running', 'recordSha256': 'c' * 64, 'createdAt': 3}]
    for i, r in (over or {}).items(): rows[i] = {**rows[i], **r} if r is not None else None
    return {'vms': [r for r in rows if r is not None]}

class GuestdBaseline(unittest.TestCase):
    orig = C.original_baseline()

    def test_original_baseline_is_pinned(self):
        self.assertEqual(self.orig, {IG: {'guest': 'gd9d4a391d', 'history': []}, EO: {'guest': 'gdd0646f2c', 'history': []}})
        self.assertEqual(C.sha((FIRST/'evidence/baseline.json').read_bytes()), C.ORIGINAL['sha256'], 'the first attempt\'s 21:31:30Z record')

    def test_exact_original_guests_pass_and_only_kept_fields(self):
        base, rows, probs = C.guestd_baseline(listing(), list(C.APPS), self.orig)
        self.assertEqual(probs, [])
        self.assertEqual({i: base[i]['guest'] for i in base}, C.ORIGINAL['guests'])
        self.assertEqual(base[IG]['recordSha256'], 'a' * 64)
        self.assertTrue(all(set(r) == set(C.KEEP) for r in rows), 'hostData/transport digests are not kept')

    def test_refusals(self):
        cases = [(listing({0: {'id': 'gd00000000'}}), 'not the original baseline guest'),
                 (listing({1: {'status': 'starting'}}), 'not running'),
                 (listing({0: {'recordSha256': None}}), 'no record digest'),
                 (listing({1: None}), '0 nonterminal'),
                 ({'vms': listing()['vms'] + [{'id': 'gd11111111', 'name': IG, 'status': 'running', 'recordSha256': 'd' * 64}]}, '2 nonterminal'),
                 ({'vms': listing()['vms'] + [{'id': 'gd22222222', 'name': EO, 'status': 'failed'}]}, 'failed history'),
                 ({'vms': listing()['vms'] + [dict(listing()['vms'][2])]}, 'duplicate'),
                 ([], 'not a guestd'), ({'vms': None}, 'not a guestd')]
        for l, why in cases:
            _b, _r, probs = C.guestd_baseline(l, list(C.APPS), self.orig)
            self.assertRegex('; '.join(probs), why)

    def test_availability_absent_is_recorded_never_pretended(self):
        base, _r, _p = C.guestd_baseline(listing(), list(C.APPS), self.orig)
        self.assertEqual(C.availability_cross_check(None, base, guestrows), ('absent: the old control is not registered and adopted nothing', []))
        held = [{'id': IG, 'vm': 'gd9d4a391d', 'status': 'running', 'owned': True}, {'id': EO, 'vm': 'gdd0646f2c', 'status': 'running', 'owned': True}]
        self.assertEqual(C.availability_cross_check(held, base, guestrows)[1], [])
        held[1]['vm'] = 'gd33333333'; self.assertTrue(C.availability_cross_check(held, base, guestrows)[1])
        self.assertTrue(C.availability_cross_check({'x': 1}, base, guestrows)[1])

    def test_listing_must_be_fresh_and_private(self):
        d = Path(tempfile.mkdtemp()); p = d/'vms.json'; p.write_text(json.dumps(listing())); p.chmod(0o600)
        now = time.time(); l, h = C.guestd_listing(p, now); self.assertEqual(h, C.sha(p.read_bytes()))
        os.utime(p, (now - 400, now - 400))
        with self.assertRaisesRegex(AssertionError, 'old'): C.guestd_listing(p, now)
        os.utime(p, (now, now)); p.chmod(0o644)
        with self.assertRaisesRegex(AssertionError, 'private'): C.guestd_listing(p, now)

    def test_collect_end_to_end_with_stubs(self):
        d = Path(tempfile.mkdtemp()); p = d/'vms.json'; p.write_text(json.dumps(listing())); p.chmod(0o600)
        avail = lambda url: (200, json.dumps({'instanceSweep': {}}).encode())
        fetch = lambda url: (200, 'text/html', b'<title>image generator</title>' + b' ' * 2000)
        out = prebaseline.collect(p, 'https://x/availability', get=avail, fetch=fetch, check=lambda s: (True, 'ok'))
        self.assertEqual(out['problems'], []); self.assertIs(out['oldControlAdopted'], False)
        self.assertEqual([r['id'] for r in out['otherGuests']], ['gdcustody01'])
        self.assertNotIn('hostData', json.dumps(out))
        bad = prebaseline.collect(p, 'https://x/availability', get=avail, fetch=fetch, check=lambda s: (False, 'down'))
        self.assertRegex('; '.join(bad['problems']), 'not actually healthy')
        p.write_text(json.dumps(listing({0: {'id': 'gd00000000'}}))); p.chmod(0o600)
        self.assertRegex('; '.join(prebaseline.collect(p, 'u', get=avail, fetch=fetch, check=lambda s: (True, 'ok'))['problems']), 'original baseline guest')


# ---- the mandatory boot-funding gate --------------------------------------------------------------------------------------------
def facts(now=10_000):
    """Modeled on root's actual 2-RPC read (root-live-fees2, block 53001451) with the worst-case test key."""
    return {
        'at': 'x', 'readOnly': True, 'rpcs': ['https://a', 'https://b'], 'chainIds': [8453, 8453],
        'block': {'number': '53001451', 'hash': '0x' + '78' * 32, 'timestamp': str(now - 20)},
        'source': {'commit': C.REVIEWED['commit'], 'supervisorSha256': C.REVIEWED['supervisorSha256']},
        'registry': {'address': C.FUNDING['registry'], 'codeHash': C.FUNDING['registryCodeHash']},
        'operator': {'address': '0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB', 'code': C.FUNDING['operatorCode'], 'nonceAtBlock': '23759',
                     'latest': ['23759', '23759'], 'pending': ['23759', '23759'], 'balanceWei': '376132087579'},
        'executor': {'address': C.FUNDING['executor'], 'codeHash': C.FUNDING['executorCodeHash']},
        'row': {'operator': '0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB', 'active': True, 'endpoint': 'https://api.enclave.host/t/metal0',
                'repo': 'EnclaveHost/enclave', 'measurement': '0x' + '00' * 32, 'cpu': '834', 'gpu': '1667', 'proofKey': '0x8604ce59f394daf05b235122E5Dc054F5C2bB453'},
        'desired': {'operator': C.FUNDING['operator'], 'endpoint': 'https://api.enclave.host/t/metal0', 'repo': 'EnclaveHost/enclave',
                    'measurement': '0x' + '00' * 32, 'cpuPricePerSec6': '834', 'gpuPricePerSec6': '1667', 'proofKey': '0x' + 'ff' * 20},
        'testProofKey': '0x' + 'ff' * 20, 'action': {'action': 'setProofKey', 'reason': 'only the proof key differs'},
        'fees': {'baseFeeWei': '5000000', 'tipWei': '1000000', 'viemDefaultMaxFeePerGas': '7000000', 'isthmus': True},
        'setProofKey': {'gas': '38772', 'gasEstimates': ['38772', '38500'], 'maxFeePerGas': '7000000', 'l1FeeUpperBoundWei': '529241039',
                        'operatorFeeWei': '0', 'worstCaseWei': str(38772 * 7000000 + 529241039)},
    }

class BootFunding(unittest.TestCase):
    now = 10_000
    def probs(self, f): return C.boot_funding_problems(f, self.now, C.REVIEWED['commit'], C.REVIEWED['supervisorSha256'])

    def test_root_actual_read_passes_with_headroom(self):
        self.assertEqual(self.probs(facts(self.now)), [])
        f = facts(self.now); self.assertGreaterEqual(int(f['operator']['balanceWei']) * 100, int(f['setProofKey']['worstCaseWei']) * 125)

    def test_refusals(self):
        def m(path, v):
            f = facts(self.now); o = f
            for k in path[:-1]: o = o[k]
            o[path[-1]] = v; return f
        worst = 38772 * 7000000 + 529241039
        cases = [
            (m(['block', 'timestamp'], str(self.now - 400)), 'old'),
            (m(['action'], {'action': 'register', 'reason': 'the registered fields differ'}), 'not setProofKey'),
            (m(['action'], {'action': 'adopt', 'reason': 'already registered exactly'}), 'not setProofKey'),
            (m(['row', 'cpu'], '835'), 'full register'),
            (m(['row', 'repo'], 'enclavehost/enclave'), 'full register'),
            (m(['row', 'active'], False), 'active row'),
            (m(['row', 'operator'], '0x' + '11' * 20), 'active row'),
            (m(['operator', 'pending'], ['23760', '23759']), 'in flight'),
            (m(['operator', 'latest'], ['23760', '23760']), 'in flight'),
            (m(['operator', 'code'], '0xef0100' + '22' * 20), 'delegation'),
            (m(['operator', 'code'], '0x'), 'delegation'),
            (m(['executor', 'codeHash'], '0x' + '33' * 32), 'executor'),
            (m(['registry', 'codeHash'], '0x' + '44' * 32), 'registry'),
            (m(['source', 'commit'], 'a6b1378cdf430217025987d90c040d0e25a9993d'), 'reviewed supervisor'),
            (m(['testProofKey'], '0x' + '01' * 20), 'test proof key'),
            (m(['row', 'proofKey'], '0x' + 'FF' * 20), 'test proof key'),
            (m(['operator', 'balanceWei'], str(worst * 12 // 10)), 'headroom'),
            (m(['operator', 'balanceWei'], str(worst - 1)), 'exceeds the balance'),
            (m(['setProofKey', 'maxFeePerGas'], '6000000'), 'viem'),
            (m(['setProofKey', 'gasEstimates'], ['38772', '40000']), 'larger of the two'),
            (m(['setProofKey', 'operatorFeeWei'], 'UNDETERMINED'), 'undetermined'),
            (m(['fees', 'isthmus'], None), 'undetermined'),
            (m(['setProofKey', 'worstCaseWei'], str(worst - 5)), 'add up'),
            (m(['chainIds'], [8453, 1]), 'Base'),
            (m(['rpcs'], ['https://a', 'https://A']), 'distinct'),
            (m(['readOnly'], False), 'read-only'),
            (m(['desired', 'gpuPricePerSec6'], '1666'), 'reviewed fields'),
        ]
        for f, why in cases:
            self.assertRegex('; '.join(self.probs(f)), why)
        g = facts(self.now); del g['setProofKey']; self.assertRegex('; '.join(self.probs(g)), 'malformed')

    def test_runner_failure_refuses(self):
        class R: returncode, stdout, stderr = 1, '', 'RPCs disagree on balance'
        f, probs = C.boot_funding(['https://a', 'https://b'], C.REVIEWED['commit'], '/nonexistent', run=lambda *a, **k: R)
        self.assertIsNone(f); self.assertRegex(probs[0], 'disagree')

    def test_runner_failure_names_the_error_line(self):
        class R: returncode, stdout = 1, ''
        R.stderr = 'file:///x/boot-funding.mjs:60\n  const agree = ...\n\nError: RPCs disagree on block\n    at agree (file:///x:60:146)\n' + 'x' * 400 + '\nNode.js v22.23.3'
        _f, probs = C.boot_funding(['https://a', 'https://b'], C.REVIEWED['commit'], '/nonexistent', run=lambda *a, **k: R)
        self.assertIn('Error: RPCs disagree on block', probs[0])


# ---- keep: a strict verdict, never a substring --------------------------------------------------------------------------------
class KeepVerdict(unittest.TestCase):
    want = hashlib.sha384(b'approved candidate').hexdigest()
    def setUp(self):
        self.d = Path(tempfile.mkdtemp()); self.raw = self.d/'attestation-raw.json'; self.raw.write_text('{"quote": "..."}'); self.raw.chmod(0o600)
        self.now = time.time(); self.attached = '2026-10-23T23:00:00+00:00'
        import datetime as dt
        at = dt.datetime.fromtimestamp(self.now - 60, dt.timezone.utc).isoformat()
        self.attached = dt.datetime.fromtimestamp(self.now - 600, dt.timezone.utc).isoformat()
        self.v = {'probe': 'attest-control/1', 'target': 'recovery', 'pass': True, 'status': 'verified', 'admissionSafe': True,
                  'expectedMeasurement': self.want, 'observedMeasurement': self.want, 'measurementMatches': True,
                  'required': {k: 'PASS' for k in C.VERDICT_REQUIRED}, 'freshness': 'verifier nonce', 'nonce': 'ab' * 32, 'vmpl': 0,
                  'failedChecks': [], 'at': at, 'rawSha256': C.sha(self.raw.read_bytes())}
    def p(self, v, raw=None): return C.attestation_verdict_problems(v, self.want, self.attached, self.now, raw or self.raw)

    def test_exact_fresh_verdict_passes(self):
        self.assertEqual(self.p(self.v), [])

    def test_substring_or_failed_or_stale_evidence_refuses(self):
        self.assertTrue(self.p({'note': 'mentions ' + self.want}), 'naming the measurement is not a verdict')
        self.assertTrue(self.p('verified ' + self.want))
        for over, why in [({'pass': False}, 'pass'), ({'status': 'unavailable'}, 'status'), ({'observedMeasurement': PRIOR}, 'approved measurement'),
                          ({'expectedMeasurement': PRIOR, 'observedMeasurement': PRIOR}, 'approved measurement'), ({'required': {'chain': 'PASS'}}, 'required check'),
                          ({'nonce': 'short'}, 'nonce'), ({'vmpl': 1}, 'vmpl'), ({'failedChecks': ['tcb policy']}, 'failed checks'),
                          ({'at': self.attached}, 'not after the attachment'), ({'at': '2026-10-23T00:00:00+00:00'}, 'not after|old'), ({'probe': 'other'}, 'attest-control'),
                          ({'rawSha256': '0' * 64}, 'rawSha256')]:
            self.assertRegex('; '.join(self.p({**self.v, **over})), why)
        self.raw.chmod(0o644); self.assertRegex('; '.join(self.p(self.v)), '0600')
        self.assertRegex('; '.join(self.p(self.v, self.d/'missing.json')), 'missing')

    def test_keep_uses_the_strict_check(self):
        k = (C.A/'keep.py').read_text()
        self.assertIn('attestation_verdict_problems(json.loads(ev), NEW[\'measurement\']', k)
        self.assertNotIn(".encode() in ev", k)


if __name__ == '__main__':
    unittest.main()
