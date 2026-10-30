#!/usr/bin/env python3
"""a1_capture.py r2 tests (PREPARED; NOT run by Claude: r2/jobs/root-capture-tests.sh runs them, exact count 36, no skips).
r1's 25 tests (the source-swap fixture FIXED: the reviewed pins are frozen at capture time and verify uses THOSE, never pins
recomputed from swapped sources) + 11 for the runtime policy, durability/crash publication and recheck-capture. Captures run
for real (subprocesses, the real node, exclusive files, fsync, rename) over STUB A1 modules / l1-authority / one fake
dependency pinned to their actual bytes; a stub A1 gate normalizes stub receipts; the REAL pinned gate runs over root's real
captured receipts; production pins and the accepted runtimes are checked against the real files of this host."""
import hashlib, json, os, pathlib, shutil, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import a1_capture as C                                                             # noqa: E402

NODE = os.environ['A1_NODE']
OPS = pathlib.Path(os.environ['A1_OPS'])
DEPS_REAL = pathlib.Path(os.environ['A1_DEPS_ROOT'])
L1A_REAL = pathlib.Path(os.environ['A1_L1_AUTHORITY'])
C.OWNER = os.getuid()
sha = lambda b: hashlib.sha256(b).hexdigest()
HELIOS_TEST = 'ab' * 32


def runtime():
    """this host's node / interpreter / mapped libpython, observed independently of the module"""
    libs = sorted({l.split()[-1] for l in pathlib.Path('/proc/self/maps').read_text().splitlines() if 'libpython' in l and '/' in l})
    return (sha(pathlib.Path(os.path.realpath(NODE)).read_bytes()), sha(pathlib.Path(os.path.realpath(sys.executable)).read_bytes()),
            sha(pathlib.Path(libs[0]).read_bytes()) if len(libs) == 1 else None)


def stub_gate(ev, mode, ini, isha):
    """stands in for the pinned gate on STUB receipts (the real gate is exercised in Production): normalizes, and refuses a
    recheck that did not read exactly the initial it is checked against"""
    e = json.loads(ev)
    if mode == 'initial':
        return {'mode': 'fresh-initial', 'N': e['N'], 'game': e['game'], 'outputRoot': e['outputRoot']}
    if e.get('initialSha256') != isha or e.get('configInitialSha256', isha) != isha:
        raise C.Refused('gate', 'recheck does not bind the initial')
    return {'mode': 'original-game-recheck', 'originalGame': e.get('originalGame'), 'originalN': e.get('originalN')}


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
        self.n, self.reviewed = 0, {}

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def write_l1(self):
        (self.t / 'l1.json').write_text(json.dumps(self.l1cfg))

    def write_portal(self):
        (self.t / 'portal.json').write_text(json.dumps(self.portal))

    def pins(self, **over):
        """the stub sources' CURRENT bytes as the 'reviewed' pins, and this host's runtimes as the accepted ones"""
        s = self.src; mods = {}
        names = {'initial': ['a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs'],
                 'recheck': ['a1-recheck-read.mjs', 'a1-recheck.mjs', 'a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs']}
        for mode, d in (('initial', s.initial_dir), ('recheck', s.recheck_dir)):
            mods[mode] = {r: sha((d / r).read_bytes()) for r in names[mode]}
        mods['recheck-capture'] = dict(mods['recheck'])
        pf = C.read_package(s.deps_root, 'fakehash'); n, p, l = runtime()
        kw = dict(modules=mods, l1_authority=sha(s.l1_authority.read_bytes()), helios=HELIOS_TEST,
                  a1_example=sha((s.initial_dir / 'a1-config.example.json').read_bytes()), initial=sha(s.initial_receipt.read_bytes()),
                  lock=sha((s.deps_root / 'package-lock.json').read_bytes()), deps={'fakehash': ('1.0.0', C.tree_rows({r: sha(x) for r, x in pf.items()}))},
                  node_accepted={n: {'provenance': 'test'}}, python_accepted={p: {'provenance': 'test'}}, libpython_accepted={l: {'provenance': 'test'}})
        kw.update(over)
        return C.Pins(**kw)

    def cap(self, mode='initial', pins=None, hooks=None, initial=None):
        self.n += 1; out = self.t / f'out{self.n}'
        pins = pins or self.pins(); self.reviewed[str(out)] = pins            # r2 FIX: the pins reviewed AT capture time
        src = C.Sources(**{**self.src.__dict__, 'initial_capture': initial})
        ok, res = C.capture(mode, out, src=src, pins=pins, hooks={'poll': 0.05, **(hooks or {})}, helios_timeout=20, a1_timeout=60, gate_fn=stub_gate)
        return ok, res, out

    def verify(self, out, pins=None, **kw):
        return C.verify(out, pins=pins or self.reviewed[str(out)], node=NODE, workdir=str(self.t), gate_fn=stub_gate, **kw)

    def refused(self, code, fn, *a, **k):
        with self.assertRaises(C.Refused) as cm:
            fn(*a, **k)
        self.assertEqual(cm.exception.code, code, str(cm.exception))

    def evidence(self, out):
        return json.loads((out / 'capture/evidence.json').read_bytes())

    def poke(self, p, b):
        os.chmod(p, 0o600); p.write_bytes(b); os.chmod(p, 0o400)

    def initial_capture(self):
        ok, res, out = self.cap(); self.assertTrue(ok, res)
        return out, self.verify(out)['captureSha256']


