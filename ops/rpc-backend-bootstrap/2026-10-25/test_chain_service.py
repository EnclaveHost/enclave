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
        if isinstance(v, dict): out += [f'[prune.segments.{k}]', f"distance = {v['distance']}"]
    out += ['[static_files.blocks_per_file]'] + [f'{k} = {v}' for k, v in doc['static_files']['blocks_per_file'].items()]
    return '\n'.join(out) + '\n'

EXPECTED_PRUNE = ['--prune.block-interval', '5', '--prune.minimum-distance', '10064', '--prune.sender-recovery.full',
                  '--prune.receipts.distance', '140000', '--prune.account-history.distance', '140000',
                  '--prune.storage-history.distance', '140000', '--prune.bodies.distance', '140000',
                  '--prune.transaction-lookup.distance', '140000']
INTENDED = {'block_interval': 5, 'minimum_pruning_distance': 10064, 'segments': {
    'sender_recovery': 'full', 'transaction_lookup': {'distance': 140000},
    **{n: {'distance': 140000} for n in ('receipts', 'account_history', 'storage_history', 'bodies_history')}}}

class PruneProfileTests(unittest.TestCase):
    def launch(self, side, profile_text):
        mnt = '/srv/enclave-base-holder' if side == 'base' else '/srv/enclave-l1-pair'
        cfg = {'baseBootstrap': {'coverageVerified': True, 'l1Block': 1, 'blobSlot': 2}}
        beacon = {'/eth/v2/beacon/blocks/2': {'message': {'body': {'blob_kzg_commitments': ['x']}}}, '/eth/v1/beacon/blobs/2': ['x']}
        with patch.object(c, 'mount', return_value=mnt), patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'read_text', return_value=profile_text), patch.object(c, 'binary', side_effect=lambda n: '/pinned/' + n), \
                patch.object(c, 'CONFIG', cfg), patch.object(c, 'l1_ready'), patch.object(c, 'rpc', return_value=[]), \
                patch.object(c, 'beacon', side_effect=beacon.__getitem__), patch.object(c.os, 'execve', side_effect=Executed) as exe:
            with self.assertRaises(Executed):
                c.run(side)
        return exe.call_args.args[1]

    def prune_part(self, argv):
        return [a for i, a in enumerate(argv) if a.startswith('--prune.') or (i and argv[i - 1].startswith('--prune.') and not a.startswith('--'))]

    def test_snapshot_profile_maps_to_complete_flags(self):
        self.assertEqual(c.prune_args(c.tomllib.loads(SNAPSHOT_PROFILE)), EXPECTED_PRUNE)

    def test_persisted_rewrite_then_second_launch_keeps_every_segment(self):
        for side in ('el', 'base'):
            with self.subTest(side=side):
                first = self.launch(side, SNAPSHOT_PROFILE)
                self.assertEqual(self.prune_part(first), EXPECTED_PRUNE)
                self.assertFalse({'--full', '--minimal'} & set(first))
                persisted = client_persists_prune(SNAPSHOT_PROFILE, first)
                self.assertEqual(persisted['prune'], INTENDED)
                second = self.launch(side, render(persisted))
                self.assertEqual(self.prune_part(second), EXPECTED_PRUNE)
                third = client_persists_prune(render(persisted), second)
                self.assertEqual(third['prune'], INTENDED)   # fixed point: no further loss across restarts

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

if __name__=='__main__':unittest.main()
