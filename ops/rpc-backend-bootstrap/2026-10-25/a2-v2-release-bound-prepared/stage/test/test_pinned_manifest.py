"""The REAL pinned manifest (sha 1f0c4e6c..., 4,089,437 B; root-observed copy, NOT committed): derived selection counts.
Path: $A2A4_PINNED_MANIFEST or outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json.
A missing or different file FAILS (never skips)."""
import hashlib, json, os, pathlib, sys, unittest
H = pathlib.Path(__file__).resolve().parents[1]; sys.path.insert(0, str(H))
import selection as S
PIN = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
PATH = pathlib.Path(os.environ.get('A2A4_PINNED_MANIFEST', '/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json'))


class PinnedManifest(unittest.TestCase):
    def test_real_manifest_selection_counts_and_checksums(self):
        raw = PATH.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), PIN, 'not the pinned manifest')
        m = json.loads(raw)
        self.assertEqual((m['block'], m['chain_id'], m['storage_version']), (53_048_526, 8453, 2))
        first, final = S.derive(m, 'first-pass-distance-140000'), S.derive(m, S.FINAL_PROFILE)
        self.assertEqual((len(first), len(final)), (116, 134))
        self.assertTrue(first < final, 'the final selection contains the first pass')
        self.assertEqual(sorted(i for c, i in final if c == 'transactions'), list(range(96, 107)))
        self.assertEqual(sorted(i for c, i in final if c == 'account_changesets'), [105, 106])
        for key in final:
            files = S.checksums(m, key)
            self.assertTrue(files and all(len(f['blake3']) == 64 for f in files), key)


if __name__ == '__main__':
    unittest.main(verbosity=2)
