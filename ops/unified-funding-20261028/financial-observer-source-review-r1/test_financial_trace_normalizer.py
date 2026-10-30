"""Offline parser qualification against preserved OWNED trace and mutations."""
from pathlib import Path
import hashlib
import json
import unittest
import io
from financial_trace_normalizer import normalize, normalize_stream, evaluate, REQUIRED_EVIDENCE

ROOT = Path(__file__).resolve().parent
PRIVATE = ROOT/'clean-r1-local-evidence/private-artifacts'
TRACE = (PRIVATE/'trace.raw').read_bytes()
assert hashlib.sha256(TRACE).hexdigest() == '1d1459a6944522ddd0510f4ee8de0580ce395eac74ccf86e3a59c3d10e6cff57'
PREFIX = '/var/tmp/enclave-checkpoint-fixture-20261028-owned-r1/runs/owned-checkpoint-s1ct9gdz/data/'
CONTEXT = {'writerTid':252795, 'threadIds':list(range(252795,252802)), 'signalSenderPid':252793,
           'tmpPath':PREFIX+'sessions-relayer.json.tmp', 'journalPath':PREFIX+'sessions-relayer.json'}


class ParserTests(unittest.TestCase):
    def test_preserved_trace_metadata_only(self):
        r = normalize(TRACE, CONTEXT)
        self.assertTrue(r['syscallCheckpoint'], r['reasons'])
        self.assertEqual(r['checkpoint']['bytes'],104)
        self.assertEqual(r['signalLine'],15)
        self.assertFalse(r['productionAcceptance'])
        self.assertNotIn(PREFIX, json.dumps(r))
        e = evaluate(r,{})
        self.assertFalse(e['financialCoverageCandidate'])
        self.assertFalse(e['writeResumptionAllowed'])

    def test_unrelated_shutdown_io_not_rejected(self):
        r=normalize(TRACE,CONTEXT)
        self.assertTrue(any(e['syscall']=='io_uring_enter' for e in r['events']))
        self.assertTrue(r['syscallCheckpoint'])

    def test_missing_signal(self):
        r=normalize(b'\n'.join(l for l in TRACE.splitlines() if b'--- SIGTERM' not in l)+b'\n',CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_wrong_signal_thread(self):
        r=normalize(TRACE.replace(b'252795 1793232541.312912 --- SIGTERM',b'252796 1793232541.312912 --- SIGTERM'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_failed_rename(self):
        r=normalize(TRACE.replace(b'= 0 <0.000172>',b'= -1 EACCES (Permission denied) <0.000172>'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_stale_same_success_then_failed_final(self):
        # Identical old checkpoint is insufficient after a later failed open.
        at=b'252795 1793232541.314647 close(0x5)'
        failure=(b'252795 1793232541.314600 openat(AT_FDCWD, "'+CONTEXT['tmpPath'].encode()+
                 b'", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0600) = -1 EACCES (Permission denied) <0.000010>\n')
        r=normalize(TRACE.replace(at,failure+at),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_partial_write(self):
        r=normalize(TRACE.replace(b'= 0x68 <0.000064>',b'= 0x60 <0.000064>'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_missing_terminal(self):
        r=normalize(TRACE[:TRACE.rfind(b'252795 1793232541.323746')],CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_decoded_buffer_rejected_without_echo(self):
        r=normalize(TRACE.replace(b'0x20c6c038, 0x68',b'"PRIVATE_TEST_CANARY", 0x68'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])
        self.assertNotIn('PRIVATE_TEST_CANARY',json.dumps(r))

    def test_unpaired_resume(self):
        r=normalize(TRACE.replace(b'<... write resumed>',b'<... writev resumed>'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_unexpected_thread(self):
        r=normalize(TRACE, {**CONTEXT,'threadIds':list(range(252795,252801))})
        self.assertFalse(r['syscallCheckpoint'])

    def test_original_refusal_preserved(self):
        old=json.loads((ROOT/'clean-r1-local-evidence/manual-review.json').read_text())
        self.assertEqual(old['conservativeCoverage'],'REFUSE')
        self.assertFalse(old['productionAcceptance'])

    def test_evidence_booleans_not_accepted(self):
        e=evaluate(normalize(TRACE,CONTEXT),{k:True for k in REQUIRED_EVIDENCE})
        self.assertFalse(e['financialCoverageCandidate'])

    def test_stream_metadata_matches(self):
        self.assertEqual(normalize_stream(io.BytesIO(TRACE),CONTEXT),normalize(TRACE,CONTEXT))

    def test_stream_long_line_refuses(self):
        r=normalize_stream(io.BytesIO(b'x'*9000+b'\n'),CONTEXT)
        self.assertFalse(r['syscallCheckpoint'])

    def test_root_review_raw_rename_after_checkpoint(self):
        at=b'252795 1793232541.314647 close(0x5)'
        injected=b'252795 1793232541.314600 rename(0x1234, 0x5678) = 0 <0.000010>\n'
        r=normalize(TRACE.replace(at,injected+at),CONTEXT)
        self.assertIn('missing-required-path-decoding',r['reasons'])
        self.assertFalse(r['syscallCheckpoint'])

    def test_root_review_raw_openat_after_checkpoint(self):
        at=b'252795 1793232541.314647 close(0x5)'
        injected=b'252795 1793232541.314600 openat(0xffffff9c, 0x1234, 0x80241, 0x180) = 24 <0.000010>\n'
        r=normalize(TRACE.replace(at,injected+at),CONTEXT)
        self.assertIn('missing-required-path-decoding',r['reasons'])
        self.assertFalse(r['syscallCheckpoint'])

    def test_explicit_other_store_role(self):
        at=b'252795 1793232541.314647 close(0x5)'
        injected=(b'252795 1793232541.314600 openat(AT_FDCWD, "/owned/accounts.json.tmp", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = 24 <0.000010>\n'
                  b'252795 1793232541.314610 write(0x18, 0x1234, 0x10) = 0x10 <0.000001>\n'
                  b'252795 1793232541.314620 close(0x18) = 0 <0.000001>\n'
                  b'252795 1793232541.314630 rename("/owned/accounts.json.tmp", "/owned/accounts.json") = 0 <0.000001>\n')
        ctx={**CONTEXT,'otherStores':{'accounts':{'tmp':'/owned/accounts.json.tmp','journal':'/owned/accounts.json'}}}
        r=normalize(TRACE.replace(at,injected+at),ctx)
        self.assertTrue(r['syscallCheckpoint'],r['reasons'])
        self.assertNotIn('/owned/',json.dumps(r))
        self.assertFalse(normalize(TRACE.replace(at,injected+at),CONTEXT)['syscallCheckpoint'])


if __name__ == '__main__':
    unittest.main()
