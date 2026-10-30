#!/usr/bin/env python3
"""a1_capture.py tests (PREPARED; NOT run by Claude: jobs/root-capture-tests.sh runs them, exact count 25, no skips).
The capture runs for real (real subprocesses, real node, exclusive files, rename) over STUB A1 modules / l1-authority / one
fake dependency whose pins are their actual bytes; production pins are checked against the real reviewed sources; the
REAL pinned A1 gate is run over root's real captured receipts."""
import hashlib, json, os, pathlib, shutil, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import a1_capture as C                                                             # noqa: E402

NODE = os.environ['A1_NODE']
OPS = pathlib.Path(os.environ['A1_OPS'])                                        # .../source/ops/rpc-backend-bootstrap/2026-10-25
DEPS_REAL = pathlib.Path(os.environ['A1_DEPS_ROOT'])                            # .../source (the reviewed runners' ANCHOR_DEPS_ROOT)
L1A_REAL = pathlib.Path(os.environ['A1_L1_AUTHORITY'])                          # .../finality-stage/l1-authority/l1_authority.py
C.OWNER = os.getuid()
sha = lambda b: hashlib.sha256(b).hexdigest()
HELIOS_TEST = 'ab' * 32


class Case(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='a1cap-')); t = self.t
        shutil.copytree(HERE / 'stubs', t / 'src')
        (t / 'checkpoint.json').write_text('{"stub": "checkpoint"}')
        self.l1cfg = {'format': 'enclave-l1-authority/v1', 'binary': {'path': '/nonexistent/helios', 'sha256': HELIOS_TEST},
                      'listen': {'ip': '127.0.0.1', 'port': 28550}, 'checkpointFile': str(t / 'checkpoint.json')}
        self.write_l1()
        self.portal = {'readSucceeded': True, 'asr': C.MAINNET['asr'], 'block': {'hash': '0x' + '11' * 32}}
        self.write_portal()
        (t / 'src/initial-receipt.json').write_text('{"stub": "initial receipt"}')
        self.src = C.Sources(initial_dir=t / 'src/initial', recheck_dir=t / 'src/recheck', l1_authority=t / 'src/l1_authority.py',
                             l1_config=t / 'l1.json', portal_result=t / 'portal.json', initial_receipt=t / 'src/initial-receipt.json',
                             deps_root=t / 'src/deps', node=NODE)
        self.n = 0

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def write_l1(self):
        (self.t / 'l1.json').write_text(json.dumps(self.l1cfg))

    def write_portal(self):
        (self.t / 'portal.json').write_text(json.dumps(self.portal))

    def pins(self):
        """the stub sources' ACTUAL bytes as the 'reviewed' pins (production pins are tested separately)"""
        s = self.src; mods = {}
        for mode, d, names in (('initial', s.initial_dir, ['a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs']),
                               ('recheck', s.recheck_dir, ['a1-recheck-read.mjs', 'a1-recheck.mjs', 'a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs'])):
            mods[mode] = {r: sha((d / r).read_bytes()) for r in names}
        pf = C.read_package(s.deps_root, 'fakehash')
        return C.Pins(modules=mods, l1_authority=sha(s.l1_authority.read_bytes()), helios=HELIOS_TEST,
                      a1_example=sha((s.initial_dir / 'a1-config.example.json').read_bytes()), initial=sha(s.initial_receipt.read_bytes()),
                      lock=sha((s.deps_root / 'package-lock.json').read_bytes()), deps={'fakehash': ('1.0.0', C.tree_rows({r: sha(x) for r, x in pf.items()}))})

    def cap(self, mode='initial', pins=None, hooks=None):
        self.n += 1; out = self.t / f'out{self.n}'
        ok, res = C.capture(mode, out, src=self.src, pins=pins or self.pins(), hooks={'poll': 0.05, **(hooks or {})}, helios_timeout=20, a1_timeout=60)
        return ok, res, out

    def verify(self, out, pins=None):
        return C.verify(out, pins=pins or self.pins(), node=NODE, workdir=str(self.t), run_gate=False)

    def refused(self, code, fn, *a, **k):
        with self.assertRaises(C.Refused) as cm:
            fn(*a, **k)
        self.assertEqual(cm.exception.code, code, str(cm.exception))

    def evidence(self, out):
        return json.loads((out / 'capture/evidence.json').read_bytes())

    def poke(self, p, b):
        os.chmod(p, 0o600); p.write_bytes(b); os.chmod(p, 0o400)


