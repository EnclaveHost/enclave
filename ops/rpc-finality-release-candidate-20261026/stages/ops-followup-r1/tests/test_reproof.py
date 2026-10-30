#!/usr/bin/env python3
"""reproof.py real-tool tests (PREPARED; NOT run by Claude: jobs/root-finality-r7-tests.sh, exact count 9). Subclasses the integration
fixture: the REAL r7 harness executing the REAL capture r4 module over its own stub sources (our own L1 fixture inputs: no network, no
live mutation), the shared admission ledger, the pinned core over the loopback chain, the r7 wrapper journal/watermark and the r7
producer record_finality. The only seam is capture_fn: it runs the real C.capture with the fixture's stub Sources/pins (production uses
the module's own reviewed Sources)."""
import datetime, json, os, pathlib, sys, types, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / 'src'))
import test_finality_integration as TI                    # the fixture (its own tests are not re-run here)
import reproof as RP
FS, W, R, P, RS, TA = TI.FS, TI.W, TI.R, TI.P, TI.RS, TI.TA
N, NP, NP2, CHAIN = TI.N, TI.NP, TI.NP2, TI.CHAIN


class Reproof(TI.Integration):
    def config(self):
        (self.t / 'caps').mkdir(mode=0o700, exist_ok=True); (self.t / 'run').mkdir(exist_ok=True)
        return {'format': RP.FORMAT, 'launchDir': str(self.d), 'chainJson': str(self.t / 'chain.json'), 'rpcUrl': self.url,
                'statusOut': str(self.t / 'run/status.json'), 'node': TI.NODE, 'depsRoot': TI.DEPS, 'workdir': str(self.t / 'work'),
                'capturesRoot': str(self.t / 'caps'), 'captureSources': str(self.t / 'capture-sources.json')}   # unused: capture_fn

    def capture_fn(self, n, l1_bump=0, fail=None):
        def cap(mode, out, initial=None):
            if mode == fail:
                return False, {'error': 'helios: finalized header unavailable (fixture)'}
            if mode == 'initial':
                e = TA.fresh_a1(TA.utcnow() - TA.datetime.timedelta(hours=1), root=CHAIN['outputRoots'][str(n)]); e['N'] = str(n)
                e['l1'] = {**e['l1'], 'number': e['l1']['number'] + l1_bump}; self.tpl.write_text(json.dumps(e))
            return self.C.capture(mode, str(out), src=self.C.Sources(**{**self.csrc.__dict__, 'initial_capture': pathlib.Path(initial) if initial else None}),
                                  pins=self.cpins, hooks={'poll': 0.05}, helios_timeout=20, a1_timeout=60)
        return cap

    def reproof(self, reviewed=True, **kw):
        with patch.object(FS, 'FINALITY_PROTOTYPE_REVIEWED', reviewed), patch.object(P, 'FINALITY_PROOF_REVIEWED', reviewed):
            return RP.run(self.config(), F=FS, W=W, R=R, P=P, top=self.t, proc=self.procdir, **kw)

    def gate(self):
        return RS.validate_finality_status(types.SimpleNamespace(finality_status=str(self.t / 'run/status.json'), finality_status_uid=self.uid,
                                                                 proc_root=self.procdir, max_finality_status_age=900))

    def pairs(self):
        return sorted(p.name for p in (self.t / 'caps').iterdir() if p.is_dir())

    def test_first_start_is_qualified_recorded_and_published(self):
        self.launched()
        r = self.reproof(capture_fn=self.capture_fn(NP)); self.assertEqual((r['action'], r['freshN']), ('reproved', NP))
        self.assertEqual(self.journal()[-1][1]['event'], 'bootstrapped'); self.assertEqual(self.wm(), [('finality-proof', NP)])
        self.assertEqual(self.gate()['recordedAs'], self.journal()[-1][0])

    def test_restart_then_reproof_readmits_and_a_second_run_does_nothing(self):
        self.launched(); self.reproof(capture_fn=self.capture_fn(NP)); self.permit(); self.handshake(); self.proc('777')
        self.assertEqual(self.status()['state'], 'stale-launch-changed')
        r = self.reproof(capture_fn=self.capture_fn(NP2, l1_bump=100)); self.assertEqual((r['action'], r['freshN']), ('reproved', NP2))
        self.assertEqual((self.gate()['freshN'], self.gate()['recordedAs']), (NP2, self.journal()[-1][0]))
        before = self.pairs(); self.assertEqual(self.reproof(capture_fn=self.capture_fn(NP2 + 1))['action'], 'none'); self.assertEqual(self.pairs(), before)

    def test_no_newer_anchor_game_waits_and_records_nothing(self):
        self.launched(); self.reproof(capture_fn=self.capture_fn(NP)); self.permit(); self.handshake(); self.proc('778')
        with self.assertRaises(FS.Refused) as cm:
            self.reproof(capture_fn=self.capture_fn(NP, l1_bump=50))              # the ASR anchor did not advance since the last proof
        self.assertEqual(cm.exception.code, 'not_newer'); self.assertIn(RP.code_of(cm.exception), RP.RETRY_CODES)
        self.assertEqual((self.journal()[-1][1]['event'], self.wm()), ('restarted', [('finality-proof', NP)]))

    def test_capture_failure_admits_and_records_nothing(self):
        self.launched()
        with self.assertRaises(RP.Refused) as cm:
            self.reproof(capture_fn=self.capture_fn(NP, fail='recheck-capture'))
        self.assertEqual(cm.exception.code, 'capture'); self.assertIn('capture', RP.RETRY_CODES)
        self.assertFalse(self.ledger.exists()); self.assertEqual(os.listdir(self.fdir), []); self.assertEqual(self.journal()[-1][1]['event'], 'consumed')

    def no_capture(self, *a, **k):
        raise AssertionError('a new capture was started although a durable or current proof was pending')

    def interrupted_second_record(self):
        """first proof recorded; one ordinary restart; a SECOND proof whose record is interrupted after the watermark entry landed"""
        self.launched(); self.reproof(capture_fn=self.capture_fn(NP)); self.permit(); self.handshake(); self.proc('777')
        with patch.object(P, '_append', side_effect=OSError('machine crash after the watermark entry landed')):
            with self.assertRaises(OSError):
                self.reproof(capture_fn=self.capture_fn(NP2, l1_bump=100))
        self.assertEqual((self.journal()[-1][1]['event'], self.wm()), ('restarted', [('finality-proof', NP), ('finality-proof', NP2)]))

    def test_r8_interrupted_record_same_process_is_adopted_before_any_capture(self):
        self.interrupted_second_record()
        r = self.reproof(capture_fn=self.no_capture); self.assertEqual(r['action'], 'adopted')
        j = self.journal()[-1]; self.assertEqual((j[1]['event'], j[1]['evidence']['number']), ('bootstrapped', NP2))
        self.assertEqual((self.gate()['freshN'], self.gate()['recordedAs']), (NP2, j[0]))

    def test_r8_interrupted_record_then_restart_adopts_first_then_records_the_newer_proof(self):
        self.interrupted_second_record(); self.proc('779')                                  # the node restarted before any adoption
        r = self.reproof(capture_fn=self.capture_fn(NP2 + 10, l1_bump=200)); self.assertEqual((r['action'], r['freshN']), ('reproved', NP2 + 10))
        boots = [e['evidence']['number'] for _, e in self.journal() if e['event'] == 'bootstrapped']
        self.assertEqual(boots, [NP, NP2, NP2 + 10], 'the durable proof was adopted BEFORE the newer one was recorded')
        self.assertEqual(self.wm(), [('finality-proof', NP), ('finality-proof', NP2), ('finality-proof', NP2 + 10)])
        self.assertEqual((self.gate()['freshN'], self.gate()['recordedAs']), (NP2 + 10, self.journal()[-1][0]))

    def test_r8_current_unrecorded_qualification_is_recorded_not_reproved(self):
        self.launched(); self.qualify(self.captures(NP))                                   # proven, never recorded (crash before record)
        r = self.reproof(capture_fn=self.no_capture); self.assertEqual(r['action'], 'recorded')
        self.assertEqual(self.gate()['recordedAs'], self.journal()[-1][0])

    def test_r8_unknown_dangling_entry_refuses_before_any_capture(self):
        self.launched(); self.reproof(capture_fn=self.capture_fn(NP)); self.proc('780')
        es = W.watermark_entries(self.store, self.uid, self.t)
        W.watermark_append(self.store, self.uid, es, NP + 5, '0x' + '66' * 32, 'finality-proof', 'cd' * 32, 'at', self.t)
        with self.assertRaises(P.Refused) as cm:
            self.reproof(capture_fn=self.no_capture)
        self.assertTrue(str(cm.exception).startswith('watermark'), str(cm.exception)); self.assertEqual(len(self.pairs()), 1)

    def test_hold_flags_fail_closed(self):
        self.launched()
        with patch.object(R, 'A1_CAPTURE_REVIEWED', False), self.assertRaises(R.Refused) as cm:
            self.reproof(capture_fn=self.capture_fn(NP))
        self.assertEqual(RP.code_of(cm.exception), 'a1_capture_pending'); self.assertEqual(self.pairs(), [])
        with self.assertRaises(FS.Refused) as cm:
            self.reproof(reviewed=False, capture_fn=self.capture_fn(NP))          # the tool's own HOLD: nothing recorded
        self.assertEqual(cm.exception.code, 'hold_prototype'); self.assertIn('hold_prototype', RP.HOLD_CODES)
        self.assertFalse(self.ledger.exists()); self.assertEqual(os.listdir(self.fdir), [])

    # ---- r10-ops-followup: every attempt leaves a receipt; failed attempts are bounded; proof pairs and active attempts are kept ----
    def history(self):
        h = self.t / 'caps' / RP.HISTORY
        return [json.loads(l) for l in h.read_text().splitlines()] if h.exists() else []

    def at(self, s):
        return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=s)

    def receipt(self, n):
        return json.loads((self.t / 'caps' / n / 'attempt.json').read_text())

    def test_failed_attempts_are_retired_with_receipts_and_bounded(self):
        self.launched()
        for i in range(3):
            with self.assertRaises(RP.Refused) as cm:
                self.reproof(capture_fn=self.capture_fn(NP, fail='recheck-capture'), now=self.at(i))
            self.assertEqual(cm.exception.code, 'capture')
        names = self.pairs(); failed = [n for n in names if n.startswith('failed-')]
        self.assertEqual((len(failed), names), (RP.FAILED_KEEP, failed))           # nothing failed stays in the proof-pair namespace
        h = self.history(); self.assertEqual([(r['outcome'], r['code']) for r in h], [('failed', 'capture')] * 3)
        self.assertEqual(sorted('failed-' + r['attempt'] for r in h)[-RP.FAILED_KEEP:], failed)   # newest kept; the oldest is history only
        self.assertEqual({self.receipt(n)['outcome'] for n in failed}, {'failed'})
        self.assertEqual(self.reproof(capture_fn=self.capture_fn(NP), now=self.at(10))['action'], 'reproved')
        rec = [n for n in self.pairs() if not n.startswith('failed-')]; self.assertEqual(len(rec), 1)
        self.assertEqual(self.receipt(rec[0])['outcome'], 'recorded'); self.assertFalse((self.t / 'caps' / rec[0] / RP.IN_PROGRESS).exists())
        self.assertTrue((self.t / 'caps' / rec[0] / 'initial').exists() and (self.t / 'caps' / rec[0] / 'recheck').exists())
        self.assertEqual((len(self.history()), len([n for n in self.pairs() if n.startswith('failed-')])), (4, RP.FAILED_KEEP))

    def test_a_not_newer_attempt_is_retired_and_the_recorded_pair_is_kept(self):
        self.launched(); self.reproof(capture_fn=self.capture_fn(NP), now=self.at(0)); self.permit(); self.handshake(); self.proc('778')
        recorded = self.pairs()
        with self.assertRaises(FS.Refused) as cm:
            self.reproof(capture_fn=self.capture_fn(NP, l1_bump=50), now=self.at(5))
        self.assertEqual(cm.exception.code, 'not_newer')
        names = self.pairs()
        self.assertEqual(([n for n in names if not n.startswith('failed-')], len(names)), (recorded, 2))
        self.assertEqual([(r['outcome'], r.get('code')) for r in self.history()], [('recorded', None), ('failed', 'not_newer')])

    def test_an_interrupted_attempt_is_retired_under_the_lock_and_older_pairs_are_kept(self):
        self.launched(); caps = self.t / 'caps'; caps.mkdir(mode=0o700, exist_ok=True)
        old = caps / '20261020T000000000000Z'; old.mkdir(mode=0o700); (old / 'initial').mkdir()           # an r10-era pair: no marker
        cut = caps / '20261021T000000000000Z'; cut.mkdir(mode=0o700); (cut / RP.IN_PROGRESS).write_bytes(b'')  # a killed attempt
        self.assertEqual(self.reproof(capture_fn=self.capture_fn(NP), now=self.at(0))['action'], 'reproved')
        names = self.pairs()
        self.assertIn(old.name, names); self.assertIn('failed-' + cut.name, names); self.assertNotIn(cut.name, names)
        self.assertEqual([(r['outcome'], r['attempt']) for r in self.history()][0], ('interrupted', cut.name))
        self.assertEqual(self.receipt('failed-' + cut.name)['outcome'], 'interrupted')

    def test_a_qualified_but_unrecorded_attempt_keeps_its_captures_for_adoption(self):
        self.interrupted_second_record()
        h = self.history(); self.assertEqual([r['outcome'] for r in h], ['recorded', 'qualified-unrecorded'])
        kept = [n for n in self.pairs() if not n.startswith('failed-')]
        self.assertEqual((len(kept), h[1]['attempt']), (2, kept[-1])); self.assertFalse((self.t / 'caps' / kept[-1] / RP.IN_PROGRESS).exists())
        self.assertEqual(self.reproof(capture_fn=self.no_capture)['action'], 'adopted')


for _n in [n for n in dir(TI.Integration) if n.startswith('test_')]:
    setattr(Reproof, _n, None)


if __name__ == '__main__':
    unittest.main()
