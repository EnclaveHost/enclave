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

if __name__=='__main__':unittest.main()
