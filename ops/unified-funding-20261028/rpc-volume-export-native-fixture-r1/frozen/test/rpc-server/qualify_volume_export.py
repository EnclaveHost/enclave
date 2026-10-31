"""Finite native dummy-data test. Requires private network/PID/mount namespaces."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import time

spec=importlib.util.spec_from_file_location('export','/src/rpc/server/volume_export.py')
export=importlib.util.module_from_spec(spec);spec.loader.exec_module(export)
os.umask(0o077)
root=Path('/work');root.mkdir(mode=0o700)
pki=root/'pki';pki.mkdir(mode=0o700)
originals=root/'originals';originals.mkdir(mode=0o700)
exports=root/'exports';exports.mkdir(mode=0o700)
nonce='f2'*16;name='rpc-'+nonce+'-l1';cn='rpc-client-'+nonce+'-l1'

def run(args, allowed=False):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
    assert len(r.stdout)+len(r.stderr)<65536
    if not allowed:assert r.returncode==0,(args[0],r.returncode,r.stderr.decode(errors='replace'))
    return r

run(['/usr/sbin/ip','link','set','lo','up'])
(pki/'openssl.cnf').write_text('[req]\ndistinguished_name=dn\n[dn]\n')
os.environ['OPENSSL_CONF']=str(pki/'openssl.cnf')
run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(pki/'ca-key.pem'),'-out',str(pki/'ca-cert.pem'),'-days','1','-subj','/CN=rpc-fixture-ca','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'])
for prefix,subject,usage in [('server','rpc-storage-fixture','serverAuth'),('client',cn,'clientAuth'),('other','rpc-wrong-client','clientAuth')]:
    run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(pki/(prefix+'-key.pem')),'-out',str(pki/(prefix+'.csr')),'-subj','/CN='+subject])
    (pki/(prefix+'.ext')).write_text('extendedKeyUsage='+usage+'\nsubjectAltName=DNS:'+subject+'\n')
    run(['openssl','x509','-req','-in',str(pki/(prefix+'.csr')),'-CA',str(pki/'ca-cert.pem'),'-CAkey',str(pki/'ca-key.pem'),'-CAcreateserial','-out',str(pki/(prefix+'-cert.pem')),'-days','1','-extfile',str(pki/(prefix+'.ext'))])
raw=originals/'seed.raw'
with raw.open('xb') as f:f.write(b'A'*4096);f.truncate(1048576)
base=originals/'base.qcow2';frozen=originals/'frozen.qcow2'
run(['/usr/bin/qemu-img','convert','-f','raw','-O','qcow2',str(raw),str(base)])
run(['/usr/bin/qemu-img','create','-q','-f','qcow2','-F','qcow2','-b',str(base),str(frozen)])
paths=[frozen,base];before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
manifest=[(str(p),export.metadata(p)) for p in paths]
server=export.CowExport(exports,nonce,'l1',manifest,1048576,pki,'127.0.0.1',10809,time.monotonic()+45)
proc=server.start();start=time.monotonic();cases=[]

def receive(s,n):
    result=b''
    while len(result)<n:
        part=s.recv(n-len(result))
        if not part:raise EOFError('NBD closed')
        result+=part
    return result

class Client:
    def __init__(self,prefix='client',hostname='rpc-storage-fixture',export_name=name,tls=True):
        s=socket.create_connection(('127.0.0.1',10809),timeout=2);s.settimeout(2);self.s=s;self.seq=0
        try:
            magic,opt,flags=struct.unpack('>QQH',receive(s,18));assert (magic,opt)==(0x4e42444d41474943,0x49484156454f5054) and flags&3==3
            s.sendall(struct.pack('>I',3))
            if tls:
                s.sendall(struct.pack('>QII',opt,5,0))
                reply=struct.unpack('>QIII',receive(s,20));assert reply==(0x3e889045565a9,5,1,0)
                ctx=ssl.create_default_context(cafile=str(pki/'ca-cert.pem'));ctx.load_cert_chain(str(pki/(prefix+'-cert.pem')),str(pki/(prefix+'-key.pem')))
                s=ctx.wrap_socket(s,server_hostname=hostname);self.s=s
            data=export_name.encode();s.sendall(struct.pack('>QII',opt,1,len(data))+data)
            size,flags=struct.unpack('>QH',receive(s,10));assert size==1048576 and flags&2==0 and flags&12==12
            self.flags=flags
        except BaseException:
            self.s.close();raise
    def request(self,command,offset=0,payload=b'',length=0,flags=0):
        self.seq+=1
        size=len(payload) if command==1 else length
        self.s.sendall(struct.pack('>IHHQQI',0x25609513,flags,command,self.seq,offset,size)+payload)
        magic,error,handle=struct.unpack('>IIQ',receive(self.s,16));assert magic==0x67446698 and handle==self.seq and error==0,(magic,error,handle)
        return receive(self.s,size) if command==0 else b''
    def close(self):
        self.seq+=1;self.s.sendall(struct.pack('>IHHQQI',0x25609513,0,2,self.seq,0,0));self.s.close()

try:
    # Wait only for the first listener; no server restart on failed observation.
    while True:
        assert proc.poll() is None, (server.root/'server.log').read_text()
        try:c=Client();break
        except ConnectionRefusedError:
            assert time.monotonic()-start<3;time.sleep(.025)
    assert c.request(0,length=4096)==b'A'*4096
    cases.append('authenticated-backing-read')
    c.request(1,payload=b'B'*4096,flags=1)  # FUA advertised and used
    c.request(3)  # FLUSH acknowledged by this real qemu-nbd instance
    assert c.request(0,length=4096)==b'B'*4096
    cases.append('write-FUA-flush-readback')
    c.close()
    c=Client();assert c.request(0,length=4096)==b'B'*4096;c.close()
    cases.append('explicit-disconnect-reconnect-readback')
    for title,kw in [('wrong-client-DN',{'prefix':'other'}),('wrong-server-name',{'hostname':'wrong.invalid'}),('wrong-export',{'export_name':name+'-wrong'}),('plaintext',{'tls':False})]:
        try:
            unexpected=Client(**kw);unexpected.close();raise AssertionError('Unauthorized connection accepted')
        except (OSError,EOFError,ssl.SSLError):cases.append(title+'-refused')
    r=run(['/usr/sbin/qemu-nbd','--socket',str(root/'second.sock'),'--format=qcow2',str(server.overlay)],allowed=True)
    assert r.returncode!=0 and b'lock' in r.stderr.lower(),r.stderr
    cases.append('second-overlay-writer-refused')
    r=run(['/usr/bin/qemu-img','resize','-f','qcow2',str(base),'2097152'],allowed=True)
    assert r.returncode!=0 and b'lock' in r.stderr.lower(),r.stderr
    cases.append('original-writer-refused')
    c=Client();assert c.request(0,length=4096)==b'B'*4096;c.close()
    cases.append('authorized-after-refusals')
finally:
    cleanup=server.close()
assert cleanup['exactChildExited'] and not cleanup['forced'] and cleanup['originalMetadataUnchanged'],cleanup
assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
check=json.loads(run(['/usr/bin/qemu-img','check','--output=json','-f','qcow2',str(server.overlay)]).stdout)
assert check.get('check-errors',0)==0 and check.get('corruptions',0)==0 and check.get('leaks',0)==0,check
cases.append('child-death-original-hashes-and-overlay-check')
try:server.start();raise AssertionError('Consumed attempt reused')
except ValueError:cases.append('consumed-attempt-refused')
# Verify the persisted guest writes without any live export.
output=root/'readback.raw'
run(['/usr/bin/qemu-img','convert','-f','qcow2','-O','raw',str(server.overlay),str(output)])
with output.open('rb') as f:assert f.read(4096)==b'B'*4096
cases.append('persisted-overlay-readback-after-exit')
print(json.dumps({'allPass':True,'cases':cases,'count':len(cases),'cleanup':cleanup,'originalHashesUnchanged':True,'dummyBytes':1048576,'productionData':False,'kernelAttachmentTested':False,'automaticReconnectEnabled':False,'guardianQualified':False,'sourceModuleUsed':True}))
