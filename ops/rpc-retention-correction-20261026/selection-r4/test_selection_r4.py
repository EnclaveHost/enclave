"""selection-r4 offline tests (python3 -I -m unittest -v test_selection_r4). The REAL pinned manifest (sha 1f0c4e6c) is read only;
datadirs are temp dirs with SPARSE files. Nothing touches a guest, a unit, the network, activation-r2 or selection-r3."""
import copy, datetime, hashlib, importlib.util, io, json, os, pathlib, re, sys, tempfile, unittest
sys.dont_write_bytecode = True                # never write __pycache__ into the frozen r2/r3 or this stage
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
R2, R3 = HERE.parent / 'activation-r2', HERE.parent / 'selection-r3'
REAL = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json')
INV = 'c67c9c6b227a4a4fbc5feddf9d91a2c7'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


PF = load('pf_r4', HERE / 'retention_preflight.py')
VC = load('vc_r4', HERE / 'verify_retention_completion.py')
PF3 = load('pf_r3', R3 / 'cached_download_preflight.py')         # frozen r3, read only: the boundary formula must be unchanged
RAW = REAL.read_bytes()
M = json.loads(RAW)
LIVE_ARGV = re.search(r'^ExecStart=(.*)$', (R2 / 'enclave-base-retention.service').read_text(), re.M).group(1).split()


def sparse(datadir, archives, skip=lambda a: False, delta=0):
    for a in archives:
        if skip(a):
            continue
        for o in a['outputs']:
            p = os.path.join(datadir, o['path']); os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.truncate(o['size'] + delta)


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.root = self.t.name; self.dd = os.path.join(self.root, 'data'); os.makedirs(self.dd)
        self.hist = PF.history_plan(M, 48_000_000, 52_500_000); self.heads = PF.header_archives(M); self.st = PF.state_component(M)

    def tearDown(self):
        self.t.cleanup()

    def rep(self, raw=RAW, free=4 * 10 ** 12):
        return PF.report(raw, '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', self.dd, 48_000_000, 52_500_000, 30, free, 16)


