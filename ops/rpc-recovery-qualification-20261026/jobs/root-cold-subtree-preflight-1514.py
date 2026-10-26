import importlib.util,json,os,stat
from pathlib import Path
p=Path.cwd();tool=p/'nvme-cold-relocation-stage/r5/relocate.py'
s=importlib.util.spec_from_file_location('relocation_readonly',tool);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path('/vm/enclave-volumes/codex-archive')
old=json.loads(Path('/home/steven/.local/state/nvme-cold-relocation/source-codex-archive.meta.json').read_text())
results={};prefixes=[]
for name in ['hf-convert','gvs5h','gguf-e2b']:
 prefix='2026-10-24/home/'+name;src=root/prefix;prefixes.append(str(src));actual=m.walk_meta(str(src))
 expected=[]
 for r in old:
  if r['p']==prefix or r['p'].startswith(prefix+'/'):
   r=dict(r);r['p']=r['p'][len(prefix):].lstrip('/')
   if not r['p']:r['id']=[r['id'][0],r['id'][1],0]
   expected.append(r)
 expected.sort(key=lambda x:x['p'])
 results[name]={'matchesPriorMetadata':actual==expected,'entries':len(actual),'bytes':sum(r.get('s',0) for r in actual),'allocatedBytes':sum((src/r['p']).lstat().st_blocks*512 for r in actual),'owners':sorted({r['u'] for r in actual}),'types':sorted({r['t'] for r in actual})}
 assert actual==expected,(name,'metadata changed')
hits=[];unreadable=[];scanned=0
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit():continue
 try:
  if proc.stat().st_uid!=os.getuid():continue
  scanned+=1
  for fd in (proc/'fd').iterdir():
   try:target=os.readlink(fd)
   except FileNotFoundError:continue
   if any(target==x or target.startswith(x+'/') for x in prefixes):hits.append({'pid':int(proc.name),'fd':fd.name,'target':target})
  maps=(proc/'maps').read_text()
  if any(x in maps for x in prefixes):hits.append({'pid':int(proc.name),'mapsHit':True})
 except FileNotFoundError:pass
 except PermissionError:unreadable.append(int(proc.name))
q={'trees':results,'sameUidProcesses':scanned,'sameUidHits':hits,'sameUidUnreadable':unreadable,'scanComplete':False,'reason':'limited to same uid; does not replace privileged writer-check','rootAvailable':os.statvfs('/').f_bavail*os.statvfs('/').f_frsize,'vmAvailable':os.statvfs('/vm').f_bavail*os.statvfs('/vm').f_frsize,'destinationExists':Path('/home/steven/.cold-archive').exists()}
Path('logs/cold-subtree-preflight-1514.json').write_text(json.dumps(q,indent=2)+'\n');print(json.dumps(q,indent=2))
