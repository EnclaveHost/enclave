import importlib.util
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
manifest={'mounts':{'l1':'/srv/enclave-l1-pair','base':'/srv/enclave-base-holder'},'binaries':{}}
disks={'disks':[{'role':r,'mount':m,'uuid':'expected'} for r,m in manifest['mounts'].items()]}
def config_read(p,*a,**k):
    return json.dumps(disks if str(p).endswith('disks.json') else manifest if str(p).endswith('manifest.json') else {'checkpoint':{'stateTime':0}})
with patch.object(Path,'read_text',config_read):
    spec=importlib.util.spec_from_file_location('chain_service',HERE/'chain_service.py')
    c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

class Executed(Exception):pass
class GateTests(unittest.TestCase):
    def test_restricted_root_writable_data(self):
        with patch('os.path.ismount',return_value=True), patch.object(c.subprocess,'check_output',side_effect=['expected ext4 ro,noatime','expected ext4 rw,noatime']):
            self.assertEqual(c.mount('l1','cl'),'/srv/enclave-l1-pair')
    def test_wrong_volume_refused(self):
        with patch('os.path.ismount',return_value=True), patch.object(c.subprocess,'check_output',return_value='wrong ext4 rw'):
            with self.assertRaisesRegex(AssertionError,'wrong dedicated'):c.mount('l1','el')
    def test_readonly_data_refused(self):
        with patch('os.path.ismount',return_value=True), patch.object(c.subprocess,'check_output',side_effect=['expected ext4 ro','expected ext4 ro']):
            with self.assertRaisesRegex(AssertionError,'not writable'):c.mount('l1','el')
    def test_resume_survives_old_checkpoint(self):
        with patch.object(c,'mount',return_value='/srv/enclave-l1-pair'), patch.object(c,'binary',return_value='/pinned/lighthouse'), patch.object(Path,'is_dir',lambda p:p.name=='chain_db'), patch.object(c.os,'execve',side_effect=Executed) as exe:
            with self.assertRaises(Executed):c.run('cl')
            self.assertNotIn('--checkpoint-state',exe.call_args.args[1])
            self.assertNotIn('--wss-checkpoint',exe.call_args.args[1])
    def test_fresh_start_refuses_old_checkpoint(self):
        with patch.object(c,'mount',return_value='/srv/enclave-l1-pair'), patch.object(c,'binary',return_value='/pinned/lighthouse'), patch.object(Path,'is_dir',return_value=False):
            with self.assertRaisesRegex(AssertionError,'checkpoint too old'):c.run('cl')
    def test_base_requires_explicit_origin_coverage(self):
        profile='[prune.segments]\nsender_recovery="full"\ntransaction_lookup="full"\n' + ''.join(name+'={distance=140000}\n' for name in ('receipts','account_history','storage_history','bodies_history')) + '[static_files.blocks_per_file]\nheaders=500000\n'
        with patch.object(c,'mount',return_value='/srv/enclave-base-holder'),patch.object(Path,'is_file',return_value=True),patch.object(Path,'read_text',return_value=profile),patch.object(c,'l1_ready') as ready:
            with self.assertRaisesRegex(AssertionError,'coverage not approved'):c.run('base')
            ready.assert_not_called()
    def test_minimal_receipt_pruning_is_refused(self):
        profile='[prune.segments]\nsender_recovery="full"\ntransaction_lookup="full"\nreceipts="full"\n[static_files.blocks_per_file]\nheaders=500000\n'
        with patch.object(c,'mount',return_value='/srv/enclave-base-holder'),patch.object(Path,'is_file',return_value=True),patch.object(Path,'read_text',return_value=profile):
            with self.assertRaisesRegex(AssertionError,'history retention too short'):c.run('base')
    def test_no_implicit_submission_route(self):
        with patch.object(c,'CONFIG',{}):self.assertEqual(c.forwarding_args(),[])
    def test_explicit_submission_route(self):
        with patch.object(c,'CONFIG',{'txForwarding':{'endpoint':'https://mainnet-sequencer.base.org'}}):
            self.assertEqual(c.forwarding_args(),['--rpc.forwarding-endpoint','https://mainnet-sequencer.base.org'])
    def test_unreviewed_submission_route_refused(self):
        with patch.object(c,'CONFIG',{'txForwarding':{'endpoint':'https://user:password@evil.example'}}):
            with self.assertRaisesRegex(AssertionError,'unsupported submission'):c.forwarding_args()
    def data(self):
        now=int(time.time()); head={'timestamp':hex(now-24),'number':'0x100','hash':'0xabc'}
        def rpc(port,method,params):
            if method=='eth_chainId':return '0x1'
            if method=='eth_syncing':return False
            if params[0]=='0x0':return {'hash':'0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'}
            return head.copy()
        b={
            '/eth/v1/beacon/genesis':{'genesis_validators_root':'0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'},
            '/eth/v1/config/spec':{'DEPOSIT_CHAIN_ID':'1','SECONDS_PER_SLOT':'12','FULU_FORK_EPOCH':'411392'},
            '/eth/v1/node/version':{'version':'Lighthouse/v8.3.2-x'},
            '/eth/v1/node/syncing':{'is_syncing':False,'is_optimistic':False,'el_offline':False},
            '/eth/v1/node/identity':{'metadata':{'custody_group_count':'64'}},
            '/eth/v2/beacon/blocks/head':{'message':{'body':{'execution_payload':{'block_number':'256','block_hash':'0xabc'}}}},
            '/eth/v1/beacon/headers/head':{'header':{'message':{'slot':'1000'}}},
            '/eth/v2/beacon/blocks/999':{'message':{'body':{'blob_kzg_commitments':['one','two']}}},
            '/eth/v1/beacon/blobs/999':['one','two']}
        return rpc,b,head
    def test_healthy_pair_has_blob_evidence(self):
        rpc,b,_=self.data()
        with patch.object(c,'rpc',side_effect=rpc),patch.object(c,'beacon',side_effect=b.__getitem__):self.assertEqual(c.l1_ready()['blobSlot'],999)
    def test_missing_blob_is_not_readiness(self):
        rpc,b,_=self.data();b['/eth/v1/beacon/blobs/999']=['one']
        with patch.object(c,'rpc',side_effect=rpc),patch.object(c,'beacon',side_effect=b.__getitem__):
            with self.assertRaisesRegex(AssertionError,'blob data unavailable'):c.l1_ready()
    def test_optimistic_pair_is_not_readiness(self):
        rpc,b,_=self.data();b['/eth/v1/node/syncing']['is_optimistic']=True
        with patch.object(c,'rpc',side_effect=rpc),patch.object(c,'beacon',side_effect=b.__getitem__):
            with self.assertRaisesRegex(AssertionError,'consensus not ready'):c.l1_ready()
    def test_stale_pair_is_not_readiness(self):
        rpc,b,h=self.data();h['timestamp']=hex(int(time.time())-500)
        with patch.object(c,'rpc',side_effect=rpc),patch.object(c,'beacon',side_effect=b.__getitem__):
            with self.assertRaisesRegex(AssertionError,'head stale'):c.l1_ready()


