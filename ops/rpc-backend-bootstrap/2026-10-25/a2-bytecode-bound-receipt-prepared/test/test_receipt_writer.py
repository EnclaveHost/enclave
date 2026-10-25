"""write_download_receipt.py: refuses anything it cannot read from systemd's record of the exact invocation (queue 256)."""
import importlib.util, json, os, pathlib, sys, tempfile, unittest
H = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('w', H / 'write_download_receipt.py'); W = importlib.util.module_from_spec(spec); spec.loader.exec_module(W)
sys.path.insert(0, str(H / 'test')); import test_a2a4 as T
W.REQUIRE_ROOT = False


class Writer(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); d = pathlib.Path(self.t.name); self.d = d
        (d / 'datadir').mkdir(); (d / 'bin').mkdir(); (d / 'marker').write_text('')
        (d / 'manifest.json').write_text(json.dumps(T.MANIFEST)); W.MANIFEST_SHA = T.A.sha256(d / 'manifest.json')
        # a stand-in for the pinned binary: path and sha are bound together (production: /opt/enclave-rpc/bin/base, 9c44836d...)
        (d / 'base').write_bytes(b'pinned base binary stand-in'); T.S.BASE_BINARY = str(d / 'base'); T.S.BASE_BINARY_SHA256 = T.A.sha256(d / 'base')
        self.argv = T.argv_for(T.S.FINAL_PROFILE, str(d / 'datadir'), str(d / 'manifest.json'))
        self.props = {'ActiveState': 'inactive', 'Result': 'success', 'ExecMainStatus': '0', 'ExecMainCode': '1', 'InvocationID': '0123456789abcdef0123456789abcdef',
                      'ExecMainExitTimestamp': 'Sun 2026-10-26', 'ExecStart': '{ path=%s ; argv[]=%s ; ignore_errors=no ; start_time=[x] ; stop_time=[y] ; pid=7 ; code=exited ; status=0/SUCCESS }'}
        self.write()

    def write(self):
        props = dict(self.props); props['ExecStart'] = props['ExecStart'] % (self.argv[0], ' '.join(self.argv)) if '%s' in props['ExecStart'] else props['ExecStart']
        (self.d / 'props.json').write_text(json.dumps(props))
        f = self.d / 'bin/systemctl'
        f.write_text(f'#!{sys.executable}\nimport json,sys\nprint(json.load(open({str(self.d / "props.json")!r}))[sys.argv[4]])\n'); f.chmod(0o755)
        os.environ['PATH'] = f'{self.d / "bin"}:{os.environ["PATH"]}'

    def tearDown(self): self.t.cleanup()

    def run_w(self, profile=T.S.FINAL_PROFILE, out='r.json'):
        return W.main(['--profile', profile, '--datadir', str(self.d / 'datadir'), '--manifest', str(self.d / 'manifest.json'),
                       '--marker', str(self.d / 'marker'), '--out', str(self.d / out)])

    def test_writes_a_receipt_the_harness_accepts_shape_of(self):
        self.assertEqual(self.run_w(), 0)
        r = json.loads((self.d / 'r.json').read_text())
        self.assertEqual((r['profile'], len(r['selectedArchives']), r['invocationId'], r['baseBinarySha256']),
                         (T.S.FINAL_PROFILE, 134, '0123456789abcdef0123456789abcdef', T.S.BASE_BINARY_SHA256))
        self.assertEqual(self.run_w(), 3, 'never overwrites an existing receipt')

    def test_refuses_without_real_success_or_exact_argv(self):
        for k, v in (('Result', 'exit-code'), ('ExecMainStatus', '1'), ('ActiveState', 'active')):
            self.setUp(); self.props[k] = v; self.write(); self.assertEqual(self.run_w(), 3, k)
        self.setUp(); self.argv = self.argv + ['--with-rocksdb']; self.write(); self.assertEqual(self.run_w(), 3)
        self.setUp(); self.assertEqual(self.run_w(profile='first-pass-distance-140000'), 3, 'argv is not the first-pass invocation')
        self.setUp(); (self.d / 'marker').write_text('x'); self.assertEqual(self.run_w(), 3)
        self.setUp(); self.props['ExecStart'] = 'garbage'; self.write(); self.assertEqual(self.run_w(), 3)
        self.setUp(); W.MANIFEST_SHA = '0' * 64; self.assertEqual(self.run_w(), 3)
        for k, v in (('ExecMainCode', '2'), ('InvocationID', ''), ('InvocationID', 'not-hex')):
            self.setUp(); self.props[k] = v; self.write(); self.assertEqual(self.run_w(), 3, (k, v))
        self.setUp(); (self.d / 'base').write_bytes(b'another program'); self.assertEqual(self.run_w(), 3, 'unpinned binary: no attribution')


if __name__ == '__main__':
    unittest.main(verbosity=2)
