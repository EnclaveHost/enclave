"""Focused tests of the fourth activation attempt (boot FEE build), all with stubs: no production file, service, SSH or network is touched.
   python3 -m unittest discover -s tests -v   (from this directory)"""
import ast, copy, hashlib, json, os, stat, subprocess, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common as C
import guestrows, prebaseline

HERE = Path(__file__).resolve().parent
FIRST = C.W / 'work/custody-recipient-activation-20261023'          # the first attempt, commit 7426b29 (reviewed)
SECOND = C.W / 'work/custody-boot-activation-20261023'               # the second attempt, frozen 86c5fee
THIRD = C.W / 'work/custody-boot-price-activation-20261023'          # the third attempt 8bbd0a74 (root's 38-entry admission.json, read only)
PRICE_BUILD = C.W / 'work/custody-boot-price-release-20261023'       # root's real 7dd3acd build (read only): build_problems' fixture
M = lambda c: c * 96
OLD, PRIOR, NINE, B007 = C.CURRENT['measurement'], C.PRIORS[0], C.PRIORS[1], C.PRIORS[2]
NEWM = hashlib.sha384(b'approved candidate').hexdigest()
NEWDIST = '/home/steven/enclave-prod/dist-leasegas-0c565d3ca'   # any candidate name
EXISTING = [OLD] + [hashlib.sha384(str(n).encode()).hexdigest() for n in range(34)] + [PRIOR, NINE, B007]   # the 38 installed (136a6553)
assert len(EXISTING) == 38 and NEWM not in EXISTING
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
        """Everything from the write on (restart, attach, adoption of the SAME guests, gate v4 at its defaults, renewals, rollback) is
        the first attempt's, but for: the state text naming the measurement; the gate line, now run under the lease watchdog with the
        SAME failure text; and the two record_registry calls (record only)."""
        cut = "save(); mutated = False"
        old = (FIRST/'activate.py').read_text(); new = (C.A/'activate.py').read_text()
        gate_line = "    if subprocess.run(gate).returncode != 0: raise RuntimeError('the operational gate FAILED: ' + json.dumps(json.loads((A/'gate.json').read_text()).get('why'))[:400])\n"
        old_tail = old[old.index(cut):].replace("result.update(state='PROVISIONAL: attached ee5df6b8,", "result.update(state=f'PROVISIONAL: attached {NEW[\"measurement\"][:8]},")
        self.assertEqual(old_tail.count(gate_line), 1)
        tail = new[new.index(cut):]
        w0, w1 = tail.index('    # gate v4 UNCHANGED, as a child'), tail.index("    if probs: raise RuntimeError('lease margin after the gate: ' + '; '.join(probs))\n")
        block = tail[w0:w1]
        self.assertIn("    if wd['returncode'] != 0: raise RuntimeError('the operational gate FAILED: ' + json.dumps(json.loads((A/'gate.json').read_text()).get('why'))[:400])", block)
        self.assertIn("if wd['outcome'] != 'exited': raise RuntimeError", block); self.assertIn('subprocess.Popen(gate, start_new_session=True)', block)
        self.assertIn('stop_gate(proc)', block); self.assertNotIn('--window', block); self.assertNotIn('--warmup', block)
        self.assertIn("    if probs: raise RuntimeError('lease margin before the gate: ' + '; '.join(probs))", block)
        self.assertLess(block.index('lease_before_gate('), block.index('subprocess.Popen(gate')); self.assertIn('initial=before', block)
        rest = tail[:w0] + gate_line + tail[w1 + len("    if probs: raise RuntimeError('lease margin after the gate: ' + '; '.join(probs))\n"):]
        rest = rest.replace("    record_registry(result, since); save()\n", "", 1).replace("        record_registry(result, since); save()\n", "", 1)
        rest = rest.replace("    for _s in (signal.SIGHUP, signal.SIGTERM): signal.signal(_s, signal.SIG_IGN)   # the rollback is never cut short by a signal\n", "", 1)
        self.assertEqual(rest, old_tail)
        self.assertLess(new.index("fund, probs = boot_funding("), new.index("probs = cutover_margin_problems(pre, ids, time.time())"))
        self.assertLess(new.index("probs = cutover_margin_problems(pre, ids, time.time())"), new.index("atomic_config(new, mode)"), 'the margin is the last check before the write')
        self.assertLess(new.index("pb = prebaseline.collect("), new.index("fund, probs = boot_funding("))
        self.assertLess(new.index("shielded_expectation_problems("), new.index("atomic_config(new, mode)"))
        pre_cut = new[:new.index(cut)]   # SIGHUP/SIGTERM become the normal failure path before the write; ignored inside the rollback
        self.assertIn("for _s in (signal.SIGHUP, signal.SIGTERM): signal.signal(_s, _signalled)", pre_cut)
        exc = tail[tail.index('except BaseException as e:'):]
        self.assertLess(exc.index('signal.SIG_IGN'), exc.index('safe_rollback('))


