import subprocess,json,hashlib,sys,datetime,time
from pathlib import Path
sys.path.insert(0,'work/enclave/wasm');from ipfs_fetch import verify_car
root=Path('work/storage-vm/readback');root.mkdir(exist_ok=True);origin='https://7ae476a3.app.enclave.host'
def fetch(path,out,timeout=45):
 return subprocess.run(['curl','-f','-sS','--connect-timeout','10','--max-time',str(timeout),'--resolve','7ae476a3.app.enclave.host:443:134.199.235.187',origin+path,'-o',str(out)],capture_output=True,text=True)
assert fetch('/api/files',root/'inventory.json').returncode==0
prior=json.loads(Path('work/adapter-corrected-inventory.json').read_text());current=json.loads((root/'inventory.json').read_text())
# Inventory entries are public deployment artifacts.
assert isinstance(prior,list) and isinstance(current,list)
currentmap={r['path']:r for r in current}
for row in prior:
 actual=currentmap[row['path']]
 assert (actual['cid'],actual['size'])==(row['cid'],row['size'])
verified=json.loads(Path('work/adapter-retained/verified.json').read_text());reads=[]
for cid in ['bafkreigfcq7pioqt22vywdmnc3ig4uqjg3c2sabr2r67ll4lcelcsq6gau','bafkreif7faz7mv3w5nkqcvapkltvp5jc6dwdgvin35br6kzz4mfkspb7pe']:
 f=root/(cid+'.bin');r=fetch('/ipfs/'+cid,f);assert r.returncode==0
 h=hashlib.sha256(f.read_bytes()).hexdigest();assert h==verified[cid]['sha256'];reads.append({'cid':cid,'sha256Verified':True,'bytes':f.stat().st_size})
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'priorEntriesVerifiedUnchanged':len(prior),'currentEntries':len(current),'retainedReads':reads,'tlsCertificateValidation':True}
Path('outputs/storage-cutover-content-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
cid='bafybeict5ln36drljamqbk2q7dtwstojckulxouwihml3my2l3wjardrru';f=root/(cid+'.car');start=time.monotonic();r=fetch('/ipfs/'+cid+'?format=car&dag-scope=all',f,180)
large={'cid':cid,'seconds':round(time.monotonic()-start,1),'httpTransferSucceeded':r.returncode==0,'receivedBytes':f.stat().st_size if f.exists() else 0}
if r.returncode:large['error']=r.stderr[:240]
else:
 try:
  raw=verify_car(cid,f.read_bytes(),128<<20);assert hashlib.sha256(raw).hexdigest()==verified[cid]['sha256'];large['cidAndSHA256Verified']=True;large['bytes']=len(raw)
 except Exception as e:large['verificationError']=str(e)[:240]
report['largeCAR']=large;Path('outputs/storage-cutover-content-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(large))