class Capture(Case):
    def test_initial_capture_binds_every_input_and_verifies(self):
        ok, res, out = self.cap()
        self.assertTrue(ok, res)
        s = self.verify(out)
        self.assertEqual(s['mode'], 'initial'); self.assertEqual(s['node']['sha256'], runtime()[0])
        for k in ('inputs/l1-authority-config.json', 'inputs/l1-checkpoint.json', 'inputs/portal-result.json', 'inputs/a1-config.example.json', 'inputs/a1-config.json'):
            self.assertIn(k, s['boundInputs'])
        e = self.evidence(out)
        self.assertEqual((e['source'], e['dep'], e['asr']), ('stub-initial', 'fakehash-1.0.0', C.MAINNET['asr']))
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
        self.refused('input', self.verify, out)

    def test_source_swap_after_hashing_executes_only_the_bound_copy(self):
        def swap(stage):
            (self.src.initial_dir / 'a1-read.mjs').write_text('process.stdout.write(JSON.stringify({source: "SWAPPED"}))')
            os.chmod(self.src.l1_authority, 0o600); self.src.l1_authority.write_text('raise SystemExit(9)')
        ok, res, out = self.cap(hooks={'before_exec': swap})
        self.assertTrue(ok, res); self.assertEqual(self.evidence(out)['source'], 'stub-initial')
        self.verify(out)                                                            # against the pins reviewed at capture
        self.refused('code_pin', self.verify, out, self.pins())                     # pins taken from the SWAPPED sources refuse

    def test_a_copy_changed_before_exec_fails_the_run(self):
        ok, res, out = self.cap(hooks={'before_exec': lambda stage: self.poke(stage / 'code/a1-read.mjs', b'process.stdout.write("{}")')})
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
        self.reviewed[str(moved)] = self.reviewed[str(self.out)]; self.refused('moved', self.verify, moved)

    def test_capture_by_other_code_than_the_reviewed_pins_refuses(self):
        pins = self.pins(); pins.modules['initial']['a1-read.mjs'] = '00' * 32
        self.refused('code_pin', self.verify, self.out, pins)
        pins = self.pins(); pins.deps = {'fakehash': ('1.0.0', '00' * 32)}; self.refused('deps_pin', self.verify, self.out, pins)

    def test_replay_is_refused_by_the_consumer_ledger(self):
        ledger = set(); C.admit(self.verify(self.out), ledger)
        self.refused('replayed', C.admit, self.verify(self.out), ledger)
        ok, res, out2 = self.cap(); self.assertTrue(ok, res)
        C.admit(self.verify(out2), ledger)


