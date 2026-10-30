"""r8: the consumers' verifier is the immutable historical-capture bundle (020cc8bf), relocated, and the r18 install manifest ships exactly it.
- relocated acceptance: the wrapper's REAL loader (_secure_path walk + O_NOFOLLOW + pins d088/5a88/cb684) loads the bundle lib from two
  different roots; every AO.PINS / SG.GATE path resolves INSIDE that root, exists and has its pinned sha (no workstation path); the full
  acceptance (re-aggregation at the current time) accepts real evidence; a tampered bundle lib byte is refused by BOTH consumers.
- install closure: r18 install/MANIFEST.json installs every bundle file (+ MANIFEST.json) under /opt/enclave-rpc/historical-capture/<sha>/
  with the bundle's sha and mode, no r16/r17 lib/anchored-coverage copy remains, wrapper and readiness point at <dest>/lib with the same
  pins; the candidate's own install_verified.py preflight plans exactly those writes (0755 for bin/* and kzgcheck)."""
import hashlib, json, os, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_r3_integration as I  # noqa: E402

W, RS = I.W, I.RS
CAND = HERE.parent / 'compose' / 'r18-candidate'
DEST = '/opt/enclave-rpc/historical-capture/' + I.BUNDLE_SHA
PINS = {'anchored_origin.py': 'd088592d0398d017ce5101f0f9bf09849735be2fe0fb1c63ef710623be08d199',
        'segments.py': '5a88a2e2894b5abb398e614db0251b313e5a6e15bbafc9d1055ec9707f602b56',
        'anchored_acceptance.py': 'cb68413866d0534822bdfc37702e253acfe04abad30d98e34b2231595518138d'}
sha = lambda b: hashlib.sha256(b).hexdigest()   # noqa: E731


class RelocatedBundle(I.Common):
    def load(self, inst):
        with patch.object(W, 'TRUSTED_TOP', inst.root), patch.object(W, 'ANCHORED_COVERAGE_LIB', inst.lib):
            return W._anchored_overlay(os.getuid())      # the REAL loader: _secure_path walk, O_NOFOLLOW, sha pins

    def test_bundle_lib_resolves_every_pin_inside_its_relocated_root_and_accepts(self):
        self.assertEqual(W.ANCHORED_COVERAGE_PINS, PINS)
        self.assertEqual(RS.ANCHORED_COVERAGE_PINS, PINS)
        for _ in range(2):                                  # two different install roots: relocatable
            inst = self.install()
            aa = self.load(inst)
            root = os.path.realpath(inst.bundle)
            self.assertEqual(aa.AO.ROOT, root)
            for key, (path, want) in list(aa.AO.PINS.items()) + [('gate', aa.SG.GATE)]:
                with self.subTest(key=key):
                    self.assertTrue(os.path.realpath(path).startswith(root + os.sep), path)
                    self.assertNotIn('/home/', path)
                    self.assertEqual(sha(Path(path).read_bytes()), want)
            b, so = self.wrapper(inst)                      # the full acceptance through the bundle lib, at the current time
            self.assertEqual((b['mode'], so['number']), ('anchored-segments', I.ORIGIN))
            self.assertEqual(self.readiness(inst)['snapshotSafe']['number'], I.NR)

    def test_a_tampered_bundle_lib_is_refused_by_both_consumers(self):
        inst = self.install()
        p = inst.lib / 'anchored_origin.py'
        p.write_bytes(p.read_bytes().replace(b"ROOT = os.path.dirname", b"ROOT  = os.path.dirname"))
        with self.assertRaisesRegex(AssertionError, 'not the pinned bytes'):
            self.wrapper(inst)
        with self.assertRaises(RS.Negative) as cm:
            self.readiness(inst)
        self.assertEqual(cm.exception.code, 'anchored-verifier-not-pinned')


class InstallClosure(unittest.TestCase):
    def test_r18_manifest_ships_exactly_the_bundle_and_both_consumers_point_at_it(self):
        bm = json.loads((I.BUNDLE / 'MANIFEST.json').read_bytes())
        m = json.loads((CAND / 'install/MANIFEST.json').read_bytes())
        ours = {e['dest']: e for e in m['files'] if e['dest'].startswith(DEST + '/')}
        want = {f'{DEST}/{rel}': (e['sha256'], e['mode']) for rel, e in bm['files'].items()}
        want[f'{DEST}/MANIFEST.json'] = (I.BUNDLE_SHA, '0644')
        self.assertEqual({d: (e['sha256'], e['mode']) for d, e in ours.items()}, want)
        for d, e in ours.items():
            self.assertEqual(sha((CAND / e['src']).read_bytes()), e['sha256'], d)
        self.assertFalse([e for e in m['files'] if '/lib/anchored-coverage/' in e['dest'] or 'anchored_' in e['dest'] and not e['dest'].startswith(DEST)])
        self.assertFalse([t for t in m['trees'] if 'historical-capture' in t['dest'] or 'anchored-coverage' in t['dest']])
        w = (CAND / 'wrapper/chain_service.py').read_text(); r = (CAND / 'readiness/readiness_sampler.py').read_text()
        self.assertIn(f"ANCHORED_COVERAGE_BUNDLE = '{I.BUNDLE_SHA}'", w); self.assertIn("ANCHORED_COVERAGE_LIB = ROOT / 'historical-capture' / ANCHORED_COVERAGE_BUNDLE / 'lib'", w)
        self.assertIn(f"ANCHORED_COVERAGE_BUNDLE = '{I.BUNDLE_SHA}'", r); self.assertIn("ANCHORED_COVERAGE_LIB = '/opt/enclave-rpc/historical-capture/' + ANCHORED_COVERAGE_BUNDLE + '/lib'", r)
        for f, h in PINS.items():
            self.assertIn(f"'{f}': '{h}'", w); self.assertIn(f"'{f}': '{h}'", r)
            self.assertEqual(ours[f'{DEST}/lib/{f}']['sha256'], h)

    def test_the_candidate_installer_plans_exactly_the_bundle_with_its_modes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('install_verified_r18', CAND / 'install/install_verified.py')
        IV = importlib.util.module_from_spec(spec); spec.loader.exec_module(IV)
        m = json.loads((CAND / 'install/MANIFEST.json').read_bytes())
        sub = dict(m, files=[e for e in m['files'] if e['dest'].startswith(DEST + '/')], trees=[])
        with tempfile.TemporaryDirectory() as t, patch.object(IV, 'ROOT', Path(t)), patch.object(IV, 'UID', os.getuid()):
            os.chmod(t, 0o755)
            ops, plan = IV.preflight(sub, replace=False, include_wrapper=False, include_units=False, stage=CAND)
        got = {op['dest']: op['mode'] for op, _ in ops}
        bm = json.loads((I.BUNDLE / 'MANIFEST.json').read_bytes())
        want = {f'{DEST}/{rel}': int(e['mode'], 8) for rel, e in bm['files'].items()} | {f'{DEST}/MANIFEST.json': 0o644}
        self.assertEqual(got, want)
        self.assertEqual({d for d, mo in got.items() if mo == 0o755}, {f'{DEST}/bin/guest-capture.sh', f'{DEST}/bin/historical-capture', f'{DEST}/vendor/coverage/kzgcheck'})
        self.assertTrue(all(p['result'] == 'create' for p in plan), plan[:3])


if __name__ == '__main__':
    unittest.main()
