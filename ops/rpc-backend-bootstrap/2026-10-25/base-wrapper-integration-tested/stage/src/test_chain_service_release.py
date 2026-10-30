"""Offline tests of the OPT-IN M7+M10 release path in chain_service.py (base_release, bootstrap_anchor_args, run('base')).
Real wrapper functions over a private temp tree (a test-owned TRUSTED_TOP, owner = this uid); only the system/RPC
boundaries are faked (mount, L1/beacon RPC, execve), exactly as test_chain_service.py does. No network, no client.
The artifact pin is the real 4a7c013a... in source (asserted); tests substitute a test artifact's hash for that pin."""
import hashlib, json, os, shutil, stat, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import test_chain_service as T          # loads ./chain_service.py (the candidate) and its fixtures
c = T.c

ANCHOR_N, ANCHOR_H = 52866960, '0x' + '5c' * 32
FAKE_BIN = b'#!/bin/false\nfake release artifact for tests\n'
sha = lambda b: hashlib.sha256(b).hexdigest()


class Tree:
    """A private root-like tree: TOP/opt/enclave-rpc/releases/base-m7m10-<16>/base and TOP/etc/enclave-rpc/base-bootstrap."""
    def __init__(self, state='anchor-pending', **over):
        self.top = Path(tempfile.mkdtemp(prefix='rel-')); os.chmod(self.top, 0o755)
        self.pin = sha(FAKE_BIN)
        self.rel = self.top / 'opt/enclave-rpc/releases' / ('base-m7m10-' + self.pin[:16]) / 'base'
        self.rel.parent.mkdir(parents=True, mode=0o755); self.rel.write_bytes(FAKE_BIN); os.chmod(self.rel, 0o555)
        for d in [self.top / 'opt', self.top / 'opt/enclave-rpc', self.top / 'opt/enclave-rpc/releases', self.rel.parent]: os.chmod(d, 0o755)
        self.bd = self.top / 'etc/enclave-rpc/base-bootstrap'; (self.bd / 'qualification').mkdir(parents=True)
        for d in [self.top / 'etc', self.top / 'etc/enclave-rpc', self.bd, self.bd / 'qualification']: os.chmod(d, 0o755)
        q = {'m10-launch.json': {'bootstrapAnchor': f'{ANCHOR_N}:{ANCHOR_H}', 'at': 'x'}, 'a2-authenticated.json': {'anchor': {'blockHash': ANCHOR_H}},
             'a4-rebuilt.json': {'blockHash': ANCHOR_H, 'verifiedStateAt': ANCHOR_N}}
        q.update(over.pop('qual', {}))
        hashes = {f: self.put(self.bd / 'qualification' / f, v) for f, v in q.items()}
        bv = {'a4Sha256': hashes['a4-rebuilt.json'], **over.pop('bytecodes', {})}
        hashes['bytecodes-verified.json'] = self.put(self.bd / 'qualification' / 'bytecodes-verified.json', bv)
        launch = {'format': c.LAUNCH_FORMAT, 'anchor': f'{ANCHOR_N}:{ANCHOR_H}', 'baseReleaseSha256': self.pin,
                  'qualification': {'m10LaunchSha256': hashes['m10-launch.json'], 'a2Sha256': hashes['a2-authenticated.json'],
                                    'a4Sha256': hashes['a4-rebuilt.json'], 'bytecodesVerifiedSha256': hashes['bytecodes-verified.json']}}
        launch.update(over.pop('launch', {}))
        self.launch_sha = self.put(self.bd / 'launch.json', launch)
        life = {'format': c.LIFECYCLE_FORMAT, 'launchSha256': self.launch_sha, 'state': state}
        life.update(over.pop('life', {}))
        self.life_sha = self.put(self.bd / 'lifecycle.json', life)
        self.manifest = {'mounts': T.manifest['mounts'], 'binaries': {'base': self.pin}, 'baseRelease': {'path': str(self.rel), 'sha256': self.pin}}
        self.cfg = {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2,
                                      'anchorLaunch': {'launchSha256': self.launch_sha, 'lifecycleSha256': self.life_sha}},
                    'baseRetention': {'historyFromBlock': T.HISTORY_FROM, 'stateHistoryFromBlock': T.STATE_FROM}}
    def put(self, p, doc):
        b = json.dumps(doc).encode(); p.write_bytes(b); os.chmod(p, 0o644); return sha(b)
    def patches(self, reviewed=True):
        return [patch.object(c, 'TRUSTED_TOP', self.top), patch.object(c, 'ROOT_UID', os.getuid()), patch.object(c, 'BASE_RELEASE_SHA256', self.pin),
                patch.object(c, 'BASE_RELEASE_PATH', self.rel), patch.object(c, 'BOOTSTRAP_DIR', self.bd), patch.object(c, 'LAUNCH_PRODUCER_REVIEWED', reviewed)]
    def close(self): shutil.rmtree(self.top, ignore_errors=True)


