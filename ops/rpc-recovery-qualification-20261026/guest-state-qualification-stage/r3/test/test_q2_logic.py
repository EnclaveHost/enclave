#!/usr/bin/env python3
"""LOGIC tests for guest/q2_extract_confinement.py (root runs them; Claude never did). systemd, the base binary, zstd and sha256 are
MOCKED: these tests only pin the decision logic against root's false-PASS findings. They are NOT a native qualification of anything;
the real Q2 is the guest run with the real pinned binary under the candidate sandbox. Python >= 3.8 stdlib (unittest.mock)."""
import importlib.util, io, json, os, subprocess, tarfile, tempfile, unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location('q2', Path(__file__).resolve().parent.parent / 'guest' / 'q2_extract_confinement.py')
q2 = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(q2)
H = 'a' * 64
RAN_OK = ({'result': 'success', 'code': 'exited', 'status': 0, 'raw': '0/SUCCESS'}, f'... {q2.MARKER} ...')
RAN_REFUSED = ({'result': 'exit-code', 'code': 'exited', 'status': 1, 'raw': '1/FAILURE'}, f'... {q2.MARKER} ... error unpacking')


def kind(client, summary, out):
    return q2.classify_run(client, summary, out)[0]


def tiny_tar():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        ti = tarfile.TarInfo('db/x'); ti.size = 1; tf.addfile(ti, io.BytesIO(b'x'))
    return buf.getvalue()


def good_map(members):
    return {'format': q2.FIXTURE_FORMAT, 'decoy': '/srv/enclave-base-holder/tmp/gsq-r2/run/decoy',
            'goodOutputs': {p: {'size': 1, 'sha256': H} for p in q2.GOOD_PATHS},
            'fixtures': {n: {'file': f'{n}.tar.zst', 'sha256': H, 'size': 1, 'expect': e, 'members': members} for n, e in q2.EXPECT.items()}}


class Classification(unittest.TestCase):
    def test_client_timeout_never_qualifies_a_hostile_case(self):          # r1: rc 'timeout' != 0 counted as a refusal
        k = kind('timeout', None, '')
        self.assertEqual(k, 'timeout')
        for exact in (False, True):
            self.assertEqual(q2.verdict('refused-or-confined', k, exact, False, True)[0], 'FAIL')

    def test_unlaunched_unit_never_qualifies(self):                        # no systemd-run summary = the binary never ran
        self.assertEqual(kind(1, None, 'Failed to start transient service unit'), 'setup')
        self.assertEqual(q2.verdict('refused-or-confined', 'setup', False, False, True)[0], 'FAIL')

    def test_systemd_exec_setup_status_never_qualifies(self):
        for st in (200, 203, 218, 226, 245):
            s = {'result': 'exit-code', 'code': 'exited', 'status': st, 'raw': str(st)}
            self.assertEqual(kind(1, s, q2.MARKER), 'setup', st)

    def test_exit_without_the_extraction_marker_is_unclassified(self):
        self.assertEqual(kind(1, RAN_REFUSED[0], 'no marker here'), 'unclassified')
        self.assertEqual(q2.verdict('refused-or-confined', 'unclassified', False, False, True)[0], 'FAIL')

    def test_signal_or_runtime_limit_is_abnormal(self):
        s = {'result': 'timeout', 'code': 'killed', 'status': 'TERM', 'raw': 'TERM'}
        self.assertEqual(kind(1, s, q2.MARKER), 'abnormal')
        self.assertEqual(q2.verdict('refused-or-confined', 'abnormal', False, False, True)[0], 'FAIL')

    def test_genuine_refusal_and_confined_extraction(self):
        self.assertEqual(kind(1, *RAN_REFUSED), 'ran-refused')
        self.assertEqual(q2.verdict('refused-or-confined', 'ran-refused', False, False, True)[0], 'PASS')
        self.assertEqual(q2.verdict('refused-or-confined', 'ran-ok', False, False, True)[0], 'PASS')     # not exact -> install refuses
        self.assertEqual(q2.verdict('refused-or-confined', 'ran-ok', True, False, True)[0], 'FAIL')      # hostile staged as exact
        self.assertEqual(q2.verdict('extracted-exact', 'ran-ok', True, False, True)[0], 'PASS')
        self.assertEqual(q2.verdict('extracted-exact', 'ran-refused', False, False, True)[0], 'FAIL')
        self.assertEqual(q2.verdict('refused-or-neutralized', 'ran-ok', True, False, True)[0], 'PASS')
        self.assertEqual(q2.verdict('refused-or-neutralized', 'ran-ok', False, False, True)[0], 'FAIL')

    def test_escape_or_unstopped_unit_always_fails(self):
        for k in ('ran-ok', 'ran-refused'):
            self.assertEqual(q2.verdict('refused-or-confined', k, False, True, True)[0], 'FAIL')
            self.assertEqual(q2.verdict('refused-or-confined', k, False, False, False)[0], 'FAIL')

    def test_status_parsing(self):
        p = lambda raw, j='': q2.parse_run_summary(f'Finished with result: exit-code\nMain processes terminated with: code=exited/status={raw}\n', j)
        self.assertEqual(p('1/FAILURE')['status'], 1)
        self.assertEqual(p('0/SUCCESS')['status'], 0)
        self.assertEqual(p('SUCCESS')['status'], 0)
        self.assertEqual(p('FAILURE', 'x.service: Main process exited, code=exited, status=1/FAILURE')['status'], 1)
        self.assertEqual(p('FAILURE')['status'], 'FAILURE')                    # unknown form stays non-numeric -> unclassified
        self.assertEqual(kind(1, p('FAILURE'), q2.MARKER), 'unclassified')
        self.assertIsNone(q2.parse_run_summary('Running as unit: x.service\n'))


