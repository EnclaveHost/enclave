"""rpc/snp/base_history_patch.py against the shipped guest chain_service.py lineage.

python3 -m unittest test/rpc-snp/test_base_history_patch.py
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
import l1_identity_patch as L  # noqa: E402

SEED = ROOT/'ops/rpc-backend-bootstrap/2026-10-25/chain_service.py'
# Base's persisted profile on prod r11 (reth.toml, 2026-11-06).
PROFILE = {'prune': {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {
    'sender_recovery': 'full', 'transaction_lookup': {'before': 48000000}, 'receipts': {'before': 48000000},
    'account_history': {'before': 52500000}, 'storage_history': {'before': 52500000}, 'bodies_history': {'before': 48000000}}},
    'static_files': {'blocks_per_file': {k: 500000 for k in ('headers', 'transactions', 'receipts', 'transaction_senders',
                                                             'account_change_sets', 'storage_change_sets')}}}
KEEP = {'_uint', '_before_args', 'prune_args', 'segment_files_present', 'history_files_present', 'base_history_floor'}


def lineage(tmp, history=True):
    s = SEED.read_text().replace("'--l1-beacon', 'http://127.0.0.1:15052'", "'--l1-beacon', 'http://127.0.0.1:15053'")
    p = Path(tmp, 'chain_service%s.py' % ('' if history else '-before'))
    p.write_text(s)
    for m in (L, P, M) + ((H,) if history else ()):
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


class Patched(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = lineage(self.tmp.name)
        self.old = functions(lineage(self.tmp.name, history=False))
        self.new = functions(self.src)
        self.datadir = Path(self.tmp.name, 'data')
        (self.datadir/'static_files').mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def files(self, first, last, segments=('headers', 'receipts', 'transactions')):
        for seg in segments:
            for start in range(first, last + 1, 500000):
                for ext in ('', '.off', '.conf'):
                    (self.datadir/'static_files'/('static_file_%s_%d_%d%s' % (seg, start, start + 499999, ext))).touch()

    def floor(self, configured=48000000):
        return self.new['base_history_floor'](str(self.datadir), PROFILE, configured)

    def test_compiles_and_calls_in_place(self):
        compile(self.src, 'chain_service.py', 'exec')
        run = self.src[self.src.index('def run(side):'):]
        self.assertLess(run.index('base_history_floor(datadir, profile, history_from)'), run.index('prune = prune_args('))
        self.assertIn('history_files_present(datadir, profile, base_history_floor(datadir, profile, history_from))', run)
        self.assertEqual(self.src.count('base_history_floor('), 3)   # def, prune path, start check
        self.assertEqual(self.new['BASE_HISTORY_WINDOW'], 7000000)

    def test_floor_today_is_the_reviewed_block(self):
        self.files(48000000, 54500000)
        self.assertEqual(self.floor(), 48000000)

    def test_floor_rolls_by_whole_files(self):
        self.files(48000000, 55500000)
        self.assertEqual(self.floor(), 48500000)
        self.files(55500000, 56000000, ('headers',))
        self.assertEqual(self.floor(), 49000000)
        self.assertEqual(self.floor(configured=49600000), 49600000)

    def test_first_start_prunes_nothing_new(self):
        self.assertEqual(self.new['prune_args'](PROFILE, 48000000, 52500000), self.old['prune_args'](PROFILE, 48000000, 52500000))

    def test_advanced_floor_moves_history_not_state(self):
        args = self.new['prune_args'](PROFILE, 49000000, 52500000)
        pairs = {a: args[i + 1] for i, a in enumerate(args) if a.endswith('.before')}
        for seg in ('receipts', 'bodies', 'transaction-lookup'):
            self.assertEqual(pairs['--prune.%s.before' % seg], '49000000')
        for seg in ('account-history', 'storage-history'):
            self.assertEqual(pairs['--prune.%s.before' % seg], '52500000')
        self.assertEqual(sorted(a for a in args if a.startswith('--')),
                         sorted(a for a in self.old['prune_args'](PROFILE, 48000000, 52500000) if a.startswith('--')))

    def test_persisted_floor_above_the_window_refuses(self):
        later = {**PROFILE, 'prune': {**PROFILE['prune'], 'segments': {**PROFILE['prune']['segments'], 'receipts': {'before': 49500000}}}}
        with self.assertRaises(AssertionError):
            self.new['prune_args'](later, 49000000, 52500000)

    def test_start_check_follows_the_floor(self):
        self.files(48500000, 55500000)   # a previous run pruned the 48000000 files
        floor = self.floor()
        self.assertEqual(floor, 48500000)
        self.new['history_files_present'](str(self.datadir), PROFILE, floor)
        with self.assertRaises(AssertionError):
            self.new['history_files_present'](str(self.datadir), PROFILE, 48000000)

    def test_refusals(self):
        with self.assertRaises(AssertionError):
            self.floor()   # no headers static files
        self.files(48000000, 54500000)
        odd = {'static_files': {'blocks_per_file': {'headers': 500000, 'receipts': 500000, 'transactions': 250000}}}
        with self.assertRaises(AssertionError):
            self.new['base_history_floor'](str(self.datadir), odd, 48000000)
        p = Path(self.tmp.name, 'other.py')
        p.write_text('import re\ndef run(side):\n    pass\n')
        with self.assertRaises(SystemExit):
            H.patch(str(p))


if __name__ == '__main__':
    unittest.main()
