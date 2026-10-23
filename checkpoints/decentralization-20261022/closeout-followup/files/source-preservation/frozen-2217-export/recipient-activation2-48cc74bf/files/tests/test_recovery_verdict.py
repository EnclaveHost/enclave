"""check-recovery-verdict.py: only the wrapper's accepted, fresh, post-attach verdict for 08d1f838 passes; every weakening refuses."""
import datetime, hashlib, importlib.util, re, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rv', str(ROOT / 'check-recovery-verdict.py'))
rv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rv)
NOW = datetime.datetime(2026, 10, 23, 23, 5, tzinfo=datetime.timezone.utc)
RESULT = {'measurement': rv.PIN, 'productionActivated': 'provisional', 'attachedAt': '2026-10-23T22:55:00+00:00'}
EE5 = 'ee5df6b83948f5bacebee414574adb87be9d58412b09ae9183fc4deed5aed3d96bc1cbead096372e7ee755febbbc22ec'

class RecoveryVerdict(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.v = self.verdict('2026-10-23T23:00:00.000Z')
    def verdict(self, at, body='{"raw": true}'):
        raw = self.d / f"attestation-raw-{at.replace(':', '').replace('.', '')}.json"; raw.write_text(body); raw.chmod(0o600)
        return {'probe': 'attest-control/1', 'wrapper': 'recovery-target/1', 'target': 'recovery', 'accepted': True, 'pass': True,
                'status': 'verified', 'admissionSafe': True, 'expectedMeasurement': rv.PIN, 'observedMeasurement': rv.PIN, 'measurementMatches': True,
                'required': {k: 'PASS' for k in rv.REQUIRED}, 'failedChecks': [], 'freshness': 'verifier nonce', 'nonce': 'ab' * 32, 'vmpl': 0,
                'at': at, 'rawSha256': hashlib.sha256(raw.read_bytes()).hexdigest()}
    def check(self, v, result=RESULT, now=NOW): return rv.problems(v, result, self.d, now=now)

    def test_pin_is_the_wrapper_pin(self):
        src = (ROOT / 'recovery-target.mjs').read_text()
        self.assertEqual(re.search(r"measurement: '([0-9a-f]{96})'", src).group(1), rv.PIN)
    def test_good_passes(self): self.assertEqual(self.check(self.v), [])
    def test_every_weakening_refused(self):
        v = self.v
        bad = [dict(v, accepted=False), dict(v, **{'pass': False}), dict(v, status='limited'), dict(v, admissionSafe=False),
               dict(v, target='new'), dict(v, wrapper=None), dict(v, probe='other'), dict(v, observedMeasurement=EE5), dict(v, expectedMeasurement=EE5),
               dict(v, measurementMatches=False), dict(v, required={**v['required'], 'binding': 'UNAVAILABLE'}), dict(v, required={}),
               dict(v, failedChecks=['crl']), dict(v, failedChecks=None), dict(v, freshness='none'), dict(v, nonce='ab' * 31), dict(v, nonce='zz' * 32),
               dict(v, vmpl=1), dict(v, vmpl=None), dict(v, rawSha256='0' * 64), dict(v, at='yesterday')]
        for b in bad: self.assertTrue(self.check(b), b)
    def test_activation_state_must_match(self):
        for r in [dict(RESULT, measurement=EE5), dict(RESULT, productionActivated=False), dict(RESULT, productionActivated=True), dict(RESULT, attachedAt=None)]:
            self.assertTrue(self.check(self.v, r), r)
    def test_time_alone_refuses(self):
        early = self.verdict('2026-10-23T22:50:00.000Z')                      # before the attachment
        p = self.check(early); self.assertEqual(len(p), 1, p); self.assertIn('not after the attachment', p[0])
        same = self.verdict('2026-10-23T22:55:00.000Z')                       # equal instant, other text form: parsed, not string-compared
        self.assertIn('not after the attachment', ' '.join(self.check(same)))
        p = self.check(self.v, now=NOW + datetime.timedelta(seconds=rv.MAX_AGE_S + 300)); self.assertEqual(len(p), 1, p); self.assertIn('older than', p[0])
        p = self.check(self.v, now=NOW - datetime.timedelta(minutes=10)); self.assertIn('from the future', ' '.join(p))
    def test_raw_file_rules(self):
        raw = self.d / 'attestation-raw-2026-10-23T230000000Z.json'
        raw.chmod(0o644); self.assertIn('not 0600', ' '.join(self.check(self.v))); raw.chmod(0o600)
        raw.unlink(); self.assertIn('missing', ' '.join(self.check(self.v)))
    def test_substring_alone_is_not_enough(self):
        self.assertTrue(self.check({'note': 'mentions ' + rv.PIN}))           # what keep.py's own test would accept
