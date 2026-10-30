from pathlib import Path
import gzip, hashlib, json, os, time
p=Path(__file__).resolve().parent;cfg=json.loads((p/'INPUT.json').read_text());assert os.sched_getaffinity(0)=={1}
def sha(f):
 with open(f,'rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
f=Path(cfg['image']);before=list((f.stat().st_dev,f.stat().st_ino,f.stat().st_size,f.stat().st_mtime_ns,f.stat().st_ctime_ns));assert before==cfg['identity'] and sha(f)==cfg['sha256']
with (p/'ATTEMPT.json').open('x') as o:json.dump({'time':time.time(),'action':'fixed public source identity extraction, no execution'},o)
found={k:[] for k in cfg['targets']};total=0;entries=0
with gzip.open(f,'rb') as z:
 def take(n):
  global total
  b=z.read(n);total+=len(b);assert len(b)==n and total<=8<<30;return b
 while True:
  first=z.read(1)
  if not first:break
  total+=1
  if first==b'\0':continue
  h=first+take(109);assert h[:6] in (b'070701',b'070702')
  fields=[int(h[6+i*8:14+i*8],16) for i in range(13)]
  mode=fields[1];size=fields[6];ns=fields[11];assert 1<=ns<=4096 and size<=1<<30
  raw=take(ns);assert raw[-1:]==b'\0';name=raw[:-1].decode('utf-8');take((-110-ns)%4)
  name=name.removeprefix('./').lstrip('/');entries+=1;assert entries<=100000
  digest=hashlib.sha256();left=size
  while left:
   b=take(min(left,65536));digest.update(b);left-=len(b)
  take((-size)%4)
  if name in found:found[name].append({'sha256':digest.hexdigest(),'bytes':size,'mode':mode})
after=list((f.stat().st_dev,f.stat().st_ino,f.stat().st_size,f.stat().st_mtime_ns,f.stat().st_ctime_ns));assert after==before and sha(f)==cfg['sha256']
for k,v in found.items():assert v and v[-1]['sha256']==cfg['targets'][k],k
(p/'RESULT.json').write_text(json.dumps({'imageUnchanged':True,'compressedSha256':cfg['sha256'],'totalUncompressedBytes':total,'entries':entries,'targets':found,'currentSelectedSourceMatches':True,'clientExecuted':False},indent=2)+'\n')