SNAPSHOT_PROFILE = ('[prune]\nblock_interval = 5\n\n[prune.segments]\nsender_recovery = "full"\ntransaction_lookup = "full"\n\n'
    + ''.join(f'[prune.segments.{n}]\ndistance = 140000\n\n' for n in ('receipts', 'account_history', 'storage_history', 'bodies_history'))
    + '[static_files.blocks_per_file]\nheaders = 500000\n')
# Exact [prune] section the pinned base binary wrote offline after a lookup-flag-only launch (prune-recovery-stage logs).
DEFECT_PROFILE = ('[prune]\nblock_interval = 5\nminimum_pruning_distance = 10064\n\n[prune.segments.transaction_lookup]\n'
                  'distance = 140000\n\n[static_files.blocks_per_file]\nheaders = 500000\n')
FLAG_SEGMENT = {'sender-recovery': 'sender_recovery', 'transaction-lookup': 'transaction_lookup', 'receipts': 'receipts',
                'account-history': 'account_history', 'storage-history': 'storage_history', 'bodies': 'bodies_history'}

def client_persists_prune(profile_text, argv):
    """Model of pinned save_pruning_config (base/reth 7134be3 launch/common.rs:190-212; offline-reproduced):
    CLI PruneConfig starts from default {block_interval 5, minimum 10064, no segments}; if any --prune.* flag is
    given and it differs from the toml prune section, the WHOLE section is replaced and the file saved."""
    doc = c.tomllib.loads(profile_text)
    cli, seen, i = {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {}}, False, 0
    while i < len(argv):
        f = argv[i]
        if f.startswith('--prune.'):
            seen = True
            parts = f[len('--prune.'):].split('.')
            if parts == ['block-interval']: cli['block_interval'] = int(argv[i + 1]); i += 1
            elif parts == ['minimum-distance']: cli['minimum_pruning_distance'] = int(argv[i + 1]); i += 1
            elif parts[1] == 'full': cli['segments'][FLAG_SEGMENT[parts[0]]] = 'full'
            elif parts[1] == 'distance': cli['segments'][FLAG_SEGMENT[parts[0]]] = {'distance': int(argv[i + 1])}; i += 1
            elif parts[1] == 'before': cli['segments'][FLAG_SEGMENT[parts[0]]] = {'before': int(argv[i + 1])}; i += 1
            else: raise AssertionError('flag outside the model: ' + f)
        i += 1
    if seen and doc.get('prune') != cli:
        doc['prune'] = cli
    return doc