def launch_base(tree=None, manifest=None, cfg=None, reviewed=True):
    """run('base') through every EXISTING gate (faked at the system/RPC boundary as in PruneProfileTests) up to execve."""
    beacon = {'/eth/v2/beacon/blocks/2': {'message': {'body': {'blob_kzg_commitments': ['x']}}}, '/eth/v1/beacon/blobs/2': ['x']}
    ps = [patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', return_value=True),
          patch.object(Path, 'read_text', return_value=T.BaseRetentionTests.PROFILE), patch.object(c, 'binary', side_effect=lambda n: '/opt/enclave-rpc/bin/' + n),
          patch.object(c, 'MANIFEST', manifest if manifest is not None else (tree.manifest if tree else T.manifest)),
          patch.object(c, 'CONFIG', cfg if cfg is not None else (tree.cfg if tree else {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2}, 'baseRetention': {'historyFromBlock': T.HISTORY_FROM, 'stateHistoryFromBlock': T.STATE_FROM}})),
          patch.object(c, 'coverage_activation', return_value=T.BOUND), patch.object(c, 'history_files_present'), patch.object(c, 'segment_files_present'),
          patch.object(c, 'l1_ready', return_value={'l1Finalized': 30000}),
          patch.object(c, 'rpc', side_effect=lambda port, m, p: {'hash': T.BOUND_HASH} if m == 'eth_getBlockByNumber' else []),
          patch.object(c, 'beacon', side_effect=beacon.__getitem__)] + (tree.patches(reviewed) if tree else [])
    for p in ps: p.start()
    try:
        with patch.object(c.os, 'execve', side_effect=T.Executed) as exe:
            with unittest.TestCase().assertRaises(T.Executed):
                c.run('base')
        return exe.call_args.args[1], exe.call_args.args[2]
    finally:
        for p in reversed(ps): p.stop()


class ReleaseSourcePins(unittest.TestCase):
    def test_source_pins_the_tested_artifact_and_holds_the_producer(self):
        self.assertEqual(c.BASE_RELEASE_SHA256, '4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f')
        self.assertEqual(str(c.BASE_RELEASE_PATH), '/opt/enclave-rpc/releases/base-m7m10-4a7c013a510f8816/base')
        self.assertIs(c.LAUNCH_PRODUCER_REVIEWED, False, 'no reviewed launch-record producer exists: anchored starts stay closed')
        self.assertEqual((c.TRUSTED_TOP, c.ROOT_UID), (Path('/'), 0))


class LegacyUnchanged(unittest.TestCase):
    def test_without_base_release_the_old_binary_runs_exactly_as_before(self):
        self.assertIsNone(c.base_release({'binaries': {'base': '9c' * 32}}))
        argv, env = launch_base()
        self.assertEqual(argv[0], '/opt/enclave-rpc/bin/base')
        self.assertNotIn('--bootstrap.anchor', argv)
        self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')

    def test_existing_gate_order_is_kept_in_release_mode(self):
        t = Tree()
        try:
            with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', return_value=True), \
                    patch.object(Path, 'read_text', return_value=T.BaseRetentionTests.PROFILE), patch.object(c, 'MANIFEST', t.manifest), \
                    patch.object(c, 'CONFIG', {'baseBootstrap': {'coverageVerified': False}}), patch.object(c, 'l1_ready') as ready:
                with self.assertRaisesRegex(AssertionError, 'coverage not approved'):
                    c.run('base')
                ready.assert_not_called()
        finally:
            t.close()


