#!/usr/bin/env python3
"""reproof.py real-tool tests (PREPARED; NOT run by Claude: jobs/root-finality-r7-tests.sh, exact count 5). Subclasses the integration
fixture: the REAL r7 harness executing the REAL capture r4 module over its own stub sources (our own L1 fixture inputs: no network, no
live mutation), the shared admission ledger, the pinned core over the loopback chain, the r7 wrapper journal/watermark and the r7
producer record_finality. The only seam is capture_fn: it runs the real C.capture with the fixture's stub Sources/pins (production uses
the module's own reviewed Sources)."""
import json, os, pathlib, sys, types, unittest
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
                'capturesRoot': str(self.t / 'caps')}

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

    def test_hold_flags_fail_closed(self):
        self.launched()
        with patch.object(R, 'A1_CAPTURE_REVIEWED', False), self.assertRaises(R.Refused) as cm:
            self.reproof(capture_fn=self.capture_fn(NP))
        self.assertEqual(RP.code_of(cm.exception), 'a1_capture_pending'); self.assertEqual(self.pairs(), [])
        with self.assertRaises(FS.Refused) as cm:
            self.reproof(reviewed=False, capture_fn=self.capture_fn(NP))          # the tool's own HOLD: nothing recorded
        self.assertEqual(cm.exception.code, 'hold_prototype'); self.assertIn('hold_prototype', RP.HOLD_CODES)
        self.assertFalse(self.ledger.exists()); self.assertEqual(os.listdir(self.fdir), [])


for _n in [n for n in dir(TI.Integration) if n.startswith('test_')]:
    setattr(Reproof, _n, None)


if __name__ == '__main__':
    unittest.main()