class Preflight(Base):
    def test_boundary_formula_is_r3s_and_the_pinned_selection_is_30(self):
        c = M['components']['transactions']
        for since in (1, 47_999_999, 48_000_000, 48_000_001, 48_322_938, 52_500_000, 52_515_705, 53_048_526):
            self.assertEqual(PF.first_chunk(c, since, M['block']), PF3.first_chunk(c, since, M['block']), since)
        self.assertEqual(len(self.hist), 30)
        self.assertEqual([f"{x['component']}:{x['chunk']}" for x in self.hist if x['belowDeclaredFloor']],
                         ['transactions:95', 'receipts:95', 'account_changesets:104', 'storage_changesets:104'])
        for bad in ((0, 52_500_000), (53_048_527, 52_500_000), (True, 1)):
            with self.assertRaises(ValueError):
                PF.history_plan(M, *bad)

    def test_same_size_changed_db_is_refused_not_reused(self):
        sparse(self.dd, self.hist + self.heads); sparse(self.dd, [self.st])           # every output at its EXACT manifest size
        r = self.rep()
        self.assertFalse(r['admitted']); self.assertNotIn('command', r)
        self.assertTrue(any('DELETE it before re-downloading' in x for x in r['refusals']))
        self.assertEqual(sorted(r['state']['existingDbTraces']), sorted(o['path'] for o in self.st['outputs']))

    def test_partial_db_traces_are_refused(self):
        for make in (lambda: open(os.path.join(self.dd, 'db', 'lock'), 'w').close(),
                     lambda: open(os.path.join(self.dd, 'db', 'unexpected.bin'), 'w').close(),
                     lambda: os.makedirs(os.path.join(self.dd, 'db', 'sub')),
                     lambda: open(os.path.join(self.dd, '.download-cache', 'state.tar.zst.part'), 'w').close()):
            self.tearDown(); self.setUp()
            os.makedirs(os.path.join(self.dd, 'db'), exist_ok=True); os.makedirs(os.path.join(self.dd, '.download-cache'), exist_ok=True)
            make(); r = self.rep()
            self.assertFalse(r['admitted']); self.assertTrue(r['state']['existingDbTraces'])

    def test_the_live_situation_counts_23_pending_and_is_refused(self):
        sparse(self.dd, self.hist + self.heads, skip=lambda a: a['component'] != 'headers' and a['chunk'] < 105)
        sparse(self.dd, [self.st], delta=4096)                                         # a finalized DB: sizes changed
        r = self.rep()
        self.assertFalse(r['admitted'])
        self.assertEqual((r['history']['sizeMissing']['archives'], r['headers']['sizeMissing']['archives'], r['state']['mandatoryNeed']['archives']), (22, 0, 1))
        self.assertEqual(r['cliWouldPlanPending']['archives'], 23)
        self.assertEqual((r['cliWouldPlanPending']['compressedBytes'], r['cliWouldPlanPending']['extractedBytes']),
                         (256_149_630_611 + 761_228_785_915, 490_033_101_074 + 1_138_167_361_549))

    def test_empty_datadir_admits_with_state_headers_history_counted(self):
        r = self.rep(free=10 ** 13)
        self.assertTrue(r['admitted'], r['refusals'])
        self.assertEqual(r['command'], PF.command(self.dd, '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', 48_000_000, 52_500_000, 16))
        self.assertEqual(PF.command('/srv/enclave-base-holder/data', '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', 48_000_000, 52_500_000, 16), LIVE_ARGV)
        self.assertEqual((r['state']['mandatoryNeed']['archives'], r['headers']['sizeMissing']['archives'], r['history']['sizeMissing']['archives']), (1, 107, 30))
        p = r['cliWouldPlanPending']
        self.assertEqual(r['needBytes'], p['compressedBytes'] + p['extractedBytes'] + r['indexReserveBytes'] + r['growthReserveBytes'])
        self.assertGreaterEqual(r['indexReserveBytes'], PF.MIN_INDEX_RESERVE)
        self.assertIn('NOT integrity', r['integrity']); self.assertIn('NOT readiness', r['readiness'])
        self.assertEqual(r['declaredFloor'], {'history': 48_000_000, 'stateHistory': 52_500_000})
        self.assertFalse(self.rep(free=r['needBytes'] - 1)['admitted'])

    def test_unreviewed_or_state_less_manifest_is_refused(self):
        m = copy.deepcopy(M); m['components'].pop('state')
        r = self.rep(raw=json.dumps(m).encode(), free=10 ** 13)
        self.assertFalse(r['admitted']); self.assertNotIn('command', r)
        self.assertTrue(any('reviewed provenance' in x for x in r['refusals']))
        self.assertTrue(any('declares no state' in x for x in r['refusals']))
        m2 = copy.deepcopy(M); m2['components']['transactions']['chunk_sizes'].pop()
        out = io.StringIO()
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(m2, f)
        try:
            with redirect_stdout(out):
                rc = PF.main(['--manifest', f.name, '--datadir', self.dd, '--history-from', '48000000', '--state-history-from', '52500000', '--free-bytes', '1'])
        finally:
            os.unlink(f.name)
        self.assertEqual(rc, 3)

    def test_docs_correct_the_false_deletion_claim(self):
        doc = PF.__doc__
        self.assertIn('cleanup_outputs', doc); self.assertIn('is FALSE', doc)
        self.assertNotRegex(doc, r'(?i)nothing re-downloaded')


