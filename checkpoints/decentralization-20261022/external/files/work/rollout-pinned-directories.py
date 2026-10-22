from pathlib import Path
import subprocess,json,urllib.request,time,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');release='f6959cb';bundle=root/'work/enclave-directory-pinned.mjs';pins=json.loads((root/'outputs/network-authority-observation.json').read_text())['authorityPins']
sha=hashlib.sha256(bundle.read_bytes()).hexdigest();results=[]
ssh_options=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
def ssh(target,command):return subprocess.check_output(['ssh',*ssh_options,target,command],text=True,timeout=45)
def get(url):
 with urllib.request.urlopen(url,timeout=25) as response:return json.load(response)
for name,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 target='root@'+ip;origin='http://'+ip+':8188'
 for baseline_attempt in range(10):
  before=get(origin+'/v1/network/routes');before_count=len(before.get('deployments',{}))
  if before_count>=12:break
  time.sleep(3)
 if before_count<12:raise RuntimeError(name+' lacks required baseline routes: '+str(before_count))
 temp='/tmp/enclave-directory-pinned-'+release+'.mjs';subprocess.run(['scp','-q',*ssh_options,str(bundle),target+':'+temp],check=True,timeout=45)
 ssh(target,"if test -f /etc/systemd/system/enclave-public-directory.service.d/30-authority-pins.conf; then sed -n '/ExecStart=\/usr/p' /etc/systemd/system/enclave-public-directory.service.d/30-authority-pins.conf; fi")
 exists=ssh(target,'if test -e /etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf; then cat /etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf; fi')
 if not exists or not any('/opt/enclave-directory/'+v+'/enclave-directory.mjs' in exists for v in ['25dd936',release]):raise RuntimeError('unexpected pre-existing directory override')
 installed=False;success=None
 install=r"""set -eu
install -d -m 0755 /opt/enclave-directory/RELEASE /etc/systemd/system/enclave-public-directory.service.d
install -m 0644 TEMP /opt/enclave-directory/RELEASE/enclave-directory.mjs
python3 - <<'REMOTE'
from pathlib import Path
import json
p=Path('/etc/enclave-directory/config.json');config=json.loads(p.read_text());config['authorityPins']=PINS
new=Path('/etc/enclave-directory/config-RELEASE.json');new.write_text(json.dumps(config,indent=2)+'\n');new.chmod(0o644)
drop=Path('/etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf')
previous=drop.read_text()
if not any('/opt/enclave-directory/'+v+'/enclave-directory.mjs' in previous for v in ['25dd936','RELEASE']):raise RuntimeError('unexpected authority pin override')
backup=drop.with_name('rollback-before-RELEASE.txt')
if not backup.exists():backup.write_text(previous)
drop.write_text('[Service]\nExecStart=\nExecStart=/usr/local/bin/node /opt/enclave-directory/RELEASE/enclave-directory.mjs /etc/enclave-directory/config-RELEASE.json\n');drop.chmod(0o644)
REMOTE
systemctl daemon-reload
systemctl restart enclave-public-directory.service
systemctl is-active enclave-public-directory.service
""".replace('RELEASE',release).replace('TEMP',temp).replace('PINS',repr(pins))
 try:
  if '/opt/enclave-directory/'+release+'/enclave-directory.mjs' not in exists:
   ssh(target,"bash -s <<'INSTALL'\n"+install+"\nINSTALL");installed=True
  success=None
  for attempt in range(10):
   try:
    health=get(origin+'/health');routes=get(origin+'/v1/network/routes');records=get(origin+'/v1/network/records')
    if health.get('ok') and len(routes.get('deployments',{}))>=12:
     success={'host':name,'origin':origin,'baselineRoutes':before_count,'verifiedRoutes':len(routes['deployments']),'providers':len(records['providers']),'policies':len(records['policies'])};break
   except Exception:pass
   time.sleep(3)
  if not success:raise RuntimeError('updated directory failed route validation')
  installed=ssh(target,'sha256sum /opt/enclave-directory/'+release+'/enclave-directory.mjs').split()[0]
  assert installed==sha
  success['systemd']=ssh(target,'systemctl show enclave-public-directory.service --property=ActiveState --property=NRestarts --property=ExecStart').strip()
  if '/opt/enclave-directory/'+release+'/enclave-directory.mjs' not in success['systemd']:raise RuntimeError('effective service command does not use pinned release')
  success['bundleSha256']=installed;results.append(success);print(name+': pinned directory active; '+str(success['verifiedRoutes'])+' live routes',flush=True)
 except Exception:
  if installed and not success:ssh(target,'cp /etc/systemd/system/enclave-public-directory.service.d/rollback-before-'+release+'.txt /etc/systemd/system/enclave-public-directory.service.d/zz-authority-pins.conf\nsystemctl daemon-reload\nsystemctl restart enclave-public-directory.service')
  raise
 report={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release':release,'authorityPins':pins,'directories':results,'status':'complete' if len(results)==4 else 'rolling out','scope':'public metadata only; provider tunnels and guest processes were not restarted'}
 (root/'outputs/pinned-directory-rollout.json').write_text(json.dumps(report,indent=2)+'\n')
