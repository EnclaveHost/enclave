"""cutover-review scenarios (Linux mock, decisions only): ONE revert pass. BASELINE=<helper> also runs the same scenarios against
an earlier helper as a negative control and prints what it did (expected: a second automatic revert)."""
import importlib.util, os, pathlib, shutil, unittest
p = pathlib.Path(__file__).with_name('cutover-mock-test.py'); spec = importlib.util.spec_from_file_location('fixture', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def privacy_kills(lines): return [l.get('newPid') for l in lines if l.get('step') == 'privacy-restart']
class OneRevertPass(unittest.TestCase):
    def setUp(self): self.r = m.world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def baseline(self, run_id, scenario):
        base = os.environ.get('BASELINE')
        if not base: return
        r2 = m.world(); old = m.SCRIPT
        try:
            m.SCRIPT = pathlib.Path(base); lines, c = m.run(r2, m.params(r2, run_id), scenario=scenario)
            print(f"\nBASELINE {m.sha(m.SCRIPT.read_bytes())[:8]} {scenario}: starts={m.starts(r2)} final={m.final(lines)[:90]}")
            return lines, r2
        finally: m.SCRIPT = old; shutil.rmtree(r2, ignore_errors=True)
    def test_a_failure_inside_the_revert_never_starts_a_second_revert(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rv-crash'), scenario='revert-crash-once')
        f = m.final(lines); self.assertTrue(f.startswith('RECOVERY_REQUIRED: the revert itself failed'), (f, c.stderr[-700:]))
        self.assertEqual(m.starts(r), 0, 'no node start after a failed revert pass')
        self.assertFalse(m.flag(r), 'the flag was restored before the failure'); self.assertFalse(m.block(r))
        self.assertEqual(sum(1 for l in lines if l.get('step') == 'revert'), 0, 'the failed pass never journals a completed revert')
        self.assertIn('nodeStopped', lines[-1]); self.assertTrue(lines[-1]['nodeStopped'] is True)
        self.baseline('rv-crash-base', 'revert-crash-once')
    def test_a_post_revert_check_failure_does_not_stop_the_restored_node(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rv-post'), scenario='revert-postcheck-throws')
        f = m.final(lines); self.assertTrue(f.startswith('ROLLED_BACK_CHECK: the revert completed'), (f, c.stderr[-700:]))
        self.assertEqual(m.starts(r), 1, 'the restored node is started exactly once and never stopped again')
        self.assertTrue(m.node_running(r)); self.assertFalse(m.flag(r)); self.assertFalse(m.block(r))
        self.baseline('rv-post-base', 'revert-postcheck-throws')
if __name__ == '__main__': unittest.main()