class Completion(Base):
    def unit(self, **kw):
        u = {'ActiveState': 'inactive', 'SubState': 'dead', 'Result': 'success', 'ExecMainStatus': '0', 'ExecMainCode': '1', 'MainPID': '0',
             'InvocationID': INV, 'ExecMainStartTimestamp': 'Mon 2026-10-26 14:58:24 UTC',
             'ExecStart': '{ path=/opt/enclave-rpc/bin/base ; argv[]=' + ' '.join(LIVE_ARGV) + ' ; ignore_errors=no ; start_time=[n/a] ; pid=110490 ; code=exited ; status=0 }'}
        u.update(kw); return u

    def full(self, marker=True, **mk):
        sparse(self.dd, self.hist + self.heads); sparse(self.dd, [self.st], delta=4096)   # finalized DB: other sizes, still present
        if marker:
            rec = {'format': 'enclave-base-retention-complete/v1', 'manifestSha256': PF.PINNED_MANIFEST_SHA256, 'baseBinarySha256': 'ab' * 32,
                   'historyFrom': 48_000_000, 'stateHistoryFrom': 52_500_000, 'archives': 26, 'argv': LIVE_ARGV,
                   'completedAt': '2026-10-27T09:00:00+00:00'}
            rec.update(mk)
            p = os.path.join(self.root, 'retention-complete'); open(p, 'w').write(json.dumps(rec)); os.chmod(p, 0o444)

    def run_v(self, u, inv=INV):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = VC.main(['--invocation', inv, '--manifest', str(REAL), '--root', self.root, '--marker-uid', str(os.getuid()), '--unit-json', json.dumps(u)])
        return rc, json.loads(out.getvalue())

    def tree(self):
        return sorted((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in pathlib.Path(self.root).rglob('*'))

    def test_successful_exact_invocation_with_marker_is_complete_and_read_only(self):
        self.full(); before = self.tree(); rc, r = self.run_v(self.unit())
        self.assertEqual((rc, r['jobComplete']), (0, True), r)
        self.assertTrue(r['state']['mdbxDatPresent']); self.assertFalse(r['state']['outputs']['db/mdbx.dat']['matchesManifestSize'])
        self.assertIn('NOT the full selection', r['marker']['scope']); self.assertIn('NOT integrity', r['history']['integrity'])
        self.assertEqual(self.tree(), before)

    def test_failed_or_other_invocation_is_never_complete_even_with_all_sizes(self):
        self.full()
        for u, inv in ((self.unit(ActiveState='failed', Result='exit-code', ExecMainStatus='1'), INV),
                       (self.unit(Result='signal', ExecMainStatus='9'), INV), (self.unit(), 'ff' * 16),
                       (self.unit(InvocationID='ee' * 16), INV),
                       (self.unit(ExecStart='{ path=/opt/enclave-rpc/bin/base ; argv[]=' + ' '.join(LIVE_ARGV + ['--force']) + ' ; }'), INV)):
            rc, r = self.run_v(u, inv)
            self.assertEqual((rc, r['jobComplete']), (1, False)); self.assertFalse(r['terminal']['ok'])
            self.assertTrue(r['history']['ok'])                                           # sizes present, still not complete

    def test_running_unit_is_refused(self):
        self.full(); rc, r = self.run_v(self.unit(ActiveState='activating', SubState='start', MainPID='110490'))
        self.assertEqual(rc, 2)

    def test_marker_must_be_exact_and_after_the_invocation_start(self):
        for mk in ({'manifestSha256': '00' * 32}, {'argv': LIVE_ARGV[:-1]}, {'archives': 30}, {'historyFrom': 47_500_000},
                   {'completedAt': '2026-10-26T14:00:00+00:00'}, {'completedAt': '2026-10-27T09:00:00'}, {'format': 'x'}):
            self.tearDown(); self.setUp(); self.full(**mk)
            rc, r = self.run_v(self.unit())
            self.assertEqual((rc, r['jobComplete'], r['marker']['ok']), (1, False, False), mk)
        self.tearDown(); self.setUp(); self.full(marker=False); rc, r = self.run_v(self.unit())
        self.assertFalse(r['jobComplete']); self.assertFalse(r['marker']['ok'])
        self.tearDown(); self.setUp(); self.full(); os.chmod(os.path.join(self.root, 'retention-complete'), 0o644)
        self.assertFalse(self.run_v(self.unit())[1]['marker']['ok'])

    def test_history_and_state_are_separate_requirements(self):
        self.full(); os.unlink(os.path.join(self.dd, 'db', 'mdbx.dat'))
        rc, r = self.run_v(self.unit())
        self.assertEqual((r['jobComplete'], r['state']['ok'], r['history']['ok']), (False, False, True))
        self.tearDown(); self.setUp(); self.full()
        a = next(x for x in self.hist if x['belowDeclaredFloor'])
        os.unlink(os.path.join(self.dd, a['outputs'][0]['path']))
        rc, r = self.run_v(self.unit())
        self.assertEqual((r['jobComplete'], r['history']['belowDeclaredFloor']['missing'], r['state']['ok']), (False, 1, True))


class Frozen(unittest.TestCase):
    def test_r2_and_r3_unchanged(self):
        for d in (R2, R3):
            for line in (d / 'SHA256SUMS').read_text().splitlines():
                h, p = line.split(None, 1)
                self.assertEqual(hashlib.sha256((d / p.strip()).read_bytes()).hexdigest(), h, (d, p))


if __name__ == '__main__':
    unittest.main()