class Capture(Case):
    def test_initial_capture_binds_every_input_and_verifies(self):
        ok, res, out = self.cap()
        self.assertTrue(ok, res)
        s = self.verify(out)
        self.assertEqual(s['mode'], 'initial'); self.assertEqual(s['node']['sha256'], sha(pathlib.Path(os.path.realpath(NODE)).read_bytes()))
        for k in ('inputs/l1-authority-config.json', 'inputs/l1-checkpoint.json', 'inputs/portal-result.json', 'inputs/a1-config.example.json', 'inputs/a1-config.json'):
            self.assertIn(k, s['boundInputs'])
        e = self.evidence(out)
        self.assertEqual((e['source'], e['dep'], e['asr']), ('stub-initial', 'fakehash-1.0.0', C.MAINNET['asr']))   # ASR from the bound portal read
        self.assertEqual(sorted(os.listdir(out)), ['capture'])

    def test_recheck_capture_preserves_the_original_game_binding_and_verifies(self):
        ok, res, out = self.cap('recheck')
        self.assertTrue(ok, res)
        self.assertEqual(self.verify(out)['mode'], 'recheck')
        e = self.evidence(out)
        self.assertEqual(e['initialSha256'], sha(self.src.initial_receipt.read_bytes())); self.assertEqual(e['originalGame'], C.RECHECK_ORIGINAL['originalGame'])

    def test_existing_out_is_never_reused(self):
        out = self.t / 'taken'; out.mkdir(); (out / 'keep').write_text('x')
        with self.assertRaises(FileExistsError):
            C.capture('initial', out, src=self.src, pins=self.pins(), hooks={'poll': 0.05})
        self.assertEqual(os.listdir(out), ['keep'])

    def test_unreviewed_module_refuses_before_anything_executes(self):
        pins = self.pins(); (self.src.initial_dir / 'a1-anchor.mjs').write_text('export {}; // changed')
        ok, res, out = self.cap(pins=pins)
        self.assertFalse(ok); self.assertIn('module_pin', res['error'])
        for n in ('capture.json', 'helios.out', 'evidence.json'):
            self.assertFalse((out / 'capture' / n).exists(), n)
        self.refused('input', self.verify, out, pins)

    def test_source_swap_after_hashing_executes_only_the_bound_copy(self):
        def swap(stage):
            (self.src.initial_dir / 'a1-read.mjs').write_text('process.stdout.write(JSON.stringify({source: "SWAPPED"}))')
            os.chmod(self.src.l1_authority, 0o600); self.src.l1_authority.write_text('raise SystemExit(9)')
        ok, res, out = self.cap(hooks={'before_exec': swap})
        self.assertTrue(ok, res); self.assertEqual(self.evidence(out)['source'], 'stub-initial')
        self.verify(out)

    def test_a_copy_changed_before_exec_fails_the_run(self):
        def tamper(stage):
            self.poke(stage / 'code/a1-read.mjs', b'process.stdout.write("{}")')
        ok, res, out = self.cap(hooks={'before_exec': tamper})
        self.assertFalse(ok); self.assertFalse(res['copiesBeforeExec'])
        self.refused('tampered', self.verify, out)

    def test_wrong_portal_source_refuses(self):
        self.portal['asr'] = '0xdb9091e48b1c42992a1213e6916184f9ebdbfedf'; self.write_portal()
        ok, res, out = self.cap(); self.assertFalse(ok); self.assertIn('portal_result', res['error'])
        self.portal = {'readSucceeded': False, 'asr': C.MAINNET['asr']}; self.write_portal()
        ok, res, out = self.cap(); self.assertFalse(ok); self.assertIn('portal_result', res['error'])

    def test_recheck_against_another_initial_receipt_refuses(self):
        pins = self.pins(); self.src.initial_receipt.write_text('{"other": true}')
        ok, res, out = self.cap('recheck', pins=pins); self.assertFalse(ok); self.assertIn('initial_pin', res['error'])

    def test_l1_config_naming_another_helios_refuses(self):
        self.l1cfg['binary']['sha256'] = 'cd' * 32; self.write_l1()
        ok, res, out = self.cap(); self.assertFalse(ok); self.assertIn('helios_pin', res['error'])

    def test_dependency_content_or_version_drift_refuses(self):
        pins = self.pins(); (self.src.deps_root / 'node_modules/fakehash/index.mjs').write_text('export const tag = "evil";')
        ok, res, out = self.cap(pins=pins); self.assertFalse(ok); self.assertIn('deps_content', res['error'])
        (self.src.deps_root / 'node_modules/fakehash/index.mjs').write_text('export const tag = "fakehash-1.0.0";\n')
        (self.src.deps_root / 'node_modules/fakehash/package.json').write_text('{"name": "fakehash", "version": "1.0.1", "type": "module"}')
        ok, res, out = self.cap(); self.assertFalse(ok); self.assertIn('deps_version', res['error'])

    def test_an_unclean_run_is_published_but_never_verifies(self):
        ex = json.loads((self.src.initial_dir / 'a1-config.example.json').read_text()); ex['stubExit'] = 3
        (self.src.initial_dir / 'a1-config.example.json').write_text(json.dumps(ex))
        ok, res, out = self.cap(); self.assertFalse(ok); self.assertEqual(res['a1Exit'], 3); self.assertTrue(res['processStopped'])
        self.refused('run', self.verify, out)

    def test_helios_not_fresh_finalized_never_verifies(self):
        self.l1cfg['stubVerdict'] = 'stale'; self.write_l1()
        ok, res, out = self.cap(); self.refused('helios', self.verify, out)

    def test_receipt_time_outside_the_capture_window_refuses(self):
        ex = json.loads((self.src.initial_dir / 'a1-config.example.json').read_text()); ex['stubAt'] = '2026-10-25T19:58:03.973Z'
        (self.src.initial_dir / 'a1-config.example.json').write_text(json.dumps(ex))
        ok, res, out = self.cap(); self.assertTrue(ok, res); self.refused('window', self.verify, out)


