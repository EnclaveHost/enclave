"""rpc/snp/base_merkle_patch.py against the shipped guest chain_service.py lineage.

python3 -m unittest test/rpc-snp/test_base_merkle_patch.py
"""
import ast
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import base_merkle_patch as M  # noqa: E402
import base_restart_patch as P  # noqa: E402
import l1_identity_patch as L  # noqa: E402

SEED = ROOT/'ops/rpc-backend-bootstrap/2026-10-25/chain_service.py'
WANT = {'incremental_threshold': 2000, 'rebuild_threshold': 5000000}
# An excerpt of the Base snapshot's reth.toml as reth serialises it (reth's defaults).
SNAPSHOT = '''bootnodes = []

[stages.era]

[stages.execution]
max_blocks = 500000
max_changes = 5000000
max_cumulative_gas = 1500000000000
max_duration = "10m"

[stages.storage_hashing]
clean_threshold = 500000
commit_threshold = 100000
commit_entries = 30000000

[stages.merkle]
incremental_threshold = 7000
rebuild_threshold = 100000

[stages.transaction_lookup]
chunk_size = 5000000

[prune]
block_interval = 5
minimum_pruning_distance = 10064

[prune.segments]
sender_recovery = "full"

[prune.segments.receipts]
before = 48000000

[static_files.blocks_per_file]
headers = 500000
'''


def shipped(tmp):
    """The chain_service.py the image builds: seed, beacon sed, then build_image.py's patches in order."""
    s = SEED.read_text().replace("'--l1-beacon', 'http://127.0.0.1:15052'", "'--l1-beacon', 'http://127.0.0.1:15053'")
    p = Path(tmp, 'chain_service.py')
    p.write_text(s)
    L.patch(str(p))
    P.patch(str(p))
    M.patch(str(p))
    return p


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = shipped(self.tmp.name).read_text()
        self.datadir = Path(self.tmp.name, 'data')
        self.datadir.mkdir()
        tree = ast.parse(self.src)
        keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == 'base_merkle_config')
                or (isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'BASE_MERKLE_STAGE')]
        self.env = {'json': json, 'os': os, 'pathlib': __import__('pathlib'), 'stat': stat, 'tomllib': tomllib}
        exec(compile(ast.Module(keep, []), 'chain_service.py', 'exec'), self.env)

    def tearDown(self):
        self.tmp.cleanup()

    def toml(self, text, mode=0o640):
        p = self.datadir/'reth.toml'
        p.write_text(text)
        p.chmod(mode)
        return p

    def test_called_after_retention_checks_before_l1(self):
        run = self.src[self.src.index("    elif side == 'base':"):]
        order = [run.index(s) for s in ('segment_files_present(datadir, profile, state_from, STATE_FILES)',
                                        'base_merkle_config(datadir)', 'ready = l1_ready()', 'os.execve')]
        self.assertEqual(order, sorted(order))
        self.assertEqual(self.src.count('        base_merkle_config(datadir)\n'), 1)
        compile(self.src, 'chain_service.py', 'exec')

    def test_snapshot_defaults_replaced_and_nothing_else(self):
        p = self.toml(SNAPSHOT)
        self.assertEqual(self.env['base_merkle_config'](str(self.datadir)), 'set')
        before, after = tomllib.loads(SNAPSHOT), tomllib.loads(p.read_text())
        self.assertEqual(after['stages']['merkle'], WANT)
        before['stages']['merkle'] = WANT
        self.assertEqual(after, before)
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o640)
        self.assertFalse((self.datadir/'reth.toml.tmp').exists())

    def test_idempotent(self):
        p = self.toml(SNAPSHOT)
        self.env['base_merkle_config'](str(self.datadir))
        once = p.read_text()
        self.assertEqual(self.env['base_merkle_config'](str(self.datadir)), 'unchanged')
        self.assertEqual(p.read_text(), once)

    def test_operator_values_from_2026_11_07_replaced(self):
        p = self.toml(SNAPSHOT.replace('incremental_threshold = 7000', 'incremental_threshold = 2000')
                      .replace('rebuild_threshold = 100000', 'rebuild_threshold = 420000'))
        self.assertEqual(self.env['base_merkle_config'](str(self.datadir)), 'set')
        self.assertEqual(tomllib.loads(p.read_text())['stages']['merkle'], WANT)

    def test_missing_section_added(self):
        text = SNAPSHOT.replace('[stages.merkle]\nincremental_threshold = 7000\nrebuild_threshold = 100000\n\n', '')
        self.assertNotIn('merkle', text)
        p = self.toml(text.rstrip('\n'))   # no trailing newline either
        self.env['base_merkle_config'](str(self.datadir))
        after = tomllib.loads(p.read_text())
        self.assertEqual(after['stages']['merkle'], WANT)
        self.assertEqual(after['stages']['transaction_lookup'], {'chunk_size': 5000000})

    def test_commented_header_recognised(self):
        p = self.toml(SNAPSHOT.replace('[stages.merkle]\n', '  [stages.merkle]  # reth defaults\n'))
        self.env['base_merkle_config'](str(self.datadir))
        self.assertEqual(tomllib.loads(p.read_text())['stages']['merkle'], WANT)

    def test_unrecognised_shape_refused_unchanged(self):
        text = SNAPSHOT.replace('[stages.merkle]\nincremental_threshold = 7000\nrebuild_threshold = 100000\n',
                                '[stages]\nmerkle = { incremental_threshold = 7000, rebuild_threshold = 100000 }\n')
        p = self.toml(text)
        with self.assertRaises(Exception):
            self.env['base_merkle_config'](str(self.datadir))
        self.assertEqual(p.read_text(), text)

    def test_patch_refuses_unknown_source(self):
        p = Path(self.tmp.name, 'other.py')
        p.write_text('def run(side):\n    pass\n')
        with self.assertRaises(SystemExit):
            M.patch(str(p))


if __name__ == '__main__':
    unittest.main()
