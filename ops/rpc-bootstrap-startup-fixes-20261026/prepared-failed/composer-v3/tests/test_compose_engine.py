#!/usr/bin/env python3
"""r13-compose v3: offline unit tests of the pin-graph engine and the wiring-overlay rules on SYNTHETIC trees (no stage, no network).
PREPARED; NOT run by Claude. Root: python3 -I -B tests/test_compose_engine.py -v  (exact count 18)."""
import hashlib, importlib.util, json, pathlib, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('c13', HERE.parent / 'compose_r13.py'); C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
h = lambda b: hashlib.sha256(b).hexdigest()
R0, R1 = 'a' * 64, 'b' * 64                                       # old / new reader sha (synthetic)


class Engine(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='c13-'))
        self.w('cap.py', f"READ = '{R0}'\n")
        self.w('harness.py', f"CAP = '{h(self.b('cap.py'))}'\n")
        self.w('tool.py', f"H = '{h(self.b('harness.py'))}'\n")
        self.w('install/MANIFEST.json', json.dumps({'files': [{'src': f, 'sha256': h(self.b(f))} for f in ('cap.py', 'harness.py', 'tool.py')]}))
        self.w('integration-old/x.patch', f'- {R0}\n')                    # a historical record keeps old shas
        self.spec = {'cap.py': {'R': 1}, 'harness.py': {'cap.py': 1}, 'tool.py': {'harness.py': 1}}

    def w(self, rel, s):
        p = self.t / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(s)

    def b(self, rel):
        return (self.t / rel).read_bytes()

    def test_discovered_graph_equals_spec_and_propagates_to_a_fixpoint(self):
        e, n = C.discover(self.t, {R0: 'R'}); C.check_edges(e, {'R'}, self.spec)
        old = {f: h(self.b(f)) for f in ('cap.py', 'harness.py', 'tool.py')}
        ch, counts = C.propagate(self.t, {R0: R1})
        self.assertIn(R1, self.b('cap.py').decode()); self.assertIn(h(self.b('cap.py')), self.b('harness.py').decode())
        self.assertIn(h(self.b('harness.py')), self.b('tool.py').decode())
        m = json.loads(self.b('install/MANIFEST.json')); self.assertEqual({x['src']: x['sha256'] for x in m['files']}, {f: h(self.b(f)) for f in old})
        C.residue(self.t, [o for o, v in ch.items() if o != v and o not in set(ch.values())])
        self.assertIn(R0, self.b('integration-old/x.patch').decode())     # records untouched

    def test_undeclared_edge_refuses(self):
        self.w('helper.py', f"PIN = '{h(self.b('harness.py'))}'\n")      # a helper silently pinning the harness
        e, _ = C.discover(self.t, {R0: 'R'})
        with self.assertRaisesRegex(SystemExit, 'pin graph != declared spec'):
            C.check_edges(e, {'R'}, self.spec)

    def test_declared_helper_edge_is_followed(self):
        self.w('helper.py', f"PIN = '{h(self.b('harness.py'))}'\n"); sp = dict(self.spec, **{'helper.py': {'harness.py': 1}})
        e, _ = C.discover(self.t, {R0: 'R'}); C.check_edges(e, {'R'}, sp); C.propagate(self.t, {R0: R1})
        self.assertIn(h(self.b('harness.py')), self.b('helper.py').decode())

    def test_missing_declared_edge_refuses(self):
        e, _ = C.discover(self.t, {R0: 'R'})
        with self.assertRaisesRegex(SystemExit, 'missing'):
            C.check_edges(e, {'R'}, dict(self.spec, **{'tool.py': {'harness.py': 1, 'cap.py': 1}}))

    def test_changed_pin_count_refuses(self):
        self.w('tool.py', f"H = '{h(self.b('harness.py'))}'\nH2 = '{h(self.b('harness.py'))}'\n")
        self.w('install/MANIFEST.json', json.dumps({'files': [{'src': f, 'sha256': h(self.b(f))} for f in ('cap.py', 'harness.py', 'tool.py')]}))
        e, _ = C.discover(self.t, {R0: 'R'})
        with self.assertRaisesRegex(SystemExit, 'pin graph'):
            C.check_edges(e, {'R'}, self.spec)

    def test_propagation_that_does_not_converge_within_the_bound_refuses(self):
        with self.assertRaisesRegex(SystemExit, 'converge'):                 # a 3-deep chain cannot settle in 1 pass
            C.propagate(self.t, {R0: R1}, limit=1)

    def test_residue_refuses_a_remaining_superseded_pin(self):
        self.w('doc.txt', f'old {R0}\n')
        with self.assertRaisesRegex(SystemExit, 'superseded pin'):
            C.residue(self.t, [R0])