class Verify(Case):
    def setUp(self):
        super().setUp(); ok, res, self.out = self.cap(); self.assertTrue(ok, res); self.d = self.out / 'capture'

    def test_post_capture_copy_or_input_tamper_refuses(self):
        self.poke(self.d / 'code/a1-anchor.mjs', b'export {}; // later'); self.refused('tampered', self.verify, self.out)

    def test_post_capture_bound_input_tamper_refuses(self):
        self.poke(self.d / 'inputs/portal-result.json', b'{}'); self.refused('tampered', self.verify, self.out)

    def test_evidence_swap_refuses(self):
        self.poke(self.d / 'evidence.json', b'{"verdict": "A1-authenticated"}'); self.refused('tampered', self.verify, self.out)

    def test_rewritten_capture_record_refuses(self):
        r = json.loads((self.d / 'capture.json').read_bytes()); r['mode'] = 'recheck'
        self.poke(self.d / 'capture.json', json.dumps(r).encode()); self.refused('binding', self.verify, self.out)

    def test_extra_missing_symlinked_or_writable_files_refuse(self):
        (self.d / 'extra').write_text('x'); os.chmod(self.d / 'extra', 0o400); self.refused('file_set', self.verify, self.out)
        os.unlink(self.d / 'extra'); os.symlink('/etc/hostname', self.d / 'link'); self.refused('untrusted', self.verify, self.out)
        os.unlink(self.d / 'link'); os.chmod(self.d / 'a1.stderr', 0o666); self.refused('untrusted', self.verify, self.out)

    def test_partial_leftover_or_moved_capture_refuses(self):
        (self.out / '.partial-1').mkdir(); self.refused('layout', self.verify, self.out)
        (self.out / '.partial-1').rmdir(); moved = self.t / 'moved'; os.rename(self.out, moved)
        self.refused('moved', self.verify, moved)

    def test_capture_by_other_code_than_the_reviewed_pins_refuses(self):
        pins = self.pins(); pins.modules['initial']['a1-read.mjs'] = '00' * 32
        self.refused('code_pin', self.verify, self.out, pins)
        pins = self.pins(); pins.deps = {'fakehash': ('1.0.0', '00' * 32)}; self.refused('deps_pin', self.verify, self.out, pins)

    def test_replay_is_refused_by_the_consumer_ledger(self):
        ledger = set(); C.admit(self.verify(self.out), ledger)
        self.refused('replayed', C.admit, self.verify(self.out), ledger)
        ok, res, out2 = self.cap(); self.assertTrue(ok, res)
        C.admit(self.verify(out2), ledger)                                               # a NEW capture is admitted


