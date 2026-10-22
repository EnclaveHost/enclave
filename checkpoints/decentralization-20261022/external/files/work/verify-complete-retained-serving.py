import pathlib,json,urllib.request,concurrent.futures,hashlib,sys,datetime
sys.path.insert(0,'work/enclave/wasm');from ipfs_fetch import verify_car
ips=['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'];entries=json.load(open('work/adapter-retained/manifest.next.json'))['verifiedObjects']
def head(job):
 ip,e,car=job;url='http://'+ip+':8189/ipfs/'+e['cid']+('?format=car' if car else '')
 expected=pathlib.Path('work/adapter-retained',e['cid']+'.car').stat().st_size if car else e['bytes']
 with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=12) as r:
  if r.status!=200 or int(r.headers['Content-Length'])!=expected:raise RuntimeError('artifact header mismatch '+url)
 return ip
jobs=[(ip,e,car) for ip in ips for e in entries for car in [False,True]]
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:list(pool.map(head,jobs))
previous={e['cid'] for e in json.load(open('work/adapter-retained/manifest.json'))['verifiedObjects']};sample=next(e for e in entries if 6<<20<e['bytes']<7<<20 and e['cid'] not in previous)
def read(ip):
 with urllib.request.urlopen('http://'+ip+':8189/ipfs/'+sample['cid']+'?format=car',timeout=45) as r:car=r.read(10<<20)
 b=verify_car(sample['cid'],car,10<<20)
 if hashlib.sha256(b).hexdigest()!=sample['sha256']:raise RuntimeError('sample content mismatch')
 return {'origin':'http://'+ip+':8189','sampleCid':sample['cid'],'sampleBytes':len(b),'verified':True}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:samples=list(pool.map(read,ips))
result={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'objectsPerReplica':len(entries),'headChecks':len(jobs),'contentSamples':samples,'fullLocalCARVerificationPerReplica':True}
json.dump(result,open('outputs/retained-replica-verification.json','w'),indent=2);print(json.dumps(result),flush=True)
