from pathlib import Path
import json, hashlib, subprocess, os, time, selectors, shlex
p=Path(__file__).resolve().parent
s=p.parent.parent/'source'
x=json.loads((p/'SPEC.json').read_text())
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
root=Path(x['root']);root.mkdir(mode=0o700)
remote=['sudo','-n','systemd-run','--quiet','--wait','--pipe','--unit=enclave-rpc-linux-public-boot-copy-'+x['nonce'],'--property=User=controladmin','--property=MemoryMax=64M','--property=MemorySwapMax=0','--property=CPUQuota=100%','--property=RuntimeMaxSec=120','--property=TimeoutStopSec=2','--property=KillMode=control-group','--property=NoNewPrivileges=yes','--property=ProtectSystem=strict','--property=ProtectHome=read-only','/usr/bin/cat',x['source']]
with(p/'COPY-INTENT.json').open('x')as f:json.dump({'at':time.time(),'remote':remote,'noRetry':True},f);f.flush();os.fsync(f.fileno())
start=time.monotonic();h=hashlib.sha256();total=0;stderr=bytearray()
proc=subprocess.Popen(json.loads((p/'SSH.json').read_text())+[shlex.join(remote)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ,'out');sel.register(proc.stderr,selectors.EVENT_READ,'err')
try:
 with(root/'boot.vhdx.partial').open('xb')as dst:
  while sel.get_map():
   assert time.monotonic()-start<130,'copy deadline'
   st=os.statvfs(root);assert st.f_bavail*st.f_frsize>=300_000_000_000,'NVMe floor'
   for key,_ in sel.select(.2):
    b=os.read(key.fileobj.fileno(),1024*1024)
    if not b:sel.unregister(key.fileobj);continue
    if key.data=='out':
     total+=len(b);assert total<=x['bytes'],'oversized boot';dst.write(b);h.update(b)
    else:stderr.extend(b);assert len(stderr)<=16384,'stderr bound'
  assert proc.wait(timeout=3)==0,'remote stream failed'
  assert total==x['bytes'] and h.hexdigest()==x['sha256'],'boot pin differs'
  dst.flush();os.fsync(dst.fileno())
 partial=root/'boot.vhdx.partial'
 with partial.open('rb')as f:assert hashlib.file_digest(f,'sha256').hexdigest()==x['sha256']
 partial.chmod(0o400);partial.rename(root/'boot.vhdx')
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 (p/'COPY-RESULT.json').write_text(json.dumps({'bytes':total,'sha256':h.hexdigest(),'seconds':time.monotonic()-start,'localReadbackVerified':True,'remoteUnitCompletionObserved':True,'independentRemoteDeathProven':False,'vmStarted':False})+'\n')
finally:
 if proc.poll() is None:proc.kill();proc.wait()
 (p/'copy-stderr.local').write_bytes(stderr)