def render(doc):
    p = doc['prune']
    out = ['[prune]', f"block_interval = {p['block_interval']}"]
    if 'minimum_pruning_distance' in p: out.append(f"minimum_pruning_distance = {p['minimum_pruning_distance']}")
    seg = p.get('segments', {})
    plain = {k: v for k, v in seg.items() if isinstance(v, str)}
    if plain: out += ['[prune.segments]'] + [f'{k} = "{v}"' for k, v in plain.items()]
    for k, v in seg.items():
        if isinstance(v, dict): out += [f'[prune.segments.{k}]'] + [f'{m} = {n}' for m, n in v.items()]
    out += ['[static_files.blocks_per_file]'] + [f'{k} = {v}' for k, v in doc['static_files']['blocks_per_file'].items()]
    return '\n'.join(out) + '\n'

EXPECTED_PRUNE = ['--prune.block-interval', '5', '--prune.minimum-distance', '10064', '--prune.sender-recovery.full',
                  '--prune.receipts.distance', '140000', '--prune.account-history.distance', '140000',
                  '--prune.storage-history.distance', '140000', '--prune.bodies.distance', '140000',
                  '--prune.transaction-lookup.distance', '140000']
INTENDED = {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {
    'sender_recovery': 'full', 'transaction_lookup': {'distance': 140000},
    **{n: {'distance': 140000} for n in ('receipts', 'account_history', 'storage_history', 'bodies_history')}}}

HISTORY_FROM = 48_000_000       # option B: whole file 96 holding the legacy EnclaveAddressBook creation (48,322,938, external)
STATE_FROM = 52_500_000         # changeset file 105, kept until the authenticated bootstrap completes
EXPECTED_BASE_PRUNE = ['--prune.block-interval', '5', '--prune.minimum-distance', '10064', '--prune.sender-recovery.full',
                       '--prune.receipts.before', str(HISTORY_FROM), '--prune.account-history.before', str(STATE_FROM),
                       '--prune.storage-history.before', str(STATE_FROM), '--prune.bodies.before', str(HISTORY_FROM),
                       '--prune.transaction-lookup.before', str(HISTORY_FROM)]
INTENDED_BASE = {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {
    'sender_recovery': 'full', 'transaction_lookup': {'before': HISTORY_FROM}, 'receipts': {'before': HISTORY_FROM},
    'bodies_history': {'before': HISTORY_FROM}, **{n: {'before': STATE_FROM} for n in ('account_history', 'storage_history')}}}
BOUND_HASH = '0x' + 'ab' * 32
BOUND = {'l1Block': 1, 'blobSlot': 2, 'toBlock': 20000, 'safeL1Origin': {'number': 3601, 'hash': BOUND_HASH},
         'snapshot': {'block': 53_048_526}}

