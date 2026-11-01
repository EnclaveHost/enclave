"""Real pipes/subprocesses/files. Chain, exporter and systemd are mocked."""
import base64,hashlib,importlib.util,json,os,select,struct,sys,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import test_owner_dispatch as fixture
spec=importlib.util.spec_from_file_location('live_stream',HERE.parents[1]/'rpc/server/owner_signer_stream.py')
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
d=fixture.d;c=d.c
spec=importlib.util.spec_from_file_location('stream_relay',HERE.parents[1]/'rpc/server/relay_owner.py')
relay=importlib.util.module_from_spec(spec);spec.loader.exec_module(relay)

class Pipes(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['RPC_OWNER_TEST_ROOT']);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
    def start(self,mode='normal',seconds=2):
        p=self.root/'cfg';p.write_text(json.dumps({'mode':mode}))
        s=live.LiveSigner(['/usr/bin/python3','-B',str(HERE/'owner_stream_fixture.py'),str(p)],time.monotonic()+seconds)
        self.addCleanup(s.close);return s
    def test_two_frames_same_live_process(self):
        s=self.start();pid=s.proc.pid
        for value in (b'initial',b'next'):
            self.assertEqual(s.exchange(value,2048,time.monotonic()+1),value);self.assertEqual(pid,s.proc.pid);self.assertIsNone(s.proc.poll())
        s.close();self.assertIsNotNone(s.proc.poll())
    def test_output_faults_close_without_respawn(self):
        for mode in ('die','oversize','truncated','stderr'):
            with self.subTest(mode=mode):
                s=self.start(mode)
                with self.assertRaises((ValueError,TimeoutError)):s.exchange(b'x',2048,time.monotonic()+.4)
                s.close();self.assertIsNotNone(s.proc.poll())
    def test_original_deadline_even_blocked_write(self):
        s=self.start('no-read',.1);start=time.monotonic()
        with self.assertRaises(TimeoutError):s.exchange(b'x'*(1<<20),2048,time.monotonic()+2)
        self.assertLess(time.monotonic()-start,.4)
    def test_unsolicited_single_byte_and_idle_death(self):
        s=self.start('unsolicited');self.assertEqual(s.exchange(b'x',2048,time.monotonic()+1),b'x')
        with self.assertRaises(ValueError):
            until=time.monotonic()+.3
            while time.monotonic()<until:s.check()
        s.close()
    def test_peer_eof_observes_signer_loss(self):
        s=self.start();s.exchange(b'x',2048,time.monotonic()+1)
        r,w=os.pipe();self.addCleanup(os.close,r);os.close(w)
        with self.assertRaises(ValueError):s.read_peer(r,1024,time.monotonic()+.5)
    def test_partial_peer_frame_obeys_original_deadline(self):
        s=self.start(seconds=.15);s.exchange(b'x',2048,time.monotonic()+1)
        r,w=os.pipe();self.addCleanup(os.close,r);self.addCleanup(os.close,w);os.write(w,b'\x00')
        with self.assertRaises(TimeoutError):s.read_peer(r,1024,time.monotonic()+2)

