"""Offline checks of root-hs2-g3.py (no remote call): its gate() against root's REAL r5 post facts (the live base), and the
expected post-G3 facts; every mutation refuses. Plus the driver's own --selfcheck (local pins, remote texts, lengths)."""
import copy, importlib.util, json, pathlib, subprocess, sys, unittest
HERE = pathlib.Path(__file__).resolve().parent
sp = importlib.util.spec_from_file_location('drv', HERE / 'root-hs2-g3.py'); drv = importlib.util.module_from_spec(sp); sp.loader.exec_module(drv)
MAN = json.loads((HERE / 'upgrade-bundle-g3/upgrade-manifest.json').read_text())
R5POST = json.loads((HERE.parent.parent / 'compose5-review/root-r5/result-upgrade-20261021T195835Z.json').read_text())['post']

def live_now():
    ev = copy.deepcopy(R5POST); f = ev['facts']
    f['journal'] = None; f['lock'] = None; f['helpers'] = 0
    for a in MAN['add']: f['files'][a['path']] = 'absent'          # what the G3 FACTS text now reports
    return ev
def upgraded():
    ev = live_now(); f = ev['facts']
    for r in MAN['replace']: f['files'][r['path']] = r['new']
    for a in MAN['add']: f['files'][a['path']] = a['new']
    f['config'] = MAN['config']['new']; f['receipt'] = 'cd' * 32
    f['journal'] = {'journal': {'manifest': drv.MSHA, 'phase': 'complete', 'receiptNew': 'cd' * 32}, 'revert-journal': None}
    return ev

class Gate(unittest.TestCase):
    def test_live_r5_base_passes_upgrade_preflight(self):
        self.assertEqual(drv.gate(live_now(), MAN, 'upgrade'), [])
    def test_upgrade_refusals(self):
        for label, mut in [('added file present', lambda f: f['files'].__setitem__('packages/service-tls.mjs', MAN['add'][0]['new'])),
                           ('added file unreported', lambda f: f['files'].pop('packages/service-tls.package.json')),
                           ('config drift', lambda f: f.__setitem__('config', 'ee' * 32)),
                           ('receipt drift', lambda f: f.__setitem__('receipt', 'ee' * 32)),
                           ('unchanged drift', lambda f: f['files'].__setitem__('packages/directory-replica.mjs', 'ee' * 32)),
                           ('already upgraded runner', lambda f: f['files'].__setitem__('bin/host-services-runner.mjs', MAN['replace'][1]['new'])),
                           ('task stopped', lambda f: f.__setitem__('taskState', 'Ready')),
                           ('lock', lambda f: f.__setitem__('lock', '20261021000000-abcdef01')),
                           ('helper running', lambda f: f.__setitem__('helpers', 1)),
                           ('low memory', lambda f: f.__setitem__('freeMiB', 100))]:
            with self.subTest(label):
                ev = live_now(); mut(ev['facts']); self.assertNotEqual(drv.gate(ev, MAN, 'upgrade'), [], label)
        ev = live_now(); ev['health']['exit'] = 1
        self.assertNotEqual(drv.gate(ev, MAN, 'upgrade'), [])
    def test_post_g3_expectation(self):
        self.assertEqual(drv.gate(upgraded(), MAN, 'upgraded', '20261021210000-abcdef01'), [])
        for label, mut in [('added missing', lambda f: f['files'].__setitem__('packages/service-tls.mjs', 'absent')),
                           ('old config', lambda f: f.__setitem__('config', MAN['config']['old'])),
                           ('receipt not the run', lambda f: f.__setitem__('receipt', 'ee' * 32)),
                           ('journal other manifest', lambda f: f['journal']['journal'].__setitem__('manifest', 'ee' * 32))]:
            with self.subTest(label):
                ev = upgraded(); mut(ev['facts']); self.assertNotEqual(drv.gate(ev, MAN, 'upgraded', 'x'), [], label)
    def test_rels_cover_replace_add_unchanged(self):
        r = drv.rels(MAN).split('|')
        self.assertEqual(len(r), len(MAN['replace']) + len(MAN['add']) + len(MAN['unchanged']))
        self.assertTrue({a['path'] for a in MAN['add']} <= set(r))

class Selfcheck(unittest.TestCase):
    def test_driver_selfcheck(self):
        p = subprocess.run([sys.executable, str(HERE / 'root-hs2-g3.py'), '--selfcheck'], capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout[-800:] + p.stderr[-800:])

if __name__ == '__main__': unittest.main()