class PruneProfileTests(unittest.TestCase):
    def launch(self, side, profile_text):
        mnt = '/srv/enclave-base-holder' if side == 'base' else '/srv/enclave-l1-pair'
        cfg = {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2}, 'baseRetention': {'historyFromBlock': HISTORY_FROM, 'stateHistoryFromBlock': STATE_FROM}}
        beacon = {'/eth/v2/beacon/blocks/2': {'message': {'body': {'blob_kzg_commitments': ['x']}}}, '/eth/v1/beacon/blobs/2': ['x']}
        with patch.object(c, 'mount', return_value=mnt), patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=profile_text), patch.object(c, 'binary', side_effect=lambda n: '/pinned/' + n), \
                patch.object(c, 'CONFIG', cfg), patch.object(c, 'coverage_activation', return_value=BOUND), \
                patch.object(c, 'history_files_present'), patch.object(c, 'segment_files_present'), \
                patch.object(c, 'l1_ready', return_value={'l1Finalized': 30000}), \
                patch.object(c, 'rpc', side_effect=lambda port, m, p: {'hash': BOUND_HASH} if m == 'eth_getBlockByNumber' else []), \
                patch.object(c, 'beacon', side_effect=beacon.__getitem__), patch.object(c.os, 'execve', side_effect=Executed) as exe:
            with self.assertRaises(Executed):
                c.run(side)
        return exe.call_args.args[1]

    def prune_part(self, argv):
        return [a for i, a in enumerate(argv) if a.startswith('--prune.') or (i and argv[i - 1].startswith('--prune.') and not a.startswith('--'))]

    def test_snapshot_profile_maps_to_complete_flags(self):
        self.assertEqual(c.prune_args(c.tomllib.loads(SNAPSHOT_PROFILE)), EXPECTED_PRUNE)

    def test_persisted_rewrite_then_second_launch_keeps_every_segment(self):
        # L1 keeps the distance profile; Base keeps receipts/bodies/lookup from the reviewed absolute block.
        for side, expected, intended in (('el', EXPECTED_PRUNE, INTENDED), ('base', EXPECTED_BASE_PRUNE, INTENDED_BASE)):
            with self.subTest(side=side):
                first = self.launch(side, SNAPSHOT_PROFILE)
                self.assertEqual(self.prune_part(first), expected)
                self.assertFalse({'--full', '--minimal'} & set(first))
                persisted = client_persists_prune(SNAPSHOT_PROFILE, first)
                self.assertEqual(persisted['prune'], intended)
                second = self.launch(side, render(persisted))
                self.assertEqual(self.prune_part(second), expected)
                third = client_persists_prune(render(persisted), second)
                self.assertEqual(third['prune'], intended)   # fixed point: no further loss across restarts

    def test_old_lookup_only_argv_reproduces_the_defect(self):
        persisted = client_persists_prune(SNAPSHOT_PROFILE, ['--prune.transaction-lookup.distance', '140000'])
        self.assertEqual(c.tomllib.loads(render(persisted))['prune'], c.tomllib.loads(DEFECT_PROFILE)['prune'])
        for side in ('el', 'base'):
            with self.assertRaisesRegex(AssertionError, 'snapshot prune profile missing'):
                self.launch(side, render(persisted))

    def test_already_rewritten_profile_is_refused_not_waived(self):
        for side in ('el', 'base'):
            with self.subTest(side=side), self.assertRaisesRegex(AssertionError, 'snapshot prune profile missing'):
                self.launch(side, DEFECT_PROFILE)

    def test_larger_retention_is_never_reduced(self):
        text = SNAPSHOT_PROFILE.replace('distance = 140000', 'distance = 200000').replace('block_interval = 5', 'block_interval = 7\nminimum_pruning_distance = 20000')
        args = c.prune_args(c.tomllib.loads(text))
        self.assertEqual(args.count('200000'), 4)
        self.assertEqual(args[:4], ['--prune.block-interval', '7', '--prune.minimum-distance', '20000'])
        self.assertEqual(client_persists_prune(text, args)['prune']['segments']['receipts'], {'distance': 200000})

    def test_settings_the_cli_cannot_reproduce_are_refused(self):
        cases = {'before mode': (SNAPSHOT_PROFILE.replace('[prune.segments.receipts]\ndistance', '[prune.segments.receipts]\nbefore'), 'retention too short'),
                 'short distance': (SNAPSHOT_PROFILE.replace('distance = 140000', 'distance = 139999', 1), 'retention too short'),
                 'log filter': (SNAPSHOT_PROFILE + '[prune.segments.receipts_log_filter]\n"0x00000000000000000000000000000000000000aa" = "full"\n', 'log filter'),
                 'unknown key': (SNAPSHOT_PROFILE.replace('block_interval = 5', 'block_interval = 5\nfuture_knob = 1'), 'unsupported prune setting'),
                 'sender distance': (SNAPSHOT_PROFILE.replace('sender_recovery = "full"', 'sender_recovery = { distance = 140000 }'), 'profile missing'),
                 'lookup short': (SNAPSHOT_PROFILE.replace('transaction_lookup = "full"', 'transaction_lookup = { distance = 10 }'), 'lookup retention')}
        for name, (text, msg) in cases.items():
            with self.subTest(name), self.assertRaisesRegex(AssertionError, msg):
                c.prune_args(c.tomllib.loads(text))


