from pathlib import Path
import os,stat,json,time
P=Path(__file__).resolve().parent; C=json.loads((P/'CONFIG.json').read_text()); until=time.monotonic()+18
os.umask(0o077)
def read(p,cap):
 with Path(p).open('rb') as f:b=f.read(cap+1)
 assert len(b)<=cap,'byte-bound'
 return b.decode('utf-8','strict')
def guard():assert time.monotonic()<until,'deadline'
def ident(pid):
 q=Path('/proc')/str(pid);v=read(q/'stat',4096).rsplit(')',1)[1].split()
 return {'pid':pid,'start':int(v[19]),'cgroup':read(q/'cgroup',4096).strip(),'namespace':(q/'ns/mnt').stat().st_ino,'exe':os.readlink(q/'exe')}
def relevant(name):return name.startswith(('/tmp/','/dev/shm/','/memfd:','memfd:','/SYSV'))
cg=Path('/sys/fs/cgroup'+C['cgroup']);assert [cg.stat().st_dev,cg.stat().st_ino]==C['identity'];assert read('/proc/sys/kernel/random/boot_id',64).strip()==C['boot']
assert int(next(x.split()[1] for x in read('/proc/meminfo',8192).splitlines() if x.startswith('MemAvailable:')))>=27648*1024
out={'at':time.time(),'readOnly':True,'before':{k:read(cg/k,8192) for k in ['memory.current','memory.stat','memory.events']},'holders':[],'unresolved':[],'noGlobalAbsenceProof':True,'noReclaimProof':True}
pending=[cg];groups=0;pids=set()
while pending:
 guard();q=pending.pop();groups+=1;assert groups<=32
 pids.update(int(v) for v in read(q/'cgroup.procs',65536).split());assert len(pids)<=128
 with os.scandir(q) as es:
  for e in es:
   if e.is_dir(follow_symlinks=False):pending.append(Path(e.path))
fdtotal=0;mapbytes=0
for pid in sorted(pids):
 guard();q=Path('/proc')/str(pid)
 try:
  first=ident(pid);assert first['cgroup'].startswith('0::'+C['cgroup'])
  found=[];errors=[]
  try:
   with os.scandir(q/'fd') as es:
    for n,e in enumerate(es):
     guard();fdtotal+=1;assert n<256 and fdtotal<=4096,'fd-bound'
     try:
      name=os.readlink(e.path);assert len(name)<=4096
      if not relevant(name):continue
      s=os.stat(e.path)
      found.append({'kind':'fd','name':name,'device':s.st_dev,'inode':s.st_ino,'bytes':s.st_size,'allocatedBytes':s.st_blocks*512,'links':s.st_nlink,'uid':s.st_uid,'mode':s.st_mode})
     except OSError as ex:errors.append(type(ex).__name__)
  except OSError as ex:errors.append('fd:'+type(ex).__name__)
  try:
   maps=read(q/'maps',131072);mapbytes+=len(maps.encode());assert mapbytes<=2097152,'aggregate-map-bound'
   for line in maps.splitlines():
    parts=line.split(None,5)
    if len(parts)<6 or not relevant(parts[5]):continue
    lo,hi=parts[0].split('-');major,minor=parts[3].split(':')
    found.append({'kind':'mapping','name':parts[5],'device':os.makedev(int(major,16),int(minor,16)),'inode':int(parts[4]),'virtualBytes':int(hi,16)-int(lo,16)})
  except (OSError,AssertionError) as ex:errors.append('maps:'+type(ex).__name__)
  assert ident(pid)==first,'process-changed'
  out['holders'].append({'identity':first,'objects':found,'unresolved':errors})
 except (OSError,AssertionError) as ex:out['unresolved'].append({'pid':pid,'reason':type(ex).__name__})
assert [cg.stat().st_dev,cg.stat().st_ino]==C['identity']
out['after']={k:read(cg/k,8192) for k in ['memory.current','memory.stat','memory.events']};out['counts']={'pids':len(pids),'groups':groups,'fdEntries':fdtotal,'mapMetadataBytes':mapbytes};out['elapsed']=18-(until-time.monotonic())
raw=json.dumps(out,indent=2);assert len(raw.encode())<=2097152
with (P/'PRIVATE-METADATA.json').open('x') as f:f.write(raw+'\n')
objects=[o for h in out['holders'] for o in h['objects']];by={}
for o in objects:
 k=(o['device'],o['inode']);v=by.setdefault(k,{'device':k[0],'inode':k[1],'references':0,'bytes':0,'allocatedBytes':0,'virtualBytes':0})
 v['references']+=1
 for field in ['bytes','allocatedBytes','virtualBytes']:v[field]=max(v[field],o.get(field,0))
summary={'readOnly':True,'counts':out['counts'],'distinctCandidateObjects':len(by),'objects':sorted(by.values(),key=lambda x:max(x['bytes'],x['virtualBytes']),reverse=True),'unresolvedProcesses':len(out['unresolved']),'unresolvedHolderCount':sum(bool(h['unresolved']) for h in out['holders']),'rawPathsPrivate':True,'cleanupAuthorized':False}
with (P/'SUMMARY.json').open('x') as f:json.dump(summary,f,indent=2);f.write('\n')
print(json.dumps(summary))
