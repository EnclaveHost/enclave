"""selection-r3 offline tests (python3 -I -m unittest -v test_selection_r3): reth 7134be3's exact Since selection, invalid inputs, the
REAL pinned manifest (sha 1f0c4e6c, read only) with SPARSE outputs at its exact sizes, the unchanged live command and r2 files, and the
read-only full-selection verifier. Nothing here touches a guest, the network, or activation-r2."""
import copy, hashlib, importlib.util, io, json, os, pathlib, re, tempfile, unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
R2 = HERE.parent / 'activation-r2'
REAL = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json')
REAL_SHA = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


PF = load('pf_r3', HERE / 'cached_download_preflight.py')
VF = load('vf_r3', HERE / 'verify_full_selection.py')
G2 = load('rg_r2', R2 / 'retention_guard.py')            # read only: its pinned 26-archive selection, never executed against a guest


def chunk(n, total, bpf, key):
    return {'total_blocks': total, 'blocks_per_file': bpf, 'chunk_sizes': [10 + i for i in range(n)],
            'chunk_decompressed_sizes': [20 + i for i in range(n)], 'chunk_files': [f'{key}-{i}.tar.zst' for i in range(n)],
            'chunk_output_files': [[{'path': f'static_files/{key}_{i}', 'size': 5 + i}] for i in range(n)]}