class BaseRetentionTests(unittest.TestCase):
    """Base history from the reviewed block: whole-file layout, never reduced, fail-closed when absent."""
    PROFILE = SNAPSHOT_PROFILE.replace('headers = 500000', 'headers = 500000\nreceipts = 500000\ntransactions = 500000'
                                       '\naccount_change_sets = 500000\nstorage_change_sets = 500000')

    def args(self, text, hf=HISTORY_FROM, sf=STATE_FROM):
        return c.prune_args(c.tomllib.loads(text), hf, sf)

    def test_downloader_profile_upgrades_to_before(self):
        self.assertEqual(self.args(self.PROFILE), EXPECTED_BASE_PRUNE)

    def test_before_at_or_below_start_is_kept_never_raised(self):
        text = self.PROFILE.replace('[prune.segments.receipts]\ndistance = 140000', '[prune.segments.receipts]\nbefore = 47000000')
        a = self.args(text)
        self.assertEqual(a[a.index('--prune.receipts.before') + 1], '47000000')
        for seg, flag in (('receipts', 'receipts'), ('bodies_history', 'bodies')):
            bad = self.PROFILE.replace(f'[prune.segments.{seg}]\ndistance = 140000', f'[prune.segments.{seg}]\nbefore = {HISTORY_FROM + 1}')
            with self.subTest(seg), self.assertRaisesRegex(AssertionError, 'would drop required Base history'):
                self.args(bad)

    def test_unreviewed_base_profiles_refused(self):
        cases = {'receipts full': self.PROFILE.replace('[prune.segments.receipts]\ndistance = 140000\n', '').replace('transaction_lookup = "full"', 'transaction_lookup = "full"\nreceipts = "full"'),
                 'short distance': self.PROFILE.replace('[prune.segments.bodies_history]\ndistance = 140000', '[prune.segments.bodies_history]\ndistance = 139999'),
                 'larger distance (never silently reduced)': self.PROFILE.replace('[prune.segments.receipts]\ndistance = 140000', '[prune.segments.receipts]\ndistance = 900000'),
                 'lookup before above start': self.PROFILE.replace('transaction_lookup = "full"', f'transaction_lookup = {{ before = {HISTORY_FROM + 5} }}')}
        for name, text in cases.items():
            with self.subTest(name), self.assertRaises(AssertionError):
                self.args(text)

    def test_l1_profile_unchanged_and_before_still_refused_without_history_policy(self):
        self.assertEqual(c.prune_args(c.tomllib.loads(SNAPSHOT_PROFILE)), EXPECTED_PRUNE)
        with self.assertRaisesRegex(AssertionError, 'retention too short'):
            c.prune_args(c.tomllib.loads(render({'prune': INTENDED_BASE, 'static_files': {'blocks_per_file': {'headers': 500000}}})))

    def test_history_start_config_required(self):
        for cfg in ({}, {'baseRetention': {}}, {'baseRetention': {'historyFromBlock': 0}},
                    {'baseRetention': {'historyFromBlock': True}}, {'baseRetention': {'historyFromBlock': '52515705'}}):
            with self.subTest(cfg=cfg), self.assertRaisesRegex(AssertionError, 'not configured'):
                c.history_from_block(cfg)
        self.assertIsNone(c.history_from_block({}, required=False))
        self.assertEqual(c.history_from_block({'baseRetention': {'historyFromBlock': HISTORY_FROM}}), HISTORY_FROM)

    def test_static_files_covering_start_must_exist(self):
        import tempfile, shutil
        d = tempfile.mkdtemp(prefix='ret-', dir=__import__('os').environ.get('TEST_TMP'))
        try:
            prof = c.tomllib.loads(self.PROFILE)
            (Path(d) / 'static_files').mkdir()
            with self.assertRaisesRegex(AssertionError, f'receipts history from block {HISTORY_FROM} absent'):
                c.history_files_present(d, prof, HISTORY_FROM)
            # names exactly as the real manifest's chunk_output_files (static_files/static_file_<seg>_<start>_<end>)
            (Path(d) / 'static_files' / 'static_file_receipts_48000000_48499999').write_bytes(b'')
            with self.assertRaisesRegex(AssertionError, f'transactions history from block {HISTORY_FROM} absent'):
                c.history_files_present(d, prof, HISTORY_FROM)
            (Path(d) / 'static_files' / 'static_file_transactions_48000000_48499999').write_bytes(b'')
            c.history_files_present(d, prof, HISTORY_FROM)
            # a datadir whose 52.5M file was already pruned (lowest file 53M) is refused
            with self.assertRaisesRegex(AssertionError, 'absent'):
                c.history_files_present(d, prof, 53_100_000)          # its file (53,000,000-53,499,999) is absent
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_base_start_requires_retention_and_files_after_coverage(self):
        cfg = {'baseBootstrap': {'coverageVerified': True}}
        with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=self.PROFILE), patch.object(c, 'CONFIG', cfg), \
                patch.object(c, 'coverage_activation', return_value=BOUND), patch.object(c, 'l1_ready') as ready:
            with self.assertRaisesRegex(AssertionError, 'not configured'):
                c.run('base')
            ready.assert_not_called()
        cfg = {'baseBootstrap': {'coverageVerified': True}, 'baseRetention': {'historyFromBlock': HISTORY_FROM, 'stateHistoryFromBlock': STATE_FROM}}
        with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', autospec=True, side_effect=lambda p: not str(p).startswith('/srv/enclave-base-holder/data/static_files')), \
                patch.object(Path, 'read_text', return_value=self.PROFILE), patch.object(c, 'CONFIG', cfg), \
                patch.object(c, 'coverage_activation', return_value=BOUND), patch.object(c, 'l1_ready') as ready:
            with self.assertRaisesRegex(AssertionError, 'refusing to serve incomplete history'):
                c.run('base')
            ready.assert_not_called()


