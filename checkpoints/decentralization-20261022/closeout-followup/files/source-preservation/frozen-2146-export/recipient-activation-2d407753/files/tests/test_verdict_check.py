"""check-attestation-verdict.py: only a genuine PASS verdict for ee5df6b8 is accepted; every weakening is refused."""
import hashlib, importlib.util, json, os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('cv', str(Path(__file__).resolve().parents[1] / 'check-attestation-verdict.py'))
cv = importlib.util.module_from_spec(spec); spec.loader.exec_module(cv)
from common import NEW
GOOD = {'probe': 'attest-control/1', 'target': 'new', 'pass': True, 'status': 'verified', 'admissionSafe': True,
        'expectedMeasurement': NEW['measurement'], 'observedMeasurement': NEW['measurement'], 'measurementMatches': True,
        'required': {k: 'PASS' for k in cv.REQUIRED}, 'freshness': 'verifier nonce', 'nonce': 'ab' * 32, 'vmpl': 0, 'failedChecks': [],
        'at': '2026-10-23T23:00:00.000Z', 'rawSha256': None}

class VerdictCheck(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp()); raw = self.d / 'attestation-raw-2026-10-23T230000000Z.json'
        raw.write_text('{"raw": true}'); raw.chmod(0o600); self.v = dict(GOOD, rawSha256=hashlib.sha256(raw.read_bytes()).hexdigest()); self.raw = raw
    def check(self, v): return cv.problems(v, attached_at='2026-10-23T22:00:00+00:00', raw_dir=self.d)
    def test_good_passes(self): self.assertEqual(self.check(self.v), [])
    def test_every_weakening_refused(self):
        bad = [dict(self.v, status='limited'), dict(self.v, pass_=1, **{'pass': False}), dict(self.v, observedMeasurement=NEW['measurement'][:-1] + '0'),
               dict(self.v, expectedMeasurement='ed918e4b' + NEW['measurement'][8:]), dict(self.v, required={**self.v['required'], 'binding': 'UNAVAILABLE'}),
               dict(self.v, freshness='none (key possession only)'), dict(self.v, vmpl=1), dict(self.v, target='current'), dict(self.v, failedChecks=['crl']),
               dict(self.v, at='2026-10-23T21:00:00.000Z'), dict(self.v, rawSha256='0' * 64), dict(self.v, probe='other'), dict(self.v, admissionSafe=False)]
        for b in bad: self.assertTrue(self.check(b), b)
    def test_verdict_before_attachment_refused_on_time_alone(self):
        raw = self.d / 'attestation-raw-2026-10-23T210000000Z.json'; raw.write_text('{"raw": "early"}'); raw.chmod(0o600)
        early = dict(self.v, at='2026-10-23T21:00:00.000Z', rawSha256=hashlib.sha256(raw.read_bytes()).hexdigest())
        p = self.check(early); self.assertEqual(len(p), 1, p); self.assertIn('not after the attachment', p[0])
    def test_substring_alone_is_not_enough(self):
        self.assertTrue(self.check({'note': 'mentions ' + NEW['measurement']}))   # what keep.py's own substring test would accept
    def test_raw_mode_and_presence(self):
        self.raw.chmod(0o644); self.assertTrue(self.check(self.v)); self.raw.unlink(); self.assertTrue(self.check(self.v))

if __name__ == '__main__': unittest.main()
