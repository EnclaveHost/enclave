#!/usr/bin/python3 -I
"""Coverage activation bridge tests (chain_service.coverage_activation + run('base') live binding).

Offline: synthetic evidence in a private temp dir (the 'operator' owner is the test uid), mocked L1 RPC. Parity with
the reviewed readiness validator (source readiness/readiness_sampler.py) on the same fixtures."""
import argparse
import copy
import functools
import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get('OPS_SOURCE') or (HERE if (HERE / 'readiness').is_dir()            # published ops layout
                                               else HERE.parent / 'source/ops/rpc-backend-bootstrap/2026-10-25'))
CHAIN_SERVICE = Path(os.environ.get('CHAIN_SERVICE') or HERE / 'chain_service.py')

manifest0 = {'mounts': {'l1': '/srv/enclave-l1-pair', 'base': '/srv/enclave-base-holder'}, 'binaries': {}}
disks0 = {'disks': [{'role': r, 'mount': m, 'uuid': 'expected'} for r, m in manifest0['mounts'].items()]}


def _boot_read(p, *a, **k):
    return json.dumps(disks0 if str(p).endswith('disks.json') else manifest0 if str(p).endswith('manifest.json')
                      else {'checkpoint': {'stateTime': 0}})


with patch.object(Path, 'read_text', _boot_read):
    spec = importlib.util.spec_from_file_location('chain_service_under_test', CHAIN_SERVICE)
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)
spec = importlib.util.spec_from_file_location('readiness_reference', SOURCE / 'readiness/readiness_sampler.py')
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

BASE_SHA = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'
SAFE_ORIGIN = 20_000_000
NEED = SAFE_ORIGIN - 3600
TO = SAFE_ORIGIN + 100
SLOT = 12_000_000
SNAP_BLOCK = 1_250_000
REAL_MANIFEST_SHA256 = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
REAL_MANIFEST_SIZE = 4_089_437
REAL_MANIFEST = os.environ.get('REAL_SNAPSHOT_MANIFEST')
BATCHER = '0x5050f69a9786f081509234f1a7f4684b5e5b76c9'
H = lambda b: '0x' + b * 32          # noqa: E731


def sha(b):
    return hashlib.sha256(b).hexdigest()


def dump(doc):
    return json.dumps(doc, indent=1, sort_keys=True).encode()


