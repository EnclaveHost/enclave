import sys,json,urllib.request,pathlib,hashlib,concurrent.futures,datetime,time,os,threading
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
import importlib.util
spec=importlib.util.spec_from_file_location('ranged_copy','work/adapter-ranged-copy.py');ranged_copy=importlib.util.module_from_spec(spec);spec.loader.exec_module(ranged_copy)
origin='https://7ae476a3.app.enclave.host';migrationSource='https://ipfs.enclave.host';root=pathlib.Path('work/adapter-retained');root.mkdir(exist_ok=True)
rows=json.load(open('work/adapter-public-inventory.after.json'));unique={r['cid']:r for r in rows};results={};lock=threading.Lock();checkpoint=root/'verified.json'
if checkpoint.exists():results=json.loads(checkpoint.read_text())
def check(row):
 cid=row['cid'];size=int(row['size']);carfile=root/(cid+'.car');datafile=root/(cid+'.bin')
 if cid in results and carfile.exists() and datafile.exists():return results[cid]
 if not cid.startswith('b') or any(c not in 'abcdefghijklmnopqrstuvwxyz234567' for c in cid):raise ValueError('invalid inventory CID')
 # Use previously verified bootstrap copies without refetching.
 base=pathlib.Path('work/bootstrap-cas')
 if (base/(cid+'.car')).exists():
  car=(base/(cid+'.car')).read_bytes()
 else:
  limit=max(2<<20,size+max(size//20,2<<20));tmp=carfile.with_suffix('.part')
  for attempt in range(3):
   try:
    if attempt>0:
     if '--adapter-recovery' not in sys.argv:raise RuntimeError('not recovered from nan; adapter recovery pending')
     source=origin+' (verified ranged retrieval)'
     car=ranged_copy.ranged(cid,size,datafile);b=verify_car(cid,car,max(size,1));break
    source=migrationSource
    req=urllib.request.Request(source+'/ipfs/'+cid+'?format=car&dag-scope=all',headers={'Accept':'application/vnd.ipld.car'})
    with urllib.request.urlopen(req,timeout=120) as r,open(tmp,'wb') as f:
     count=0
     while True:
      b=r.read(1<<20)
      if not b:break
      count+=len(b)
      if count>limit:raise ValueError('CAR exceeds bounded inventory size')
      f.write(b)
    car=tmp.read_bytes();b=verify_car(cid,car,max(size,1))
    if len(b)!=size:raise ValueError("inventory size mismatch")
    break
   except Exception:
    if '--adapter-recovery' not in sys.argv:raise RuntimeError('not recovered from nan; adapter recovery pending')
    if attempt==2:raise
    time.sleep(2*(attempt+1))
 b=verify_car(cid,car,max(size,1))
 if len(b)!=size:raise ValueError('inventory size mismatch for '+cid)
 carfile.write_bytes(car);datafile.write_bytes(b)
 carfile.with_suffix('.part').unlink(missing_ok=True)
 result={'cid':cid,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'bootstrap' if (base/(cid+'.car')).exists() else source,'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 with lock:
  results[cid]=result;temp=checkpoint.with_suffix('.tmp');temp.write_text(json.dumps(results,indent=2));temp.replace(checkpoint)
  print(json.dumps({'verified':len(results),'total':len(unique),'cid':cid,'bytes':len(b)}),flush=True)
 return result
errors=[]
known_missing=json.loads(pathlib.Path('work/retained-nan-missing.json').read_text()) if '--adapter-recovery' not in sys.argv else {}
errors.extend(known_missing.values())
# Large objects first; two concurrent reads bound load on the live guest.
with concurrent.futures.ThreadPoolExecutor(max_workers=2 if '--adapter-recovery' in sys.argv else 4) as pool:
 fs={pool.submit(check,r):r for r in sorted(unique.values(),key=lambda r:int(r['size']),reverse=True) if r['cid'] not in known_missing}
 for f in concurrent.futures.as_completed(fs):
  try:f.result()
  except Exception as e:
   err={'cid':fs[f]['cid'],'error':str(e)};errors.append(err);print(json.dumps(err),flush=True)
json.dump({'origin':origin,'inventoryObjects':len(unique),'verifiedObjects':list(results.values()),'errors':errors},open('outputs/retained-content-manifest.json','w'),indent=2)
if errors:sys.exit(1)