class FixtureMap(unittest.TestCase):
    def test_exact_map_accepted(self):
        q2.validate_fixture_map(good_map([['db/x', '0', '', 420]]))

    def test_empty_or_malformed_maps_refused(self):
        m = good_map([['db/x', '0', '', 420]])
        bad = [{}, {'format': q2.FIXTURE_FORMAT, 'fixtures': {}}, dict(m, format='enclave-guest-qualification-fixtures/r1')]
        drop = json.loads(json.dumps(m)); del drop['fixtures']['hardlink-rel']; bad.append(drop)
        extra = json.loads(json.dumps(m)); extra['fixtures']['bonus'] = dict(m['fixtures']['good'], file='bonus.tar.zst'); bad.append(extra)
        wrong = json.loads(json.dumps(m)); wrong['fixtures']['traversal']['expect'] = 'extracted-exact'; bad.append(wrong)
        sha = json.loads(json.dumps(m)); sha['fixtures']['good']['sha256'] = 'zz'; bad.append(sha)
        nomem = json.loads(json.dumps(m)); nomem['fixtures']['abs-path']['members'] = []; bad.append(nomem)
        gout = json.loads(json.dumps(m)); del gout['goodOutputs']['db/lock']; bad.append(gout)
        for b in bad:
            with self.assertRaises(q2.Refuse):
                q2.validate_fixture_map(b)


