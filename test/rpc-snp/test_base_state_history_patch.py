"""rpc/snp/base_state_history_patch.py against the shipped guest chain_service.py lineage.

python3 -m unittest test/rpc-snp/test_base_state_history_patch.py
"""
import ast
from pathlib import Path
import pathlib
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import base_history_patch as H  # noqa: E402
import base_merkle_patch as M  # noqa: E402
import base_restart_patch as P  # noqa: E402
import base_state_history_patch as S  # noqa: E402
import l1_identity_patch as L  # noqa: E402

SEED = ROOT/'ops/rpc-backend-bootstrap/2026-10-25/chain_service.py'
# Base's persisted profile on prod r15 (reth.toml read from the chain disk, 2026-11-24): history at the floor the
# weekly restart last set, state history still at the configured block.
PROFILE = {'prune': {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {
    'sender_recovery': 'full', 'transaction_lookup': {'before': 54500000}, 'receipts': {'before': 54500000},
    'account_history': {'before': 52500000}, 'storage_history': {'before': 52500000}, 'bodies_history': {'before': 54500000}}},
    'static_files': {'blocks_per_file': {k: 500000 for k in ('headers', 'transactions', 'receipts', 'transaction_senders',
                                                             'account_change_sets', 'storage_change_sets')}}}
KEEP = {'_uint', '_before_args', 'prune_args', 'segment_files_present', 'history_files_present', 'base_history_floor',
        'base_state_history_floor'}
STATE = ('account-change-sets', 'storage-change-sets')


def lineage(tmp, state=True):
    s = SEED.read_text().replace("'--l1-beacon', 'http://127.0.0.1:15052'", "'--l1-beacon', 'http://127.0.0.1:15053'")
    p = Path(tmp, 'chain_service%s.py' % ('' if state else '-before'))
    p.write_text(s)
    for m in (L, P, M, H) + ((S,) if state else ()):
        m.patch(str(p))
    return p.read_text()


def literal(node):
    try:
        ast.literal_eval(node)
        return True
    except ValueError:
        return False


def functions(src):
    tree = ast.parse(src)
    keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in KEEP) or
            (isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and n.targets[0].id.isupper() and literal(n.value))]
    env = {'pathlib': pathlib, 're': re}
    exec(compile(ast.Module(keep, []), 'chain_service.py', 'exec'), env)
    return env


def befores(args):
    return {a: args[i + 1] for i, a in enumerate(args) if a.endswith('.before')}