class RewriteDist(unittest.TestCase):
    raw = ('{\n  "name": "metal0",\n  "dist": "/home/steven/enclave-prod/dist-leasegas-deabf8f90",\n  "leaseGas": {"rpcs": ["x"]},\n'
           '    "odd":   [1,2 , 3]\n}\n').encode()

    def test_only_dist_changes_every_other_byte_preserved(self):
        new = C.rewrite_dist(self.raw, C.CURRENT['dist'], NEWDIST)
        self.assertEqual(new, self.raw.replace(b'dist-leasegas-deabf8f90', b'dist-leasegas-0c565d3ca'))
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

    def test_additive_38_to_39_in_installed_order(self):
        existing, text = C.admission_body(self.body, list(reversed(EXISTING)), NEWM)
        self.assertEqual(existing, EXISTING)
        self.assertEqual(text, 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n')
        self.assertEqual(len(text.strip().split('=')[1].split(',')), 39)
        self.assertEqual(C.RELAY['installedSha256'], json.loads((THIRD/'admission.json').read_text())['environmentSha256'], 'CAS from the 38-entry admission')

    def test_refusals(self):
        w_ee5 = [x for x in EXISTING if x != PRIOR] + [M('d')]; w_08d = [x for x in EXISTING if x != NINE] + [M('d')]; w_b07 = [x for x in EXISTING if x != B007] + [M('d')]
        cases = [(self.body + 'X=1\n', EXISTING, NEWM, 'not exactly one'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:37]) + '\n', EXISTING[:37], NEWM, 'reviewed state is 38'),
                 (self.body, EXISTING[:37] + [M('f')], NEWM, 'not the public allowlist'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(w_08d) + '\n', w_08d, NEWM, 'b007d471 is not admitted'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(w_b07) + '\n', w_b07, NEWM, 'b007d471 is not admitted'),
                 (self.body, EXISTING, B007, 'already admitted'),
                 (self.body, EXISTING, NINE, 'already admitted'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[1:] + [M('e')]) + '\n', EXISTING[1:] + [M('e')], NEWM, 'running measurement is not admitted'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(w_ee5) + '\n', w_ee5, NEWM, 'b007d471 is not admitted'),
                 (self.body, EXISTING, PRIOR, 'already admitted'),
                 (self.body, EXISTING, 'x' * 96, 'malformed candidate'),
                 ('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING[:37] + [EXISTING[3]]) + '\n', EXISTING, NEWM, 'duplicate')]
        for body, pub, new, w in cases:
            with self.assertRaisesRegex(AssertionError, w): C.admission_body(body, pub, new)


class RemoteScripts(unittest.TestCase):
    """The SAME remote script text admit/unadmit/prepare send over SSH, run locally against temp files and a stub systemctl."""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.env, self.drop, self.log = self.d/'m.env', self.d/'drop.conf', self.d/'systemctl.log'
        self.env.write_text('METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING) + '\n'); self.drop.write_text('[Service]\nEnvironmentFile=x\n')
        (self.d/'m.env.before-a6b1378cd').write_text('the first attempt\'s backup'); (self.d/'m.env.before-9f6d37bd8').write_text('the second attempt\'s backup')
        self.ctl = self.d/'systemctl'
        self.ctl.write_text(f'#!/bin/sh\necho "$@" >> {self.log}\nif [ "$1" = restart ] && [ -e {self.d}/fail-restart ]; then rm {self.d}/fail-restart; exit 1; fi\n'
                            f'if [ "$1" = is-active ]; then echo active; fi\nexit 0\n')
        self.ctl.chmod(0o755)

    def run_script(self, template, args):
        return subprocess.run([sys.executable, '-'], input=C.remote(template, args), text=True, capture_output=True)

    def cas(self, body, expect=None, backup=None):
        backup = backup or self.d/'m.env.before-0c565d3ca'
        args = (str(self.env), str(self.drop), str(backup), body, expect or C.sha(self.env.read_bytes()), C.sha(self.drop.read_bytes()),
                '0c565d3ca', str(self.ctl), 'enclave-api-relay.service')
        return self.run_script(C.REMOTE_CAS, args), backup

    def test_cas_success_keeps_the_first_backup(self):
        old = self.env.read_bytes(); new = 'METAL_ALLOWED_MEASUREMENTS=' + ','.join(EXISTING + [NEWM]) + '\n'
        r, backup = self.cas(new)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(self.env.read_text(), new); self.assertEqual(backup.read_bytes(), old)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600); self.assertIn('restart enclave-api-relay.service', self.log.read_text())
        self.assertEqual((self.d/'m.env.before-a6b1378cd').read_text(), 'the first attempt\'s backup')
        self.assertEqual((self.d/'m.env.before-9f6d37bd8').read_text(), 'the second attempt\'s backup')

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
    """build_problems on ROOT's real completed 7dd3acd0 build (custody-boot-price-release-20261023, 22:25-22:29:26Z: the newest real
    build-price.sh output; the fee commit has no build yet), read-only, and on single-field corruptions of it. Its source is
    re-derived with source_base: 7dd's sendOperatorTx is the fee counterexample, refused by source_record (below)."""
    @classmethod
    def setUpClass(cls):
        B = PRICE_BUILD
        cls.appr = (B/'APPROVED-COMMIT.txt').read_text(); cls.src = C.source_base(cls.appr)[0]
        cls.name = 'dist-leasegas-' + cls.src['commit'][:9]
        cls.log = (B/'logs/root-build-price.out').read_text(); cls.rec = (B/'stage/build-record.json').read_text()
        cls.inv = (B/'stage/INVENTORY.sha256').read_text(); cls.meas = (B/'stage'/cls.name/'MEASUREMENT').read_text()

    def setUp(self):   # the fixture IS b007d471, now a prior: the builder rules are exercised on it with b007 lifted (in place)
        self._priors = list(C.PRIORS); C.PRIORS[:] = [x for x in C.PRIORS if x != B007]
    def tearDown(self): C.PRIORS[:] = self._priors

    def test_with_the_real_priors_the_7dd_build_is_a_previous_image(self):
        C.PRIORS[:] = self._priors
        self.assertIn("the candidate measurement is a previous image's", self.bp()[1])

    def bp(self, log=None, rec=None, inv=None, meas=None, src=None, appr=None):
        return C.build_problems(self.log if log is None else log, self.appr if appr is None else appr, self.rec if rec is None else rec,
                                self.inv if inv is None else inv, self.meas if meas is None else meas, self.src if src is None else src)

    def test_the_actual_completed_build_passes(self):
        rec, p = self.bp(); self.assertEqual(p, [])
        self.assertEqual((rec['commit'], rec['parent'], rec['name']), ('7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b', C.PARENT, 'dist-leasegas-7dd3acd06'))
        self.assertTrue(rec['measurement'].startswith('b007d471')); self.assertEqual(rec['imageFiles'], ['/app/supervisor.js', '/opt/metal/gsup.mjs'])
        self.assertEqual(rec['files']['vmlinuz'], C.NINE['files']['vmlinuz']); self.assertNotEqual(rec['files']['initramfs.cpio.gz'], C.NINE['files']['initramfs.cpio.gz'])
        self.assertEqual(C.staged_problems(PRICE_BUILD/'stage'/self.name, rec['files']), [])

    def test_refusals(self):
        L = self.log
        drop = lambda w: '\n'.join(l for l in L.splitlines() if l != w) + '\n'
        dup = lambda w: L.replace(w + '\n', w + '\n' + w + '\n', 1)
        for w in C.build_markers(self.src['imageFiles']):
            self.assertRegex('; '.join(self.bp(log=drop(w))[1]), 'not once', w); self.assertRegex('; '.join(self.bp(log=dup(w))[1]), 'not once', w)
        cand = next(l for l in L.splitlines() if l.startswith('MEASURE-CANDIDATE '))
        r = json.loads(self.rec)
        for log, why in [(L + 'REFUSED: x\n', 'refusal'), (L + 'CHANGED vmlinuz\n', 'refusal'), (L + 'VERIFY-FAILED: x\n', 'refusal'),
                         (L.replace(cand, 'MEASURE-CANDIDATE ' + NINE), 'previous image'), (L.replace(cand + '\n', ''), 'MEASURE-CANDIDATE'),
                         (L.replace('BUILD-RECORD ', 'BUILD-RECORD 0'), 'BUILD-RECORD'),
                         (L.replace('PRECHECK-PASS {', 'PRECHECK-PASS {"extra": 1, ', 1), 'logged precheck')]:
            self.assertRegex('; '.join(self.bp(log=log)[1]), why)
        for rec, why in [(json.dumps({**r, 'delta': r['delta'][1:]}), 're-derived source'), (json.dumps({**r, 'patch': {**r['patch'], 'sha256': '0' * 64}}), 'source patch'),
                         (json.dumps({**r, 'measurement': NINE}), 'do not name'), (json.dumps({**r, 'inventory': {}}), 'inventory'), ('{', 'not JSON')]:
            self.assertRegex('; '.join(self.bp(rec=rec)[1]), why)
        self.assertRegex('; '.join(self.bp(meas=NINE + '\n')[1]), 'MEASUREMENT')
        kern = self.inv.replace(C.NINE['files']['vmlinuz'], '0' * 64)
        self.assertRegex('; '.join(self.bp(inv=kern, log=L.replace(C.NINE['files']['vmlinuz'] + '  ' + self.name, '0' * 64 + '  ' + self.name))[1]), 'vmlinuz changed')
        self.assertRegex('; '.join(self.bp(src={**self.src, 'imageFiles': ['/app/supervisor.js']})[1]), 're-derived source|not once')
        for f in ('initramfs.cpio.gz', 'manifest.json'):                     # the 08d1 (9f) image file itself: not the new build
            ours = next(l.split('  ')[0] for l in self.inv.splitlines() if l.endswith('/' + f))
            inv = self.inv.replace(ours, C.NINE['files'][f]); log = L.replace(ours + '  ' + self.name, C.NINE['files'][f] + '  ' + self.name)
            self.assertRegex('; '.join(self.bp(inv=inv, log=log)[1]), f"{f} equals 08d1", f)

    def test_source_is_rederived_from_git_with_the_pinned_precheck(self):
        self.assertEqual(self.src['bootDecisionSha256'], C.sha(C.decision_source(C.git('show', self.src['commit'] + ':supervisor.js').decode()).encode()))
        for appr, why in [(self.appr.replace('gsup REVIEWED', 'gsup UNCHANGED'), 'source refused'), ('commit ' + C.PARENT + '\ngsup REVIEWED\ntests NONE\n', 'source refused'),
                          (self.appr.replace('tests test/boot-gpu-price.test.mjs ', 'tests '), 'source refused')]:
            with self.assertRaisesRegex(AssertionError, why): C.source_base(appr)
        self.assertEqual(C.sha((C.BUILD/'precheck.py').read_bytes()), C.PRECHECK_SHA256, 'the fee build folder carries the reviewed precheck')
        d = Path(tempfile.mkdtemp()); (d/'precheck.py').write_text((C.BUILD/'precheck.py').read_text() + '# edited\n')
        with self.assertRaisesRegex(AssertionError, 'not the reviewed one'): C.precheck_module(d)
        with self.assertRaisesRegex(AssertionError, 'not exactly one'): C.decision_source('function bootRegistrationAction(row, want) {\n}\nfunction bootRegistrationAction(row, want) {\n}')
        # 9f6d37bd's own source lacks the pending-GPU expectation: refused even with a matching precheck record
        class PC:
            class Refused(Exception): pass
            @staticmethod
            def check(repo, text): return ({'commit': C.PARENT, 'parent': 'x', 'gsupReviewed': True, 'tests': [], 'delta': [], 'imageFiles': []}, b'p', 'full context')
        with self.assertRaisesRegex(AssertionError, 'pending-GPU expectation'): C.source_base('x', pc=PC)
        class PC2(PC):
            @staticmethod
            def check(repo, text): return ({'commit': self.src['commit'], 'parent': C.PARENT, 'gsupReviewed': False, 'tests': [], 'delta': [], 'imageFiles': []}, b'p', 'full context')
        with self.assertRaisesRegex(AssertionError, 'gsup.mjs is unchanged'): C.source_base('x', pc=PC2)
        orig = C.git                                                         # the real 7dd3acd source with ONE marker removed
        for path, token in [('gsup.mjs', b'SHIELDED_GPU_EXPECTED'), ('supervisor.js', b'SHIELDED_GPU_EXPECTED'), ('supervisor.js', b'function gpuPricePending(')]:
            C.git = lambda *a, repo=C.H_REPO, path=path, token=token: orig(*a, repo=repo).replace(token, b'XX') if a[-1].endswith(path) else orig(*a, repo=repo)
            try:
                with self.assertRaisesRegex(AssertionError, 'pending-GPU expectation', msg=(path, token)): C.source_base(self.appr)
            finally: C.git = orig
        self.assertEqual(C.source_base(self.appr)[0], self.src)

    def test_the_7dd_sender_is_refused_by_the_fee_contract_and_the_explicit_sender_passes(self):
        with self.assertRaisesRegex(AssertionError, 'breaks the fee contract.*estimateFeesPerGas'): C.source_record(self.appr)   # 7dd3acd0: plain writeContract
        old = C.sender_source(C.git('show', self.src['commit'] + ':supervisor.js').decode())
        self.assertRegex('; '.join(C.sender_contract_problems(old)), 'writeContract does not state gas')
        fx = (HERE/'fixtures/sender-explicit.js').read_text(); new = C.sender_source(fx)
        self.assertEqual(C.sender_contract_problems(new), [])
        for a, b, why in [('chainClient.estimateFeesPerGas()', 'estimateFeesPerGas()', 'estimateFeesPerGas'), ('chainClient.estimateContractGas(', 'x.estimateContractGas(', 'estimateContractGas'),
                          ('args, gas, maxFeePerGas, maxPriorityFeePerGas })', 'args, gas, maxFeePerGas })', 'maxPriorityFeePerGas'), ('_txChain.then(', 'Promise.resolve().then(', '_txChain')]:
            self.assertIn(a, new, a); self.assertRegex('; '.join(C.sender_contract_problems(new.replace(a, b))), why)
        with self.assertRaisesRegex(AssertionError, 'not exactly one'): C.sender_source(new + '\n' + new)

    def test_approval_and_plan(self):
        d = Path(tempfile.mkdtemp()); rec, _ = self.bp(); rec = {**rec, 'senderSha256': 'ab' * 32}; raw = (json.dumps(rec) + '\n').encode(); (d/'build.json').write_bytes(raw)
        (d/'APPROVED-BUILD.txt').write_text('build-sha256 ' + '0' * 64 + '\n')
        with self.assertRaisesRegex(AssertionError, 'root review'): C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt')
        (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw)}\n')
        got, h = C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt'); self.assertEqual(h, C.sha(raw))
        for other, why in [({**rec, 'parent': 'a6b1378cdf430217025987d90c040d0e25a9993d'}, 'child of 9f6d37bd'), ({**rec, 'name': 'dist-leasegas-9f6d37bd8'}, 'child of 9f6d37bd'),
                           ({**rec, 'measurement': NINE}, 'no new measurement'),
                           ({**rec, 'bootDecisionSha256': None}, 'bootDecisionSha256'), ({**rec, 'senderSha256': None}, 'senderSha256')]:
            raw2 = (json.dumps(other) + '\n').encode(); (d/'build.json').write_bytes(raw2); (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw2)}\n')
            with self.assertRaisesRegex(AssertionError, why): C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt')
        C.PRIORS[:] = self._priors                                           # with the real priors a b007d471 build.json refuses
        raw2 = (json.dumps({**rec, 'measurement': B007}) + '\n').encode(); (d/'build.json').write_bytes(raw2); (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw2)}\n')
        with self.assertRaisesRegex(AssertionError, 'no new measurement'): C.approved_build(d/'build.json', d/'APPROVED-BUILD.txt')
        C.PRIORS[:] = [x for x in C.PRIORS if x != B007]                   # back to the lifted fixture for the plan checks
        (d/'build.json').write_bytes(raw); (d/'APPROVED-BUILD.txt').write_text(f'build-sha256 {C.sha(raw)}\n')
        plan = {'buildSha256': C.sha(raw), 'measurement': rec['measurement'], 'files': rec['files'], 'image': NEWDIST}
        (d/'plan.json').write_text(json.dumps(plan)); n = C.load_new(d)
        self.assertEqual((n['measurement'], n['bootDecisionSha256'], n['supervisorSha256'], n['senderSha256']), (rec['measurement'], rec['bootDecisionSha256'], rec['supervisorSha256'], rec['senderSha256']))
        (d/'plan.json').write_text(json.dumps({**plan, 'measurement': PRIOR}))
        with self.assertRaisesRegex(AssertionError, 'not the approved build'): C.load_new(d)

    def test_staged_dir_hashes(self):
        d = Path(tempfile.mkdtemp()); files = {}
        for f in C.FILES: (d/f).write_bytes(f.encode()); files[f] = C.sha(f.encode())
        self.assertEqual(C.staged_problems(d, files), [])
        (d/'cmdline').write_bytes(b'x'); self.assertTrue(C.staged_problems(d, files))
        (d/'cmdline').write_bytes(b'cmdline'); (d/'extra').write_bytes(b''); self.assertTrue(C.staged_problems(d, files))