class ReleaseSelection(unittest.TestCase):
    def setUp(self): self.t = Tree(); [p.start() for p in self.t.patches()]
    def tearDown(self): patch.stopall(); self.t.close()

    def test_valid_release_is_selected(self):
        self.assertEqual(c.base_release(self.t.manifest), str(self.t.rel))

    def test_refusals(self):
        m = self.t.manifest
        cases = {'not the reviewed': {**m, 'baseRelease': {**m['baseRelease'], 'sha256': '00' * 32}},
                 'versioned path': {**m, 'baseRelease': {**m['baseRelease'], 'path': str(self.t.rel) + '2'}},
                 'binaries.base must name the release': {**m, 'binaries': {'base': '9c' * 32}},
                 'exactly': {**m, 'baseRelease': {**m['baseRelease'], 'extra': 1}}}
        for why, man in cases.items():
            with self.subTest(why), self.assertRaisesRegex(AssertionError, why):
                c.base_release(man)
        self.t.rel.chmod(0o755); self.t.rel.write_bytes(FAKE_BIN + b'x'); self.t.rel.chmod(0o555)
        with self.assertRaisesRegex(AssertionError, 'release binary pin mismatch'):
            c.base_release(m)

    def test_symlinks_and_writable_parents_are_refused(self):
        real = self.t.rel.parent.with_name('real'); self.t.rel.parent.rename(real)
        self.t.rel.parent.symlink_to(real)                                       # a symlinked parent directory
        with self.assertRaisesRegex(AssertionError, 'is a symlink'):
            c.base_release(self.t.manifest)
        self.t.rel.parent.unlink(); real.rename(self.t.rel.parent)
        os.chmod(self.t.rel.parent.parent, 0o777)                                # a group/other-writable parent
        with self.assertRaisesRegex(AssertionError, 'non-writable'):
            c.base_release(self.t.manifest)
        os.chmod(self.t.rel.parent.parent, 0o755)
        self.t.rel.unlink(); self.t.rel.symlink_to(Path('/bin/true'))             # a symlinked target
        with self.assertRaisesRegex(AssertionError, 'is a symlink'):
            c.base_release(self.t.manifest)


