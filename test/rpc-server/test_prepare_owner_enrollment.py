"""Actual protected preparation/entry FD composition; native/systemd/chain mocked."""
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
from types import SimpleNamespace
import unittest
from unittest.mock import patch

S=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
b=load('bootstrap_entry',S/'rpc/server/owner_bootstrap_entry.py');c=b.c
m=load('prepare_enrollment',S/'rpc/server/prepare_owner_enrollment.py')
f=load('export_fixture',S/'test/rpc-server/test_startup_export.py')

class Preparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(dir='/run');cls.base=Path(cls.tmp.name);cls.base.chmod(0o700)
        subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','ed25519','-nodes','-keyout',str(cls.base/'key'),'-out',str(cls.base/'cert'),'-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE'],capture_output=True,check=True,timeout=3)
        cls.der=ssl.PEM_cert_to_DER_cert((cls.base/'cert').read_text())
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def setUp(self):
        self.environment=patch.dict(os.environ,{'RPC_TEST_ROOT':str(self.base)});self.environment.start();self.addCleanup(self.environment.stop)
        self.fixture=f.Composition();self.fixture.setUp();self.addCleanup(self.fixture.tearDown)
        self.export=self.fixture.export_config();self.root=self.fixture.root;self.original=c.validate(self.export['clock'])
        source=str(S/'rpc/server/app_control.py');self.export['runtimePins'][source]=hashlib.sha256(Path(source).read_bytes()).hexdigest()
        self.count=0
        bundle=b'public inert bundle fixture'
        scope={'appId':hashlib.sha256(bundle).hexdigest(),'deployment':'0x'+'b'*64,'profile':'c'*64,'l1Volume':'d'*64,'baseVolume':'e'*64}
        request={**scope,'schema':'enclave-rpc-storage-acquire/1','boot':'11111111-2222-3333-4444-555555555555','nonce':'f'*64,'originMonotonicNs':1000,'deadlineMonotonicNs':900000001000}
        info={'purpose':'enclave-rpc-storage-bootstrap/1','request':request,'requestSha256':hashlib.sha256(c.encode(request).strip()).hexdigest(),'runtime':{},'transportKey':'unused-before-attestation','certificate':base64.b64encode(self.der).decode(),'rootsGranted':False,'rpcReady':False}
        self.enrollment={'token':'a'*128,'vmGuid':'11111111-2222-3333-4444-555555555555','ownershipReceiptSha256':'f'*64,'originalOriginMs':str(self.original['windowsOriginMilliseconds']),'originalDeadlineMs':str(self.original['windowsDeadlineMilliseconds']),'enrollment':{'info':info,'keys':{}}}
        policy={'schema':'enclave-rpc-storage-owner/1','runtime':'a'*64,'l1Volume':scope['l1Volume'],'baseVolume':scope['baseVolume'],'chainId':8453,'ledger':'0x'+'1'*40,'rpcs':['https://owner.invalid'],'confirmations':2,'maxAgeSeconds':30}
        authority=self.root/'authority';authority.mkdir(mode=0o700);(authority/'journal').mkdir(mode=0o700)
        keys={}
        for role,byte in [('l1',b'x'),('base',b'y')]:
            c.write_new(authority/(role+'-seed'),byte*32);st=(authority/(role+'-seed')).stat();keys[role]={'publicKey':('1' if role=='l1' else '2')*64,'identity':[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns]}
        identity=lambda p:[p.stat().st_dev,p.stat().st_ino]
        descriptor={'schema':'enclave-rpc-owner-state/1','root':identity(authority),'parent':identity(self.root),'journal':identity(authority/'journal'),'roles':{role:{'volumeId':scope[role+'Volume'],'originals':self.export['roles'][role]['originals']} for role in ('l1','base')},'keys':keys,'provisionAttempt':'a'*32}
        self.template={'schema':'enclave-rpc-owner-enrollment-preparation/1','scope':scope,'native':{k:self.enrollment[k] for k in ('vmGuid','ownershipReceiptSha256')},'bundle':self.write(bundle),'manifest':self.write(b'{}'),'exportPreparation':self.write(self.export),'control':{'host':'192.0.2.1','port':10902,'serverKey':self.write((self.base/'key').read_bytes()),'serverCert':self.write((self.base/'cert').read_bytes())},'policy':self.write(policy),'ownerProvision':c.write_new(authority/'authority.json',c.encode(descriptor)),'binary':self.write(b'inert signer not executed')}
        self.config={'schema':'enclave-rpc-owner-bootstrap-entry/3','clock':self.export['clock'],'enrollment':self.write(self.enrollment),'bootstrapPolicy':self.write({'schema':'enclave-rpc-bootstrap-policy/1'}),'listen':{'host':'192.0.2.1','port':10903,'serverName':'localhost','key':self.template['control']['serverKey'],'cert':self.template['control']['serverCert']},'pins':{n:hashlib.sha256(Path(n).read_bytes()).hexdigest() for n in b.closure()}}
        self.out=Path(self.export['clock']['path']).parent/'owner-enrollment'
        self.resource={'authenticated':True,'unreadUnits':0,'availableMiB':50000,'pendingMiB':2000,'floorMiB':18432}
    def write(self,value):
        self.count+=1;return c.write_new(self.root/('input-'+str(self.count)),value if isinstance(value,bytes) else c.encode(value))
    def invoke(self):
        self.config['preparation']=self.write(self.template)
        entry=SimpleNamespace(c=c,e=b.e,HERE=b.HERE,envelope=lambda original:None,verify_pins=b.verify_pins,load_owner_state=b.load_owner_state)
        with patch('subprocess.run',return_value=SimpleNamespace(stdout=c.encode(self.resource),stderr=b'')):
            return m.prepare(entry,self.config,self.original)
    def test_actual_export_signer_dispatcher_relay_and_enrollment_bind_same_request(self):
        value=self.invoke();self.assertEqual(value['schema'],'enclave-rpc-owner-bootstrap-entry/2')
        relay=c.protocol.decode(c.read_pinned(value['relay']));dispatch=c.protocol.decode(c.read_pinned(relay['dispatcher']));signer=c.protocol.decode(c.read_pinned(dispatch['entry']))
        prepared=json.loads(Path(dispatch['request']['path']).read_bytes());contract=c.protocol.decode(c.read_pinned(signer['contract']));policy=c.protocol.decode(c.read_pinned(signer['policy']))
        self.assertEqual(prepared['request'],self.enrollment['enrollment']['info']['request']);self.assertEqual(signer['clock'],self.config['clock']);self.assertEqual(signer['ownerProvision'],self.template['ownerProvision'])
        self.assertEqual(contract['startupClock'],self.config['clock']);self.assertEqual(policy['export']['contractSha256'],signer['contract']['sha256']);self.assertEqual(contract['appControl']['clientCertificateSha256'],hashlib.sha256(self.der).hexdigest())
        self.assertEqual(ssl.PEM_cert_to_DER_cert(Path(contract['appControl']['tls'],'ca-cert.pem').read_text()),self.der)
        inputs=load('inputs',S/'rpc/server/owner_bootstrap_inputs.py');session,_,delivery=inputs.prepare(c,value,self.original,prepared,contract,policy,signer['contract']['sha256'])
        self.assertEqual(session['request'],prepared['request']);self.assertNotIn('PRIVATE KEY',json.dumps(delivery));self.assertFalse((self.out/'dispatches'/self.original['attempt']).exists())
        with self.assertRaises(FileExistsError):self.invoke()
    def test_explicit_stream_preparation_preserves_original_authorities(self):
        self.config['schema']='enclave-rpc-owner-bootstrap-entry/4'
        policy=c.protocol.decode(c.read_pinned(self.template['policy']));policy['schema']='enclave-rpc-storage-owner/2';self.template['policy']=self.write(policy)
        value=self.invoke();self.assertEqual(value['schema'],'enclave-rpc-owner-bootstrap-entry/5')
        relay=c.protocol.decode(c.read_pinned(value['relay']));dispatch=c.protocol.decode(c.read_pinned(relay['dispatcher']));signer=c.protocol.decode(c.read_pinned(dispatch['entry']))
        self.assertEqual([relay['schema'],dispatch['schema'],signer['schema']],['enclave-rpc-owner-relay/2','enclave-rpc-owner-dispatch/2','enclave-rpc-owner-entry/2'])
        policy=c.protocol.decode(c.read_pinned(signer['policy']));self.assertEqual(policy['schema'],'enclave-rpc-storage-owner/2')
        self.assertEqual(signer['ownerProvision'],self.template['ownerProvision']);self.assertEqual(signer['clock'],self.config['clock'])
        inputs=load('stream_inputs',S/'rpc/server/owner_bootstrap_inputs.py');prepared=c.protocol.decode(c.read_pinned(dispatch['request']));contract=c.protocol.decode(c.read_pinned(signer['contract']))
        journal=Path(self.template['ownerProvision']['path']).parent/'journal';row=journal.stat()
        self.assertEqual(contract['appControl']['schema'],'enclave-rpc-export-control/2')
        self.assertEqual(contract['appControl']['ownerJournal'],{'path':str(journal),'device':row.st_dev,'inode':row.st_ino})
        inputs.prepare(c,value,self.original,prepared,contract,policy,signer['contract']['sha256'])
        with self.assertRaisesRegex(ValueError,'policy required'):inputs.prepare(c,dict(value,schema='enclave-rpc-owner-bootstrap-entry/2'),self.original,prepared,contract,policy,signer['contract']['sha256'])

    def test_stream_preparation_cannot_promote_one_shot_owner_policy(self):
        self.config['schema']='enclave-rpc-owner-bootstrap-entry/4'
        with self.assertRaisesRegex(ValueError,'owner policy'):self.invoke()
        self.assertFalse(self.out.exists())

    def test_scope_and_original_windows_refused_before_consumption(self):
        for change in ({'originalDeadlineMs':'1'},{'vmGuid':'99999999-2222-3333-4444-555555555555'}):
            self.config['enrollment']=self.write({**self.enrollment,**change})
            with self.assertRaisesRegex(ValueError,'binding differs'):self.invoke()
            self.assertFalse(self.out.exists())
        changed=copy.deepcopy(self.enrollment);changed['enrollment']['info']['request']['l1Volume']='8'*64;self.config['enrollment']=self.write(changed)
        with self.assertRaisesRegex(ValueError,'scope'):self.invoke()
        self.assertFalse(self.out.exists())
    def test_pending_commitments_refuse_before_private_key_or_output(self):
        self.resource.update(availableMiB=32000,pendingMiB=4000)
        with patch.object(b.e,'held',side_effect=AssertionError('No key or payload read before admission')):
            with self.assertRaisesRegex(ValueError,'admission refused'):self.invoke()
        self.assertFalse(self.out.exists())
    def test_changed_private_key_retains_consumed_preparation(self):
        Path(self.template['control']['serverKey']['path']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed'):self.invoke()
        self.assertTrue((self.out/'prepare.intent').exists());self.assertFalse((self.out/'RESULT.json').exists())
        with self.assertRaises(FileExistsError):self.invoke()
    def test_original_volume_substitution_cannot_choose_another_journal(self):
        Path(self.export['roles']['l1']['originals'][0][0]).write_bytes(b'changed original')
        with self.assertRaisesRegex(ValueError,'volume identity'):self.invoke()
        self.assertFalse(self.out.exists())
    def test_actual_stream_entry_seals_selected_protocol_and_original_clock(self):
        self.config['schema']='enclave-rpc-owner-bootstrap-entry/4'
        policy=c.protocol.decode(c.read_pinned(self.template['policy']));policy['schema']='enclave-rpc-storage-owner/2';self.template['policy']=self.write(policy)
        self.test_actual_v3_entry_composes_and_seals_original_inputs()

    def test_actual_v3_entry_composes_and_seals_original_inputs(self):
        self.config['preparation']=self.write(self.template);path=self.write(self.config)['path'];result=self.root/'sealed-result'
        pid=os.fork()
        if pid==0:
            try:
                def execute(exe,args,env):
                    value=json.loads(os.pread(3,os.fstat(3).st_size,0));self.assertEqual(exe,'/usr/bin/node');self.assertEqual(value['request'],self.enrollment['enrollment']['info']['request']);self.assertEqual(value['original']['deadlineMonotonicNs'],self.original['deadlineMonotonicNs']);self.assertEqual(value['ownerProtocol'],2 if self.config['schema']=='enclave-rpc-owner-bootstrap-entry/4' else 1);self.assertNotIn('PRIVATE KEY',json.dumps(value));self.assertEqual(os.read(6,32),b'x'*32);self.assertEqual(os.read(7,32),b'y'*32)
                    with self.assertRaises(PermissionError):os.write(3,b'bad')
                    result.write_text('PASS');os._exit(0)
                with patch.object(b,'envelope',return_value={}),patch('subprocess.run',return_value=SimpleNamespace(stdout=c.encode(self.resource),stderr=b'')),patch.object(b.os,'execve',side_effect=execute):b.main(path)
                os._exit(2)
            except BaseException:
                import traceback;traceback.print_exc();os._exit(1)
        _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),0);self.assertEqual(result.read_text(),'PASS')

if __name__=='__main__':unittest.main(verbosity=2)
