from pathlib import Path
import sys,json,hashlib,os,collections
sys.path.insert(0,'work/enclave/wasm')
from ipfs_fetch import parse_car,cid_str_to_bytes,_cid_info,_fields,_parse_dagpb,reconstruct,RAW_CODEC,DAGPB_CODEC
base=Path('work/control-vm');source=base/'missing-pins';out=base/'missing-pin-package';files=out/'objects';dirs=out/'sites';files.mkdir(parents=True,exist_ok=True);dirs.mkdir(exist_ok=True);rows=json.loads((source/'manifest.json').read_text());fileRows=[];dirRows=[];dedup={};allBlocks=0
for n,row in enumerate(rows):
 cid=row['cid'];car=(source/(cid+'.car')).read_bytes();assert len(car)==row['carBytes'] and hashlib.sha256(car).hexdigest()==row['carSHA256'];blocks=parse_car(car);root=cid_str_to_bytes(cid);assert root in blocks;seen=set();pending=[root]
 while pending:
  c=pending.pop()
  if c in seen:continue
  seen.add(c);assert c in blocks;_,info,_=_cid_info(c,0)
  if info['codec']==DAGPB_CODEC:pending.extend(_parse_dagpb(blocks[c])[0])
  else:assert info['codec']==RAW_CODEC
 assert len(seen)==len(blocks);allBlocks+=len(blocks)
 if row['unixfsType']!=1:
  raw=reconstruct(root,blocks,256<<20);(files/(cid+'.bin')).write_bytes(raw)
  if not (files/(cid+'.car')).exists():os.link(source/(cid+'.car'),files/(cid+'.car'))
  fileRows.append({'cid':cid,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'carSha256':row['carSHA256'],'source':'Nan-pinned-root-retirement-20261019'})
 else:
  dest=dirs/cid;site=dest/'site';site.mkdir(parents=True,exist_ok=True);entries=[];total=0;visits=0
  def extract(c,path,depth=0):
   nonlocal_placeholder=None
   global total,visits
   visits+=1;assert visits<10000 and depth<32
   _,info,_=_cid_info(c,0);block=blocks[c]
   if info['codec']==RAW_CODEC:kind=0
   else:
    fields=_fields(block);data=next((v for f,w,v in fields if f==1 and w==2),b'');kind=next((v for f,w,v in _fields(data) if f==1 and w==0),None)
   if kind==1:
    path.mkdir(exist_ok=True);names=set()
    for f,w,v in fields:
     if f!=2 or w!=2:continue
     lf=_fields(v);child=next(x for a,b,x in lf if a==1 and b==2);name=next(x for a,b,x in lf if a==2 and b==2).decode('utf8')
     assert name and name not in ['.','..'] and not any(x in name for x in '/\\\0') and name not in names;names.add(name);extract(child,path/name,depth+1)
   elif kind in [0,2]:
    data=reconstruct(c,blocks,64<<20);total+=len(data);assert total<128<<20;h=hashlib.sha256(data).hexdigest()
    if path.exists():assert hashlib.sha256(path.read_bytes()).hexdigest()==h
    elif h in dedup:os.link(dedup[h],path)
    else:path.write_bytes(data);dedup[h]=path
    entries.append({'path':str(path.relative_to(site)),'bytes':len(data),'sha256':h})
   else:raise ValueError('Unsupported UnixFS type '+str(kind))
  extract(root,site)
  if not (dest/'site.car').exists():os.link(source/(cid+'.car'),dest/'site.car')
  (dest/'site-root.block').write_bytes(blocks[root]);(dest/'site-root.txt').write_text('/ipfs/'+cid+'\n')
  manifest={'cid':cid,'carSHA256':row['carSHA256'],'carBytes':row['carBytes'],'verifiedBlocks':len(blocks),'files':len(entries),'bytes':total,'fileManifest':entries};(dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');dirRows.append({k:v for k,v in manifest.items() if k!='fileManifest'})
 if (n+1)%30==0:print('Verified',n+1,'/',len(rows),'roots',flush=True)
(files/'manifest-additions.json').write_text(json.dumps(fileRows,indent=2)+'\n');(out/'directories.json').write_text(json.dumps(dirRows,indent=2)+'\n')
report={'roots':len(rows),'fileRoots':len(fileRows),'directoryRoots':len(dirRows),'verifiedBlocksIncludingRepeatedHistory':allBlocks,'carBytes':sum(x['carBytes'] for x in rows),'directoryFiles':sum(x['files'] for x in dirRows),'uniqueDirectoryFiles':len(dedup),'allRequestedRootsComplete':True}
Path('outputs/ipfs-missing-pins-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
