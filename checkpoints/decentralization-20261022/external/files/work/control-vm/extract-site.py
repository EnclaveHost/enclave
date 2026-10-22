from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'work/enclave/wasm')
from ipfs_fetch import parse_car,cid_str_to_bytes,_cid_info,_fields,_parse_dagpb,reconstruct,RAW_CODEC,DAGPB_CODEC
base=Path('work/control-vm');cid=(base/'site-root.txt').read_text().strip().split('/')[-1];car=(base/'website.car').read_bytes();blocks=parse_car(car);root=cid_str_to_bytes(cid);assert root in blocks
seen=set();pending=[root]
while pending:
 c=pending.pop()
 if c in seen:continue
 seen.add(c);assert c in blocks,'Missing referenced block';_,info,_=_cid_info(c,0)
 if info['codec']==DAGPB_CODEC:pending.extend(_parse_dagpb(blocks[c])[0])
 else:assert info['codec']==RAW_CODEC,'Unsupported codec'
output=base/'verified-site';output.mkdir(exist_ok=True);rows=[];total=0;visits=0

def extract(c,path,depth=0):
 global total,visits
 visits+=1;assert visits<10000 and depth<32,'Directory traversal limit'
 _,info,_=_cid_info(c,0);block=blocks[c]
 if info['codec']==RAW_CODEC:kind=0
 else:
  fields=_fields(block);data=next((v for f,w,v in fields if f==1 and w==2),b'');kind=next((v for f,w,v in _fields(data) if f==1 and w==0),None)
 if kind==1:
  path.mkdir(exist_ok=True);names=set()
  for f,w,v in fields:
   if f!=2 or w!=2:continue
   linkfields=_fields(v);child=next(x for a,b,x in linkfields if a==1 and b==2);name=next(x for a,b,x in linkfields if a==2 and b==2).decode('utf8')
   assert name and name not in ['.','..'] and not any(x in name for x in '/\\\0') and name not in names;names.add(name);extract(child,path/name,depth+1)
 elif kind in [0,2]:
  data=reconstruct(c,blocks,64<<20);total+=len(data);assert total<128<<20;path.write_bytes(data);rows.append({'path':str(path.relative_to(output)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 else:raise ValueError('Unsupported UnixFS node type '+str(kind))
extract(root,output)
report={'cid':cid,'carSHA256':hashlib.sha256(car).hexdigest(),'carBytes':len(car),'verifiedBlocks':len(blocks),'reachableBlocks':len(seen),'files':len(rows),'bytes':total,'fileManifest':rows}
(base/'website-manifest.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='fileManifest'}))
