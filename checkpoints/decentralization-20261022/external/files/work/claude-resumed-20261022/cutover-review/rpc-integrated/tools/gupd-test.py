"""rpc-integrated G-UPD regression (Linux mock; decisions only). BASELINE=<previous cutover b3869dd0> is the old negative control:
it ACCEPTS Queued / no next run / an absent or failing query / a Queued state appearing after the pins."""
import importlib.util, os, pathlib, shutil, unittest
p = pathlib.Path(__file__).with_name('cutover-mock-test.py'); spec = importlib.util.spec_from_file_location('fixture', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
REFUSE_AT_PINS = {'update-queued': 'runs or is due inside this window (state Queued)', 'update-unknown': 'state Unknown / enabled True is not accepted',
                  'update-next-null': 'has no known next run', 'update-absent': 'absent or unreadable', 'update-query-fails': 'absent or unreadable',
                  'update-enabled-nonbool': 'Enabled flag is not a boolean', 'update-disabled-incoherent': 'Disabled but enabled or with a next run',
                  'update-running': 'runs or is due inside this window (state Running)', 'update-due': 'runs or is due inside this window'}
def go(sc, run_id, script=None):
    r = m.world(); old = m.SCRIPT
    try:
        if script: m.SCRIPT = pathlib.Path(script)
        lines, c = m.run(r, m.params(r, run_id), scenario=sc)
        return m.final(lines), [l.get('step') for l in lines if l.get('step')], m.node_running(r), m.starts(r), m.flag(r), (r / 'run-node.cmd').read_bytes() == m.RUN_NODE_OLD, c
    finally: m.SCRIPT = old; shutil.rmtree(r, ignore_errors=True)
class Gupd(unittest.TestCase):
    def test_incoherent_or_unknown_states_refuse_at_the_pins(self):
        for sc, why in REFUSE_AT_PINS.items():
            f, steps, running, starts, flag, rn_old, c = go(sc, 'g-' + sc)
            self.assertTrue(f.startswith('REFUSED') and why in f, (sc, f, c.stderr[-300:])); self.assertEqual(steps, ['pins'], sc)
            self.assertEqual((running, starts, flag, rn_old), (True, 0, False, True), sc)
    def test_queued_after_the_pins_refuses_in_beforestop_nothing_stopped(self):
        f, steps, running, starts, flag, rn_old, c = go('update-queued-after-pins', 'g-late')
        self.assertTrue(f.startswith('REFUSED: the \\Enclave\\Update task runs or is due inside this window (state Queued); nothing stopped'), (f, c.stderr[-300:]))
        self.assertEqual(steps, ['pins', 'stop-node'], 'refused at the stop step'); self.assertEqual((running, starts, flag, rn_old), (True, 0, False, True))
    def test_coherent_states_pass(self):
        for sc in ('ok', 'update-disabled'):
            f, steps, running, starts, flag, rn_old, c = go(sc, 'g-ok-' + sc); self.assertTrue(f.startswith('DONE:'), (sc, f, c.stderr[-300:]))
    def test_old_negative_control(self):
        base = os.environ.get('BASELINE')
        if not base: self.skipTest('BASELINE not set')
        got = {}
        for sc in ('update-queued', 'update-next-null', 'update-absent', 'update-query-fails', 'update-queued-after-pins'):
            f, steps, running, starts, flag, rn_old, c = go(sc, 'gb-' + sc, base); got[sc] = f[:60]
            self.assertTrue(f.startswith('DONE'), (sc, f)); self.assertIn('stop-node', steps, f'{sc}: the old gate let the stop proceed')
        print('\nBASELINE', m.sha(pathlib.Path(base).read_bytes())[:8], got)
if __name__ == '__main__': unittest.main()
