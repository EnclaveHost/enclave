#!/usr/bin/env python3
"""r10 capture regressions + r10-capture-fixture-fix (fixture-only: cap() seeds self.tpl like TI.captures; assertions unchanged) (PREPARED; NOT run by Claude: jobs/root-finality-r10-tests.sh, exact count 3). Subclasses the integration fixture:
the REAL capture module under test ($CAPTURE_MODULE = r10/capture/a1_capture.py) over the capture stage's stub A1 readers, real
capture -> verify -> recheck-capture -> verify (with its initial), and the module's mandatory runtime validation. Guards root's actual
failures: the initial A1 config ignored Sources.el_url (workstation 28645 from the template; guest canary r2) and verify() raised
NameError 'py' (r9 run 0648)."""
import dataclasses, json, os, pathlib, sys, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_finality_integration as TI
NP = TI.NP


class CaptureR10(TI.Integration):
    def src(self, el_url, initial=None):
        return self.C.Sources(**{**self.csrc.__dict__, 'el_url': el_url, 'initial_capture': pathlib.Path(initial) if initial else None})

    def seed(self, n):
        e = TI.TA.fresh_a1(TI.TA.utcnow() - TI.TA.datetime.timedelta(hours=1), root=TI.CHAIN['outputRoots'][str(n)]); e['N'] = str(n)
        self.tpl.write_text(json.dumps(e))

    def cap(self, mode, el_url, initial=None):
        if mode == 'initial':                                                    # fixture fix: seed the stub A1 reader's receipt EXACTLY as TI.captures does
            self.seed(NP)                                                        # (recheck-capture's stub reads the initial evidence the module hands it)
        self.ncap += 1; out = self.t / f'r10cap-{self.ncap}'
        ok, res = self.C.capture(mode, str(out), src=self.src(el_url, initial), pins=self.cpins, hooks={'poll': 0.05}, helios_timeout=20, a1_timeout=60)
        return ok, res, out

    def a1cfg(self, out):
        return json.loads((out / 'capture/inputs/a1-config.json').read_text())

    def test_guest_custom_port_flows_into_both_modes_through_capture_verify_recheck(self):
        url = 'http://127.0.0.1:18999'                                          # a guest EL port that is neither 18645 nor the template's 28645
        self.assertIn('28645', (self.csrc.initial_dir / 'a1-config.example.json').read_text() + json.dumps(self.C.Sources().el_url))
        ok, res, ini = self.cap('initial', url); self.assertTrue(ok, res)
        self.assertEqual(self.a1cfg(ini)['elUrl'], url)
        s1 = self.C.verify(str(ini), pins=self.cpins, node=TI.NODE, workdir=str(self.t / 'work'))
        self.assertEqual(s1['mode'], 'initial'); self.assertTrue(s1['python'].get('sha256'))
        ok, res, rk = self.cap('recheck-capture', url, initial=ini); self.assertTrue(ok, res)
        self.assertEqual(self.a1cfg(rk)['elUrl'], url)
        s2 = self.C.verify(str(rk), pins=self.cpins, node=TI.NODE, workdir=str(self.t / 'work'), initial_out=str(ini),
                           expected_initial_capture_sha256=s1['captureSha256'])
        self.assertEqual((s2['mode'], s2['initialCapture']['captureSha256']), ('recheck-capture', s1['captureSha256']))
        self.assertEqual(s2['python'], s1['python'])

    def test_non_loopback_el_url_refuses(self):
        for bad in ('http://10.0.0.5:18645', 'https://127.0.0.1:18645', 'http://localhost:18645'):
            ok, res, _ = self.cap('initial', bad); self.assertFalse(ok); self.assertIn('el_url', str(res.get('error') or res))

    def test_runtime_validation_stays_mandatory_in_verify(self):
        ok, res, ini = self.cap('initial', 'http://127.0.0.1:18645'); self.assertTrue(ok, res)
        for field, code in (('python_accepted', 'python_identity'), ('node_accepted', 'node_identity')):
            pins = dataclasses.replace(self.cpins, **{field: {}})
            with self.assertRaises(self.C.Refused) as cm:
                self.C.verify(str(ini), pins=pins, node=TI.NODE, workdir=str(self.t / 'work'))
            self.assertEqual(cm.exception.code, code, str(cm.exception))


for _n in [n for n in dir(TI.Integration) if n.startswith('test_')]:
    setattr(CaptureR10, _n, None)


if __name__ == '__main__':
    unittest.main()