def synthetic(block=53_048_526, total=None, bpf=500_000):
    total = block if total is None else total
    n = -(-total // bpf)
    comps = {k: chunk(n, total, bpf, k) for k in ('headers', 'transactions', 'receipts', 'account_changesets', 'storage_changesets')}
    comps['state'] = {'file': 'state.tar.zst', 'size': 7, 'decompressed_size': 9, 'output_files': [{'path': 'db/mdbx.dat', 'size': 3}]}
    comps['rocksdb_indices'] = {'decompressed_size': 1000}
    return {'block': block, 'components': comps}


def sparse(datadir, archives, skip=lambda a: False):
    for a in archives:
        if skip(a):
            continue
        for o in a['outputs']:
            p = os.path.join(datadir, o['path']); os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.truncate(o['size'])


class Formula(unittest.TestCase):
    def first(self, m, name, since):
        return PF.first_chunk(m['components'][name], since, m['block'])

    def test_exact_boundary_selects_the_chunk_below(self):
        m = synthetic()                                   # total_blocks == block, as in the pinned manifest
        self.assertEqual(self.first(m, 'transactions', 48_000_000), 95)
        self.assertEqual(self.first(m, 'storage_changesets', 52_500_000), 104)
        p = PF.plan(m, 48_000_000, 52_500_000)
        self.assertEqual({k: (v['firstChunk'], v['chunks'], v['legacyR2FirstChunk'], v['belowFloorChunks']) for k, v in p['selected'].items()},
                         {'transactions': (95, 12, 96, 1), 'receipts': (95, 12, 96, 1), 'account_changesets': (104, 3, 105, 1), 'storage_changesets': (104, 3, 105, 1)})

    def test_inclusive_distance_is_against_the_components_total_blocks(self):
        m = synthetic(total=53_048_527)                   # one more block: the boundary no longer pulls the chunk below
        self.assertEqual(self.first(m, 'transactions', 48_000_000), 96)
        self.assertEqual(self.first(m, 'account_changesets', 52_500_000), 105)

    def test_non_boundary_matches_floor_division(self):
        m = synthetic()
        for since in (48_322_938, 52_515_705, 48_000_001, 47_999_999):
            self.assertEqual(self.first(m, 'receipts', since), since // 500_000 if since % 500_000 else since // 500_000 - 1)
        p = PF.plan(m, 48_322_938, 52_515_705)
        self.assertTrue(all(v['belowFloorChunks'] == 0 and v['firstChunk'] == v['legacyR2FirstChunk'] for v in p['selected'].values()))

    def test_edges_snapshot_block_and_one(self):
        m = synthetic()
        self.assertEqual(self.first(m, 'transactions', 53_048_526), 106)       # distance 1 -> the partial tail chunk only
        self.assertEqual(self.first(m, 'transactions', 1), 0)                  # distance > total_blocks -> every chunk
        p = PF.plan(m, 53_048_526, 53_048_526)
        self.assertEqual({v['chunks'] for v in p['selected'].values()}, {1})

    def test_zero_future_and_non_integer_starts_refuse(self):
        m = synthetic()
        for h, s in ((0, 52_500_000), (48_000_000, 0), (53_048_527, 52_500_000), (48_000_000, 53_048_527), (-1, 1),
                     (True, 52_500_000), ('48000000', 52_500_000), (48e6, 52_500_000), (None, 52_500_000)):
            with self.assertRaises(ValueError, msg=(h, s)):
                PF.plan(m, h, s)

    def test_invalid_manifests_refuse(self):
        def mut(f):
            m = synthetic(); f(m); return m
        bad = [lambda m: m['components'].pop('receipts'), lambda m: m.update(block=0), lambda m: m.pop('block'),
               lambda m: m['components']['transactions'].update(blocks_per_file=0),
               lambda m: m['components']['transactions'].update(total_blocks=True),
               lambda m: m['components']['transactions'].update(total_blocks='53048526'),
               lambda m: m['components']['receipts']['chunk_sizes'].pop(),
               lambda m: m['components']['receipts']['chunk_files'].append('x'),
               lambda m: m['components']['account_changesets']['chunk_decompressed_sizes'].__setitem__(3, -1),
               lambda m: m['components']['storage_changesets']['chunk_output_files'][105][0].pop('size'),
               lambda m: m['components']['storage_changesets']['chunk_output_files'][105][0].update(path='/etc/x'),
               lambda m: m['components']['storage_changesets']['chunk_output_files'][105][0].update(path='a/../../x'),
               lambda m: m['components']['transactions']['chunk_output_files'].__setitem__(100, [])]
        for i, f in enumerate(bad):
            with self.assertRaises(ValueError, msg=i):
                PF.plan(mut(f), 48_000_000, 52_500_000)
        with self.assertRaises(ValueError):
            PF.plan([], 1, 1)
        with tempfile.TemporaryDirectory() as t:
            man = pathlib.Path(t, 'm.json'); man.write_text(json.dumps(mut(bad[0])))
            out = io.StringIO()
            with redirect_stdout(out):
                rc = PF.main(['--manifest', str(man), '--datadir', t, '--history-from', '48000000', '--state-history-from', '52500000', '--free-bytes', '1'])
            self.assertEqual(rc, 3); self.assertIn('input:', json.loads(out.getvalue())['refusal'])


class RealManifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = REAL.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == REAL_SHA, 'the real pinned manifest copy changed'
        cls.m = json.loads(raw)

    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.dd = os.path.join(self.t.name, 'data'); os.makedirs(self.dd)
        self.p = PF.plan(self.m, 48_000_000, 52_500_000)

    def tearDown(self):
        self.t.cleanup()

    def rep(self, free=2_696_017_272_832):
        return PF.report(self.m, self.dd, 48_000_000, 52_500_000, 30, free, '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', 16)

    def test_real_selection_is_30_and_the_at_or_above_floor_part_is_r2s_pinned_26(self):
        got = {}
        for a in self.p['archives']:
            got.setdefault(a['component'], []).append(a['chunk'])
        self.assertEqual(got, {'transactions': list(range(95, 107)), 'receipts': list(range(95, 107)),
                               'account_changesets': list(range(104, 107)), 'storage_changesets': list(range(104, 107))})
        above = {}
        for a in self.p['archives']:
            if not a['belowDeclaredFloor']:
                above.setdefault(a['component'], []).append(a['chunk'])
        self.assertEqual({k: (min(v), max(v)) for k, v in above.items()}, G2.EXPECTED_SELECTION)
        self.assertEqual(sum(len(v) for v in above.values()), G2.SELECTED_TOTAL)
        below = [(a['component'], a['chunk'], a['fromBlock'], a['toBlock']) for a in self.p['archives'] if a['belowDeclaredFloor']]
        self.assertEqual(below, [('transactions', 95, 47_500_000, 47_999_999), ('receipts', 95, 47_500_000, 47_999_999),
                                 ('account_changesets', 104, 52_000_000, 52_499_999), ('storage_changesets', 104, 52_000_000, 52_499_999)])

    def test_real_first_batch_worst_case_22_missing_and_reserves(self):
        sparse(self.dd, self.p['archives'], skip=lambda a: a['chunk'] < 105)
        sparse(self.dd, PF.cli_all_archives(self.m))
        r = self.rep()
        self.assertEqual((r['required']['archives'], r['missing']['archives']), (30, 22))
        self.assertEqual((r['missing']['compressedBytes'], r['missing']['extractedBytes']), (221_616_054_366 + 34_533_576_245, 409_990_674_216 + 80_042_426_858))
        self.assertEqual((r['belowDeclaredFloor']['archives'], r['belowDeclaredFloor']['compressedBytes'], r['belowDeclaredFloor']['extractedBytes']),
                         (4, 34_533_576_245, 80_042_426_858))
        self.assertEqual(r['belowDeclaredFloor']['missing']['archives'], 4)
        self.assertEqual(r['cliAlsoPlanned']['missing']['archives'], 0)              # headers and state reused, not counted
        self.assertEqual(r['cliAlsoPlanned']['byComponent'], {'headers': 107, 'state': 1})
        self.assertGreaterEqual(r['indexReserveBytes'], max(2 * 80_518_207_004, PF.MIN_INDEX_RESERVE))   # never below r2's reserve
        self.assertEqual(r['growthReserveBytes'], r['dailyGrowthBytes'] * 30)
        self.assertEqual(r['needBytes'], r['missing']['compressedBytes'] + r['missing']['extractedBytes'] + r['indexReserveBytes'] + r['growthReserveBytes'])
        self.assertEqual(r['headroomAfterBytes'], 2_696_017_272_832 - r['needBytes']); self.assertTrue(r['admitted'])
        self.assertFalse(self.rep(free=r['needBytes'] - 1)['admitted'])

    def test_real_after_the_r2_subset_only_the_4_below_floor_archives_are_missing(self):
        sparse(self.dd, self.p['archives'], skip=lambda a: a['belowDeclaredFloor']); sparse(self.dd, PF.cli_all_archives(self.m))
        r = self.rep()
        self.assertEqual((r['missing']['archives'], r['missing']['compressedBytes']), (4, 34_533_576_245))

    def test_header_or_state_output_absent_is_counted_not_assumed_reused(self):
        sparse(self.dd, self.p['archives']); allx = PF.cli_all_archives(self.m); sparse(self.dd, allx)
        self.assertEqual(self.rep()['missing']['archives'], 0)
        h = allx[50]; o = next(o for o in h['outputs'] if o['size'] > 0); os.truncate(os.path.join(self.dd, o['path']), o['size'] - 1)
        r = self.rep()
        self.assertEqual(r['cliAlsoPlanned']['missing'], {'archives': 1, 'compressedBytes': h['compressed'], 'extractedBytes': h['extracted']})

    def test_command_is_the_live_units_execstart_and_floors_are_declared_only(self):
        unit = (R2 / 'enclave-base-retention.service').read_text()
        live = re.search(r'^ExecStart=(.*)$', unit, re.M).group(1).split()
        r = self.rep()
        self.assertEqual(PF.command('/srv/enclave-base-holder/data', '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json', 48_000_000, 52_500_000, 16), live)
        self.assertEqual(r['declaredFloor'], {'history': 48_000_000, 'stateHistory': 52_500_000})
        self.assertIn('NOT readiness', r['readiness'])
        self.assertEqual({v['declaredFloor'] for v in r['selected'].values()}, {48_000_000, 52_500_000})

    def test_activation_r2_files_are_unchanged(self):
        for line in (R2 / 'SHA256SUMS').read_text().splitlines():
            h, p = line.split(None, 1)
            self.assertEqual(hashlib.sha256((R2 / p.strip()).read_bytes()).hexdigest(), h, p)


class Verifier(unittest.TestCase):
    INACTIVE = {'ActiveState': 'inactive', 'SubState': 'dead', 'Result': 'success', 'MainPID': '0'}

    @classmethod
    def setUpClass(cls):
        cls.m = json.loads(REAL.read_bytes()); cls.p = PF.plan(cls.m, 48_000_000, 52_500_000); cls.allx = PF.cli_all_archives(cls.m)

    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.root = self.t.name; self.dd = os.path.join(self.root, 'data'); os.makedirs(self.dd)

    def tearDown(self):
        self.t.cleanup()

    def run_v(self, state=None):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = VF.main(['--manifest', str(REAL), '--root', self.root, '--unit-state-json', json.dumps(state or self.INACTIVE)])
        return rc, json.loads(out.getvalue())

    def tree(self):
        return sorted((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in pathlib.Path(self.root).rglob('*'))

    def test_running_unit_or_wrong_manifest_refuses(self):
        rc, r = self.run_v({'ActiveState': 'activating', 'SubState': 'start', 'MainPID': '110490'})
        self.assertEqual(rc, 2); self.assertIn('still running', r['refusal'])
        bad = pathlib.Path(self.root, 'other.json'); bad.write_text('{}')
        out = io.StringIO()
        with redirect_stdout(out):
            rc = VF.main(['--manifest', str(bad), '--root', self.root, '--unit-state-json', json.dumps(self.INACTIVE)])
        self.assertEqual(rc, 2)

    def test_r2_subset_with_its_marker_is_not_complete(self):
        sparse(self.dd, self.p['archives'], skip=lambda a: a['belowDeclaredFloor']); sparse(self.dd, self.allx)
        pathlib.Path(self.root, 'retention-complete').write_text(json.dumps({'format': 'enclave-base-retention-complete/v1', 'archives': 26}))
        before = self.tree(); rc, r = self.run_v()
        self.assertEqual(rc, 1); self.assertFalse(r['complete'])
        self.assertEqual((r['selected'], r['selectedPresent'], r['atOrAboveFloor'], r['belowDeclaredFloor']['present']), (30, 26, {'selected': 26, 'present': 26}, 0))
        self.assertEqual(r['absentArchives'], ['transactions:95', 'receipts:95', 'account_changesets:104', 'storage_changesets:104'])
        self.assertEqual(r['r2Marker']['record']['archives'], 26); self.assertIn('NOT the full selection', r['r2Marker']['scope'])
        self.assertEqual(self.tree(), before)                                     # read-only

    def test_full_30_complete_and_a_wrong_size_is_partial(self):
        sparse(self.dd, self.p['archives']); sparse(self.dd, self.allx)
        before = self.tree(); rc, r = self.run_v()
        self.assertEqual((rc, r['complete'], r['selectedPresent'], r['cliAlsoPlannedMissing']), (0, True, 30, []))
        self.assertEqual(r['declaredFloor'], {'history': 48_000_000, 'stateHistory': 52_500_000}); self.assertIn('NOT readiness', r['readiness'])
        self.assertEqual(self.tree(), before)
        a = self.p['archives'][0]; o = next(o for o in a['outputs'] if o['size'] > 1); os.truncate(os.path.join(self.dd, o['path']), o['size'] - 1)
        rc, r = self.run_v()
        self.assertEqual(rc, 1); self.assertEqual(r['partialArchives'][0]['archive'], f"{a['component']}:{a['chunk']}")


if __name__ == '__main__':
    unittest.main()
