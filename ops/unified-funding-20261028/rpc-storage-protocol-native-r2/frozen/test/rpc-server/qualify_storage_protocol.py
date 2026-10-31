"""Actual two-role TLS export metadata -> owner bundle -> guest validation.

Private namespace, disposable keys and tiny sparse qcow2 metadata only. Virtual
size is4TB per role; no blockchain, filesystem, kernel attachment or data copy.
"""
from pathlib import Path
import hashlib,importlib.util,json,os,subprocess,sys,time
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'rpc/server'))
import guarded_export as g
from volume_export import CowExport,metadata

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
credentials=load('credentials','rpc/guest/credentials.py');prepare=load('prepare','rpc/prepare_attachment.py');guest=load('guest','rpc/guest/attach_storage.py');p=g.protocol
os.umask(0o077);root=Path('/work');root.mkdir(mode=0o700,exist_ok=True);root.chmod(0o700)
pins={name:{'path':'/usr/bin/'+name,'sha256':hashlib.sha256(Path('/usr/bin',name).read_bytes()).hexdigest()} for name in ['openssl','ssh-keygen']}
nonce='ef'*16;instance='rpc-owned-native-metadata-fixture'
keys=credentials.generate(root,nonce,instance,pins);bundle=Path(keys['path'])
for args in [['/usr/sbin/ip','link','set','lo','up'],['/usr/sbin/ip','addr','add','192.0.2.1/32','dev','lo']]:subprocess.run(args,check=True,timeout=2,capture_output=True)
originals=root/'originals';originals.mkdir();parents=root/'exports';parents.mkdir()
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();origin=time.time_ns()
server={'attempt':nonce,'instance':instance,'bootId':boot,'createdUtcNs':origin,'deadlineUtcNs':origin+p.WINDOW,'roles':{}}
exports=[];roles={};before={};allocated=0;checks=[]
try:
 for role,port in [('l1',10809),('base',10810)]:
  image=originals/(role+'.qcow2');subprocess.run(['/usr/bin/qemu-img','create','-q','-f','qcow2',str(image),str(p.BYTES)],check=True,timeout=3,capture_output=True)
  allocated+=image.stat().st_blocks*512;assert allocated<16*1024**2
  before[str(image)]=hashlib.sha256(image.read_bytes()).hexdigest()
  row={'parent':str(parents),'originals':[(str(image),metadata(image))],'bytes':p.BYTES,'tls':str(bundle/role/'server'),'clientTls':str(bundle/role/'client'),'tlsName':keys['public']['roles'][role]['tlsName'],'host':'192.0.2.1','port':port}
  server['roles'][role]=row
  e=CowExport(parents,nonce,role,row['originals'],p.BYTES,Path(row['tls']),row['host'],port,time.monotonic()+15);exports.append(e);e.start()
  roles[role]=g.probe_export(e,row)
 raw=json.dumps(server).encode();ready=p.make_ready(server,p.sha(raw),roles,'a'*32,time.time_ns());ready_raw=json.dumps(ready).encode()
 c={'instance':instance,'guestBootId':boot,'output':str(root/'attachment-bundle')}
 for field,data in [('serverContract',raw),('serverReady',ready_raw),('credentialReceipt',(bundle/'PUBLIC.json').read_bytes())]:
  path=root/(field+'.json');path.write_bytes(data);c[field]={'path':str(path),'sha256':p.sha(data)}
 result=prepare.prepare(c);contract=p.decode((root/'attachment-bundle/attachment.json').read_bytes())
 for role in ['l1','base']:guest.validate_config(contract,role,time.time_ns(),boot)
 p.validate_ready(p.decode((root/'attachment-bundle/server-ready.json').read_bytes()),contract,time.time_ns())
 for e in exports:e.check();assert e.proc.poll() is None
 checks=['both-live-mutual-TLS-negotiations','exact-export-size-FLUSH-FUA','owner-input-hash-bindings','original-window-preserved','actual-guest-v2-parser','unmodified-server-receipt','no-RPC-or-writer-fence-claim']
 assert not result['rpcReady'] and not result['writersFenced']
finally:
 cleanup=[e.close() for e in reversed(exports)]
assert all(x['exactChildExited'] and x['originalMetadataUnchanged'] and not x['forced'] for x in cleanup)
assert before=={name:hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in before}
checks.append('both-exact-export-exits-originals-unchanged')
print(json.dumps({'allPass':True,'count':len(checks),'cases':checks,'sparseOriginalAllocatedBytes':allocated,'virtualBytesPerRole':p.BYTES,'productionData':False,'kernelAttachment':False,'filesystemUuidTested':False,'guardianCompositionQualified':False,'cleanup':cleanup}))