class Production(unittest.TestCase):
    def test_production_pins_equal_the_reviewed_sources(self):
        for mode, d in (('initial', OPS / 'l1-anchor-a1'), ('recheck', OPS / 'a1-original-game-prepared')):
            for rel, h in C.MODULES[mode].items():
                self.assertEqual(sha((d / rel).read_bytes()), h, f'{mode} {rel}')
        self.assertEqual(sha(L1A_REAL.read_bytes()), C.L1_AUTHORITY_SHA256)
        self.assertEqual(sha((OPS / 'l1-anchor-a1/a1-config.example.json').read_bytes()), C.A1_EXAMPLE_SHA256)
        self.assertEqual(sha((OPS / 'l1-anchor-a1/live-1958/a1-evidence.json').read_bytes()), C.INITIAL_SHA256)
        self.assertEqual(sha((DEPS_REAL / 'package-lock.json').read_bytes()), C.LOCK_SHA256)
        for name, (ver, digest) in C.DEPS.items():
            pf = C.read_package(DEPS_REAL, name)
            self.assertEqual(json.loads(pf['package.json'])['version'], ver, name)
            self.assertEqual(C.tree_rows({r: sha(x) for r, x in pf.items()}), digest, name)
        for name, h in C.A1_GATE_PINS.items():
            self.assertEqual(sha((HERE.parent / 'a1gate' / name).read_bytes()), h, name)

    def test_the_real_pinned_gate_accepts_root_captured_receipts_and_refuses_a_tampered_one(self):
        ini = (OPS / 'l1-anchor-a1/live-1958/a1-evidence.json').read_bytes()
        rc = (OPS / 'a1-original-game-prepared/live/l1-a1-recheck-retry-2152/recheck.json').read_bytes()
        w = tempfile.mkdtemp(prefix='a1gate-test-'); self.addCleanup(shutil.rmtree, w, True)
        self.assertEqual(C.gate(ini, 'initial', None, NODE, C.Pins(), w)['N'], '52866960')
        self.assertEqual(C.gate(rc, 'recheck', ini, NODE, C.Pins(), w)['mode'], 'original-game-recheck')
        self.assertIn(b'helios-call', rc)
        with self.assertRaises(C.Refused):
            C.gate(rc.replace(b'helios-call', b'plain-rpc', 1), 'recheck', ini, NODE, C.Pins(), w)

    def test_the_real_gate_refuses_a_receipt_with_an_unauthenticated_label(self):
        ini = (OPS / 'l1-anchor-a1/live-1958/a1-evidence.json').read_bytes()
        w = tempfile.mkdtemp(prefix='a1gate-test-'); self.addCleanup(shutil.rmtree, w, True)
        with self.assertRaises(C.Refused) as cm:
            C.gate(ini.replace(b'"mpt-proof"', b'"plain-rpc"', 1), 'initial', None, NODE, C.Pins(), w)
        self.assertEqual(cm.exception.code, 'gate')

    def test_l1_config_derivation_changes_only_the_checkpoint_path(self):
        b = json.dumps({'a': 1, 'checkpointFile': '/x'}).encode()
        self.assertEqual(json.loads(C.derive_l1_config(b, '/copy')), {'a': 1, 'checkpointFile': '/copy'})
        with self.assertRaises(C.Refused):
            C.derive_l1_config(b'{"a": 1}', '/copy')


if __name__ == '__main__':
    unittest.main()
