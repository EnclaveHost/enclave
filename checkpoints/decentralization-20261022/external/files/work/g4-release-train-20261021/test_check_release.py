#!/usr/bin/env python3
"""Scenario tests of check-release.py over the REAL manifests (published 2026.10.12.47 5b966e81; local 2026.10.20.1 f509d0b4)
and the live on-disk overlay. S3/S4/S5 releases are SYNTHETIC (labelled): no release was built."""
import copy, importlib.util, json, pathlib, unittest
H = pathlib.Path(__file__).resolve().parent; W = H.parent
s = importlib.util.spec_from_file_location('c', H / 'check-release.py'); c = importlib.util.module_from_spec(s); s.loader.exec_module(c)
P47 = c.load(H / 'evidence/manifest-2026.10.12.47.json'); P201 = c.load(W / 'windows-bundle-abe86262/bundle-manifest.json')
REQ = c.load(H / 'required-release-files.json'); DISK = c.load(H / 'evidence/on-disk-live.json')
HS2 = {'host-services/hs2/bin/host-services-runner.mjs': 'a075c7fa' + '0' * 56}          # marker: hs2 lives under Program Files\Enclave

def bump(m, v, files=None):
    n = copy.deepcopy(m); n['version'] = v
    if files:
        idx = {e['path']: e for e in n['files']}
        for p, h in files.items():
            if p in idx: idx[p]['sha256'] = h
            else: n['files'].append({'path': p, 'sha256': h, 'bytes': 1000})
    return n

class T(unittest.TestCase):
    def test_s1_today_if_installed_is_2026_10_12_47(self):
        r, rc = c.judge(P47, P47, REQ, DISK); self.assertTrue(r['decision'].startswith('NOT INSTALLED')); self.assertEqual(rc, 0)
    def test_s2_today_if_installed_is_2026_10_20_1(self):
        r, rc = c.judge(P201, P47, REQ, DISK); self.assertTrue(r['decision'].startswith('NOT INSTALLED')); self.assertEqual(rc, 0)
    def test_s3_any_newer_publish_without_the_candidates_breaks_minipc(self):
        for base in (P47, P201):
            r, rc = c.judge(base, bump(P47, '2026.10.21'), REQ, DISK)
            self.assertEqual(r['decision'], 'INSTALLED'); self.assertEqual(rc, 1); self.assertGreater(r['failures'], 5, r['required'])
    def test_s4_a_release_carrying_every_required_file_passes_as_a_delta(self):
        r, rc = c.judge(P47, bump(P47, '2026.10.22', REQ), REQ, {**DISK, **HS2})
        self.assertEqual((r['decision'], r['mode'], rc), ('INSTALLED', 'DELTA', 0), r['required'])
    def test_s5_the_same_release_as_a_full_install_deletes_hs2(self):
        r, rc = c.judge(P47, bump(P47, '2026.10.22', REQ), REQ, {**DISK, **HS2}, kept_bundle=False)
        self.assertEqual((r['mode'], rc), ('FULL', 0)); self.assertIn('host-services/hs2/bin/host-services-runner.mjs', r['deletedOutsideRelease'])
    def test_version_ordering_is_dotnet(self):
        self.assertTrue(c.vgt(c.ver('2026.10.21'), c.ver('2026.10.20.1'))); self.assertFalse(c.vgt(c.ver('2026.10.20'), c.ver('2026.10.20.1')))
        self.assertFalse(c.vgt(c.ver('2026.10.12.47'), c.ver('2026.10.20.1')))

if __name__ == '__main__':
    unittest.main(verbosity=2)