class BootstrapStateTests(unittest.TestCase):
    """Option B + bootstrap state history: changesets kept from STATE_FROM, bounded by the verified snapshot block."""
    PROFILE = BaseRetentionTests.PROFILE
    SINCE = (PROFILE.replace('[prune.segments.receipts]\ndistance = 140000', f'[prune.segments.receipts]\nbefore = {HISTORY_FROM}')
             .replace('[prune.segments.bodies_history]\ndistance = 140000', f'[prune.segments.bodies_history]\nbefore = {HISTORY_FROM}')
             .replace('[prune.segments.account_history]\ndistance = 140000', f'[prune.segments.account_history]\nbefore = {STATE_FROM}')
             .replace('[prune.segments.storage_history]\ndistance = 140000', f'[prune.segments.storage_history]\nbefore = {STATE_FROM}'))

    def test_cached_since_download_profile_is_a_fixed_point(self):
        # the profile the reviewed --with-*-since run writes (download/config_gen.rs:217-243,263): lookup stays "full"
        a = c.prune_args(c.tomllib.loads(self.SINCE), HISTORY_FROM, STATE_FROM)
        self.assertEqual(a, EXPECTED_BASE_PRUNE)
        persisted = client_persists_prune(self.SINCE, a)
        self.assertEqual(persisted['prune'], INTENDED_BASE)
        self.assertEqual(c.prune_args(c.tomllib.loads(render(persisted)), HISTORY_FROM, STATE_FROM), EXPECTED_BASE_PRUNE)

    def test_state_history_before_policy(self):
        a = c.prune_args(c.tomllib.loads(self.PROFILE), HISTORY_FROM, STATE_FROM)       # distance 140000 upgraded
        self.assertEqual(a[a.index('--prune.account-history.before') + 1], str(STATE_FROM))
        keep = self.SINCE.replace(f'[prune.segments.storage_history]\nbefore = {STATE_FROM}', '[prune.segments.storage_history]\nbefore = 52000000')
        a = c.prune_args(c.tomllib.loads(keep), HISTORY_FROM, STATE_FROM)               # earlier before preserved
        self.assertEqual(a[a.index('--prune.storage-history.before') + 1], '52000000')
        for seg in ('account_history', 'storage_history'):
            bad = self.SINCE.replace(f'[prune.segments.{seg}]\nbefore = {STATE_FROM}', f'[prune.segments.{seg}]\nbefore = {STATE_FROM + 1}')
            with self.subTest(seg), self.assertRaisesRegex(AssertionError, 'would drop required Base history'):
                c.prune_args(c.tomllib.loads(bad), HISTORY_FROM, STATE_FROM)
        big = self.PROFILE.replace('[prune.segments.account_history]\ndistance = 140000', '[prune.segments.account_history]\ndistance = 900000')
        with self.assertRaisesRegex(AssertionError, 'not reviewed'):
            c.prune_args(c.tomllib.loads(big), HISTORY_FROM, STATE_FROM)

    def test_state_start_required_and_bounded_by_snapshot(self):
        for cfg in ({'baseRetention': {'historyFromBlock': HISTORY_FROM}},
                    {'baseRetention': {'historyFromBlock': HISTORY_FROM, 'stateHistoryFromBlock': 0}},
                    {'baseRetention': {'historyFromBlock': HISTORY_FROM, 'stateHistoryFromBlock': True}}):
            with self.subTest(cfg=cfg), self.assertRaisesRegex(AssertionError, 'state history start'):
                c.state_history_from_block(cfg)
        self.assertIsNone(c.state_history_from_block({}, required=False))
        for hf, sf in ((HISTORY_FROM, 53_048_527), (53_048_527, STATE_FROM)):
            cfg = {'baseBootstrap': {'coverageVerified': True}, 'baseRetention': {'historyFromBlock': hf, 'stateHistoryFromBlock': sf}}
            with self.subTest(hf=hf, sf=sf), patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), \
                    patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', return_value=self.PROFILE), \
                    patch.object(c, 'CONFIG', cfg), patch.object(c, 'coverage_activation', return_value=BOUND), \
                    patch.object(c, 'l1_ready') as ready:
                with self.assertRaisesRegex(AssertionError, 'above the verified snapshot block'):
                    c.run('base')
                ready.assert_not_called()
        cfg = {'baseBootstrap': {'coverageVerified': True}, 'baseRetention': {'historyFromBlock': HISTORY_FROM}}
        with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=self.PROFILE), patch.object(c, 'CONFIG', cfg), \
                patch.object(c, 'coverage_activation', return_value=BOUND), patch.object(c, 'l1_ready') as ready:
            with self.assertRaisesRegex(AssertionError, 'state history start'):
                c.run('base')
            ready.assert_not_called()

    def test_base_start_refuses_missing_changesets_even_with_history_files(self):
        cfg = {'baseBootstrap': {'coverageVerified': True}, 'baseRetention': {'historyFromBlock': HISTORY_FROM, 'stateHistoryFromBlock': STATE_FROM}}
        present = lambda p: 'change-sets' not in str(p)        # receipts/transactions files exist, changeset files do not
        with patch.object(c, 'mount', return_value='/srv/enclave-base-holder'), patch.object(Path, 'is_file', autospec=True, side_effect=present), \
                patch.object(Path, 'read_text', return_value=self.PROFILE), patch.object(c, 'CONFIG', cfg), \
                patch.object(c, 'coverage_activation', return_value=BOUND), patch.object(c, 'l1_ready') as ready:
            with self.assertRaisesRegex(AssertionError, 'account-change-sets history from block 52500000 absent'):
                c.run('base')
            ready.assert_not_called()

    def test_state_files_exact_manifest_names(self):
        import tempfile, shutil, os
        d = tempfile.mkdtemp(prefix='st-', dir=os.environ.get('TEST_TMP'))
        try:
            prof = c.tomllib.loads(self.PROFILE)
            (Path(d) / 'static_files').mkdir()
            with self.assertRaisesRegex(AssertionError, 'account-change-sets history from block 52500000 absent'):
                c.segment_files_present(d, prof, STATE_FROM, c.STATE_FILES)
            (Path(d) / 'static_files' / 'static_file_account-change-sets_52500000_52999999').write_bytes(b'')
            with self.assertRaisesRegex(AssertionError, 'storage-change-sets history from block 52500000 absent'):
                c.segment_files_present(d, prof, STATE_FROM, c.STATE_FILES)
            (Path(d) / 'static_files' / 'static_file_storage-change-sets_52500000_52999999').write_bytes(b'')
            c.segment_files_present(d, prof, STATE_FROM, c.STATE_FILES)
            with self.assertRaisesRegex(AssertionError, 'state_change|account_change_sets static-file size missing'):
                c.segment_files_present(d, {'static_files': {'blocks_per_file': {}}}, STATE_FROM, c.STATE_FILES)
        finally:
            shutil.rmtree(d, ignore_errors=True)

if __name__=='__main__':unittest.main()
