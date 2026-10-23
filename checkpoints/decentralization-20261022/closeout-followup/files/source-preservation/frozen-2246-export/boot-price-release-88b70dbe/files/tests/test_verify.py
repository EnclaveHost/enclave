"""verify.py exact-delta rules on the REAL root-built 08d1 manifest, with synthetic candidate edits."""
import copy, json, sys, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent; sys.path.insert(0, str(HERE.parent))
import verify as v
M9 = json.loads((HERE.parent.parent / 'custody-recipient-restore-20261023/stage-approved/dist-leasegas-9f6d37bd8/manifest.json').read_text())
NEW = 'ab' * 20

def cand(changed=('/app/supervisor.js',), **over):
    m = copy.deepcopy(M9); m['controlOverlay']['commit'] = NEW; m['initramfs'] = {**m['initramfs'], 'sha256': '11' * 32}
    for f in m['controlOverlay']['files']:
        if f['path'] in changed: f['sha256'] = '22' * 32
    for k, val in over.items(): m[k] = val
    return m

class Verify(unittest.TestCase):
    S, G = ['/app/supervisor.js'], ['/app/supervisor.js', '/opt/metal/gsup.mjs']
    def test_exact_supervisor_and_gsup_deltas_pass(self):
        self.assertEqual(v.manifest_problems(M9, cand(), NEW, self.S), [])
        self.assertEqual(v.manifest_problems(M9, cand(self.G), NEW, self.G), [])
        self.assertEqual(v.entries_problems(['app/supervisor.js', 'opt/metal/manifest.json'], ['app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/manifest.json'], self.S), [])
        self.assertEqual(v.entries_problems(['app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/manifest.json'], ['app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/manifest.json'], self.G), [])
    def test_manifest_deviations_refuse(self):
        lease = next(f['path'] for f in M9['controlOverlay']['files'] if 'lease' in f['path'])
        added = cand(); added['controlOverlay']['files'].append({'path': '/app/new.mjs', 'source': 'new.mjs', 'sha256': '33' * 32})
        removed = cand(); removed['controlOverlay']['files'] = [f for f in removed['controlOverlay']['files'] if f['path'] != lease]
        builder = cand(); builder['controlOverlay']['builderSha256'] = '44' * 32
        closure = cand(); closure['controlOverlay']['supervisorClosure'] = {'x': 1}
        for m, files in [(cand(('/app/supervisor.js', lease)), self.S), (cand(self.G), self.S), (cand(), self.G), (added, self.S), (removed, self.S),
                         (builder, self.S), (closure, self.S), (cand(kernel={'sha256': '55' * 32}), self.S)]:
            self.assertTrue(v.manifest_problems(M9, m, NEW, files), files)
        self.assertTrue(v.manifest_problems(M9, cand(), 'cd' * 20, self.S))       # another commit
    def test_entry_deviations_refuse(self):
        ok9, okp = ['app/supervisor.js', 'opt/metal/manifest.json'], ['app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/manifest.json']
        for a, b in [(ok9 + ['app/verifier/snp.mjs'], okp), (ok9, okp + ['app/network/lease-gas-owner.mjs']), (['opt/metal/manifest.json'], okp),
                     (ok9, ['app/supervisor.js', 'opt/metal/manifest.json']), (ok9 + ['opt/metal/gsup.mjs'], okp)]:
            self.assertTrue(v.entries_problems(sorted(a), sorted(b), self.S), (a, b))

if __name__ == '__main__': unittest.main()