class Runtime(Case):
    def test_an_unaccepted_node_refuses_before_anything_executes(self):
        ok, res, out = self.cap(pins=self.pins(node_accepted={'00' * 32: {}}))
        self.assertFalse(ok); self.assertIn('node_identity', res['error']); self.assertFalse((out / 'capture/capture.json').exists())

    def test_an_unaccepted_interpreter_refuses_before_anything_executes(self):
        ok, res, out = self.cap(pins=self.pins(libpython_accepted={'00' * 32: {}}))
        self.assertFalse(ok); self.assertIn('python_identity', res['error']); self.assertEqual(os.listdir(out / 'capture'), ['result.json'])

    def test_verify_refuses_a_capture_whose_runtime_is_no_longer_accepted(self):
        ok, res, out = self.cap(); self.assertTrue(ok, res)
        self.refused('node_identity', self.verify, out, self.pins(node_accepted={}))
        self.refused('python_identity', self.verify, out, self.pins(python_accepted={}))

    def test_the_gate_runs_node_only_from_a_hashed_accepted_fd(self):
        self.refused('node_identity', C.run_node_fd, NODE, self.pins(node_accepted={}), ['--version'], capture_output=True)
        r = C.run_node_fd(NODE, self.pins(), ['-e', 'process.stdout.write(process.version)'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0); self.assertTrue(r.stdout.startswith('v'))

    def test_production_policy_accepts_this_hosts_observed_runtimes_with_explicit_provenance(self):
        n, p, l = runtime()
        self.assertIn(n, C.ACCEPTED_NODE); self.assertIn(p, C.ACCEPTED_PYTHON); self.assertIn(l, C.ACCEPTED_LIBPYTHON)
        for table in (C.ACCEPTED_NODE, C.ACCEPTED_PYTHON, C.ACCEPTED_LIBPYTHON):
            for h, v in table.items():
                self.assertIn('NOT upstream-verified', v['provenance']); self.assertIn('pending root review', v['provenance'])

    def test_published_records_are_sealed_and_a_crash_before_publication_never_verifies(self):
        ok, res, out = self.cap(); self.assertTrue(ok, res)
        for n in ('capture.json', 'result.json', 'evidence.json', 'a1.stderr', 'helios.out', 'bin/node'):
            self.assertFalse(os.stat(out / 'capture' / n).st_mode & 0o222, n)
        crashed = self.t / 'crashed'; crashed.mkdir(mode=0o700); (crashed / '.partial-77').mkdir(mode=0o700)
        self.reviewed[str(crashed)] = self.pins(); self.refused('layout', self.verify, crashed)

    def test_a_failure_after_execution_is_published_with_its_error_and_never_verifies(self):
        ok, res, out = self.cap(hooks={'after_exec': lambda stage: (_ for _ in ()).throw(OSError('disk gone'))})
        self.assertFalse(ok); self.assertIn('disk gone', res['error']); self.assertTrue((out / 'capture/evidence.json').exists())
        self.refused('run', self.verify, out)


class RecheckCapture(Case):
    def test_a_recheck_of_a_newly_captured_initial_binds_to_the_consumers_reviewed_capture(self):
        iout, isha = self.initial_capture()
        ok, res, rout = self.cap('recheck-capture', initial=iout); self.assertTrue(ok, res)
        s = self.verify(rout, initial_out=iout, expected_initial_capture_sha256=isha)
        self.assertEqual(s['initialCapture']['captureSha256'], isha)
        e = self.evidence(rout); ie = self.evidence(iout)
        self.assertEqual((e['originalGame'], e['originalN'], e['originalOutputRoot']), (ie['game'], ie['N'], ie['outputRoot']))
        self.assertEqual(e['initialSha256'], sha((iout / 'capture/evidence.json').read_bytes()))

    def test_the_consumer_must_name_the_initial_it_reviewed(self):
        iout, isha = self.initial_capture()
        ok, res, rout = self.cap('recheck-capture', initial=iout); self.assertTrue(ok, res)
        self.refused('initial_binding', self.verify, rout)
        self.refused('initial_binding', self.verify, rout, initial_out=iout, expected_initial_capture_sha256='0' * 64)
        jout, jsha = self.initial_capture()                                                   # another genuine initial capture
        self.refused('initial_binding', self.verify, rout, initial_out=jout, expected_initial_capture_sha256=jsha)

    def test_the_initial_capture_tampered_after_the_recheck_refuses(self):
        iout, isha = self.initial_capture()
        ok, res, rout = self.cap('recheck-capture', initial=iout); self.assertTrue(ok, res)
        self.poke(iout / 'capture/evidence.json', b'{"N": "2"}')
        self.refused('tampered', self.verify, rout, initial_out=iout, expected_initial_capture_sha256=isha)

    def test_only_a_clean_initial_capture_can_be_rechecked(self):
        iout, isha = self.initial_capture()
        ok, res, rout = self.cap('recheck-capture', initial=iout); self.assertTrue(ok, res)
        ok, res, out = self.cap('recheck-capture', initial=rout); self.assertFalse(ok); self.assertIn('initial_binding', res['error'])
        ex = json.loads((self.src.initial_dir / 'a1-config.example.json').read_text()); ex['stubExit'] = 1
        (self.src.initial_dir / 'a1-config.example.json').write_text(json.dumps(ex))
        ok, res, bad = self.cap(); self.assertFalse(ok)
        ok, res, out = self.cap('recheck-capture', initial=bad); self.assertFalse(ok); self.assertIn('run', res['error'])
        ok, res, out = self.cap('recheck-capture'); self.assertFalse(ok); self.assertIn('initial_binding', res['error'])


class Production(unittest.TestCase):
    def test_production_pins_equal_the_reviewed_sources(self):
        for mode, d in (('initial', OPS / 'l1-anchor-a1'), ('recheck', OPS / 'a1-original-game-prepared'), ('recheck-capture', OPS / 'a1-original-game-prepared')):
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
        self.assertEqual(C.gate(ini, 'initial', None, None, NODE, C.Pins(), w)['N'], '52866960')
        self.assertEqual(C.gate(rc, 'recheck-capture', ini, sha(ini), NODE, C.Pins(), w)['mode'], 'original-game-recheck')
        self.assertIn(b'helios-call', rc)
        with self.assertRaises(C.Refused):
            C.gate(rc.replace(b'helios-call', b'plain-rpc', 1), 'recheck', ini, sha(ini), NODE, C.Pins(), w)
        with self.assertRaises(C.Refused):                                         # a recheck against ANOTHER initial sha
            C.gate(rc, 'recheck', ini, '0' * 64, NODE, C.Pins(), w)

    def test_the_real_gate_refuses_a_receipt_with_an_unauthenticated_label(self):
        ini = (OPS / 'l1-anchor-a1/live-1958/a1-evidence.json').read_bytes()
        w = tempfile.mkdtemp(prefix='a1gate-test-'); self.addCleanup(shutil.rmtree, w, True)
        with self.assertRaises(C.Refused) as cm:
            C.gate(ini.replace(b'"mpt-proof"', b'"plain-rpc"', 1), 'initial', None, None, NODE, C.Pins(), w)
        self.assertEqual(cm.exception.code, 'gate')

    def test_l1_config_derivation_changes_only_the_checkpoint_path(self):
        b = json.dumps({'a': 1, 'checkpointFile': '/x'}).encode()
        self.assertEqual(json.loads(C.derive_l1_config(b, '/copy')), {'a': 1, 'checkpointFile': '/copy'})
        with self.assertRaises(C.Refused):
            C.derive_l1_config(b'{"a": 1}', '/copy')


if __name__ == '__main__':
    unittest.main()
