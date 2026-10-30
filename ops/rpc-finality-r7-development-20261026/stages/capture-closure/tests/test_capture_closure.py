"""production-capture-closure-stage: guest runtime policy (static python, split node/libnode), settings-driven Sources, reproof config,
templates and closure manifest. Offline; private tmp; no node/helios/network is executed (the libnode probe is injected)."""
import hashlib, importlib.util, json, os, pathlib, sys, tempfile, unittest

ST = pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


A = load(ST / 'src/a1_capture.py', 'a1_capture_closure')
RP = load(ST / 'src/reproof.py', 'reproof_closure')
UID = os.getuid()
sha = lambda b: hashlib.sha256(b).hexdigest()


class Runtime(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='closure-rt-'))
        self.exe = self.d / 'python3.12'; self.exe.write_bytes(b'static python image')
        self.lib = self.d / 'libpython3.14.so.1.0'; self.lib.write_bytes(b'shared libpython')
        self.shared = self.d / 'python3.14'; self.shared.write_bytes(b'shared python launcher')
        self.pins = A.Pins(python_accepted={sha(self.exe.read_bytes()): {'staticLibpython': True},
                                            sha(self.shared.read_bytes()): {}},
                           libpython_accepted={sha(self.lib.read_bytes()): {}})

    def test_guest_pins_are_the_observed_identities(self):
        n = A.ACCEPTED_NODE['f3f93db342d5ac5bb61656d0599a603a73779e98befd9342171e550002725f4d']
        self.assertEqual((n['size'], n['libnode']['sha256'], n['libnode']['path']),
                         (26704, 'ce7cb9cd408c412090c86dada332aaa82650679ed1b32527768c8dbd8c4028d0', '/usr/lib/x86_64-linux-gnu/libnode.so.109'))
        p = A.ACCEPTED_PYTHON['e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f']
        self.assertTrue(p['staticLibpython']); self.assertIn('NOT upstream-verified', p['provenance'])
        self.assertIn('7af789e55afc0975d66bb19ccbc5a3b60c4b838f61d1ec10a117832ba70baaf9', A.ACCEPTED_NODE)      # host entries kept

    def test_static_interpreter_accepted_only_with_no_libpython_mapped(self):
        r = A.python_identity(self.pins, exe=str(self.exe), maps_text='7f00 r-xp /usr/lib/libc.so.6\n')
        self.assertEqual((r['libpythonSha256'], r['staticLibpython']), (None, True))
        with self.assertRaisesRegex(A.Refused, 'only as a static interpreter'):
            A.python_identity(self.pins, exe=str(self.exe), maps_text=f'7f00 r-xp {self.lib}\n')

    def test_shared_interpreter_still_needs_exactly_one_accepted_libpython(self):
        self.assertEqual(A.python_identity(self.pins, exe=str(self.shared), maps_text=f'7f00 r-xp {self.lib}\n')['libpythonSha256'],
                         sha(self.lib.read_bytes()))
        with self.assertRaisesRegex(A.Refused, 'exactly one mapped libpython'):
            A.python_identity(self.pins, exe=str(self.shared), maps_text='')
        other = self.d / 'libpython-other.so'; other.write_bytes(b'x')
        with self.assertRaisesRegex(A.Refused, 'not an accepted runtime'):
            A.python_identity(self.pins, exe=str(self.shared), maps_text=f'7f00 r-xp {other}\n')

    def test_unknown_interpreter_refused(self):
        x = self.d / 'python-x'; x.write_bytes(b'unknown')
        with self.assertRaises(A.Refused):
            A.python_identity(self.pins, exe=str(x), maps_text='')


class NodeLib(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='closure-node-'))
        self.node = self.d / 'node'; self.node.write_bytes(b'launcher'); self.libnode = self.d / 'libnode.so.109'; self.libnode.write_bytes(b'engine')
        self.pins = A.Pins(node_accepted={sha(b'launcher'): {'libnode': {'path': str(self.libnode), 'sha256': sha(b'engine')}}})

    def ident(self, mapped):
        return A.node_lib_identity(str(self.node), self.pins, probe=lambda: json.dumps(mapped), owner=UID)

    def test_the_accepted_libnode_actually_mapped_is_accepted(self):
        self.assertEqual(self.ident([str(self.libnode)])['sha256'], sha(b'engine'))

    def test_another_or_extra_mapped_libnode_is_refused(self):
        other = self.d / 'libnode.so.115'; other.write_bytes(b'engine')
        for mapped in ([str(other)], [str(self.libnode), str(other)], []):
            with self.assertRaisesRegex(A.Refused, 'not exactly the accepted'):
                self.ident(mapped)

    def test_changed_libnode_bytes_or_unaccepted_launcher_are_refused(self):
        self.libnode.write_bytes(b'patched engine')
        with self.assertRaisesRegex(A.Refused, 'not the accepted libnode'):
            self.ident([str(self.libnode)])
        self.node.write_bytes(b'other launcher')
        with self.assertRaisesRegex(A.Refused, 'not an accepted runtime'):
            self.ident([str(self.libnode)])

    def test_self_contained_node_needs_no_libnode(self):
        pins = A.Pins(node_accepted={sha(b'launcher'): {}})
        self.assertIsNone(A.node_lib_identity(str(self.node), pins, probe=lambda: '[]', owner=UID))

    def test_verify_side_runtime_record(self):
        launcher, exe = sha(b'launcher'), sha(b'static')
        pins = A.Pins(node_accepted=self.pins.node_accepted, python_accepted={exe: {'staticLibpython': True}}, libpython_accepted={})
        files = {'bin/node': {'sha256': launcher}}
        good = {'python': {'sha256': exe, 'libpythonSha256': None, 'staticLibpython': True}, 'runtimePolicy': {'libnode': {'sha256': sha(b'engine')}}}
        A.runtime_accepted(good, files, pins)
        with self.assertRaisesRegex(A.Refused, 'libnode that executed'):
            A.runtime_accepted({**good, 'runtimePolicy': {'libnode': None}}, files, pins)
        with self.assertRaisesRegex(A.Refused, 'static interpreter'):
            A.runtime_accepted({**good, 'python': {'sha256': exe, 'libpythonSha256': 'ab' * 32, 'staticLibpython': False}}, files, pins)