class ShieldedExpectation(unittest.TestCase):
    """The new boot pends its GPU price only if gsup states the expectation: derived from config.json + the pinned launcher."""
    L = Path(C.LAUNCHER['path']).read_bytes()
    def cfg(self, **iso): return json.dumps({'mode': 'snp', 'isolation': {'backend': 'guestd', **iso}}).encode()
    def test_pinned_launcher_and_config(self):
        good = self.cfg(shieldedInference=True, shieldedPricing={'tflopUsdHr': 0.01, 'vramGiBUsdHr': 0.02})
        self.assertEqual(C.shielded_expectation_problems(good, self.L), (2, []))
        for raw, why in [(self.cfg(shieldedInference=False), 'not true'), (self.cfg(), 'not true'), (json.dumps({'mode': 'snp'}).encode(), 'no isolation'),
                         (self.cfg(shieldedInference=True, shieldedPricing={'tflopUsdHr': 0, 'vramGiBUsdHr': 0}), 'invalid'),
                         (self.cfg(shieldedInference=True, shieldedPricing={'tflopUsdHr': True, 'vramGiBUsdHr': 1}), 'invalid'),
                         (self.cfg(shieldedInference=True), 'invalid')]:
            n, p = C.shielded_expectation_problems(raw, self.L); self.assertEqual(n, 0); self.assertRegex('; '.join(p), why)
        n, p = C.shielded_expectation_problems(good, self.L + b'//x'); self.assertEqual(n, 0); self.assertRegex('; '.join(p), 'pinned')


