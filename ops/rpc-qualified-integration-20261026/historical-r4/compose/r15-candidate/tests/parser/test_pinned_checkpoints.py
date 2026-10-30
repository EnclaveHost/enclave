#!/usr/bin/env python3
"""pinned-checkpoint-parser focused tests (PREPARED; NOT run by Claude; exact count 8). Rows are the pinned reth 7134be3 output
shape: `{StageId Display}: StageCheckpoint { block_number: N, stage_checkpoint: None|Some(<StageUnitCheckpoint Debug>) }`.
env: HARNESS=<stage>/harness/a2a4.py, HARNESS_DEPS=<dir holding the harness's sibling imports (selection.py)>"""
import importlib.util, os, sys, types, unittest
sys.path.insert(0, os.environ['HARNESS_DEPS'])
s = importlib.util.spec_from_file_location('a2a4_pinned', os.environ['HARNESS']); A = importlib.util.module_from_spec(s); s.loader.exec_module(A)
row = lambda st, n, d='None': f'{st}: StageCheckpoint {{ block_number: {n}, stage_checkpoint: {d} }}'
FIN = lambda p: f'Some(Finish(FinishCheckpoint {{ partial_state_trie: {p} }}))'
def table(n, finish='None', extra=()):            # get_all_checkpoints rows are sorted by stage name (stage_checkpoints.rs)
    rows = {'AccountHashing': row('AccountHashing', n), 'Bodies': row('Bodies', n), 'Era': row('Era', 0), 'Execution': row('Execution', n),
            'Finish': row('Finish', n, finish), 'Headers': row('Headers', n), 'MerkleExecute': row('MerkleExecute', n),
            'SenderRecovery': row('SenderRecovery', n), 'StorageHashing': row('StorageHashing', n)}
    return '\n'.join([rows[k] for k in sorted(rows)] + list(extra)) + '\n'

class Pinned(unittest.TestCase):
    def refused(self, text, frag):
        with self.assertRaises(A.Refused) as cm:
            A.parse_checkpoints(text)
        self.assertTrue(str(cm.exception).startswith('unparsed:') and frag in str(cm.exception), str(cm.exception))
    def test_real_rows_give_canonical_keys_and_full_state(self):
        cps, state = A.parse_checkpoints(table(120))
        self.assertEqual(cps, {'headers': 120, 'bodies': 120, 'execution': 120, 'merkle-execute': 120, 'finish': 120}); self.assertEqual(state, 120)
        self.assertEqual(A.checkpoint_block(table(7), 'merkle-execute'), 7)
    def test_lagging_finish_partial_state_trie_is_the_state_frontier(self):
        cps, state = A.parse_checkpoints(table(120, FIN('Some(95)')))
        self.assertEqual((cps['execution'], cps['finish'], state), (120, 120, 95))     # labels at the tip, persisted state at 95
    def test_finish_checkpoint_without_partial_state(self):
        self.assertEqual(A.parse_checkpoints(table(120, FIN('None')))[1], 120)
    def test_missing_required_row_refuses(self):
        self.refused(table(5).replace(row('MerkleExecute', 5) + '\n', ''), "['MerkleExecute']")
    def test_duplicate_row_refuses(self):
        self.refused(table(5, extra=(row('Headers', 6),)), 'duplicate checkpoint row for Headers')
    def test_old_synthetic_lowercase_and_unknown_or_malformed_rows_refuse(self):
        self.refused('headers: Some(StageCheckpoint { block_number: 5, stage_checkpoint: None })\n', 'not a pinned stage-checkpoints row')
        self.refused(table(5, extra=(row('Foo', 5),)), "unknown stage 'Foo'")
        self.refused(table(5, extra=('Prune: StageCheckpoint { block_number: x, stage_checkpoint: None }',)), 'not a pinned stage-checkpoints row')
    def test_finish_detail_must_be_a_finish_checkpoint_not_above_finish(self):
        self.refused(table(5, 'Some(Execution(ExecutionCheckpoint { block_range: CheckpointBlockRange { from: 1, to: 5 } }))'), 'is not a FinishCheckpoint')
        self.refused(table(5, FIN('Some(6)')), 'above the Finish checkpoint')
    def test_head_state_reads_the_gated_db_output(self):
        base = types.SimpleNamespace(db=lambda *a: table(130, FIN('Some(129)')) if a == ('stage-checkpoints', 'get') else None)
        self.assertEqual(A.head_state({}, base), ({'headers': 130, 'bodies': 130, 'execution': 130, 'merkle-execute': 130, 'finish': 130}, 129))
        self.assertEqual(A.head_checkpoints({}, base)['finish'], 130)

if __name__ == '__main__':
    unittest.main(verbosity=2)