class Settings(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='closure-src-')); self.p = self.d / 'sources.json'
        self.good = json.loads((ST / 'config-templates/a1-capture-sources.json').read_text())

    def write(self, doc, mode=0o644):
        self.p.write_text(json.dumps(doc)); os.chmod(self.p, mode)

    def test_template_is_complete_and_loads(self):
        self.assertEqual(set(self.good), A.SOURCES_KEYS)
        self.write(self.good); s = A.Sources.from_settings(self.p, initial_capture='/var/lib/x/initial', owner=UID)
        self.assertEqual((s.el_url, s.node, str(s.initial_capture), s.initial_receipt), ('http://127.0.0.1:18645', '/usr/bin/node', '/var/lib/x/initial', None))
        self.assertTrue(all(str(v).startswith(('/opt/enclave-rpc/', '/etc/enclave-rpc/', '/usr/bin/')) for k, v in self.good.items() if k not in ('format', 'elUrl')))

    def test_bad_settings_are_refused(self):
        for doc in ({k: v for k, v in self.good.items() if k != 'l1Config'}, {**self.good, 'extra': '/x'}, {**self.good, 'depsRoot': 'deps'},
                    {**self.good, 'elUrl': 'http://10.0.2.15:28645'}, {**self.good, 'format': 'other'}):
            self.write(doc)
            with self.assertRaises(A.Refused):
                A.Sources.from_settings(self.p, owner=UID)
        self.write(self.good, 0o664)
        with self.assertRaisesRegex(A.Refused, 'root-owned'):
            A.Sources.from_settings(self.p, owner=UID)


class Templates(unittest.TestCase):
    def test_reproof_config_names_the_capture_sources(self):
        c = json.loads((ST / 'config-templates/base-finality-reproof.json').read_text())
        self.assertEqual(set(c), RP.CONFIG_KEYS); self.assertIn('captureSources', RP.CONFIG_KEYS)
        self.assertTrue(all(isinstance(v, str) and v for v in c.values()), 'every reproof value is established')
        self.assertIn('Sources.from_settings(c[\'captureSources\']', (ST / 'src/reproof.py').read_text())

    def test_l1_authority_config_uses_the_guest_own_l1_and_leaves_the_checkpoint_to_root(self):
        l1 = (ST / 'bundle-origin.json')
        c = json.loads((ST / 'config-templates/l1-authority.json').read_text())
        self.assertEqual((c['consensusRpc'], c['executionRpc']), ('http://127.0.0.1:15052', 'http://127.0.0.1:18645'))
        self.assertEqual(c['binary']['sha256'], A.HELIOS_SHA256)
        self.assertEqual(c['checkpointFile'], '/etc/enclave-rpc/l1-checkpoint.json')
        self.assertFalse((ST / 'config-templates/l1-checkpoint.json').exists(), 'no checkpoint is invented')

    def test_closure_manifest_pins_every_reviewed_input(self):
        m = json.loads((ST / 'install/MANIFEST.json').read_text())
        by_dest = {e['dest']: e for e in m['files']}
        for rel, h in {**A.MODULES['initial']}.items():
            self.assertEqual(by_dest[f'/opt/enclave-rpc/a1-capture/l1-anchor-a1/{rel}']['sha256'], h)
        for rel, h in A._RECHECK.items():
            self.assertEqual(by_dest[f'/opt/enclave-rpc/a1-capture/a1-original-game-prepared/{rel}']['sha256'], h)
        self.assertEqual(by_dest['/opt/enclave-rpc/a1-capture/l1-anchor-a1/a1-config.example.json']['sha256'], A.A1_EXAMPLE_SHA256)
        self.assertEqual(by_dest['/opt/enclave-rpc/a1-capture/l1_authority.py']['sha256'], A.L1_AUTHORITY_SHA256)
        self.assertEqual(by_dest['/opt/enclave-rpc/a1-capture/bin/helios-eeffcc9']['sha256'], A.HELIOS_SHA256)
        self.assertEqual(by_dest['/opt/enclave-rpc/a1-capture/deps/package-lock.json']['sha256'], A.LOCK_SHA256)
        self.assertEqual(by_dest['/opt/enclave-rpc/a1-capture/a1_capture.py']['sha256'], sha((ST / 'src/a1_capture.py').read_bytes()))
        self.assertEqual({t['dest'].rsplit('/node_modules/', 1)[1] for t in m['trees']}, set(A.DEPS))
        for t in m['trees']:
            name = t['dest'].rsplit('/node_modules/', 1)[1]
            self.assertEqual(A.tree_rows(t['files']), A.DEPS[name][1], f'{name}: the installed tree is the pinned package content')
        self.assertFalse([e for e in m['files'] if 'checkpoint' in e['dest']], 'no checkpoint in the closure')


if __name__ == '__main__':
    unittest.main(verbosity=2)
