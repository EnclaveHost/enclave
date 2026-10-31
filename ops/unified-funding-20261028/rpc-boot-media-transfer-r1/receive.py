import pathlib,sys,os,hashlib,json,time
root=pathlib.Path('/home/controladmin/rpc-boot-media-20261031-r1');root.mkdir(mode=0o700)
expected='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94';h=hashlib.sha256();n=0;start=time.monotonic()
with (root/'source.qcow2').open('xb') as f:
 while True:
  b=sys.stdin.buffer.read(1024*1024)
  if not b:break
  n+=len(b)
  if n>621284352 or time.monotonic()-start>110:raise RuntimeError('Input bound')
  v=os.statvfs(root);m=next(int(x.split()[1])*1024 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
  if v.f_bavail*v.f_frsize<16*1024**3 or m<2*1024**3:raise RuntimeError('Resource guard')
  h.update(b);f.write(b)
 f.flush();os.fsync(f.fileno())
if n!=621284352 or h.hexdigest()!=expected:raise RuntimeError('Input mismatch')
os.chmod(root/'source.qcow2',0o400)
r={'bytes':n,'sha256':h.hexdigest(),'elapsed':time.monotonic()-start,'invocation':os.environ.get('INVOCATION_ID'),'sourceOnly':True}
(root/'TRANSFER.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