class BootstrapLifecycle(unittest.TestCase):
    def args(self, t, reviewed=True):
        ps = t.patches(reviewed); [p.start() for p in ps]
        try:
            return c.bootstrap_anchor_args(t.cfg, t.pin)
        finally:
            for p in ps: p.stop()

    def test_anchor_pending_gives_the_one_time_anchor_only_when_the_producer_is_reviewed(self):
        t = Tree()
        try:
            self.assertEqual(self.args(t), ['--bootstrap.anchor', f'{ANCHOR_N}:{ANCHOR_H}'])
            with self.assertRaisesRegex(AssertionError, 'HOLD: no reviewed producer'):
                self.args(t, reviewed=False)                                     # the source default
        finally:
            t.close()

    def test_bootstrapped_never_replays_the_anchor(self):
        t = Tree('bootstrapped', life={'finalizedPastAnchor': {'number': ANCHOR_N + 1, 'hash': '0x' + '7a' * 32, 'recordedAt': 'root'}})
        try:
            self.assertEqual(self.args(t), [])
        finally:
            t.close()
        for bad in ({'number': ANCHOR_N, 'hash': '0x' + '7a' * 32, 'recordedAt': 'r'}, {'number': True, 'hash': '0x' + '7a' * 32, 'recordedAt': 'r'}, None):
            t = Tree('bootstrapped', life={'finalizedPastAnchor': bad})
            try:
                with self.subTest(bad=bad), self.assertRaisesRegex(AssertionError, 'finality beyond N'):
                    self.args(t)
            finally:
                t.close()

    def test_ambiguous_or_failed_states_refuse_instead_of_skipping_or_replaying(self):
        for state in ('advanced-unfinalized', 'started', 'failed', 'rolled-back', None):
            t = Tree(state)
            try:
                with self.subTest(state=state), self.assertRaisesRegex(AssertionError, 'lifecycle state'):
                    self.args(t)
            finally:
                t.close()

    def test_evidence_bindings_refuse_any_mismatch(self):
        cases = [({'launch': {'baseReleaseSha256': '00' * 32}}, 'another binary'),
                 ({'launch': {'anchor': f'{ANCHOR_N}:0x' + 'AB' * 32}}, 'lower-case hex'),
                 ({'qual': {'m10-launch.json': {'bootstrapAnchor': f'{ANCHOR_N + 1}:{ANCHOR_H}'}}}, 'not the A2-A4 release anchor'),
                 ({'bytecodes': {'a4Sha256': '00' * 32}}, 'another A4 result'),
                 ({'life': {'launchSha256': '00' * 32}}, 'another launch record'),
                 ({'launch': {'format': 'other'}}, 'format')]
        for over, why in cases:
            t = Tree(**over)
            try:
                with self.subTest(why), self.assertRaisesRegex(AssertionError, why):
                    self.args(t)
            finally:
                t.close()

    def test_unpinned_partial_or_tampered_evidence_refuses(self):
        t = Tree()
        try:
            t.cfg['baseBootstrap'].pop('anchorLaunch')
            with self.assertRaisesRegex(AssertionError, 'no implicit bootstrap path'):
                self.args(t)
        finally:
            t.close()
        t = Tree()
        try:
            (t.bd / 'qualification' / 'a4-rebuilt.json').unlink()               # a partial copy (crash during staging)
            with self.assertRaisesRegex(AssertionError, 'unreadable'):
                self.args(t)
        finally:
            t.close()
        t = Tree()
        try:
            p = t.bd / 'lifecycle.json'; p.chmod(0o644); p.write_text(p.read_text().replace('anchor-pending', 'bootstrapped'))
            with self.assertRaisesRegex(AssertionError, 'differ from the operator pins'):   # an edit without re-pinning (rollback must re-pin)
                self.args(t)
        finally:
            t.close()
        t = Tree()
        try:
            os.chmod(t.bd / 'qualification', 0o777)
            with self.assertRaisesRegex(AssertionError, 'non-writable'):
                self.args(t)
        finally:
            t.close()


class ReleaseLaunch(unittest.TestCase):
    def test_release_mode_execs_the_release_with_every_gate_and_the_anchor(self):
        t = Tree()
        try:
            argv, env = launch_base(t)
            self.assertEqual(argv[0], str(t.rel))
            self.assertEqual(argv[-2:], ['--bootstrap.anchor', f'{ANCHOR_N}:{ANCHOR_H}'])
            self.assertEqual(env['BASE_NODE_L1_TRUST_RPC'], 'false')
            self.assertIn('--l1-eth-rpc', argv)
        finally:
            t.close()

    def test_release_mode_with_the_source_hold_never_execs(self):
        t = Tree()
        try:
            with self.assertRaisesRegex(AssertionError, 'HOLD'):
                launch_base(t, reviewed=False)
        finally:
            t.close()

    def test_bootstrapped_restart_execs_the_release_without_the_anchor(self):
        t = Tree('bootstrapped', life={'finalizedPastAnchor': {'number': ANCHOR_N + 5, 'hash': '0x' + '7a' * 32, 'recordedAt': 'root'}})
        try:
            argv, _ = launch_base(t)
            self.assertEqual(argv[0], str(t.rel)); self.assertNotIn('--bootstrap.anchor', argv)
        finally:
            t.close()


if __name__ == '__main__':
    unittest.main()