class CutoverMarginAndWatchdog(unittest.TestCase):
    ids = list(C.APPS)
    def pre(self, left=(1000, 1400), ts=1000):
        return {'block': {'timestamp': str(ts)}, 'rows': [{'id': i, 'leaseRemainingSeconds': str(l)} for i, l in zip(self.ids, left)]}
    def test_cutover_margin_rollback_bound_and_required_feasibility_1440_at_the_actual_time(self):
        self.assertEqual((C.CUTOVER_MARGIN_S, C.CUTOVER_FEASIBLE_S), (900, 1440))
        self.assertEqual(C.cutover_margin_problems(self.pre((1600, 1800)), self.ids, 1000 + 159), [])
        self.assertRegex('; '.join(C.cutover_margin_problems(self.pre((1600, 1800)), self.ids, 1000 + 160)), 'not > 1440')   # exactly 1440: refused
        for left in (950, 1100, 1400):                                        # > 900 (rollback-safe) but no PASS possible: refused
            self.assertRegex('; '.join(C.cutover_margin_problems(self.pre((left, 1800)), self.ids, 1000)), 'da09d0f2', left)
        self.assertRegex('; '.join(C.cutover_margin_problems(self.pre((1800, 1430)), self.ids, 1000)), '9eb4e600')       # the OTHER app too
        self.assertEqual(C.cutover_margins(self.pre(), self.ids, 1010), {self.ids[0]: 990, self.ids[1]: 1390})

    # a fake gate process, wall clock and lease reader
    class Proc:
        def __init__(self, ends_at=None, rc=0, clock=None): self.ends_at, self.rc, self.clock, self.stopped, self.pid = ends_at, rc, clock, False, -1
        def poll(self): return (-15 if self.stopped else None) if (self.ends_at is None or self.clock.t < self.ends_at) else self.rc
    class Clock:
        def __init__(self): self.t = 10_000.0
        def wall(self): return self.t
        def sleep(self, s): self.t += s
    def run_wd(self, reader, ends_at=None, rc=0):
        c = self.Clock(); proc = self.Proc(ends_at and c.t + ends_at, rc, c)
        def stop(p): p.stopped = True
        def read():
            r = reader(c); c.t += 3; return r      # every read takes 3 s
        return C.gate_watchdog(proc, read, self.ids, wall=c.wall, sleep=c.sleep, stop=stop), proc, c
    def lease(self, left):   # every verified read shows these seconds left (as if each lease were renewed continuously)
        return lambda c: {'blockTs': int(c.t), 'block': '1', 'expiry': {i: c.t + l for i, l in zip(self.ids, left)}, 'holder': {i: ['0xr', '0xo', True] for i in self.ids}}
    def fixed(self, left):   # the expiries the FIRST read saw stay fixed: no renewal lands
        st = {}
        def read(c):
            st.setdefault('exp', {i: c.t + l for i, l in zip(self.ids, left)})
            return {'blockTs': int(c.t), 'block': '1', 'expiry': dict(st['exp']), 'holder': {i: ['0xr', '0xo', True] for i in self.ids}}
        return read

    def test_happy_path_waits_for_the_gate_and_never_reports_pass(self):
        wd, proc, c = self.run_wd(self.lease((1500, 1900)), ends_at=870, rc=0)
        self.assertEqual((wd['outcome'], wd['returncode']), ('exited', 0)); self.assertFalse(proc.stopped)
        self.assertGreaterEqual(len(wd['reads']), 14); self.assertNotIn('PASS', json.dumps(wd))
        gaps = [b['at'] - a['at'] for a, b in zip(wd['reads'], wd['reads'][1:])]; self.assertTrue(all(g <= C.WATCH_POLL_S + 5 for g in gaps), gaps)
        wd, _, _ = self.run_wd(self.lease((1500, 1900)), ends_at=100, rc=1); self.assertEqual((wd['outcome'], wd['returncode']), ('exited', 1))

    def test_low_margin_stops_the_gate(self):
        wd, proc, _ = self.run_wd(self.fixed((1500, 700)), ends_at=870)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertRegex(wd['why'], '<= 600')
        wd, proc, _ = self.run_wd(self.fixed((600, 1500)))
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertEqual(len(wd['reads']), 1)

    def test_only_a_verified_renewal_extends_the_window(self):
        def lease_renewed_at(renew_after):
            st = {}
            def read(c):   # app 0 starts with 900 s; a renewal (+1800 s) is visible only in verified reads after renew_after
                t0 = st.setdefault('t0', c.t)
                exp = t0 + 900 + (1800 if renew_after is not None and c.t - t0 >= renew_after else 0)
                return {'blockTs': int(c.t), 'block': '1', 'expiry': {self.ids[0]: exp, self.ids[1]: c.t + 1800}, 'holder': {i: ['0xr', '0xo', True] for i in self.ids}}
            return read
        wd, proc, _ = self.run_wd(lease_renewed_at(240), ends_at=870, rc=0)
        self.assertEqual(wd['outcome'], 'exited'); self.assertFalse(proc.stopped)
        wd, proc, _ = self.run_wd(lease_renewed_at(None), ends_at=870)          # never renewed: stopped once 600 s remain
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertRegex(wd['why'], '<= 600')
        wd, proc, _ = self.run_wd(lease_renewed_at(330), ends_at=870)          # renewed too late (after the floor): stopped
        self.assertEqual(wd['outcome'], 'stopped')

    def test_rpc_failure_and_staleness_stop_the_gate(self):
        def never(c): raise RuntimeError('RPCs disagree')
        wd, proc, _ = self.run_wd(never, ends_at=870)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertRegex(wd['why'], 'no fresh verified lease read'); self.assertTrue(wd['readErrors'])
        state = {'n': 0}
        def flaky(c):
            state['n'] += 1
            if state['n'] > 2: raise RuntimeError('timeout')
            return self.lease((1500, 1900))(c)
        wd, proc, c = self.run_wd(flaky, ends_at=870)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertRegex(wd['why'], r'block is \d+ s old \(> 105 s\)')
        state['n'] = 0
        def one_blip(c):
            state['n'] += 1
            if state['n'] == 2: raise RuntimeError('one timeout')
            return self.lease((1500, 1900))(c)
        wd, proc, _ = self.run_wd(one_blip, ends_at=870, rc=0)
        self.assertEqual(wd['outcome'], 'exited', 'one failed read retried within the stale bound'); self.assertEqual(len(wd['readErrors']), 1)

    def test_watchdog_seed_is_the_fresh_pre_gate_read_and_block_age_is_never_reset(self):
        hold = {i: ['0xr', '0xo', True] for i in self.ids}
        stop = lambda p: setattr(p, 'stopped', True)
        def seeded(block_age, exp=1500):
            c = self.Clock(); return c, {'blockTs': int(c.t) - block_age, 'readAt': c.t, 'block': '0', 'expiry': {i: c.t + exp for i in self.ids}, 'holder': hold}
        st = {'n': 0}
        def blip_then_ok(c):
            st['n'] += 1
            if st['n'] == 1: raise RuntimeError('first live read times out')
            return self.lease((1500, 1900))(c)
        c, init = seeded(5); proc = self.Proc(c.t + 870, 0, c)                 # fresh seed: one failed live read is retried in budget
        wd = C.gate_watchdog(proc, lambda: (blip_then_ok(c), setattr(c, 't', c.t + 3))[0], self.ids, wall=c.wall, sleep=c.sleep, stop=stop, initial=init)
        self.assertEqual(wd['outcome'], 'exited'); self.assertFalse(proc.stopped); self.assertEqual(len(wd['readErrors']), 1)
        c, init = seeded(200); proc = self.Proc(c.t + 870, 0, c)               # an OLD block read just now is not blessed fresh
        wd = C.gate_watchdog(proc, lambda: self.lease((1500, 1900))(c), self.ids, wall=c.wall, sleep=c.sleep, stop=stop, initial=init)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertRegex(wd['why'], 'agreed block is 200 s old'); self.assertEqual(wd['reads'], [])
        c, init = seeded(5); proc = self.Proc(c.t + 870, 0, c)                 # live reads all failing: stopped once the SEED's block is 105 s old
        wd = C.gate_watchdog(proc, lambda: (_ for _ in ()).throw(RuntimeError('down')), self.ids, wall=c.wall, sleep=c.sleep, stop=stop, initial=init)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertRegex(wd['why'], r'block is 10[5-9] s old|block is 11\d s old')
        self.assertLessEqual(c.t - init['blockTs'], C.WATCH_STALE_S + 5)
        c, init = seeded(5, exp=590); proc = self.Proc(c.t + 870, 0, c)        # seed already under the floor: stopped at once
        wd = C.gate_watchdog(proc, lambda: self.lease((1500, 1900))(c), self.ids, wall=c.wall, sleep=c.sleep, stop=stop, initial=init)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertRegex(wd['why'], '<= 600')

    def test_lease_before_gate_is_fresh_same_holder_and_above_the_floor(self):
        hold = {i: ['0xr', '0xo', True] for i in self.ids}
        c = self.Clock(); st = {'n': 0}
        def stale_then_fresh():
            st['n'] += 1
            return {'blockTs': int(c.t) - (300 if st['n'] == 1 else 2), 'block': '1', 'expiry': {i: c.t + 1400 for i in self.ids}, 'holder': hold}
        r, p = C.lease_before_gate(stale_then_fresh, hold, wall=c.wall, sleep=c.sleep); self.assertEqual(p, []); self.assertEqual(st['n'], 2); self.assertIn('readAt', r)
        r, p = C.lease_before_gate(lambda: {'blockTs': int(c.t), 'block': '1', 'expiry': {i: c.t + 600 for i in self.ids}, 'holder': hold}, hold, wall=c.wall, sleep=c.sleep)
        self.assertIsNone(r); self.assertRegex('; '.join(p), 'before the gate, not > 600')
        r, p = C.lease_before_gate(lambda: {'blockTs': int(c.t), 'block': '1', 'expiry': {i: c.t + 1400 for i in self.ids}, 'holder': {**hold, self.ids[1]: ['0xs', '0xo', True]}}, hold, wall=c.wall, sleep=c.sleep)
        self.assertIsNone(r); self.assertRegex('; '.join(p), 'holder')
        r, p = C.lease_before_gate(lambda: (_ for _ in ()).throw(RuntimeError('down')), hold, wall=c.wall, sleep=c.sleep)
        self.assertIsNone(r); self.assertRegex(p[0], 'no fresh verified lease read before the gate within 105 s')

    def test_lease_after_gate_retries_only_staleness_within_the_budget(self):
        hold = {i: ['0xr', '0xo', True] for i in self.ids}
        c = self.Clock(); st = {'n': 0}
        def fail_then_ok():
            st['n'] += 1
            if st['n'] < 3: raise RuntimeError('timeout')
            return {'blockTs': int(c.t), 'expiry': {i: c.t + 1000 for i in self.ids}, 'holder': hold}
        r, p = C.lease_after_gate(fail_then_ok, hold, wall=c.wall, sleep=c.sleep); self.assertEqual(p, []); self.assertIsNotNone(r)
        r, p = C.lease_after_gate(lambda: (_ for _ in ()).throw(RuntimeError('down')), hold, wall=c.wall, sleep=c.sleep)
        self.assertIsNone(r); self.assertRegex(p[0], 'no fresh verified lease read after the gate')
        st['n'] = 0
        def moved():
            st['n'] += 1; return {'blockTs': int(c.t), 'expiry': {i: c.t + 1000 for i in self.ids}, 'holder': {**hold, self.ids[0]: ['0xs', '0xo', True]}}
        r, p = C.lease_after_gate(moved, hold, wall=c.wall, sleep=c.sleep); self.assertRegex('; '.join(p), 'holder'); self.assertEqual(st['n'], 1, 'a holder change is final, never retried')
        r, p = C.lease_after_gate(lambda: {'blockTs': int(c.t), 'expiry': {i: c.t + 400 for i in self.ids}, 'holder': hold}, hold, wall=c.wall, sleep=c.sleep)
        self.assertRegex('; '.join(p), 'not > 480')

    def test_after_gate_needs_more_than_rollback_on_a_fresh_read_by_the_same_holder(self):
        hold = {i: ['0xr', '0xo', True] for i in self.ids}
        r = {'blockTs': 990, 'expiry': {self.ids[0]: 2000, self.ids[1]: 1481}, 'holder': hold}
        self.assertEqual(C.after_gate_problems(r, 1000, hold), [])
        self.assertTrue(C.after_gate_problems({**r, 'expiry': {self.ids[0]: 1480, self.ids[1]: 5000}}, 1000, hold))
        self.assertRegex('; '.join(C.after_gate_problems({**r, 'blockTs': 800}, 1000, hold)), 'old')
        self.assertRegex('; '.join(C.after_gate_problems(r, 1000, {**hold, self.ids[0]: ['0xs', '0xo', True]})), 'holder')
        self.assertRegex('; '.join(C.after_gate_problems(r, 1000, None)), 'no lease holder')

    def test_stale_or_future_block_is_not_fresh_and_a_holder_change_stops(self):
        old = lambda c: {**self.lease((1500, 1900))(c), 'blockTs': int(c.t) - 200}      # agreeing RPCs serving an old block
        wd, proc, _ = self.run_wd(old, ends_at=870)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertRegex(wd['readErrors'][0]['error'], 'old')
        fut = lambda c: {**self.lease((1500, 1900))(c), 'blockTs': int(c.t) + 120}
        wd, proc, _ = self.run_wd(fut, ends_at=870); self.assertEqual(wd['outcome'], 'stopped')
        st = {'n': 0}
        def moved(c):
            st['n'] += 1; r = self.lease((1500, 1900))(c)
            if st['n'] >= 3: r['holder'] = {**r['holder'], self.ids[1]: ['0xother', '0xo', True]}
            return r
        wd, proc, _ = self.run_wd(moved, ends_at=870)
        self.assertEqual(wd['outcome'], 'stopped'); self.assertTrue(proc.stopped); self.assertRegex(wd['why'], 'holder')

    def test_stop_gate_sweeps_a_descendant_that_ignores_sigterm(self):
        d = Path(tempfile.mkdtemp()); pidf = d/'child.pid'
        code = ('import subprocess,sys,time; c=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)"]); '
                f'open({str(pidf)!r},"w").write(str(c.pid)); time.sleep(300)')
        gate = subprocess.Popen([sys.executable, '-c', code], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(200):
                if pidf.exists() and pidf.read_text(): break
                time.sleep(0.05)
            child = int(pidf.read_text()); time.sleep(0.2)
            C.stop_gate(gate, grace=2); self.assertIsNotNone(gate.poll())
            for _ in range(40):
                try: os.kill(child, 0); time.sleep(0.05)
                except ProcessLookupError: break
            with self.assertRaises(ProcessLookupError): os.kill(child, 0)
        finally:
            try: os.killpg(gate.pid, 9)
            except ProcessLookupError: pass

    def test_real_process_group_is_stopped_without_orphans(self):
        d = Path(tempfile.mkdtemp()); pidf = d/'child.pid'
        gate = subprocess.Popen([sys.executable, '-c', f'import subprocess,time; c=subprocess.Popen(["sleep","300"]); open({str(pidf)!r},"w").write(str(c.pid)); time.sleep(300)'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if pidf.exists() and pidf.read_text(): break
            time.sleep(0.05)
        child = int(pidf.read_text())
        wd = C.gate_watchdog(gate, lambda: (_ for _ in ()).throw(RuntimeError('no RPC')), self.ids, sleep=lambda s: time.sleep(0.01),
                             wall=(lambda t=[time.time()]: (t.__setitem__(0, t[0] + 50) or t[0])))
        self.assertEqual(wd['outcome'], 'stopped'); self.assertIsNotNone(gate.poll())
        time.sleep(0.2)
        try:
            with self.assertRaises(ProcessLookupError): os.kill(child, 0)   # the gate's own child went with its group
        finally:                                                         # never leave the test's own processes behind (mutants)
            try: os.killpg(gate.pid, 9)
            except ProcessLookupError: pass

    def test_lease_read_parses_only_a_verified_preflight(self):
        d = Path(tempfile.mkdtemp())
        ok = lambda *a, **k: type('R', (), {'returncode': 0, 'stdout': '', 'stderr': ''})
        def write(**over):
            pre = {'readOnly': True, 'quorum': 2, 'block': {'number': '5', 'timestamp': '1000'},
                   'rows': [{'id': i, 'active': True, 'leaseRemainingSeconds': '1200', 'runner': '0xR', 'runnerOperator': '0xO', 'hostActive': True} for i in self.ids], **over}
            (d/'lease-preflight.json').write_text(json.dumps(pre))
        write(); self.assertEqual(C.lease_read(self.ids, run=ok, evidence=d)['expiry'], {i: 2200 for i in self.ids})
        self.assertEqual(C.lease_read(self.ids, run=ok, evidence=d)['holder'], {i: ['0xr', '0xo', True] for i in self.ids})
        for over in [{'readOnly': False}, {'quorum': 1}, {'rows': [{'id': self.ids[0], 'active': True, 'leaseRemainingSeconds': '1'}]},
                     {'rows': [{'id': i, 'active': False, 'leaseRemainingSeconds': '1200'} for i in self.ids]}]:
            write(**over)
            with self.assertRaises(RuntimeError): C.lease_read(self.ids, run=ok, evidence=d)
        bad = lambda *a, **k: type('R', (), {'returncode': 1, 'stdout': '', 'stderr': 'boom'})
        with self.assertRaisesRegex(RuntimeError, 'lease read failed'): C.lease_read(self.ids, run=bad, evidence=d)


class RegistryRecord(unittest.TestCase):
    def test_paths(self):
        tx = '0x' + 'ab' * 32
        self.assertEqual(C.registry_path([f'[registry] adopted the existing registration of https://api.enclave.host/t/metal0 id=0x1 (only the proof key differs; GPU price pending shielded discovery): proofKey=0x2 tx={tx}'])['setProofKeyTx'], tx)
        self.assertEqual(C.registry_path(['[registry] adopted the existing registration of u id=0x1 (already registered exactly): no transaction, proofKey=0x2'])['path'], 'read-only adopt')
        self.assertEqual(C.registry_path(['[registry] registered u repo=r id=0x1 tx=0x3'])['path'], 'full register()')
        self.assertEqual(C.registry_path([])['path'], 'no registration line seen')
        r = {}; C.record_registry(r, 'x', read=lambda: (_ for _ in ()).throw(RuntimeError('no journal'))); self.assertEqual(r['registry']['path'], 'unrecorded')


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
NEWX = {'commit': 'ab' * 20, 'supervisorSha256': '91' * 32, 'bootDecisionSha256': 'fe' * 32, 'senderSha256': '5e' * 32}
W7 = 38772 * 7000000 + 529241039
def row(rpc, gas='38772', fee='7000000', tip='1000000', sgas='38772', sfee='7000000', stip='1000000', l1='529241039', op='0', worst=None):
    w = worst if worst is not None else str(int(gas) * int(fee) + int(l1) + int(op if str(op).isdigit() else 0))
    return {'rpc': rpc, 'senderGas': sgas, 'senderMaxFeePerGas': sfee, 'senderMaxPriorityFeePerGas': stip, 'gas': gas, 'maxFeePerGas': fee,
            'maxPriorityFeePerGas': tip, 'nonce': '23759', 'l1FeeUpperBoundWei': l1, 'operatorFeeWei': op, 'worstCaseWei': w}
SET = {'action': 'setProofKey', 'reason': 'only the proof key differs'}
def facts(now=10_000):
    """Modeled on root's actual 2-RPC read (root-live-fees2, block 53001451) with the worst-case test key."""
    return {
        'at': 'x', 'readOnly': True, 'rpcs': ['https://a', 'https://b'], 'chainIds': [8453, 8453],
        'block': {'number': '53001451', 'hash': '0x' + '78' * 32, 'timestamp': str(now - 20)},
        'source': dict(NEWX),
        'registry': {'address': C.FUNDING['registry'], 'codeHash': C.FUNDING['registryCodeHash']},
        'operator': {'address': '0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB', 'code': C.FUNDING['operatorCode'], 'nonceAtBlock': '23759',
                     'latest': ['23759', '23759'], 'pending': ['23759', '23759'], 'balanceWei': '376132087579'},
        'executor': {'address': C.FUNDING['executor'], 'codeHash': C.FUNDING['executorCodeHash']},
        'row': {'operator': '0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB', 'active': True, 'endpoint': 'https://api.enclave.host/t/metal0',
                'repo': 'EnclaveHost/enclave', 'measurement': '0x' + '00' * 32, 'cpu': '834', 'gpu': '1667', 'proofKey': '0x8604ce59f394daf05b235122E5Dc054F5C2bB453'},
        'desired': {'operator': C.FUNDING['operator'], 'endpoint': 'https://api.enclave.host/t/metal0', 'repo': 'EnclaveHost/enclave',
                    'measurement': '0x' + '00' * 32, 'cpuPricePerSec6': '834', 'gpuPricePerSec6': '1667', 'proofKey': '0x' + 'ff' * 20},
        'desiredPending': {'operator': C.FUNDING['operator'], 'endpoint': 'https://api.enclave.host/t/metal0', 'repo': 'EnclaveHost/enclave',
                           'measurement': '0x' + '00' * 32, 'cpuPricePerSec6': '834', 'gpuPricePerSec6': None, 'proofKey': '0x' + 'ff' * 20},
        'testProofKey': '0x' + 'ff' * 20, 'actions': {'pending': dict(SET), 'discovered': dict(SET)},
        'fees': {'isthmus': True, 'pricedBy': 'the approved sendOperatorTx + viem prepareTransactionRequest (inert, no signer)'},
        'setProofKey': {'perRpc': [row('https://a'), row('https://b', gas='38500', sgas='38500')], 'worstCaseWei': str(W7)},
    }

class BootFunding(unittest.TestCase):
    now = 10_000
    def probs(self, f): return C.boot_funding_problems(f, self.now, NEWX)

    def test_root_actual_read_passes_with_headroom(self):
        self.assertEqual(self.probs(facts(self.now)), [])
        f = facts(self.now); self.assertGreaterEqual(int(f['operator']['balanceWei']) * 100, int(f['setProofKey']['worstCaseWei']) * 125)

    def test_refusals(self):
        def m(path, v):
            f = facts(self.now); o = f
            for k in path[:-1]: o = o[k]
            o[path[-1]] = v; return f
        worst = W7
        cases = [
            (m(['block', 'timestamp'], str(self.now - 400)), 'old'),
            (m(['actions', 'pending'], {'action': 'register', 'reason': 'the registered fields differ'}), 'pending AND|not setProofKey'),
            (m(['actions', 'discovered'], {'action': 'register', 'reason': 'the registered fields differ'}), 'not setProofKey'),
            (m(['actions', 'pending'], {'action': 'adopt', 'reason': 'already registered exactly'}), 'not setProofKey'),
            (m(['actions'], {'discovered': dict(SET)}), 'not setProofKey'),
            (m(['desiredPending', 'gpuPricePerSec6'], '1667'), 'pending decision was not asked'),
            (m(['desiredPending', 'cpuPricePerSec6'], '835'), 'pending decision was not asked'),
            (m(['source', 'bootDecisionSha256'], '00' * 32), 'approved build'),
            (m(['source', 'supervisorSha256'], '00' * 32), 'approved build'),
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
            (m(['source', 'commit'], 'a6b1378cdf430217025987d90c040d0e25a9993d'), 'approved build'),
            (m(['testProofKey'], '0x' + '01' * 20), 'test proof key'),
            (m(['row', 'proofKey'], '0x' + 'FF' * 20), 'test proof key'),
            (m(['operator', 'balanceWei'], str(worst * 12 // 10)), 'headroom'),
            (m(['operator', 'balanceWei'], str(worst - 1)), 'exceeds the balance'),
            (m(['setProofKey', 'perRpc'], [row('https://a', fee='13200000'), row('https://b')]), 're-priced by the fill path'),       # the 23:15 counterexample
            (m(['setProofKey', 'perRpc'], [row('https://a', sgas=None, sfee=None, stip=None, fee='13200000'), row('https://b')]), 'did not state explicit'),
            (m(['setProofKey', 'perRpc'], [row('https://a'), row('https://b', gas='40000')]), 're-priced'),
            (m(['setProofKey', 'perRpc'], [row('https://a')]), 'both RPCs'),
            (m(['setProofKey', 'perRpc'], [row('https://b'), row('https://a')]), 'both RPCs'),
            (m(['setProofKey', 'perRpc'], [row('https://a', op='UNDETERMINED'), row('https://b')]), 'undetermined'),
            (m(['fees', 'isthmus'], None), 'undetermined'),
            (m(['setProofKey', 'perRpc'], [row('https://a', worst=str(W7 - 5)), row('https://b')]), 'add up'),
            (m(['setProofKey', 'worstCaseWei'], str(W7 - 5)), 'larger per-RPC'),
            (m(['source', 'senderSha256'], '00' * 32), 'approved build'),
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
        f, probs = C.boot_funding(['https://a', 'https://b'], NEWX, '/nonexistent', run=lambda *a, **k: R)
        self.assertIsNone(f); self.assertRegex(probs[0], 'disagree')

    def test_runner_failure_names_the_error_line(self):
        class R: returncode, stdout = 1, ''
        R.stderr = 'file:///x/boot-funding.mjs:60\n  const agree = ...\n\nError: RPCs disagree on block\n    at agree (file:///x:60:146)\n' + 'x' * 400 + '\nNode.js v22.23.3'
        _f, probs = C.boot_funding(['https://a', 'https://b'], NEWX, '/nonexistent', run=lambda *a, **k: R)
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
        self.build = 'bb' * 32
        self.v = {'probe': 'attest-control/1', 'wrapper': 'attest-price/1', 'target': 'priceRecovery', 'accepted': True, 'buildSha256': self.build, 'pass': True, 'status': 'verified', 'admissionSafe': True,
                  'expectedMeasurement': self.want, 'observedMeasurement': self.want, 'measurementMatches': True,
                  'required': {k: 'PASS' for k in C.VERDICT_REQUIRED}, 'freshness': 'verifier nonce', 'nonce': 'ab' * 32, 'vmpl': 0,
                  'failedChecks': [], 'at': at, 'rawSha256': C.sha(self.raw.read_bytes())}
    def p(self, v, raw=None, build=None): return C.attestation_verdict_problems(v, self.want, self.attached, self.now, raw or self.raw, build_sha=build or self.build)

    def test_exact_fresh_verdict_passes(self):
        self.assertEqual(self.p(self.v), [])

    def test_substring_or_failed_or_stale_evidence_refuses(self):
        self.assertTrue(self.p({'note': 'mentions ' + self.want}), 'naming the measurement is not a verdict')
        self.assertTrue(self.p('verified ' + self.want))
        for over, why in [({'pass': False}, 'pass'), ({'status': 'unavailable'}, 'status'), ({'observedMeasurement': PRIOR}, 'approved measurement'),
                          ({'expectedMeasurement': PRIOR, 'observedMeasurement': PRIOR}, 'approved measurement'), ({'required': {'chain': 'PASS'}}, 'required check'),
                          ({'nonce': 'short'}, 'nonce'), ({'vmpl': 1}, 'vmpl'), ({'failedChecks': ['tcb policy']}, 'failed checks'),
                          ({'at': self.attached}, 'not after the attachment'), ({'at': '2026-10-23T00:00:00+00:00'}, 'not after|old'), ({'probe': 'other'}, 'attest-price'),
                          ({'rawSha256': '0' * 64}, 'rawSha256'), ({'target': 'recovery'}, 'did not accept'), ({'accepted': False}, 'did not accept'),
                          ({'wrapper': None}, 'attest-price'), ({'buildSha256': 'cc' * 32}, 'approved build.json'), ({'failedChecks': None}, 'exactly'),
                          ({'failedChecks': 'none'}, 'exactly')]:
            self.assertRegex('; '.join(self.p({**self.v, **over})), why)
        self.raw.chmod(0o644); self.assertRegex('; '.join(self.p(self.v)), '0600')
        self.assertRegex('; '.join(self.p(self.v, self.d/'missing.json')), 'missing')

    def test_keep_uses_the_strict_check(self):
        k = (C.A/'keep.py').read_text()
        self.assertIn("attestation_verdict_problems(json.loads(ev), NEW['measurement'], r.get('attachedAt'), time.time(), a.attestation_raw, build_sha=NEW['buildSha256'])", k)
        self.assertTrue(self.p(self.v, build='cc' * 32))
        self.assertNotIn(".encode() in ev", k)


if __name__ == '__main__':
    unittest.main()