class Envelopes(unittest.TestCase):
    def test_derived_stream_runtime_and_exact_actual_cutoff(self):
        start=time.monotonic_ns();original={'deadlineMonotonicNs':start+100_000_000_000}
        self.assertIn(d.entry.stream_runtime(original),(96,97))
        d.entry.stream_envelope({'RuntimeMaxUSec':'1min 36s','ExecMainStartTimestampMonotonic':str(start//1000)},original)
        for text in ('infinity','2min','1min 40s','0s','99.9s','1h'):
            with self.subTest(text=text),self.assertRaises(ValueError):d.entry.stream_envelope({'RuntimeMaxUSec':text,'ExecMainStartTimestampMonotonic':str(start//1000)},original)
        with self.assertRaises(ValueError):d.entry.stream_runtime({'deadlineMonotonicNs':start+10_000_000_000})

class DispatchStream(unittest.TestCase):
    def setUp(self):
        self.f=fixture.DispatchTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        f=self.f;f.policy['schema']='enclave-rpc-storage-owner/2'
        f.cfg.update(schema='enclave-rpc-owner-entry/2',policy=c.write_new(f.root/'policy2',c.encode(f.policy)))
        f.config.update(schema='enclave-rpc-owner-dispatch/2',entry=c.write_new(f.root/'entry2',c.encode(f.cfg)))
        self.relay=Path(f.clock['path']).parent/'relay';self.relay.mkdir(mode=0o700)
        self.processes=[]
    def invoke(self,mode='normal',bad=False,through_relay=False,preparation=None):
        f=self.f;resource={'authenticated':True,'unreadUnits':0,'availableMiB':40000,'pendingMiB':0,'floorMiB':18432}
        class Response:stdout=json.dumps(resource).encode()
        class Owner:
            @staticmethod
            def inspect(*args):pass
        class Startup:pass
        startup=Startup();startup.start_export=f.start
        started={'attempt':f.attempt,'clock':f.clock,'contract':f.cb,'binary':f.cfg['binary'],'unit':{'Id':'enclave-rpc-owner-sign-stream-'+f.attempt+'.service'}}
        original_load=d.load;actual=live.LiveSigner
        def make(args,deadline):
            self.assertTrue((f.out/'signer-submit.intent').exists());self.assertIn('--property=MemoryMax=128M',args)
            self.assertIn('--property=MemorySwapMax=0',args);self.assertTrue(any(x.startswith('--property=RuntimeMaxSec=') and x!='--property=RuntimeMaxSec=20' for x in args))
            cfg=c.write_new(f.root/'stub-config',c.encode({'mode':mode,'journal':str(f.journal),'output':str(f.out),'proof':f.proof,'requestSha':f.request_sha,'started':started}))
            s=actual(['/usr/bin/python3','-B',str(HERE/'owner_stream_fixture.py'),cfg['path']],deadline)
            self.processes.append(s);return s
        class Streaming:LiveSigner=staticmethod(make)
        if through_relay:
            self.relay.rmdir()
            relay_config={'schema':'enclave-rpc-owner-relay/2','dispatcher':c.write_new(f.root/'dispatch2',c.encode(f.config))}
        src,writer=os.pipe();reader,sink=os.pipe();errors=[];replies=[]
        def receive():
            def exact(n):
                result=b'';until=time.monotonic()+3
                while len(result)<n:
                    if time.monotonic()>until:raise TimeoutError('fixture receive')
                    if not select.select([reader],[],[],.05)[0]:continue
                    chunk=os.read(reader,n-len(result))
                    if not chunk:raise EOFError()
                    result+=chunk
                return result
            def frame():return exact(struct.unpack('!I',exact(4))[0])
            try:
                if through_relay:
                    initial=c.read_pinned(f.config['request']).strip();os.write(writer,struct.pack('!I',len(initial))+initial)
                first=frame();replies.append(first);value=json.loads(first)
                raw=base64.b64decode(value['proof']);self.assertEqual(raw,(f.journal/('proof-'+f.request_sha)).read_bytes())
                self.assertEqual(first,c.read(self.relay/'response.json'));previous=hashlib.sha256(raw).hexdigest()
                for sequence in (1,2):
                    p={'schema':'enclave-rpc-continuation/1','phase':'serving' if bad else 'startup','sequence':sequence,'previousSha256':previous,'readinessSha256':'','issuedAt':int(time.time()),'notAfter':int(time.time())+30}
                    raw=json.dumps(p,separators=(',',':')).encode();os.write(writer,struct.pack('!I',len(raw))+raw)
                    reply=frame();replies.append(reply);previous=hashlib.sha256(reply).hexdigest()
                    self.assertEqual(reply,c.read(f.out/('continuation-%016x-proof'%sequence)))
                    if sequence==1 and preparation:
                        observation=b'ERPCRD01'+b'x'*144
                        prep={'schema':'enclave-rpc-serving-prepare/1','sequence':sequence,'previousSha256':previous,'observation':base64.b64encode(observation).decode()}
                        if preparation=='wrong-link':prep['previousSha256']='e'*64
                        if preparation=='short':prep['observation']=base64.b64encode(observation[:-1]).decode()
                        raw=json.dumps(prep,separators=(',',':')).encode();os.write(writer,struct.pack('!I',len(raw))+raw)
                        prepared=frame();replies.append(prepared)
                        self.assertEqual(prepared,c.read(f.out/'serving-prepare-proof'))
                        self.assertEqual(json.loads(prepared)['requestSha256'],hashlib.sha256(raw).hexdigest())
                        if preparation=='replay':
                            os.write(writer,struct.pack('!I',len(raw))+raw);frame();raise AssertionError('preparation replay acknowledged')
                        # The startup chain link deliberately remains unchanged.

            except EOFError:pass
            except Exception as e:errors.append(e)
            finally:os.close(writer);os.close(reader)
        thread=threading.Thread(target=receive);thread.start()
        try:
            with patch.object(relay,'d',d),patch.object(d,'dispatcher_envelope',return_value={'ExecMainStartTimestampMonotonic':str(time.monotonic_ns()//1000)}),patch.object(d,'load',side_effect=lambda name,path:startup if name=='rpc_owner_startup' else Owner if name=='rpc_dispatch_owner_state' else Streaming if name=='rpc_owner_signer_stream' else original_load(name,path)),patch.object(d.subprocess,'run',return_value=Response()):
                with self.assertRaises((ValueError,FileNotFoundError)):
                    if through_relay:relay.run(relay_config,src,sink)
                    else:d.dispatch(f.config,stream_io=(src,sink))
        finally:
            os.close(src);os.close(sink);thread.join(4)
        self.assertFalse(thread.is_alive());self.assertFalse(errors,errors);self.assertEqual(len(self.processes),1);self.assertIsNotNone(self.processes[0].proc.poll())
        return replies
    def test_live_signer_proof_and_two_permits_then_eof_held(self):
        replies=self.invoke();self.assertEqual(len(replies),3);self.assertEqual(self.f.starts,1)
        self.assertTrue((self.f.out/'signer-submit.intent').exists());self.assertTrue((self.f.out/'export-submit.intent').exists())
    def test_actual_relay_enters_stream_dispatch_without_waiting_for_exit(self):
        replies=self.invoke(through_relay=True);self.assertEqual(len(replies),3)
        self.assertTrue((self.relay/'ingress.intent').exists());self.assertTrue((self.relay/'dispatch.intent').exists())
        self.assertEqual(self.f.starts,1)

    def test_unpersisted_continuation_never_acknowledged(self):
        replies=self.invoke('missing-journal');self.assertEqual(len(replies),1)
        self.assertTrue((self.f.out/'continuation-0000000000000001-submit').exists());self.assertFalse((self.f.out/'continuation-0000000000000001-proof').exists())
    def test_serving_request_refused_before_signer_write(self):
        replies=self.invoke(bad=True);self.assertEqual(len(replies),1)
        self.assertFalse((self.f.out/'continuation-0000000000000001-submit').exists())
    def test_serving_preparation_same_original_actor_and_startup_chain(self):
        replies=self.invoke(through_relay=True,preparation='normal')
        self.assertEqual(len(replies),4);self.assertEqual(self.f.starts,1)
        self.assertTrue((self.f.out/'serving-prepare-submit').exists())
        self.assertTrue((self.f.out/'continuation-0000000000000002-proof').exists())
    def test_serving_preparation_requires_original_durable_response(self):
        for mode in ('missing-prepare-journal','bad-prepare-response'):
            # Each test case needs its own original consumed namespace.
            with self.subTest(mode=mode):
                obj=DispatchStream();obj.setUp()
                try:
                    replies=obj.invoke(mode=mode,preparation='normal');self.assertEqual(len(replies),2)
                    self.assertFalse((obj.f.out/'serving-prepare-proof').exists())
                finally:obj.doCleanups()
    def test_serving_preparation_replay_and_wrong_scope_refused(self):
        for mode,count in (('replay',3),('wrong-link',2),('short',2)):
            with self.subTest(mode=mode):
                obj=DispatchStream();obj.setUp()
                try:self.assertEqual(len(obj.invoke(preparation=mode)),count)
                finally:obj.doCleanups()

    def test_stream_requires_real_pipes_before_submission(self):
        with self.assertRaises(ValueError):d.dispatch(self.f.config)
        self.assertFalse(self.f.out.exists())

if __name__=='__main__':unittest.main()