class Wiring(unittest.TestCase):
    """load_wiring/apply_wiring against a synthetic base standing in for r12-final"""
    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp(prefix='c13base-')); self.wd = pathlib.Path(tempfile.mkdtemp(prefix='c13wire-'))
        (self.base / 'producer').mkdir(); (self.base / 'producer/p.py').write_text('BASE\n'); (self.base / 'install').mkdir()
        (self.base / 'install/MANIFEST.json').write_text(json.dumps({'files': [{'src': 'producer/p.py', 'dest': '/opt/p.py', 'sha256': h(b'BASE\n')}], 'trees': []}))
        (self.base / 'bundle-origin.json').write_text(json.dumps({'entries': {}}))
        (self.wd / 'overlay/producer').mkdir(parents=True); (self.wd / 'overlay/producer/p.py').write_text('NEW\n')
        (self.wd / 'overlay/bootstrap').mkdir(); (self.wd / 'overlay/bootstrap/helper.py').write_text('HELPER\n')
        self.orig = (C.R12F, C.R12F_SUMS); C.R12F = self.base

    def tearDown(self):
        C.R12F, C.R12F_SUMS = self.orig

    def contract(self, **kw):
        c = {'format': 'enclave-r13-wiring-input/v1', 'base': {'stage': 'base-finality-proof-stage/r12-final', 'sha256sums': C.R12F_SUMS},
             'files': [
                 {'path': 'producer/p.py', 'src': 'overlay/producer/p.py', 'action': 'replace', 'baseSha256': h(b'BASE\n'), 'sha256': h(b'NEW\n')},
                 {'path': 'bootstrap/helper.py', 'src': 'overlay/bootstrap/helper.py', 'action': 'add', 'sha256': h(b'HELPER\n')}],
             'pinEdges': {}, 'manifest': {'add': [{'src': 'bootstrap/helper.py', 'dest': '/opt/helper.py', 'mode': '0755', 'sha256': h(b'HELPER\n')}]}}
        c.update(kw); (self.wd / 'COMPOSITION-INPUT.json').write_text(json.dumps(c))
        sums = ''.join(f'{h(p.read_bytes())}  ./{p.relative_to(self.wd).as_posix()}\n' for p in sorted(self.wd.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS')
        (self.wd / 'SHA256SUMS').write_text(sums)
        return c

    def out(self):
        o = pathlib.Path(tempfile.mkdtemp(prefix='c13out-'))
        for p in self.base.rglob('*'):
            if p.is_file():
                d = o / p.relative_to(self.base); d.parent.mkdir(parents=True, exist_ok=True); d.write_bytes(p.read_bytes())
        return o

    def test_exact_base_overlay_applies_and_seeds_the_registry(self):
        c, _ = C.load_wiring(self.wd, True) if self.contract() else None
        o = self.out(); seeds = C.apply_wiring(o, self.wd, c)
        self.assertEqual(seeds, {h(b'BASE\n'): h(b'NEW\n')}); self.assertEqual((o / 'producer/p.py').read_text(), 'NEW\n')
        m = json.loads((o / 'install/MANIFEST.json').read_text()); self.assertEqual({x['dest'] for x in m['files']}, {'/opt/p.py', '/opt/helper.py'})

    def test_overlapping_change_refuses(self):
        (self.base / 'producer/p.py').write_text('SOMEONE ELSE CHANGED THIS\n'); self.contract()
        with self.assertRaisesRegex(SystemExit, 'overlapping change'):
            C.load_wiring(self.wd, True)

    def test_add_over_existing_and_manifest_dest_collision_refuse(self):
        self.contract(files=[{'path': 'producer/p.py', 'src': 'overlay/producer/p.py', 'action': 'add', 'sha256': h(b'NEW\n')}])
        with self.assertRaisesRegex(SystemExit, 'would overwrite'):
            C.load_wiring(self.wd, True)
        c = self.contract(manifest={'add': [{'src': 'bootstrap/helper.py', 'dest': '/opt/p.py', 'mode': '0755', 'sha256': h(b'HELPER\n')}]})
        c, _ = C.load_wiring(self.wd, True)
        with self.assertRaisesRegex(SystemExit, 'destination exists'):
            C.apply_wiring(self.out(), self.wd, c)

    def test_stale_pin_refuses(self):
        (self.wd / 'overlay/bootstrap/helper.py').write_text(f"P = '{h(b'BASE' + bytes([10]))}'\n")
        self.contract(files=[{'path': 'producer/p.py', 'src': 'overlay/producer/p.py', 'action': 'replace', 'baseSha256': h(b'BASE\n'), 'sha256': h(b'NEW\n')},
                             {'path': 'bootstrap/helper.py', 'src': 'overlay/bootstrap/helper.py', 'action': 'add', 'sha256': h((self.wd / 'overlay/bootstrap/helper.py').read_bytes())}])
        c, _ = C.load_wiring(self.wd, True)
        with self.assertRaisesRegex(SystemExit, 'stale pin'):
            C.apply_wiring(self.out(), self.wd, c)

    # ---- v3: EXTERNAL qualification (root-supplied; never inside the frozen input) -------------------------------------------
    def qualify(self, lines, binds='stageSha256sums', sums=None, stage=None, rsha=None):
        self.contract(); s = h((self.wd / 'SHA256SUMS').read_bytes())
        rec = pathlib.Path(tempfile.mkdtemp(prefix='c13rec-')) / 'root-wiring.out'; rec.write_text('\n'.join(l.replace('@S@', s) for l in lines) + '\n')
        q = {'format': 'enclave-r13-input-qualification/v1', 'stage': str(stage or self.wd), 'stageSha256sums': sums or s, 'binds': binds,
             'receipts': [{'path': str(rec), 'sha256': rsha or h(rec.read_bytes()), 'lines': ['## wiring rc=0']}]}
        qf = rec.parent / 'q.json'; qf.write_text(json.dumps(q)); return qf, s

    def test_external_qualification_binds_a_frozen_input_after_the_fact(self):
        qf, s = self.qualify(['## wiring SHA256SUMS @S@', '## wiring rc=0'])
        before = (self.wd / 'SHA256SUMS').read_bytes(); C.load_qualification(qf, self.wd, s, {})
        self.assertEqual((self.wd / 'SHA256SUMS').read_bytes(), before)               # the frozen input is untouched by its own qualification
        self.assertNotIn('qualification', json.loads((self.wd / 'COMPOSITION-INPUT.json').read_text()))

    def test_qualification_for_other_sums_or_stage_refuses(self):
        qf, s = self.qualify(['## wiring SHA256SUMS @S@', '## wiring rc=0'], sums='0' * 64)
        with self.assertRaisesRegex(SystemExit, 'another stage or other SHA256SUMS'):
            C.load_qualification(qf, self.wd, s, {})
        qf, s = self.qualify(['## wiring SHA256SUMS @S@', '## wiring rc=0'], stage=self.base)
        with self.assertRaisesRegex(SystemExit, 'another stage'):
            C.load_qualification(qf, self.wd, s, {})

    def test_wrong_receipt_sha_or_missing_line_or_unbound_receipt_refuses(self):
        qf, s = self.qualify(['## wiring SHA256SUMS @S@', '## wiring rc=0'], rsha='1' * 64)
        with self.assertRaisesRegex(SystemExit, 'not its declared sha'):
            C.load_qualification(qf, self.wd, s, {})
        qf, s = self.qualify(['## wiring SHA256SUMS @S@', '## wiring rc=1'])
        with self.assertRaisesRegex(SystemExit, 'lacks the declared exact lines'):
            C.load_qualification(qf, self.wd, s, {})
        qf, s = self.qualify(['## wiring SHA256SUMS of something else', '## wiring rc=0'])
        with self.assertRaisesRegex(SystemExit, 'binds this exact input'):
            C.load_qualification(qf, self.wd, s, {})

    def test_file_binding_mode(self):
        srcs = {'overlay/producer/p.py': h(b'NEW\n')}
        qf, s = self.qualify([f'{h(b"NEW" + bytes([10]))}  overlay/producer/p.py', '## wiring rc=0'], binds='files')
        C.load_qualification(qf, self.wd, s, srcs)
        with self.assertRaisesRegex(SystemExit, 'binds this exact input'):
            C.load_qualification(qf, self.wd, s, {'overlay/producer/p.py': '2' * 64})

    def test_embedded_qualification_in_the_frozen_input_refuses(self):
        self.contract(qualification={'receipt': 'x'})
        with self.assertRaisesRegex(SystemExit, 'must be EXTERNAL'):
            C.load_wiring(self.wd, True)

    def test_second_overlay_on_the_same_path_refuses(self):
        self.contract(); c, _ = C.load_wiring(self.wd, True)
        o = self.out(); (o / 'producer/p.py').write_text('EARLIER OVERLAY\n')          # e.g. the wrapper overlay already replaced it
        with self.assertRaisesRegex(SystemExit, 'current tree is not its declared base'):
            C.apply_wiring(o, self.wd, c)

    def test_cross_overlay_base_pin_is_propagated_not_refused(self):
        W0, W1 = b'WRAPPER OLD\n', b'WRAPPER NEW\n'
        (self.base / 'w.py').write_bytes(W0)
        (self.wd / 'overlay/producer/p.py').write_text(f"WRAPPER = '{h(W0)}'\n")      # the wiring was staged against the BASE wrapper
        self.contract(files=[{'path': 'producer/p.py', 'src': 'overlay/producer/p.py', 'action': 'replace', 'baseSha256': h(b'BASE\n'), 'sha256': h((self.wd / 'overlay/producer/p.py').read_bytes())}],
                      manifest={})
        c, _ = C.load_wiring(self.wd, True); o = self.out()
        (o / 'w.py').write_bytes(W1)                                                    # the wrapper overlay, applied first
        seeds = {h(W0): h(W1), **C.apply_wiring(o, self.wd, c)}
        e, n = C.discover(o, {}); C.check_edges(e, {'w.py'}, {'producer/p.py': {'w.py': 1}})
        ch, _ = C.propagate(o, seeds)
        self.assertEqual((o / 'producer/p.py').read_text(), f"WRAPPER = '{h(W1)}'\n")
        C.residue(o, [k for k, v in ch.items() if k != v and k not in set(ch.values())])


if __name__ == '__main__':
    unittest.main(verbosity=2)
