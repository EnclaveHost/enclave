from pathlib import Path
import sys,subprocess,concurrent.futures,json,hashlib,datetime
p=Path(__file__).resolve().parent
h=sys.argv[1];ips={'us-west':'134.199.235.187','ca-east':'146.190.246.39','ap-southeast':'165.245.191.129','eu-central':'134.209.248.172'}
j=json.loads((p/'release.json').read_text())
names=sorted(set(j['delta'])|{'host.html','dashboard.html','css/site.css','vendor/sessions.js','vendor/funding.funding-cutover-r1.69242be6e8d8d5d3.js','funding.html'})
def one(n):
 r=subprocess.run(['curl','--fail','--silent','--show-error','--max-time','20','--resolve','enclave.host:443:'+ips[h],'https://enclave.host/'+n],capture_output=True,timeout=25)
 assert r.returncode==0,(n,r.stderr.decode()[:300])
 got=hashlib.sha256(r.stdout).hexdigest();assert got==j['files'][n],(n,got)
 return {'path':n,'sha256':got,'bytes':len(r.stdout)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(one,names))
out={'host':h,'cid':j['cid'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tlsVerified':True,'files':rows}
(p/(h+'.verified.json')).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'host':h,'files':len(rows),'tlsVerified':True}))
