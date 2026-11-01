import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import unittest

S=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('owner_inputs',S/'rpc/server/owner_bootstrap_inputs.py')
c=load('clock',S/'rpc/startup_clock.py')

class EnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(dir='/run');cls.root=Path(cls.tmp.name);cls.root.chmod(0o700)
        subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','ed25519','-nodes','-keyout',str(cls.root/'key'),' -out'.strip(),str(cls.root/'server-cert.pem'),'-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE'],capture_output=True,check=True,timeout=3)
        (cls.root/'server-cert.pem').chmod(0o600)
        cls.der=ssl.PEM_cert_to_DER_cert((cls.root/'server-cert.pem').read_text())
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def setUp(self):
        self.folder=Path(tempfile.mkdtemp(dir=self.root));self.folder.chmod(0o700)
        request=copy.deepcopy(json.loads(Path(os.environ['RPC_BOOTSTRAP_VECTOR_DIR'],'bootstrap-vector.json').read_text())['evidence']['request'])
        self.prepared={'request':request,'bundle':base64.b64encode(b'dummy').decode(),'manifest':base64.b64encode(b'{}').decode()}
        request['appId']=hashlib.sha256(b'dummy').hexdigest()
        digest=hashlib.sha256(c.encode(request).strip()).hexdigest();client=hashlib.sha256(self.der).hexdigest()
        self.contract={'appControl':{'requestSha256':digest,'clientCertificateSha256':client,'host':'192.0.2.1','port':10902,'tls':str(self.root)}}
        self.policy={'schema':'enclave-rpc-storage-owner/1','runtime':'a'*64,'l1Volume':request['l1Volume'],'baseVolume':request['baseVolume'],'chainId':8453,'ledger':'0x'+'1'*40,'rpcs':['https://owner.example'],'confirmations':2,'maxAgeSeconds':30,'export':{'host':'192.0.2.1','port':10902,'contractSha256':'e'*64,'clientCertificateSha256':client,'serverCertificateSha256':client}}
        self.original={'windowsOriginMilliseconds':10000,'windowsDeadlineMilliseconds':910000}
        self.row={'token':'1'*128,'vmGuid':'11111111-2222-3333-4444-555555555555','ownershipReceiptSha256':'b'*64,'originalOriginMs':'10000','originalDeadlineMs':'910000','enrollment':{'info':{'purpose':'enclave-rpc-storage-bootstrap/1','request':request,'requestSha256':digest,'runtime':{},'transportKey':'not-tested-in-python','certificate':base64.b64encode(self.der).decode(),'rootsGranted':False,'rpcReady':False},'keys':{}}}
        self.cfg={'bootstrapPolicy':c.write_new(self.folder/'policy',c.encode({'schema':'enclave-rpc-bootstrap-policy/1'}))}
    def invoke(self):
        self.cfg['enrollment']=c.write_new(self.folder/('enrollment-'+str(len(list(self.folder.iterdir())))),c.encode(self.row))
        return m.prepare(c,self.cfg,self.original,self.prepared,self.contract,self.policy,'e'*64)
    def test_owner_derives_broker_authorities_and_exact_delivery(self):
        session,enrollment,delivery=self.invoke()
        self.assertEqual(session['request'],self.prepared['request']);self.assertEqual(session['runtime'],self.policy['runtime'])
        self.assertEqual(enrollment['receiptSha256'],self.cfg['enrollment']['sha256'])
        broker=json.loads(base64.b64decode(delivery['policy']))
        for key in ('chainId','ledger','rpcs','confirmations','maxAgeSeconds'):self.assertEqual(broker[key],self.policy[key])
        self.assertEqual(broker['manifest'],self.prepared['manifest']);self.assertEqual(base64.b64decode(delivery['exportServerDer']),self.der)
        self.assertNotIn('key',delivery);self.assertFalse(session['request']=={})
    def test_changed_or_extended_original_clock_refused(self):
        for key in ('originalOriginMs','originalDeadlineMs'):
            old=self.row[key];self.row[key]=str(int(old)+1)
            with self.assertRaisesRegex(ValueError,'clock'):self.invoke()
            self.row[key]=old
    def test_request_and_client_substitution_refused(self):
        self.row['enrollment']['info']['request']=dict(self.prepared['request'],nonce='f'*64)
        with self.assertRaisesRegex(ValueError,'request'):self.invoke()
        self.row['enrollment']['info']['request']=self.prepared['request'];self.policy['export']['clientCertificateSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'binding'):self.invoke()
    def test_export_certificate_volume_and_bundle_substitution_refused(self):
        self.policy['export']['serverCertificateSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'certificate'):self.invoke()
        self.policy['export']['serverCertificateSha256']=hashlib.sha256(self.der).hexdigest();self.policy['l1Volume']='f'*64
        with self.assertRaisesRegex(ValueError,'volume'):self.invoke()
        self.policy['l1Volume']=self.prepared['request']['l1Volume'];self.prepared['bundle']='Zm9yZWlnbg=='
        with self.assertRaisesRegex(ValueError,'bundle'):self.invoke()
    def test_ungranted_candidate_and_pinned_namespace_required(self):
        self.row['enrollment']['info']['rootsGranted']=True
        with self.assertRaises(ValueError):self.invoke()
        self.row['enrollment']['info']['rootsGranted']=False;self.invoke()
        Path(self.cfg['enrollment']['path']).write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'changed'):m.prepare(c,self.cfg,self.original,self.prepared,self.contract,self.policy,'e'*64)

if __name__=='__main__':unittest.main()
