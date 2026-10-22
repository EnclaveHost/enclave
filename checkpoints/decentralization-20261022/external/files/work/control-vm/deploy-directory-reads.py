from pathlib import Path
import subprocess,json,hashlib,time,sys,datetime
ips={'ca-east':'146.190.246.39','us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129'}
region=sys.argv[1];target=region;bundle=Path('work/enclave-directory-coalesced.mjs');sha=hashlib.sha256(bundle.read_bytes()).hexdigest();assert sha=='897b1702e36346cb2f614220a4a6000e9bed9adac6080e43491652fe5898172a'
subprocess.run(['scp','-q',str(bundle),target+':/tmp/enclave-directory-coalesced.mjs'],check=True)
script='''from pathlib import Path
import subprocess,hashlib
bundle=Path('/tmp/enclave-directory-coalesced.mjs');assert hashlib.sha256(bundle.read_bytes()).hexdigest()==SHA
assert hashlib.sha256(Path('/opt/enclave-directory/f6959cb/enclave-directory.mjs').read_bytes()).hexdigest()=='946565a19bfa6fda4107796ea65eba7b3c6b2d901de9d9788cdfd299d2ad7497'
dest=Path('/opt/enclave-directory/reads-897b170');dest.mkdir(exist_ok=True);(dest/'enclave-directory.mjs').write_bytes(bundle.read_bytes())
drop=Path('/etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf');old=drop.read_text();oldpath=next((v for v in ['/opt/enclave-directory/f6959cb/enclave-directory.mjs','/opt/enclave-directory/reads-4620bef/enclave-directory.mjs'] if v in old),None);assert oldpath
backup=drop.with_name('rollback-before-reads-897b170.txt');assert not backup.exists();backup.write_text(old)
drop.write_text(old.replace(oldpath,'/opt/enclave-directory/reads-897b170/enclave-directory.mjs'))
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-public-directory'],check=True)
'''
r=subprocess.run(['ssh',target,'python3','-'],input='SHA='+repr(sha)+'\n'+script,text=True,capture_output=True);assert r.returncode==0,r.stderr
checks=[]
try:
 for attempt in range(12):
  time.sleep(5);start=time.monotonic()
  r=subprocess.run(['ssh',target,'curl -fsS --max-time 15 http://127.0.0.1:8188/v1/network/routes'],capture_output=True,text=True,timeout=20)
  if r.returncode: print(region+': check retry '+str(attempt),flush=True);continue
  d=json.loads(r.stdout);item={'seconds':round(time.monotonic()-start,3),'routes':len(d.get('deployments',{})),'adapter':'7ae476a3' in d.get('labels',{})};checks.append(item);print(region+': '+json.dumps(item),flush=True)
  if len(checks)>=4 and all(v['adapter'] and v['routes']>=10 and v['seconds']<8 for v in checks[-4:]):break
 else:raise RuntimeError('route checks did not stabilize')
except BaseException:
 subprocess.run(['ssh',target,'cp /etc/systemd/system/enclave-public-directory.service.d/rollback-before-reads-897b170.txt /etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf\nsystemctl daemon-reload\nsystemctl restart enclave-public-directory'],check=True)
 raise
Path('outputs/directory-read-rollout-'+region+'.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'region':region,'sha256':sha,'checks':checks},indent=2)+'\n')
