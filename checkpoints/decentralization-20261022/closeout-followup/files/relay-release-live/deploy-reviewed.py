"""One bounded, CAS-protected relay update; no wallet or guest/host restart."""
from pathlib import Path
import base64, hashlib, json, subprocess

base = Path(__file__).resolve().parent
review = base.parent / 'relay-release-list-review'
old = '93d543e61b5cb8254087fce04bf776832fb6215c9d08f8a05ddeb411d02582e2'
new = '48cf67ee80a088f3b713eaed401273a97aecb3aeca7204f320e0f22083405715'
module = (review / 'secrets-release.mjs.installed-lineage').read_bytes()
assert hashlib.sha256(module).hexdigest() == new
settings = json.loads((base / 'backend-public-settings.json').read_text())
evidence = json.loads((base.parent / 'queued-funding-review/summary.json').read_text())
add = [i for i in evidence['ids'] if i[:10] in ['0xef514ed3','0x38f368d6','0xc13d4b6a','0x59f1273d']]
assert len(add) == 4
assert all(next(r for r in evidence['ownerProvenance'] if r['id'] == i)['credited'] for i in add)
payload = dict(old=old, new=new, source=base64.b64encode(module).decode(), previous=settings['SECRETS_RELEASE_DEPLOYMENTS'], add=add)
remote = r'''
import base64, hashlib, json, os, pathlib, subprocess, time, urllib.request
p = PAYLOAD
svc = 'enclave-api-relay'
target = pathlib.Path('/opt/nan-relay/secrets-release.mjs')
envfile = pathlib.Path('/etc/nan-relay/queued-release-recovery-20261022.env')
dropin = pathlib.Path('/etc/systemd/system/enclave-api-relay.service.d/zzzzzz-queued-release-recovery.conf')
backup = pathlib.Path('/var/backups/enclave-release-20261022-r2')
pid = subprocess.check_output(['systemctl','show',svc,'-p','MainPID','--value'],text=True).strip()
env = dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_text().split(chr(0)) if '=' in x)
assert env.get('SECRETS_ATTESTED_RELEASE') == '1'
assert env['SECRETS_RELEASE_DEPLOYMENTS'] == p['previous'], 'release list changed'
before = target.read_bytes()
assert hashlib.sha256(before).hexdigest() == p['old'], 'source changed'
assert not envfile.exists() and not dropin.exists() and not backup.exists(), 'already attempted: inspect instead'
source = base64.b64decode(p['source'])
assert hashlib.sha256(source).hexdigest() == p['new']
ids = list(dict.fromkeys(p['previous'].split(',') + p['add']))
assert len(ids) == 14 and '*' not in ids
backup.mkdir(mode=0o700)
(backup/'secrets-release.mjs').write_bytes(before)
os.chmod(backup/'secrets-release.mjs',0o600)
(backup/'public-previous.json').write_text(json.dumps({'pid':pid,'sha256':p['old'],'releaseIds':p['previous']}))
st = target.stat()
tmp = target.with_name('secrets-release.queued-candidate.mjs')
assert not tmp.exists()
tmp.write_bytes(source); os.chmod(tmp,st.st_mode & 0o777); os.chown(tmp,st.st_uid,st.st_gid)
subprocess.run(['/usr/bin/node','--check',str(tmp)],check=True,timeout=15,capture_output=True)
changed = False
try:
 os.replace(tmp,target); changed = True
 envfile.write_text('SECRETS_RELEASE_DEPLOYMENTS='+','.join(ids)+'\n'); os.chmod(envfile,0o600)
 dropin.write_text('[Service]\nEnvironmentFile='+str(envfile)+'\n'); os.chmod(dropin,0o644)
 subprocess.run(['systemctl','daemon-reload'],check=True,timeout=15,capture_output=True)
 subprocess.run(['systemctl','restart',svc],check=True,timeout=45,capture_output=True)
 # systemd's active PID precedes asynchronous RPC initialization/listen.
 deadline=time.monotonic()+40
 while True:
  try:
   with urllib.request.urlopen('http://127.0.0.1:8100/v1/secrets/release-status?id='+ids[0],timeout=3) as r:
    assert r.status==200 and json.load(r).get('listed') is True
   break
  except Exception:
   if time.monotonic()>=deadline: raise
   time.sleep(1)
 newpid = subprocess.check_output(['systemctl','show',svc,'-p','MainPID','--value'],text=True).strip()
 assert newpid != '0' and newpid != pid
 newenv = dict(x.split('=',1) for x in pathlib.Path('/proc/'+newpid+'/environ').read_text().split(chr(0)) if '=' in x)
 assert newenv['SECRETS_RELEASE_DEPLOYMENTS'] == ','.join(ids)
 assert newenv.get('SECRETS_ATTESTED_RELEASE') == '1'
 assert newenv.get('SECRETS_RELEASE_APP_REFS') == env.get('SECRETS_RELEASE_APP_REFS')
 probes=[]
 for i in ids:
  start=time.monotonic()
  with urllib.request.urlopen('http://127.0.0.1:8100/v1/secrets/release-status?id='+i,timeout=5) as r:
   row=json.load(r); assert r.status==200 and row=={'id':i,'listed':True},row
  probes.append({'id':i,'listed':True,'ms':round((time.monotonic()-start)*1000)})
 result={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'status':'DEPLOYED_VERIFIED','oldPid':pid,'newPid':newpid,'oldSha256':p['old'],'newSha256':p['new'],'added':p['add'],'probes':probes,'backup':str(backup),'guestRestarts':0}
 print(json.dumps(result))
except Exception as e:
 if changed:
  tmp.write_bytes(before); os.chmod(tmp,st.st_mode & 0o777); os.chown(tmp,st.st_uid,st.st_gid); os.replace(tmp,target)
  dropin.unlink(missing_ok=True);envfile.unlink(missing_ok=True)
  subprocess.run(['systemctl','daemon-reload'],timeout=15,capture_output=True)
  rollback=subprocess.run(['systemctl','restart',svc],timeout=45,capture_output=True)
  print(json.dumps({'status':'ROLLED_BACK' if rollback.returncode==0 else 'ROLLBACK_RESTART_FAILED','errorType':type(e).__name__}))
 raise
'''.replace('PAYLOAD', repr(payload), 1)
ssh=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
r=subprocess.run(ssh+['sudo python3 -'],input=remote,text=True,capture_output=True,timeout=160)
(base/'deployment-result-r2.json').write_text(r.stdout)
print(r.stdout)
if r.returncode: print(r.stderr[-1800:])
raise SystemExit(r.returncode)