class Preconditions(unittest.TestCase):
    """run() with systemd/base/zstd/sha256 mocked: refusals happen BEFORE any scratch side effect"""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix='q2logic-')); self.addCleanup(lambda: subprocess.run(['rm', '-rf', str(self.d)]))
        self.tar = tiny_tar(); self.members = q2.tar_members(self.tar)
        (self.d / 'unit.service').write_text('[Service]\nExecStart=/x\nReadWritePaths=/y\n' +
                                              ''.join(f'{k}={v}\n' for k, v in q2.REQUIRED_SANDBOX.items()))
        (self.d / 'fixtures.json').write_text(json.dumps(good_map(self.members)))
        self.analyze_rc, self.version_rc, self.version_out, self.zstd_out = 0, 0, 'base 1.5.1\n', self.tar
        self.args = mock.Mock(candidate_unit=str(self.d / 'unit.service'), candidate_unit_sha256='U', base_bin='/opt/base',
                              base_bin_sha256='B', fixtures_dir=str(self.d), fixtures_json_sha256='F', zstd='/usr/bin/zstd',
                              scratch='/srv/enclave-base-holder/tmp/gsq-r2/run', datadir='/nonexistent', case_timeout=300)

    def fake_sha(self, p):
        p = str(p)
        return {'unit.service': 'U', 'fixtures.json': 'F'}.get(os.path.basename(p), 'B' if p == '/opt/base' else H)

    def fake_run(self, cmd, **kw):
        if cmd[0] == '/usr/bin/zstd':
            return subprocess.CompletedProcess(cmd, 0, self.zstd_out, b'')
        if cmd[0] == q2.ANALYZE:
            return subprocess.CompletedProcess(cmd, self.analyze_rc, '', 'verify output')
        if cmd[1:] == ['--version']:
            return subprocess.CompletedProcess(cmd, self.version_rc, self.version_out, '')
        raise AssertionError(f'unexpected command {cmd}')

    def run_q2(self):
        class Reached(Exception):
            pass
        with mock.patch.object(q2, 'sha256', self.fake_sha), mock.patch.object(q2.subprocess, 'run', self.fake_run), \
                mock.patch.object(q2.os, 'getuid', return_value=0), mock.patch.object(q2.os, 'makedirs', side_effect=Reached), \
                mock.patch.object(q2.os.path, 'lexists', return_value=False):
            try:
                q2.run(self.args)
            except Reached:
                return 'preconditions-passed'

    def test_all_preconditions_pass_reaches_scratch_creation(self):
        self.assertEqual(self.run_q2(), 'preconditions-passed')

    def test_systemd_analyze_failure_refuses(self):                         # r1 recorded the rc but ignored it
        self.analyze_rc = 1
        with self.assertRaisesRegex(q2.Refuse, 'systemd-analyze verify failed'):
            self.run_q2()

    def test_base_version_failure_refuses(self):                            # r1 recorded the rc but ignored it
        self.version_rc = 127
        with self.assertRaisesRegex(q2.Refuse, 'base --version failed'):
            self.run_q2()
        self.version_rc, self.version_out = 0, ''
        with self.assertRaisesRegex(q2.Refuse, 'base --version failed'):
            self.run_q2()

    def test_decoy_must_match_the_scratch_run(self):
        self.args.scratch = '/srv/enclave-base-holder/tmp/gsq-r2/other-run'
        with self.assertRaisesRegex(q2.Refuse, 'another decoy path'):
            self.run_q2()

    def test_fixture_members_must_match_the_map(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as tf:
            ti = tarfile.TarInfo('db/other'); ti.size = 0; tf.addfile(ti, io.BytesIO(b''))
        self.zstd_out = buf.getvalue()
        with self.assertRaisesRegex(q2.Refuse, 'members differ'):
            self.run_q2()


class OwnedUnitStop(unittest.TestCase):
    def test_active_owned_unit_is_stopped_and_verified(self):
        states = iter([{'ActiveState': 'active', 'MainPID': '42', 'LoadState': 'loaded'},
                       {'ActiveState': 'inactive', 'MainPID': '0', 'LoadState': 'loaded'}])
        calls = []
        with mock.patch.object(q2, 'unit_state', lambda u: next(states)), \
                mock.patch.object(q2.subprocess, 'run', lambda cmd, **kw: calls.append(cmd)):
            ok, ev = q2.ensure_stopped('gsq-r2-t-x.service', after_timeout=True)
        self.assertTrue(ok); self.assertEqual(calls, [[q2.SYSTEMCTL, 'stop', 'gsq-r2-t-x.service']])

    def test_unit_that_cannot_be_verified_stopped_is_reported(self):
        calls = []
        with mock.patch.object(q2, 'unit_state', lambda u: {'ActiveState': 'deactivating', 'MainPID': '42', 'LoadState': 'loaded'}), \
                mock.patch.object(q2.subprocess, 'run', lambda cmd, **kw: calls.append(cmd)), mock.patch.object(q2.time, 'sleep'):
            ok, ev = q2.ensure_stopped('gsq-r2-t-y.service', after_timeout=True)
        self.assertFalse(ok); self.assertEqual(len(calls), 1)            # only our unit, stopped once; the caller ABORTS the run

    def test_unloaded_or_inactive_needs_no_stop(self):
        for st in ({'LoadState': 'not-found'}, {'LoadState': 'loaded', 'ActiveState': 'failed', 'MainPID': '0'}):
            with mock.patch.object(q2, 'unit_state', lambda u, st=st: st), \
                    mock.patch.object(q2.subprocess, 'run', side_effect=AssertionError('no stop expected')):
                self.assertTrue(q2.ensure_stopped('gsq-r2-t-z.service', after_timeout=False)[0])


class Sandbox(unittest.TestCase):
    def test_weakened_candidate_refused_and_properties_kept_in_order(self):
        props = q2.service_properties('[Unit]\nX=1\n[Service]\nA=1\nA=2\nProtectSystem=strict\n')
        self.assertEqual(props, [('A', '1'), ('A', '2'), ('ProtectSystem', 'strict')])
        with self.assertRaises(q2.Refuse):
            q2.check_sandbox(props + [('ExecStart', '/x'), ('ReadWritePaths', '/y')])


if __name__ == '__main__':
    unittest.main(verbosity=2)
