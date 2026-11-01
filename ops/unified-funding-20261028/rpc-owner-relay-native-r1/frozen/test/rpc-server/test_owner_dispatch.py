import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

SOURCE=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('dispatch_owner',SOURCE/'rpc/server/dispatch_owner.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
c=d.c


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['RPC_OWNER_TEST_ROOT']);self.root=Path(self.tmp.name);self.root.chmod(0o700)
        self.addCleanup(self.tmp.cleanup)
        self.attempt=uuid.uuid4().hex
        parent=self.root/'clocks';parent.mkdir(mode=0o700)
        begin=c.begin(parent,self.attempt,'rpc-owned-fixture-'+self.attempt,uuid.uuid4().hex);b=c.protocol.decode(c.read_pinned(begin))
        sample=c.write_new(self.root/'sample',c.encode({'schema':'owned-rpc-windows-clock/1','attempt':self.attempt,'vmAttempt':b['vmAttempt'],'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000}))
        self.clock=c.finish(begin,sample)
        self.outputs=self.root/'outputs';self.outputs.mkdir(mode=0o700);self.out=self.outputs/self.attempt
        self.journal=self.root/'journal';self.journal.mkdir(mode=0o700)
        state=self.root/'state';state.mkdir(mode=0o700)
        request={'appId':'a'*64,'nonce':'b'*64};request_sha=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(',',':')).encode()).hexdigest();self.request_sha=request_sha
        observer=self.root/'observer.json';observer.write_text('{}');observer.chmod(0o600)
        argv=['/usr/bin/node',str(d.HERE/'observe_resources.mjs'),str(observer)]
        contract={'attempt':self.attempt,'startupClock':self.clock,'appControl':{'requestSha256':request_sha},'stateParent':str(state),'floorMiB':27648,'resourceArgv':argv,'sourcePins':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in argv}}
        cb=c.write_new(self.root/'contract',c.encode(contract));self.contract=contract;self.cb=cb
        policy={'export':{'contractSha256':cb['sha256']}};pb=c.write_new(self.root/'policy',c.encode(policy));self.policy=policy
        cfg={'attempt':self.attempt,'clock':self.clock,'contract':cb,'policy':pb,'journal':str(self.journal),'binary':{'path':'/not-executed','sha256':'c'*64},'receipt':str(self.out/'signer-started.json')};cfg['ownerProvision']={'path':str(self.root/'authority.json'),'sha256':'e'*64};self.cfg=cfg
        eb=c.write_new(self.root/'entry',c.encode(cfg))
        rb=c.write_new(self.root/'request',c.encode({'bundle':'ZHVtbXk=','manifest':'e30=','request':request}))
        paths={str(p) for p in d.HERE.parent.rglob('*.py')}|{'/usr/bin/python3','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/bwrap','/usr/bin/node'}
        self.config={'schema':'enclave-rpc-owner-dispatch/1','entry':eb,'request':rb,'outputParent':str(self.outputs),'pins':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}}
        self.proof={'schema':'enclave-rpc-storage-consent/2','export':policy['export']}
        self.signs=0;self.starts=0;self.mode='ok'

    def signer(self,args,fd,deadline):
        self.assertTrue((self.out/'signer-submit.intent').exists());self.assertFalse((self.out/'export-submit.intent').exists());self.signs+=1
        if self.mode=='signer-ambiguous':raise TimeoutError('mocked lost signer response')
        raw=json.dumps(self.proof).encode()
        file=self.journal/('proof-'+self.request_sha);file.write_bytes(raw);file.chmod(0o400)
        c.write_new(self.out/'signer-started.json',c.encode({'attempt':self.attempt,'clock':self.clock,'contract':self.cb,'binary':self.cfg['binary'],'unit':{'Id':'enclave-rpc-owner-sign-'+self.attempt+'.service'}}))
        return raw if self.mode!='bad-proof' else b'{}'

    def start(self,*args):
        self.assertTrue((self.out/'signer-result.json').exists());self.assertTrue((self.out/'export-submit.intent').exists());self.starts+=1
        if self.mode=='export-ambiguous':raise TimeoutError('mocked lost provider response')
        folder=Path(self.contract['stateParent'])/self.attempt;folder.mkdir(mode=0o700)
        c.write_new(folder/'control-listening.json',c.encode({'contractSha256':self.cb['sha256'],'requestSha256':self.request_sha,'bound':False,'rpcReady':False}))
        class Lease:
            def check(self):return {'invocation':'d'*32,'pid':123,'start':'1234','unit':'mocked-only'}
            def close(self):pass
        return Lease()

    def invoke(self):
        resource={'authenticated':True,'unreadUnits':0,'availableMiB':40000,'pendingMiB':0,'floorMiB':18432}
        if self.mode=='low-reserve':resource['availableMiB']=27648
        class Response:stdout=json.dumps(resource).encode()
        real_load=d.load
        class Owner:
            @staticmethod
            def inspect(*args):pass
        owner=Owner()
        class Startup:pass
        startup=Startup();startup.start_export=self.start
        with patch.object(d,'dispatcher_envelope',return_value={}),patch.object(d,'load',side_effect=lambda name,path:startup if name=='rpc_owner_startup' else owner if name=='rpc_dispatch_owner_state' else real_load(name,path)),patch.object(d.subprocess,'run',return_value=Response()),patch.object(d,'run_signer',side_effect=self.signer):
            return d.dispatch(self.config)

    def test_ordered_persistence_before_ack_and_no_repeat(self):
        result=self.invoke();self.assertFalse(result['rpcReady']);self.assertFalse(result['reservationMayRelease'])
        self.assertEqual((self.signs,self.starts),(1,1));self.assertTrue((self.out/'response.json').exists())
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual((self.signs,self.starts),(1,1))

    def test_ambiguous_signer_stays_held_without_export(self):
        self.mode='signer-ambiguous'
        with self.assertRaises(TimeoutError):self.invoke()
        self.assertTrue((self.out/'signer-submit.intent').exists());self.assertEqual(self.starts,0)
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual(self.signs,1)

    def test_ambiguous_export_stays_held_without_ack(self):
        self.mode='export-ambiguous'
        with self.assertRaises(TimeoutError):self.invoke()
        self.assertTrue((self.out/'export-submit.intent').exists());self.assertFalse((self.out/'response.json').exists())
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual((self.signs,self.starts),(1,1))

    def test_wrong_proof_cannot_submit_export(self):
        self.mode='bad-proof'
        with self.assertRaises(ValueError):self.invoke()
        self.assertEqual((self.signs,self.starts),(1,0))

    def test_full_pending_aware_reserve_before_submission(self):
        self.mode='low-reserve'
        with self.assertRaises(ValueError):self.invoke()
        self.assertEqual((self.signs,self.starts),(0,0));self.assertFalse(self.out.exists())

    def test_changed_runtime_pin_before_submission(self):
        self.config['pins'][str(d.HERE/'dispatch_owner.py')]='f'*64
        with self.assertRaises(ValueError):self.invoke()
        self.assertEqual((self.signs,self.starts),(0,0))


if __name__=='__main__':unittest.main()
