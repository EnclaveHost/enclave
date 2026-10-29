from pathlib import Path
import subprocess,json,sys,hashlib,concurrent.futures,datetime
p=Path(__file__).resolve().parent
hosts={'us-west':'134.199.235.187','ca-east':'146.190.246.39','ap-southeast':'165.245.191.129','eu-central':'134.209.248.172'}
h=sys.argv[1];ip=hosts[h]
rows=json.loads((p/'artifact/ADDITIONS.json').read_text())
for f in ['index.html','js/boot.js','vendor/sessions.js']:
 rows.append({'path':f,'sha256':hashlib.sha256((p/'composite/site'/f).read_bytes()).hexdigest()})
def one(x):
 r=subprocess.run(['curl','--fail','--silent','--show-error','--max-time','30','--resolve',f'enclave.host:443:{ip}','https://enclave.host/'+x['path']],capture_output=True,timeout=35)
 assert r.returncode==0,(x['path'],r.returncode)
 got=hashlib.sha256(r.stdout).hexdigest();assert got==x['sha256'],(x['path'],got)
 return {'path':x['path'],'sha256':got,'bytes':len(r.stdout),'tlsVerified':True}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:out=list(ex.map(one,rows))
r={'host':h,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verified':out};(p/(h+'.https-verification.json')).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'host':h,'verifiedFiles':len(out),'oldFilesPreserved':True,'tlsVerified':True}))