class Patched(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = lineage(self.tmp.name)
        self.old = functions(lineage(self.tmp.name, state=False))
        self.new = functions(self.src)
        self.datadir = Path(self.tmp.name, 'data')
        (self.datadir/'static_files').mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def files(self, first, last, segments=('headers',) + STATE):
        for seg in segments:
            for start in range(first, last + 1, 500000):
                for ext in ('', '.off', '.conf'):
                    (self.datadir/'static_files'/('static_file_%s_%d_%d%s' % (seg, start, start + 499999, ext))).touch()

    def floor(self, configured=52500000):
        return self.new['base_state_history_floor'](str(self.datadir), PROFILE, configured)

    def test_compiles_and_calls_in_place(self):
        compile(self.src, 'chain_service.py', 'exec')
        run = self.src[self.src.index('def run(side):'):]
        self.assertLess(run.index('base_state_history_floor(datadir, profile, state_from)'), run.index('prune = prune_args('))
        self.assertIn('segment_files_present(datadir, profile, base_state_history_floor(datadir, profile, state_from), STATE_FILES)', run)
        self.assertEqual(self.src.count('base_state_history_floor('), 3)   # def, prune path, start check
        self.assertEqual(self.new['BASE_STATE_HISTORY_WINDOW'], 7000000)
        self.assertEqual(self.new['BASE_STATE_HISTORY_WINDOW'], self.new['BASE_HISTORY_WINDOW'])
        # the snapshot check still compares the configured block, not the floor
        self.assertIn('history_from <= snap and state_from <= snap', run)
        self.assertLess(run.index('state_from = state_history_from_block(CONFIG)\n'), run.index('state_from <= snap'))

    def test_needs_the_history_patch_first(self):
        p = Path(self.tmp.name, 'bare.py')
        p.write_text(SEED.read_text())
        with self.assertRaises(SystemExit):
            S.patch(str(p))
        with self.assertRaises(SystemExit):   # and not twice
            q = Path(self.tmp.name, 'twice.py')
            q.write_text(self.src)
            S.patch(str(q))

    def test_floor_never_below_the_configured_block(self):
        self.files(52500000, 59000000)   # tip 6.5M above the configured block: inside the window
        self.assertEqual(self.floor(), 52500000)

    def test_floor_on_production_today(self):
        self.files(52500000, 61500000)   # the chain disk on 2026-11-24: headers and changesets to 61,999,999
        self.assertEqual(self.floor(), 54500000)

    def test_the_window_holds_the_anchor_until_the_next_weekly_restart(self):
        # 2026-11-25: anchor 2,184,313 blocks behind the tip; a week of Base is 3,024,000 blocks
        self.files(52500000, 61500000)
        floor, tip = self.floor(), 61878673
        self.assertLessEqual(floor, tip - 2184313)                 # the anchor of the day the floor is set
        # a week later, just before the next restart, an anchor that old is still above the same floor, with margin
        self.assertGreaterEqual((tip + 3024000 - 2184313 - 3024000) - floor, 1000000)
        self.assertGreaterEqual(7000000 - (2184313 + 3024000 + 500000), 1000000)   # age, a week, file rounding

    def test_floor_rolls_by_whole_files_and_respects_a_later_configured_block(self):
        self.files(52500000, 61500000)
        self.files(62000000, 62000000, ('headers',))
        self.assertEqual(self.floor(), 55000000)
        self.assertEqual(self.floor(configured=55200000), 55200000)

    def test_unequal_changeset_file_sizes_refuse(self):
        self.files(52500000, 61500000)
        odd = {**PROFILE, 'static_files': {'blocks_per_file': {**PROFILE['static_files']['blocks_per_file'], 'account_change_sets': 250000}}}
        with self.assertRaises(AssertionError):
            self.new['base_state_history_floor'](str(self.datadir), odd, 52500000)

    def test_without_headers_refuses(self):
        with self.assertRaises(AssertionError):
            self.floor()

    def test_same_flags_while_the_floor_is_the_configured_block(self):
        self.assertEqual(self.new['prune_args'](PROFILE, 54500000, 52500000), self.old['prune_args'](PROFILE, 54500000, 52500000))

    def test_advanced_floor_moves_state_history_only(self):
        args = self.new['prune_args'](PROFILE, 54500000, 55000000)
        pairs = befores(args)
        for seg in ('account-history', 'storage-history'):
            self.assertEqual(pairs['--prune.%s.before' % seg], '55000000')
        for seg in ('receipts', 'bodies', 'transaction-lookup'):
            self.assertEqual(pairs['--prune.%s.before' % seg], '54500000')
        self.assertEqual(sorted(a for a in args if a.startswith('--')),
                         sorted(a for a in self.old['prune_args'](PROFILE, 54500000, 52500000) if a.startswith('--')))

    def test_persisted_floor_above_the_window_refuses(self):
        later = {**PROFILE, 'prune': {**PROFILE['prune'], 'segments': {**PROFILE['prune']['segments'], 'storage_history': {'before': 55500000}}}}
        with self.assertRaises(AssertionError):
            self.new['prune_args'](later, 54500000, 55000000)

    def test_start_check_follows_the_floor(self):
        self.files(54500000, 61500000)   # a previous run pruned everything below the floor
        floor = self.floor()
        self.assertEqual(floor, 54500000)
        self.new['segment_files_present'](str(self.datadir), PROFILE, floor, self.new['STATE_FILES'])
        with self.assertRaises(AssertionError):
            self.new['segment_files_present'](str(self.datadir), PROFILE, 52500000, self.new['STATE_FILES'])

    def test_start_check_refuses_a_missing_floor_file(self):
        self.files(54500000, 61500000, ('headers', 'account-change-sets'))
        self.files(55000000, 61500000, ('storage-change-sets',))
        with self.assertRaises(AssertionError):
            self.new['segment_files_present'](str(self.datadir), PROFILE, self.floor(), self.new['STATE_FILES'])


if __name__ == '__main__':
    unittest.main()