class Fixture:
    """A valid activation: installed manifest, chain config, and root-owned receipt/verdict/origin."""

    def __init__(self, root):
        self.root = Path(root)
        self.dir = self.root / 'coverage'
        self.manifest_path = self.root / 'manifest.json'
        self.manifest = {'format': 'enclave-rpc-production-bootstrap/v1', 'binaries': {'base': BASE_SHA, 'reth': 'r' * 64},
                         'snapshotManifests': {'base': 'https://mainnet-v2-snapshots.base.org/1792886410/manifest.json'},
                         'mounts': manifest0['mounts']}
        self.origin = {'format': c.ORIGIN_FORMAT, 'chain': 'base-mainnet', 'status': 'SAFE_HEAD_PERSISTED',
                       'labels': {'tip': {'number': SNAP_BLOCK, 'hash': H('11'), 'l1Origin': {'number': SAFE_ORIGIN + 5, 'hash': H('22')}},
                                  'safe': {'number': SNAP_BLOCK - 1000, 'hash': H('33'), 'batcher': BATCHER,
                                           'l1Origin': {'number': SAFE_ORIGIN, 'hash': H('44')}},
                                  'finalized': None},
                       'source': {'tool': 'base reth db get (AccessRights::RO)', 'binarySha256': BASE_SHA,
                                  'datadirReadOnlyMount': True}}
        # Compact, structurally faithful to the real manifest (sha 1f0c4e6c…, block 53048526, 9 components):
        # host-root base_url, finalized chunks under static_files/, tip chunk and state under the snapshot id dir,
        # a root-level single archive, BLAKE3 output entries. Same keys as the real document.
        out = lambda p: {'path': p, 'size': 5, 'blake3': 'ab' * 32}          # noqa: E731
        self.snapshot = {'block': SNAP_BLOCK, 'chain_id': 8453, 'storage_version': 2, 'timestamp': 1792888464,
                         'base_url': 'https://mainnet-v2-snapshots.base.org', 'reth_version': '2.5.2-dev (7134be3)',
                         'components': {
                             'headers': {'blocks_per_file': 500000, 'total_blocks': SNAP_BLOCK,
                                         'chunk_sizes': [1, 2, 3], 'chunk_decompressed_sizes': [4, 5, 6],
                                         'chunk_files': ['static_files/headers-0-499999.tar.zst',
                                                         'static_files/headers-500000-999999.tar.zst',
                                                         '1792886410/headers-1000000-1499999.tar.zst'],
                                         'chunk_output_files': [[out('static_files/static_file_headers_0_499999')],
                                                                [out('static_files/static_file_headers_500000_999999')],
                                                                [out('static_files/static_file_headers_1000000_1499999')]]},
                             'state': {'file': '1792886410/state.tar.zst', 'size': 10, 'decompressed_size': 20,
                                       'output_files': [out('db/database.version'), out('db/mdbx.dat')]},
                             'proofs': {'file': 'proofs.tar.zst', 'size': 10, 'decompressed_size': 20,
                                        'output_files': [out('proofs/000001.sst')]}}}
        self.verdict = {'format': c.VERDICT_FORMAT, 'verdict': 'COVERED', 'rule': 'safe-origin-minus-seq-window',
                        'needFromBlock': NEED, 'toBlock': TO, 'batcher': BATCHER, 'coverageVerifiedWritten': False,
                        'counts': {'blocks': TO - NEED + 1, 'missingData': 0, 'mismatches': 0, 'blobsVerified': 7},
                        'proposedBaseBootstrap': {'l1Block': NEED, 'blobSlot': SLOT, 'rootReviewRequired': True,
                                                  'coverageVerifiedEligible': True}}
        self.cfg = {'checkpoint': {'root': H('55'), 'epoch': 1}, 'txForwarding': {'endpoint': None},
                    'baseRetention': {'historyFromBlock': 1_000_000, 'stateHistoryFromBlock': 1_000_000},
                    'baseBootstrap': {'coverageVerified': True}}
        self.receipt = {'format': c.RECEIPT_FORMAT, 'decision': 'accepted',
                        'kzgcheckSha256': c.KZGCHECK_SHA256, 'baseBinarySha256': BASE_SHA,
                        'baseBootstrap': {'l1Block': NEED, 'blobSlot': SLOT},
                        'review': {'reviewer': 'root', 'gateRunner': 'rpcbase-gate', 'reviewedAt': '2026-10-25T18:00:00Z'}}

    def write(self, receipt_extra=None, raw=None, pins=True):
        """Write every file; the receipt binds the actual bytes unless overridden; config pins the actual bytes."""
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(mode=0o755)
        os.chmod(self.dir, 0o755)
        m_raw = dump(self.manifest)
        self.manifest_path.write_bytes(m_raw)
        files = {'verdict.json': dump(self.verdict), 'origin.json': dump(self.origin),
                 'snapshot-manifest.json': dump(self.snapshot)}
        files.update({k: v for k, v in (raw or {}).items() if k == 'snapshot-manifest.json'})
        rc = dict(self.receipt, verdictSha256=sha(files['verdict.json']), originSha256=sha(files['origin.json']),
                  snapshotManifestSha256=sha(files['snapshot-manifest.json']), bootstrapManifestSha256=sha(m_raw),
                  snapshotManifestUrl=(self.manifest.get('snapshotManifests') or {}).get('base'),
                  chainConfigSha256=c.config_identity(self.cfg))
        rc.update(receipt_extra or {})
        files['receipt.json'] = dump(rc)
        files.update(raw or {})
        for n, b in files.items():
            p = self.dir / n
            p.write_bytes(b)
            os.chmod(p, 0o644)
        if pins:
            self.cfg['baseBootstrap']['coverageAcceptance'] = {
                'receiptSha256': sha(files['receipt.json']), 'verdictSha256': sha(files['verdict.json']),
                'originSha256': sha(files['origin.json']), 'snapshotManifestSha256': sha(files['snapshot-manifest.json'])}
        return files

    def check(self, owner=None):
        return c.coverage_activation(self.cfg, self.manifest_path, BASE_SHA, directory=self.dir,
                                     owner=os.getuid() if owner is None else owner)

    def readiness(self):
        a = argparse.Namespace(coverage_receipt=str(self.dir / 'receipt.json'), coverage_verdict=str(self.dir / 'verdict.json'),
                               coverage_origin=str(self.dir / 'origin.json'),
                               expect_snapshot_manifest_sha256=sha((self.dir / 'snapshot-manifest.json').read_bytes()),
                               expect_chain_config_sha256=c.config_identity(self.cfg),
                               expect_kzg_sha256=c.KZGCHECK_SHA256, expect_base_sha256=BASE_SHA)
        return rs.validate_coverage_files(a)


