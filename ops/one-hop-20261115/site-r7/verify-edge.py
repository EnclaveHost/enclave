from pathlib import Path
import sys,subprocess,concurrent.futures,json,hashlib,datetime
p=Path(__file__).resolve().parent
h=sys.argv[1];assert h in ['us-west','ca-east','ap-southeast','eu-central']
# the edge's address is the one this workstation's ssh configuration has for it; none is written here
g=subprocess.run(['ssh','-G',h],capture_output=True,text=True,timeout=10);assert g.returncode==0
ip=[l.split(None,1)[1].strip() for l in g.stdout.splitlines() if l.startswith('hostname ')];assert len(ip)==1
ip=ip[0];assert all(x.isdigit() and int(x)<256 for x in ip.split('.')) and ip.count('.')==3,'the ssh alias must name an IPv4 address'
j=json.loads((p/'release.json').read_text())
names=sorted(set(j['delta'])|{'host.html','dashboard.html','css/site.css','vendor/sessions.js','vendor/funding.funding-cutover-r1.69242be6e8d8d5d3.js','funding.html'})
def one(n):
 r=subprocess.run(['curl','--fail','--silent','--show-error','--max-time','20','--resolve','enclave.host:443:'+ip,'https://enclave.host/'+n],capture_output=True,timeout=25)
 assert r.returncode==0,(n,r.stderr.decode()[:300])
 got=hashlib.sha256(r.stdout).hexdigest();assert got==j['files'][n],(n,got)
 return {'path':n,'sha256':got,'bytes':len(r.stdout)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(one,names))
out={'host':h,'cid':j['cid'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tlsVerified':True,'files':rows}
(p/(h+'.verified.json')).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'host':h,'files':len(rows),'tlsVerified':True}))
