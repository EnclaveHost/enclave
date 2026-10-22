from pathlib import Path
import json,subprocess,hashlib,datetime,concurrent.futures,urllib.parse
files={x['path']:x['sha256'] for x in json.loads(Path('work/control-vm/website-manifest.json').read_text())['fileManifest']}
rules=[]
for line in Path('work/control-vm/live-site-redirects').read_text().splitlines():
 line=line.split('#')[0].strip()
 if line and not line.startswith('/*'):rules.append(line.split())
ips={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
def check(job):
 region,ip,route,target,status=job
 query='route-check=pretty&tab=apps'
 args=['curl','-sS','--max-time','25','--resolve','enclave.host:443:'+ip]
 if status=='200':args+=['-L']
 r=subprocess.run(args+['-w','\n%{http_code}\n%{redirect_url}','https://enclave.host'+route+'?'+query],capture_output=True)
 assert r.returncode==0,(region,route,'request failed')
 body,code,redirect=r.stdout.rsplit(b'\n',2)
 assert int(code)==int(status),(region,route,code)
 if status=='200':
  path=route.strip('/')
  expected=files.get(path) or files.get(path+'/index.html') or files[target.lstrip('/')]
  assert hashlib.sha256(body).hexdigest()==expected,(region,route,'content mismatch')
 elif status=='404':assert hashlib.sha256(body).hexdigest()==files['404.html']
 else:
  parsed=urllib.parse.urlsplit(redirect.decode());assert parsed.path==target and parsed.query==query,(region,route,redirect)
 return {'region':region,'route':route,'status':int(code),'verified':True}
jobs=[(h,ip,*rule) for h,ip in ips.items() for rule in rules]
jobs += [(h,ip,'/does-not-exist-pretty-test','/404.html','404') for h,ip in ips.items()]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: checks=list(pool.map(check,jobs))
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'normalTLSVerification':True,'checks':checks,'passed':len(checks),'failed':0}
Path('outputs/dashboard-route-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':len(checks),'failed':0,'regions':list(ips)}))
