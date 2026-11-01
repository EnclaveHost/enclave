"""Original clock/envelope checks and actual subprocess pipes. Systemd, chain
and exporter are mocked; no production service or owner authority is created.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

S=Path(__file__).resolve().parents[2]
def load(name):
    spec=importlib.util.spec_from_file_location(name,S/'rpc/server'/f'{name}.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
b=load('owner_bootstrap_entry');q=load('owner_bootstrap_submit');c=b.c

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/run');self.root=Path(self.tmp.name);self.root.chmod(0o700);self.addCleanup(self.tmp.cleanup)
        self.attempt=uuid.uuid4().hex
        begin=c.begin(self.root,self.attempt,'rpc-bootstrap-fixture-'+self.attempt,uuid.uuid4().hex);row=c.protocol.decode(c.read_pinned(begin))
        sample=c.write_new(self.root/'sample',c.encode({'schema':'owned-rpc-windows-clock/1','attempt':self.attempt,'vmAttempt':row['vmAttempt'],'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000}))
        self.clock=c.finish(begin,sample);self.original=c.validate(self.clock)
        self.parent=Path(self.clock['path']).parent
        (self.parent/'bootstrap').mkdir(mode=0o700);(self.parent/'relay').mkdir(mode=0o700)
        self.raw=b'{"prepared":"synthetic"}'
        c.write_new(self.parent/'bootstrap/dispatch.intent',c.encode({'wireSha256':hashlib.sha256(self.raw).hexdigest()}))
        relay=c.write_new(self.root/'relay.json',c.encode({'schema':'enclave-rpc-owner-relay/1','dispatcher':{'path':'unused-controlled-fixture','sha256':'a'*64}}))
        self.cfg={'clock':self.clock,'original':{**{k:self.original[k] for k in ('attempt','originMonotonicNs','deadlineMonotonicNs')},'boot':self.original['bootId']},'relay':relay,'pins':{},'prepared':self.raw.decode()}
        self.reply={'schema':'enclave-rpc-owner-dispatched/1','attempt':self.attempt,'rpcReady':False,'writersFenced':False,'reservationMayRelease':False}
    def invoke(self,mode='normal'):
        cfg=b.sealed(self.cfg);self.addCleanup(os.close,cfg)
        real_popen=subprocess.Popen;started=[]
        reply=json.dumps(self.reply,sort_keys=True,separators=(',',':')).encode()+b'\n'
        script='''import os,stat,sys,struct
assert all(stat.S_ISFIFO(os.fstat(n).st_mode) for n in (0,1,2))
head=sys.stdin.buffer.read(4);n=struct.unpack('!I',head)[0];raw=sys.stdin.buffer.read(n)
assert raw==bytes.fromhex(sys.argv[1]);assert sys.stdin.buffer.read(1)==b''
reply=bytes.fromhex(sys.argv[2])
if sys.argv[4]!='lost':
 if sys.argv[4]!='undurable':
  with open(sys.argv[3],'xb') as f: f.write(reply);f.flush();os.fsync(f.fileno())
  os.chmod(sys.argv[3],0o600)
 sys.stdout.buffer.write(struct.pack('!I',len(reply))+reply);sys.stdout.buffer.flush()
else: sys.exit(7)
'''
        def launch(args,**kw):
            self.assertTrue((self.parent/'bootstrap/relay-submit.intent').exists());started.append(args)
            self.assertEqual(args[-2],str(S/'rpc/server/relay_owner.py'));self.assertIn('--property=RuntimeMaxSec=60',args);self.assertIn('--property=MemoryMax=256M',args)
            return real_popen(['/usr/bin/python3','-B','-c',script,self.raw.hex(),reply.hex(),str(self.parent/'relay/response.json'),mode],**kw)
        real_fstat=os.fstat;real_pread=os.pread;real_fcntl=q.fcntl.fcntl
        output=io.BytesIO();writer=io.TextIOWrapper(output)
        # Map helper's fixed FD3 calls to a real sealed memfd without overwriting
        # the test runner's own descriptors. Actual child stdio remains pipes.
        with patch.object(q.os,'fstat',side_effect=lambda fd:real_fstat(cfg if fd==3 else fd)),patch.object(q.os,'pread',side_effect=lambda fd,n,o:real_pread(cfg if fd==3 else fd,n,o)),patch.object(q.fcntl,'fcntl',side_effect=lambda fd,op,*a:real_fcntl(cfg if fd==3 else fd,op,*a)),patch.object(q.b,'verify_pins'),patch.object(q.subprocess,'Popen',side_effect=launch),patch.object(q.sys,'stdout',writer):
            try:q.run();return output.getvalue(),started
            finally:writer.detach()
    def test_actual_pipes_durable_ack_and_no_repeat(self):
        result,started=self.invoke();self.assertEqual(len(started),1);self.assertEqual(int.from_bytes(result[:4],'big'),len(result)-4)
        self.assertEqual((self.parent/'bootstrap/response.json').read_bytes(),result[4:])
        with self.assertRaises(FileExistsError):self.invoke()
    def test_lost_submission_retains_intent_without_response_or_retry(self):
        with self.assertRaisesRegex(ValueError,'refused'):self.invoke('lost')
        self.assertTrue((self.parent/'bootstrap/relay-submit.intent').exists());self.assertFalse((self.parent/'bootstrap/response.json').exists())
        with self.assertRaises(FileExistsError):self.invoke()
    def test_undurable_response_is_not_acknowledged(self):
        with self.assertRaises(FileNotFoundError):self.invoke('undurable')
        self.assertFalse((self.parent/'bootstrap/response.json').exists())
    def test_clock_substitution_refused_before_submission(self):
        self.cfg['original']['boot']='00000000-0000-0000-0000-000000000000'
        with self.assertRaisesRegex(ValueError,'clock differs'):self.invoke()
        self.assertFalse((self.parent/'bootstrap/relay-submit.intent').exists())
    def test_envelope_requires_exact_actor_and_original_cutoff(self):
        unit='enclave-rpc-owner-bootstrap-'+self.attempt+'.service'
        row={'Id':unit,'MainPID':str(os.getpid()),'InvocationID':'f'*32,'ControlGroup':Path('/proc/self/cgroup').read_text().strip()[3:],
        'Type':'exec','RuntimeMaxUSec':'2min','TimeoutStopUSec':'1s','MemoryMax':str(256<<20),'MemorySwapMax':'0','CPUQuotaPerSecUSec':'1s','TasksMax':'32','KillMode':'control-group','Restart':'no','SendSIGKILL':'yes','FinalKillSignal':'9','NoNewPrivileges':'yes','LimitCORE':'0','ExecMainStartTimestampMonotonic':str(b.time.monotonic_ns()//1000)}
        with patch.dict(os.environ,{'INVOCATION_ID':'f'*32}),patch.object(b.e,'show',return_value=row):
            self.assertEqual(b.envelope(self.original),row)
            for field,bad in [('MemoryMax','0'),('MainPID','1'),('Restart','always'),('MemorySwapMax','1'),('ControlGroup','/wrong'),('RuntimeMaxUSec','3min')]:
                old=row[field];row[field]=bad
                with self.assertRaisesRegex(ValueError,'envelope differs'):b.envelope(self.original)
                row[field]=old
            original={**self.original,'deadlineMonotonicNs':b.time.monotonic_ns()+121_000_000_000}
            with self.assertRaisesRegex(ValueError,'cutoff'):b.envelope(original)
    def test_sealed_config_cannot_change(self):
        fd=b.sealed(self.cfg);self.addCleanup(os.close,fd)
        with self.assertRaises(PermissionError):os.write(fd,b'x')
        self.assertEqual(json.loads(os.pread(fd,os.fstat(fd).st_size,0)),self.cfg)

if __name__=='__main__':unittest.main()
