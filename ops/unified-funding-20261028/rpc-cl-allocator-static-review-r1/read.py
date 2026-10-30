from pathlib import Path
import hashlib,json,time
p=Path(__file__).resolve().parent
b=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/payload-v2/bin/lighthouse')
expected='11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'
st=b.stat();h=hashlib.sha256();hits={};tokens=[b'_RJEM_MALLOC_CONF',b'narenas:',b'dirty_decay_ms',b'muzzy_decay_ms',b'confirm_conf',b'abort_conf',b'jemalloc',b'malloc_conf',b'5.3.0',b'5.2.1'];offset=0;tail=b''
with b.open('rb') as f:
 while True:
  chunk=f.read(1048576)
  if not chunk:break
  h.update(chunk);data=tail+chunk
  for t in tokens:
   start=0
   while len(hits.get(t.decode(),[]))<8:
    i=data.find(t,start)
    if i<0:break
    pos=offset-len(tail)+i
    if not any(v['offset']==pos for v in hits.get(t.decode(),[])):
     raw=data[max(0,i-40):i+100];context=''.join(chr(c) if 32<=c<127 else '.' for c in raw)
     hits.setdefault(t.decode(),[]).append({'offset':pos,'context':context})
    start=i+len(t)
  offset+=len(chunk);tail=data[-256:]
assert h.hexdigest()==expected
assert (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns)==tuple(getattr(b.stat(),k) for k in ['st_dev','st_ino','st_size','st_mtime_ns'])
r={'at':time.time(),'binary':str(b),'sha256':h.hexdigest(),'bytes':st.st_size,'readOnly':True,'executed':False,'hits':hits}
(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'sha256':h.hexdigest(),'tokens':{k:len(v) for k,v in hits.items()}}))
