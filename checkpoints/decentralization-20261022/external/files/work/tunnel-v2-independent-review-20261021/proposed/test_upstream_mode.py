"""7d: the UPSTREAM shape of make-upgrade-bundle-g3-upstream.py on the REAL live G3 config and stage (config-only)."""
import hashlib, importlib.util, json, pathlib, shutil, tempfile, unittest
HERE = pathlib.Path(__file__).resolve().parent
sp = importlib.util.spec_from_file_location('m', HERE / 'make-upgrade-bundle-g3-upstream.py'); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
W = HERE.parents[1]
STAGE = W / 'host-service-tls-20261021/g3-final-package/stage-g3/stage-r2/enclave-host-services-hs2-windows'
FR = HERE.parent / 'frozen'
LIVE = FR / 'hs2-r6/live-47f3e1f.json'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
class T(unittest.TestCase):
    def setUp(self): self.d = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.d)
    def b(self, new, up='127.0.0.1:31053', out='b'):
        return m.build(str(STAGE), str(STAGE), str(LIVE), sha(LIVE), 'ab' * 32, str(self.d / out), str(new), [], False, up)
    def test_r6_upstream_is_exactly_one_key(self):
        man, msha = self.b(FR / 'hs2-r6/host-services.r6-upstream.json')
        self.assertEqual(man['replace'], []); self.assertEqual(man['add'], [])
        self.assertEqual(man['config']['old'], '47f3e1f56a4e232283b10641c03066616841d0da1286110961320c2e1e807518')
        self.assertEqual(man['config']['new'], sha(FR / 'hs2-r6/host-services.r6-upstream.json'))
        self.assertEqual(man['config']['challengeTxtUpstream'], '127.0.0.1:31053')
        self.assertEqual((self.d / 'b/config/host-services.json').read_bytes(), (FR / 'hs2-r6/host-services.r6-upstream.json').read_bytes())
    def test_refusals(self):
        live = json.loads(LIVE.read_text())
        def variant(name, f):
            c = json.loads(LIVE.read_text()); f(c); p = self.d / f'{name}.json'; p.write_text(json.dumps(c, indent=2) + '\n'); return p
        def rd(c): return next(s for s in c['services'] if s['role'] == 'route-dns')['config']
        cases = [('r6 (NS, appStatic, rate changes)', FR / 'hs2-r6/host-services.r6.json', '127.0.0.1:31053'),
                 ('r5e (stale, no service-tls)', FR / 'host-services.r5e.json', '127.0.0.1:31053'),
                 ('other value', FR / 'hs2-r6/host-services.r6-upstream.json', '127.0.0.1:31054'),
                 ('self', variant('self', lambda c: rd(c).__setitem__('challengeTxtUpstream', f"127.0.0.1:{rd(c)['dnsPort']}")), None),
                 ('tls orders approved too', variant('tls', lambda c: (rd(c).__setitem__('challengeTxtUpstream', '127.0.0.1:31053'), c['services'][-1]['config'].__setitem__('orders', 'approved'))), '127.0.0.1:31053'),
                 ('no change', LIVE, '127.0.0.1:31053'),
                 ('hostname', FR / 'hs2-r6/host-services.r6-upstream.json', 'localhost:31053')]
        for i, (label, new, up) in enumerate(cases):
            with self.subTest(label):
                if up is None: up = f"127.0.0.1:{rd(live)['dnsPort']}"
                with self.assertRaises(m.Refused): self.b(new, up, out=f'r{i}')
if __name__ == '__main__': unittest.main()