class Bridge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='covact-', dir=os.environ.get('TEST_TMP'))
        self.f = Fixture(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def refused(self, needle, **kw):
        with self.assertRaises(AssertionError) as cm:
            self.f.check(**kw)
        self.assertIn(needle, str(cm.exception))

    # ---- accept ----
    def test_valid_binding(self):
        self.f.write()
        b = self.f.check()
        self.assertEqual((b['l1Block'], b['blobSlot'], b['toBlock']), (NEED, SLOT, TO))
        self.assertEqual(b['safeL1Origin'], {'number': SAFE_ORIGIN, 'hash': H('44')})

    def test_activation_section_edits_do_not_change_config_identity(self):
        self.f.write()
        self.f.cfg['baseBootstrap']['reason'] = 'operator note'
        self.f.cfg['baseBootstrap']['l1Block'] = NEED          # restating the bound value is allowed
        self.f.cfg['baseBootstrap']['blobSlot'] = SLOT
        self.assertEqual(self.f.check()['l1Block'], NEED)

    # ---- operator decision and pins ----
    def test_boolean_alone_never_activates(self):
        self.f.write(pins=False)
        self.refused('coverageVerified alone never activates')

    def test_not_approved(self):
        self.f.write()
        for v in (False, 'true', 1, None):
            self.f.cfg['baseBootstrap']['coverageVerified'] = v
            self.refused('not approved')
        self.f.cfg.pop('baseBootstrap')
        self.refused('not approved')

    def test_malformed_pins(self):
        self.f.write()
        for bad in ('A' * 64, 'x' * 64, 'a' * 63, None):
            self.f.write()
            self.f.cfg['baseBootstrap']['coverageAcceptance']['verdictSha256'] = bad
            self.refused('coverageVerified alone never activates')

    def test_tampered_evidence_bytes(self):
        files = self.f.write()
        for n in ('receipt.json', 'verdict.json', 'origin.json'):
            self.f.write()
            p = self.f.dir / n
            p.write_bytes(p.read_bytes() + b' ')
            self.refused('differ from the operator-pinned hashes')
        self.assertTrue(files)

    def test_arbitrary_receipt_cannot_bypass(self):
        # an attacker-written receipt pinned in config still needs an accepted, bound, COVERED evidence chain
        for extra, needle in (({'decision': 'rejected'}, 'not an accepted review'),
                              ({'format': 'something-else/v1'}, 'not an accepted review'),
                              ({'verdictSha256': 'f' * 64}, 'does not bind these evidence bytes'),
                              ({'originSha256': 'f' * 64}, 'does not bind these evidence bytes'),
                              ({'review': {'reviewer': 'root', 'gateRunner': 'root', 'reviewedAt': 'x'}}, 'not independent'),
                              ({'review': {'reviewer': ' ', 'gateRunner': 'g', 'reviewedAt': 'x'}}, 'not independent'),
                              ({'snapshotManifestSha256': 'A' * 64}, 'malformed')):
            with self.subTest(extra=extra):
                self.f.write(receipt_extra=extra)
                self.refused(needle)

    def test_installed_identity_bindings(self):
        self.f.write()
        self.f.manifest['snapshotManifests']['base'] = 'https://example.invalid/other.json'
        self.f.manifest_path.write_bytes(dump(self.f.manifest))
        self.refused('different installed bootstrap manifest')
        self.f = Fixture(self.tmp)
        self.f.write()
        self.f.cfg['checkpoint']['epoch'] = 2
        self.refused('different chain config')
        self.f = Fixture(self.tmp)
        self.f.write()
        self.f.cfg['txForwarding']['endpoint'] = 'https://mainnet-sequencer.base.org'
        self.refused('different chain config')

    def test_tool_pins(self):
        self.f.write(receipt_extra={'kzgcheckSha256': 'e' * 64})
        self.refused('tool pins differ')
        self.f.write(receipt_extra={'baseBinarySha256': 'e' * 64})
        self.refused('tool pins differ')
        self.f.write()
        self.f.manifest['binaries']['base'] = 'e' * 64             # installed manifest pins another binary
        self.f.manifest_path.write_bytes(dump(self.f.manifest))
        self.refused('does not pin this base binary')

    def test_origin_rules(self):
        for mut, needle in ((lambda o: o.update(status='NO_PERSISTED_SAFE_HEAD'), 'no persisted safe label'),
                            (lambda o: o['labels'].update(safe=None), 'no persisted safe label'),
                            (lambda o: o['source'].update(datadirReadOnlyMount=False), 'provenance'),
                            (lambda o: o['source'].update(binarySha256='e' * 64), 'provenance'),
                            (lambda o: o['labels']['safe'].update(hash='0x12'), 'malformed'),
                            (lambda o: o['labels']['safe']['l1Origin'].update(number=True), 'malformed')):
            with self.subTest(needle=needle):
                self.f = Fixture(self.tmp)
                mut(self.f.origin)
                self.f.write()
                self.refused(needle)

    def test_verdict_rules(self):
        for mut, needle in ((lambda v: v.update(verdict='REFUSED'), 'not COVERED'),
                            (lambda v: v.update(verdict='COVERED_UNDER_TIP_WALK_RULE_ROOT_DECISION_REQUIRED'), 'not COVERED'),
                            (lambda v: v.update(refusal={'code': 'x'}), 'not COVERED'),
                            (lambda v: v.update(coverageVerifiedWritten=True), 'not COVERED'),
                            (lambda v: v.update(rule='tip-walk-rule'), 'safe-label rule'),
                            (lambda v: v['proposedBaseBootstrap'].update(coverageVerifiedEligible=False), 'safe-label rule'),
                            (lambda v: v['counts'].update(missingData=1), 'incomplete'),
                            (lambda v: v['counts'].update(mismatches=1), 'incomplete'),
                            (lambda v: v['counts'].update(blobsVerified=0), 'incomplete'),
                            (lambda v: v['counts'].update(blobsVerified=True), 'incomplete'),
                            (lambda v: v['counts'].update(blocks=TO - NEED), 'incomplete'),
                            (lambda v: v.update(toBlock=SAFE_ORIGIN - 1), 'does not cover'),
                            (lambda v: v.update(needFromBlock=-1), 'does not cover')):
            with self.subTest(needle=needle):
                self.f = Fixture(self.tmp)
                mut(self.f.verdict)
                self.f.write()
                self.refused(needle)

    def test_binding_consistency(self):
        cases = ((lambda f: f.verdict['proposedBaseBootstrap'].update(l1Block=NEED + 1), 'bindings disagree'),
                 (lambda f: f.receipt['baseBootstrap'].update(l1Block=NEED - 1), 'bindings disagree'),
                 (lambda f: f.receipt['baseBootstrap'].update(blobSlot=SLOT + 1), 'bindings disagree'),
                 (lambda f: f.verdict['proposedBaseBootstrap'].update(blobSlot=None), 'bindings disagree'),
                 (lambda f: (f.verdict.update(needFromBlock=NEED + 1),
                             f.verdict['counts'].update(blocks=TO - NEED)), 'bindings disagree'),
                 (lambda f: f.verdict.update(batcher='0x' + '99' * 20), 'batcher'))
        for mut, needle in cases:
            with self.subTest(needle=needle):
                self.f = Fixture(self.tmp)
                mut(self.f)
                self.f.write()
                self.refused(needle)

    def test_config_cannot_diverge_from_binding(self):
        for k, v in (('l1Block', NEED + 1), ('blobSlot', SLOT - 1), ('l1Block', str(NEED))):
            with self.subTest(k=k, v=v):
                self.f = Fixture(self.tmp)
                self.f.write()
                self.f.cfg['baseBootstrap'][k] = v
                self.refused('differs from the reviewed binding')

    # ---- files: missing, permissions, bounds ----
    def test_missing_and_unsafe_files(self):
        self.f.write()
        (self.f.dir / 'verdict.json').unlink()
        self.refused('unreadable')
        self.f.write()
        (self.f.dir / 'origin.json').rename(self.f.dir / 'o2.json')
        (self.f.dir / 'origin.json').symlink_to(self.f.dir / 'o2.json')
        self.refused('unreadable')                                   # O_NOFOLLOW
        self.f.write()
        os.chmod(self.f.dir / 'receipt.json', 0o664)
        self.refused('non-writable regular file')
        self.f.write()
        self.refused('not operator-controlled', owner=os.getuid() + 1)   # dir checked first; same uid owns the files
        self.f.write()
        with self.assertRaisesRegex(AssertionError, 'base binary pin missing'):
            c.coverage_activation(self.f.cfg, self.f.manifest_path, None, directory=self.f.dir, owner=os.getuid())
        self.f.write()
        os.chmod(self.f.dir, 0o777)
        self.refused('not operator-controlled')
        shutil.rmtree(self.f.dir)
        self.refused('directory absent')
        self.f.write()
        self.f.manifest_path.unlink()
        self.refused('installed bootstrap manifest unreadable')

    def test_malformed_and_oversize(self):
        files = self.f.write(raw={'verdict.json': b'not json'})
        self.assertTrue(files)
        self.refused('not JSON')
        self.f.write(raw={'origin.json': b'[1, 2]'})
        self.refused('not a JSON object')
        self.f.write()
        with patch.object(c, 'MAX_EVIDENCE', 64):
            self.refused('within bounds')

    # ---- parity with the reviewed readiness validator ----
    def test_parity_with_readiness_validator(self):
        self.f.write()
        ours, ref = self.f.check(), self.f.readiness()
        self.assertEqual((ours['l1Block'], ours['blobSlot']), (ref['needFromBlock'], ref['blobSlot']))
        tampers = (('receipt', {'decision': 'rejected'}), ('receipt', {'verdictSha256': 'f' * 64}),
                   ('receipt', {'kzgcheckSha256': 'e' * 64}),
                   ('verdict', lambda v: v.update(verdict='REFUSED')), ('verdict', lambda v: v['counts'].update(missingData=2)),
                   ('verdict', lambda v: v.update(rule='tip-walk-rule')), ('origin', lambda o: o.update(status='NO_PERSISTED_SAFE_HEAD')),
                   ('origin', lambda o: o['source'].update(datadirReadOnlyMount=False)),
                   ('binding', lambda f: f.receipt['baseBootstrap'].update(blobSlot=SLOT + 1)))
        for kind, mut in tampers:
            with self.subTest(kind=kind):
                self.f = Fixture(self.tmp)
                if kind == 'receipt':
                    self.f.write(receipt_extra=mut)
                else:
                    mut(self.f if kind == 'binding' else getattr(self.f, kind))
                    self.f.write()
                with self.assertRaises(AssertionError):
                    self.f.check()
                with self.assertRaises((rs.Negative, rs.Unavailable)):
                    self.f.readiness()


class SnapshotIdentity(unittest.TestCase):
    """Bootstrap/install manifest and the exact downloaded snapshot manifest are distinct, both bound (root review 18:12)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='covsnap-', dir=os.environ.get('TEST_TMP'))
        self.f = Fixture(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def refused(self, needle):
        with self.assertRaises(AssertionError) as cm:
            self.f.check()
        self.assertIn(needle, str(cm.exception))

    def test_valid_binds_both_documents(self):
        self.f.write()
        b = self.f.check()
        self.assertEqual(b['bootstrapManifestSha256'], sha(self.f.manifest_path.read_bytes()))
        self.assertEqual(b['evidence']['snapshotManifestSha256'], sha((self.f.dir / 'snapshot-manifest.json').read_bytes()))
        self.assertEqual(b['snapshot']['block'], SNAP_BLOCK)
        self.assertEqual(b['snapshot']['effectiveBaseUrl'], 'https://mainnet-v2-snapshots.base.org')
        self.assertIn('not authenticated snapshot state', b['snapshot']['scope'])

    def test_bootstrap_manifest_presented_as_snapshot_manifest(self):
        self.f.write()
        self.f.write(raw={'snapshot-manifest.json': self.f.manifest_path.read_bytes()})      # exact installer bytes
        self.refused('not the downloaded snapshot manifest')
        lookalike = dict(self.f.manifest, block=SNAP_BLOCK, chain_id=8453, storage_version=2, timestamp=1, components={'s': {'file': 'a', 'size': 1}})
        self.f.write(raw={'snapshot-manifest.json': dump(lookalike)})                         # installer-shaped document
        self.refused('not the downloaded snapshot manifest')

    def test_old_relabel_of_bootstrap_hash_refused(self):
        self.f.write(receipt_extra={'snapshotManifestSha256': sha(dump(self.f.manifest))})
        self.refused('does not bind this snapshot manifest')

    def test_snapshot_manifest_missing_tampered_or_unpinned(self):
        self.f.write()
        (self.f.dir / 'snapshot-manifest.json').unlink()
        self.refused('unreadable')
        self.f.write()
        p = self.f.dir / 'snapshot-manifest.json'
        p.write_bytes(p.read_bytes() + b' ')
        self.refused('operator-pinned')
        self.f.write()
        self.f.cfg['baseBootstrap']['coverageAcceptance'].pop('snapshotManifestSha256')
        self.refused('coverageVerified alone never activates')

    def test_receipt_document_fields(self):
        self.f.write(receipt_extra={'bootstrapManifestSha256': None})
        self.refused('bootstrapManifestSha256 malformed')
        self.f.write(receipt_extra={'snapshotManifestUrl': 'https://mainnet-v2-snapshots.base.org/1700000000/manifest.json'})
        self.refused('different snapshot manifest URL')
        self.f.write(receipt_extra={'bootstrapManifestSha256': 'd' * 64})
        self.refused('different installed bootstrap manifest')

    def test_snapshot_manifest_schema_and_location(self):
        cases = ((lambda s: s.update(chain_id=1), 'not for Base mainnet'),
                 (lambda s: s.update(storage_version=3), 'storage/block invalid'),
                 (lambda s: s.update(block=True), 'block malformed'),
                 (lambda s: s.update(timestamp=-1), 'timestamp malformed'),
                 (lambda s: s.update(components={}), 'no components'),
                 (lambda s: s['components'].update(state={'file': '/etc/passwd', 'size': 1}), 'component state malformed'),
                 (lambda s: s['components'].update(state={'file': '../x.tar', 'size': 1}), 'component state malformed'),
                 (lambda s: s['components'].update(headers={'blocks_per_file': 0, 'total_blocks': 1}), 'component headers malformed'),
                 (lambda s: s.update(base_url='https://evil.example/1792886410'), 'base_url is not the snapshot location'))
        for mut, needle in cases:
            with self.subTest(needle=needle):
                self.f = Fixture(self.tmp)
                mut(self.f.snapshot)
                self.f.write()
                self.refused(needle)

    def test_base_url_may_be_omitted(self):
        self.f.snapshot.pop('base_url')
        self.f.write()
        self.assertEqual(self.f.check()['snapshot']['url'], self.f.manifest['snapshotManifests']['base'])

    def test_adversarial_locations_and_paths(self):
        """Inputs that pinned reth would resolve outside the pinned snapshot host/directory, or extract outside the datadir."""
        H_ = self.f.snapshot['components']['headers']
        cases = (
            (lambda s: s.update(base_url='https://evil.example'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='http://mainnet-v2-snapshots.base.org'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://user@mainnet-v2-snapshots.base.org'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://mainnet-v2-snapshots.base.org:8443'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://mainnet-v2-snapshots.base.org/other'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://mainnet-v2-snapshots.base.org/17928'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://mainnet-v2-snapshots.base.org/?x=1'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url='https://mainnet-v2-snapshots.base.org.evil.example'), 'base_url is not the snapshot location'),
            (lambda s: s.update(base_url=7), 'base_url is not the snapshot location'),
            (lambda s: s['components']['state'].update(file='https://evil.example/state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='//evil.example/state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='1792886410/../../x/state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='1792886410\\..\\state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='1792886410/state.tar.zst?x'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='1700000000/state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['state'].update(file='other/state.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['headers']['chunk_files'].__setitem__(2, '1700000000/headers-1000000-1499999.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['headers']['chunk_files'].__setitem__(0, '../static_files/headers-0-499999.tar.zst'), 'archive path escapes'),
            (lambda s: s['components']['headers']['chunk_files'].pop(), 'chunk_files not one per chunk'),
            (lambda s: s['components']['headers'].update(total_blocks=SNAP_BLOCK - 1), 'component headers malformed'),
            (lambda s: s['components']['state']['output_files'].append({'path': '../../etc/cron.d/x', 'size': 1, 'blake3': 'ab' * 32}), 'output file entry'),
            (lambda s: s['components']['state']['output_files'].append({'path': '/etc/x', 'size': 1, 'blake3': 'ab' * 32}), 'output file entry'),
            (lambda s: s['components']['headers']['chunk_output_files'][0].append({'path': 'static_files/x', 'size': 1, 'blake3': 'AB' * 32}), 'output file entry'),
            (lambda s: s['components']['headers'].update(chunk_sizes=[1, -2, 3]), 'sizes'),
        )
        self.assertTrue(H_)
        for mut, needle in cases:
            with self.subTest(needle=needle, n=cases.index((mut, needle))):
                self.f = Fixture(self.tmp)
                mut(self.f.snapshot)
                self.f.write()
                self.refused(needle)

    def test_base_url_at_pinned_directory_or_empty_is_accepted(self):
        for base in ('https://mainnet-v2-snapshots.base.org/1792886410', 'https://mainnet-v2-snapshots.base.org/', ''):
            with self.subTest(base=base):
                self.f = Fixture(self.tmp)
                self.f.snapshot['base_url'] = base
                self.f.write()
                self.assertEqual(self.f.check()['snapshot']['block'], SNAP_BLOCK)

    def test_snapshot_block_binds_origin(self):
        self.f.snapshot['block'] = SNAP_BLOCK + 1                           # consistent manifest, other block
        self.f.snapshot['components']['headers']['total_blocks'] = SNAP_BLOCK + 1
        self.f.write()
        self.refused('not the downloaded snapshot manifest block')
        self.f = Fixture(self.tmp)
        self.f.origin['labels']['safe']['number'] = SNAP_BLOCK + 1
        self.f.origin['labels']['tip']['number'] = SNAP_BLOCK
        self.f.write()
        self.refused('safe label malformed')

    def test_bootstrap_without_snapshot_url(self):
        self.f.manifest.pop('snapshotManifests')
        self.f.write()
        self.refused('pins no Base snapshot manifest URL')


class RealManifest(unittest.TestCase):
    """The ACTUAL observed raw Base snapshot manifest (sha 1f0c4e6c…, 4,089,437 B) passes; adversarial edits of it fail.
    The 4 MB body is not published; staging runs it via REAL_SNAPSHOT_MANIFEST (jobs.sh)."""

    @classmethod
    def setUpClass(cls):
        if not REAL_MANIFEST:
            raise unittest.SkipTest('REAL_SNAPSHOT_MANIFEST not set (staging job sets it; the body is not published)')
        raw = Path(REAL_MANIFEST).read_bytes()
        assert (len(raw), sha(raw)) == (REAL_MANIFEST_SIZE, REAL_MANIFEST_SHA256), 'not the observed manifest bytes'
        cls.raw, cls.doc = raw, json.loads(raw)

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='covreal-', dir=os.environ.get('TEST_TMP'))
        self.f = Fixture(self.tmp)
        self.url = self.f.manifest['snapshotManifests']['base']

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_real_manifest_accepted(self):
        r = c.snapshot_manifest_check(self.doc, self.f.manifest, self.url)
        self.assertEqual((r['block'], r['components'], r['effectiveBaseUrl']),
                         (53048526, 9, 'https://mainnet-v2-snapshots.base.org'))

    def test_real_manifest_full_activation(self):
        self.f.origin['labels']['tip']['number'] = 53048526
        self.f.origin['labels']['safe']['number'] = 53047000
        self.f.write(raw={'snapshot-manifest.json': self.raw})
        b = self.f.check()
        self.assertEqual(b['evidence']['snapshotManifestSha256'], REAL_MANIFEST_SHA256)
        self.assertEqual(b['snapshot']['block'], 53048526)

    def test_real_manifest_adversarial_edits_refused(self):
        def edit(fn):
            d = json.loads(self.raw)
            fn(d)
            with self.assertRaises(AssertionError):
                c.snapshot_manifest_check(d, self.f.manifest, self.url)
        edit(lambda d: d.update(base_url='https://evil.example'))
        edit(lambda d: d['components']['state'].update(file='../state.tar.zst'))
        edit(lambda d: d['components']['headers']['chunk_files'].__setitem__(0, 'https://evil.example/h.tar.zst'))
        edit(lambda d: d['components']['transactions']['chunk_files'].__setitem__(-1, '1700000000/transactions-53000000-53499999.tar.zst'))
        edit(lambda d: d['components']['rocksdb_indices']['output_files'][0].update(path='../../rocksdb/001210.sst'))
        edit(lambda d: d.update(chain_id=1))
        # the same bytes under another pinned snapshot directory are refused (location binding)
        with self.assertRaises(AssertionError):
            c.snapshot_manifest_check(self.doc, self.f.manifest, 'https://mainnet-v2-snapshots.base.org/1700000000/manifest.json')


class LiveBinding(unittest.TestCase):
    """run('base'): offline evidence first, then live checks on our L1, only bound values used."""
    PROFILE = ('[prune.segments]\nsender_recovery="full"\ntransaction_lookup="full"\n'
               + ''.join(n + '={distance=140000}\n' for n in ('receipts', 'account_history', 'storage_history', 'bodies_history'))
               + '[static_files.blocks_per_file]\nheaders=500000\n')

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='covlive-', dir=os.environ.get('TEST_TMP'))
        self.f = Fixture(self.tmp)
        self.f.write()
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def launch(self, finalized=TO + 10, canon=H('44'), receipts=True, blobs=True):
        real = functools.partial(c.coverage_activation.__wrapped__ if hasattr(c.coverage_activation, '__wrapped__')
                                 else c.coverage_activation, directory=self.f.dir, owner=os.getuid())

        def rpc(port, method, params):
            self.calls.append((method, params))
            if method == 'eth_getBlockByNumber':
                return {'hash': canon} if canon else None
            if method == 'eth_getBlockReceipts':
                return [] if receipts else None
            raise AssertionError('unexpected rpc')

        def beacon(path):
            self.calls.append(('beacon', path))
            if path == f'/eth/v2/beacon/blocks/{SLOT}':
                return {'message': {'body': {'blob_kzg_commitments': ['c1', 'c2']}}}
            if path == f'/eth/v1/beacon/blobs/{SLOT}':
                return ['b1', 'b2'] if blobs else ['b1']
            raise AssertionError('unexpected beacon ' + path)

        class Executed(Exception):
            pass
        manifest_path = self.f.manifest_path
        with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=self.PROFILE), patch.object(c, 'binary', side_effect=lambda n: '/pinned/' + n), \
                patch.object(c, 'CONFIG', self.f.cfg), patch.object(c, 'MANIFEST', {'binaries': {'base': BASE_SHA}}), \
                patch.object(c, 'ROOT', manifest_path.parent), \
                patch.object(c, 'coverage_activation', side_effect=lambda cfg, mp, b: real(cfg, mp, b)), \
                patch.object(c, 'history_files_present'), patch.object(c, 'segment_files_present'), \
                patch.object(c, 'l1_ready', return_value={'l1Block': TO + 20, 'l1Finalized': finalized, 'blobSlot': 1}) as ready, \
                patch.object(c, 'rpc', side_effect=rpc), patch.object(c, 'beacon', side_effect=beacon), \
                patch.object(c.os, 'execve', side_effect=Executed) as exe:
            try:
                c.run('base')
            except Executed:
                return exe.call_args.args[1], ready
            raise AssertionError('not executed')

    def test_valid_starts_with_bound_values(self):
        argv, ready = self.launch()
        self.assertTrue(argv[0].endswith('/base'))
        self.assertIn(('eth_getBlockByNumber', [hex(SAFE_ORIGIN), False]), self.calls)
        self.assertIn(('eth_getBlockReceipts', [hex(NEED)]), self.calls)
        self.assertIn(('beacon', f'/eth/v1/beacon/blobs/{SLOT}'), self.calls)

    def test_offline_refusal_precedes_live_calls(self):
        self.f.cfg['baseBootstrap']['coverageAcceptance']['originSha256'] = 'f' * 64
        with self.assertRaisesRegex(AssertionError, 'operator-pinned'):
            self.launch()
        self.assertEqual(self.calls, [])

    def test_origin_not_canonical(self):
        with self.assertRaisesRegex(AssertionError, 'not canonical'):
            self.launch(canon=H('99'))
        with self.assertRaisesRegex(AssertionError, 'not canonical'):
            self.launch(canon=None)

    def test_range_above_our_finality(self):
        with self.assertRaisesRegex(AssertionError, 'above our L1 finalized'):
            self.launch(finalized=TO - 1)

    def test_receipts_and_blobs_must_be_served(self):
        with self.assertRaisesRegex(AssertionError, 'receipts absent'):
            self.launch(receipts=False)
        with self.assertRaisesRegex(AssertionError, 'blobs absent'):
            self.launch(blobs=False)


class Cli(unittest.TestCase):
    """coverage-identity / coverage-check operator subcommands (read-only) through main()."""

    def run_main(self, f, argv):
        import contextlib
        import io
        out = io.StringIO()
        real = c.coverage_activation
        with patch.object(c, 'ROOT', f.manifest_path.parent), patch.object(c, 'CONFIG', f.cfg), \
                patch.object(c, 'MANIFEST', f.manifest), patch.object(c, 'COVERAGE_DIR', f.dir), \
                patch.object(c, 'coverage_activation', functools.partial(real, directory=f.dir, owner=os.getuid())), \
                patch.object(c, 'l1_ready', side_effect=AssertionError('no live call allowed')), \
                contextlib.redirect_stdout(out):
            c.main(argv)
        return json.loads(out.getvalue())

    def test_identity_and_check(self):
        tmp = tempfile.mkdtemp(prefix='covcli-', dir=os.environ.get('TEST_TMP'))
        try:
            f = Fixture(tmp)
            f.write()
            ident = self.run_main(f, ['coverage-identity'])
            self.assertEqual(ident['chainConfigSha256'], c.config_identity(f.cfg))
            self.assertEqual(ident['bootstrapManifestSha256'], sha(f.manifest_path.read_bytes()))
            self.assertEqual(ident['snapshotManifestSha256'], sha((f.dir / 'snapshot-manifest.json').read_bytes()))
            self.assertNotEqual(ident['snapshotManifestSha256'], ident['bootstrapManifestSha256'])
            self.assertEqual(ident['snapshotManifestUrl'], f.manifest['snapshotManifests']['base'])
            self.assertEqual((ident['baseBinarySha256'], ident['kzgcheckSha256']), (BASE_SHA, c.KZGCHECK_SHA256))
            self.assertEqual(self.run_main(f, ['coverage-check'])['l1Block'], NEED)
            (f.dir / 'verdict.json').write_bytes(b'{}')
            with self.assertRaisesRegex(AssertionError, 'operator-pinned'):
                self.run_main(f, ['coverage-check'])
            with self.assertRaises(SystemExit):
                c.main(['coverage-activate'])
            with patch.object(c, 'run') as r:
                c.main(['base'])
                r.assert_called_once_with('base')
            with self.assertRaises(SystemExit):
                c.main(['base', 'extra'])
            for side in ('el', 'cl'):                                  # explicit-argument dispatch (not sys.argv)
                with patch.object(c, 'run') as r, patch.object(c.sys, 'argv', ['chain_service.py']):
                    c.main([side])
                    r.assert_called_once_with(side)
            with patch.object(c.sys, 'argv', ['chain_service.py', 'base']), self.assertRaises(SystemExit):
                c.main([])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    unittest.main(verbosity=2)
