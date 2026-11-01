"""Real pipes/config preparation/atomic offer collection; service and proof fixture."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
S=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('exchange',S/'rpc/server/owner_bootstrap_exchange.py');c=m.c
f=load('preparation_fixture',S/'test/rpc-server/test_prepare_owner_enrollment.py')

class Exchange(unittest.TestCase):
    @classmethod
    def setUpClass(cls):f.Preparation.setUpClass()
    @classmethod
    def tearDownClass(cls):f.Preparation.tearDownClass()
    def setUp(self):
        self.fixture=f.Preparation();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        for p in self.fixture.fixture.patches:p.stop()
        self.original=c.validate(self.fixture.config['clock']);self.parent=Path(self.fixture.config['clock']['path']).parent
        owner={k:v for k,v in self.fixture.config.items() if k!='enrollment'};owner['preparation']=self.fixture.write(self.fixture.template)
        self.config={'schema':'enclave-rpc-owner-exchange/1','native':{'original':'8'*64,'plan':'9'*64},'owner':owner}
        self.frame={'schema':'native-rpc-bootstrap-enrollment/1',**self.config['native'],'enrollmentSha256':'7'*64,'enrollment':self.fixture.enrollment}
        self.start=time.monotonic_ns();self.invocation=patch.dict(os.environ,{'INVOCATION_ID':'a'*32});self.invocation.start();self.addCleanup(self.invocation.stop)
        self.identity={'Id':'enclave-rpc-owner-bootstrap-'+self.original['attempt']+'.service','MainPID':str(os.getpid()),'InvocationID':'b'*32,'ControlGroup':'/fixture-owner'}
        self.submissions=[]
    def show(self,unit):
        if unit==self.identity['Id']:return self.identity
        return {'Id':unit,'MainPID':str(os.getpid()),'InvocationID':'a'*32,'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:],
          'Type':'exec','RuntimeMaxUSec':'20s','TimeoutStopUSec':'1s','MemoryMax':str(128<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s',
          'TasksMax':'32','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0','ExecMainStartTimestampMonotonic':str(self.start//1000)}
    def submit(self,binding,original):
        self.submissions.append(binding)
        self.assertTrue((self.parent/'bootstrap-exchange'/'submit.intent').exists())
        owner=c.protocol.decode(c.read_pinned(binding))
        entry=SimpleNamespace(c=c,e=m.b.e,HERE=m.HERE,envelope=lambda _:None,verify_pins=m.b.verify_pins,load_owner_state=m.b.load_owner_state)
        result=f.m.prepare(entry,owner,original)
        prepared=c.protocol.decode(c.read(self.parent/'owner-enrollment'/'RESULT.json'))
        c.write_new(self.parent/'bootstrap-entry.intent',c.encode({'clock':owner['clock'],'relay':result['relay'],'unit':self.identity}))
        folder=self.parent/'bootstrap';folder.mkdir(mode=0o700)
        info=self.frame['enrollment']['enrollment']['info'];client=hashlib.sha256(base64.b64decode(info['certificate'])).hexdigest()
        enrolled={'receiptSha256':owner['enrollment']['sha256'],'requestSha256':info['requestSha256'],'certificateSha256':client,'guestAuthenticated':False,'rootsGranted':False,'rpcReady':False}
        c.write_new(folder/'enrollment.json',c.encode(enrolled))
        offer={'proof':{'offer':{'requestSha256':info['requestSha256'],'clientCertificateSha256':client},'signatures':'INERT-NOT-SIGNED'},'ownerServerDer':info['certificate'],'exportServerDer':info['certificate'],'policy':'e30='}
        # Same actual final publication operations as the Node publisher.
        c.write_new(folder/'host-offer.pending',c.encode(offer));os.link(folder/'host-offer.pending',folder/'host-offer.json');os.unlink(folder/'host-offer.pending');c.sync_directory(folder)
    def invoke(self,frame=None,submit=None,extra=b'',fragmented=False):
        raw=c.encode(self.frame if frame is None else frame);wire=struct.pack('!I',len(raw))+raw+extra
        r,w=os.pipe();out,write=os.pipe();child=None
        try:
            if fragmented:
                child=os.fork()
                if child==0:
                    os.close(r);os.close(out);os.close(write)
                    for i in range(0,len(wire),37):os.write(w,wire[i:i+37]);time.sleep(.001)
                    os.close(w);os._exit(0)
            else:os.write(w,wire)
            os.close(w);w=None
            with patch.object(m.b.e,'show',side_effect=self.show),patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=c.encode(self.fixture.resource),stderr=b'',returncode=0)),patch.object(m,'submit',side_effect=submit or self.submit):
                result=m.run(self.config,r,write)
            os.close(write);write=None;data=os.read(out,131076)
            self.assertEqual(struct.unpack('!I',data[:4])[0],len(data)-4)
            return result,m.decode(data[4:])
        finally:
            for fd in (r,w,out,write):
                if fd is not None:os.close(fd)
            if child:
                _,status=os.waitpid(child,0);self.assertEqual(os.waitstatus_to_exitcode(status),0)
    def test_fragmented_native_frame_actual_preparation_and_atomic_offer(self):
        result,response=self.invoke(fragmented=True)
        self.assertEqual(response['enrollmentSha256'],'7'*64);self.assertFalse(result['rpcReady']);self.assertEqual(len(self.submissions),1)
        nested=json.loads(c.read_pinned(json.loads(c.read_pinned(self.submissions[0]))['enrollment']))
        self.assertEqual(nested,self.fixture.enrollment)
        persisted=c.protocol.decode(c.read(self.parent/'bootstrap-exchange'/'submit.intent'))
        self.assertNotEqual(persisted['enrollment']['sha256'],response['enrollmentSha256'])
        self.assertEqual(c.protocol.decode(c.read(self.parent/'bootstrap-exchange'/'response.json')),response)
        with self.assertRaisesRegex(ValueError,'already consumed'):self.invoke()
        self.assertEqual(len(self.submissions),1)
    def test_wrong_original_and_trailing_input_do_not_submit(self):
        bad=copy.deepcopy(self.frame);bad['original']='6'*64
        with self.assertRaisesRegex(ValueError,'frame differs'):self.invoke(bad)
        self.assertFalse(self.submissions);self.assertTrue((self.parent/'bootstrap-exchange'/'ingress.intent').exists())
    def test_extra_input_consumed_without_submission(self):
        with self.assertRaisesRegex(ValueError,'One enrollment'):self.invoke(extra=b'x')
        self.assertFalse(self.submissions);self.assertFalse((self.parent/'bootstrap-exchange'/'submit.intent').exists())
    def test_lost_submission_response_is_held_without_retry(self):
        def lost(binding,original):
            self.submissions.append(binding);self.assertTrue((self.parent/'bootstrap-exchange'/'submit.intent').exists());raise TimeoutError('transport lost')
        with self.assertRaises(TimeoutError):self.invoke(submit=lost)
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual(len(self.submissions),1);self.assertFalse((self.parent/'bootstrap-exchange'/'response.json').exists())
    def test_changed_offer_enrollment_or_service_cannot_acknowledge(self):
        def changed(binding,original):
            self.submit(binding,original);path=self.parent/'bootstrap'/'enrollment.json';value=json.loads(path.read_bytes());value['receiptSha256']='6'*64;path.write_bytes(c.encode(value))
        with self.assertRaisesRegex(ValueError,'another enrollment'):self.invoke(submit=changed)
        self.assertFalse((self.parent/'bootstrap-exchange'/'response.json').exists())
    def test_wrong_independent_service_limit_refuses_before_ingress(self):
        original=self.show
        def weakened(unit):return {**original(unit),'MemoryMax':str(256<<20)}
        self.show=weakened
        with self.assertRaisesRegex(ValueError,'envelope differs'):self.invoke()
        self.assertFalse((self.parent/'bootstrap-exchange').exists())
    def test_real_submit_uses_fixed_independent_owner_service_once(self):
        binding={'path':str(self.parent/'pinned-entry.json'),'sha256':'f'*64}
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as run:m.submit(binding,self.original)
        args=run.call_args.args[0]
        self.assertEqual(args[:3],['/usr/bin/systemd-run','--user','--quiet']);self.assertIn('--property=RuntimeMaxSec=120',args);self.assertIn('--property=MemoryMax=256M',args);self.assertIn('--property=Restart=no',args);self.assertNotIn('--wait',args);self.assertEqual(args[-1],binding['path']);self.assertEqual(run.call_count,1)
    def test_duplicate_native_fields_are_refused(self):
        with self.assertRaisesRegex(ValueError,'Duplicate'):m.decode(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(ValueError,'Finite'):m.decode(b'{"a":NaN}')

if __name__=='__main__':unittest.main(verbosity=2)
