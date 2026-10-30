#!/usr/bin/env python3
"""base-forward-sync-stage/r2 unit regressions (PREPARED; NOT run by Claude; exact count 6). Pure-module tests: the pinned stage-checkpoint
format and state frontier, exact per-subcommand help tokens (root's REAL pinned help logs/base-live-help-0603/help.txt), the own-CL
retention preflight, and the producer binary pin (production constant AND launch binding; fixture override only inside the test).
env: FORWARD_SYNC_SRC=<r2>/src, R2_PRODUCER=<r2>/r6-followup/producer/base_launch.py, BASE_HELP=<work>/logs/base-live-help-0603/help.txt"""
import importlib.util, os, pathlib, sys, tempfile, types, unittest
from unittest.mock import patch
sys.path.insert(0, os.environ['FORWARD_SYNC_SRC'])
import forward_sync as FS
HELP = pathlib.Path(os.environ['BASE_HELP']).read_text()
row = lambda s, n, d='None': f'{s}: StageCheckpoint {{ block_number: {n}, stage_checkpoint: {d} }}'
ALL = lambda n, fin='None': '\n'.join([row(s, n) for s in ('Bodies', 'Execution', 'Headers', 'MerkleExecute')] + [row('Finish', n, fin), row('AccountHashing', n)])

class StageFrontier(unittest.TestCase):
    def test_pinned_format_all_stages_and_full_state(self):
        cps, state = FS.stage_frontier(ALL(120))
        self.assertEqual((set(cps.values()), state), ({120}, 120)); self.assertEqual(set(cps), set(FS.STAGES))
    def test_partial_state_trie_is_the_state_frontier(self):
        _c, state = FS.stage_frontier(ALL(120, 'Some(Finish(FinishCheckpoint { partial_state_trie: Some(95) }))'))
        self.assertEqual(state, 95)                                    # labels say 120; persisted state/trie only to 95
        _c, state = FS.stage_frontier(ALL(120, 'Some(Finish(FinishCheckpoint { partial_state_trie: None }))')); self.assertEqual(state, 120)
    def test_refuses_kebab_labels_missing_rows_and_unknown_finish(self):
        for text in ('headers: Some(StageCheckpoint { block_number: 1, .. })', ALL(5).replace('MerkleExecute', 'Merkle'),
                     ALL(5, 'Some(Execution(ExecutionCheckpoint { block_range: 1 }))'), ALL(5) + '\n' + row('Finish', 5)):
            with self.assertRaises(FS.Refused) as cm:
                FS.stage_frontier(text)
            self.assertEqual(cm.exception.code, 'unparsed', text[:60])

class Capability(unittest.TestCase):
    def test_exact_tokens_per_subcommand_from_the_real_pinned_help(self):
        i = HELP.index('Usage: base rpc'); d = pathlib.Path(tempfile.mkdtemp())
        (d / 'g').write_text(HELP[:i]); (d / 'r').write_text(HELP[i:]); exe = d / 'base'
        exe.write_text(f'#!/bin/sh\nif [ "$1" = rpc ]; then cat {d}/r; else cat {d}/g; fi\n'); exe.chmod(0o755)
        argv = FS.node_argv(str(exe), '/x', [])
        FS.capability(str(exe), (), argv)                               # every flag exact and in its position
        for bad in ([str(exe), '--chain', 'mainnet', 'rpc', '--rpc'], [str(exe), '--datadir', '/x', 'rpc'], [str(exe), 'rpc', '--chain', 'mainnet'],
                    [str(exe), '--chain', 'mainnet', 'rpc', '--http.portx', '1']):
            with self.assertRaises(FS.Refused) as cm:
                FS.capability(str(exe), (), bad)
            self.assertEqual(cm.exception.code, 'capability', bad)

class Retention(unittest.TestCase):
    def test_own_cl_retained_range_against_need_from(self):
        info = lambda b, dd: (lambda: {'anchor': {'oldest_block_slot': str(b)}, 'data_info': {'oldest_data_slot': str(dd)}})
        with patch.object(FS, 'lighthouse_db_info', info(100, 200)):
            self.assertEqual(FS.retention(None, 200)['oldestDataSlot'], 200)
            for need in (199, 99):
                with self.assertRaises(FS.Refused) as cm:
                    FS.retention(None, need)
                self.assertEqual(cm.exception.code, 'blob_history_missing')
        with patch.object(FS, 'lighthouse_db_info', lambda: {'data': {}}), self.assertRaises(FS.Refused) as cm:
            FS.retention(None, 1)
        self.assertEqual(cm.exception.code, 'blob_history_unknown')

class ProducerPin(unittest.TestCase):
    def test_production_constant_and_launch_binding_both_required(self):
        s = importlib.util.spec_from_file_location('base_launch_r2', os.environ['R2_PRODUCER']); P = importlib.util.module_from_spec(s); s.loader.exec_module(P)
        d = pathlib.Path(tempfile.mkdtemp()); cfg = d / 'cfg.json'; cfg.write_bytes(b'{}'); csha = P.sha(cfg.read_bytes())
        stand = 'ab' * 32
        A = types.SimpleNamespace(load_config=lambda p: {'baseBinarySha256': stand})
        L = lambda b: {'bindings': {'configSha256': csha, 'harnessBinarySha256': b}}
        with self.assertRaises(P.Refused) as cm:                        # REAL negative: unpatched production pin refuses a stand-in
            P.bound_config(L(stand), cfg, A)
        self.assertTrue(str(cm.exception).startswith('binary_pin:'))
        with patch.object(P, 'HARNESS_BINARY_SHA256', stand):           # fixture-scoped stand-in: binding == config == (patched) pin
            self.assertEqual(P.bound_config(L(stand), cfg, A)['baseBinarySha256'], stand)
            with self.assertRaises(P.Refused) as cm:                    # a launch binding naming another binary still refuses
                P.bound_config(L('cd' * 32), cfg, A)
            self.assertTrue(str(cm.exception).startswith('binary_pin:'))

if __name__ == '__main__':
    unittest.main(verbosity=2)
