from pathlib import Path
import os,json,hashlib,subprocess,datetime,time,urllib.request,secrets,stat
W=Path('/home/steven/Documents/Codex/2026-10-18/wo');A=W/'work/linux-lease-root-release/activation'; plan=json.loads((A/'plan.json').read_text());ad=json.loads((A/'admission.json').read_text())
os.umask(0o077)
assert ad['stage']=='verified active; old control still connected'
pre=json.loads((W/'outputs/decentralization-audit/linux-conduit-funding-preflight.json').read_text());age=time.time()-float(pre['block']['timestamp'])
assert age<360,'refresh funding/lease preflight before cutover'
assert all(int(r['leaseRemainingSeconds'])-age>480 for r in pre['rows']),'not enough lease margin for controlled rollback'
assert all(r['reserve']['enabled'] and int(r['reserve']['balanceWei'])>0 for r in pre['rows'])
config=Path('/home/steven/Projects/enclave/metal/config.json');drop=Path('/home/steven/.config/systemd/user/enclave-metal.service.d/95-app-funded-leases.conf');backup=A/'private-backup';assert not backup.exists() and not drop.exists()
old=config.read_bytes();c=json.loads(old)
assert c['dist']=='/home/steven/enclave-prod/dist-sdshield-2857356cd' and c.get('mode')=='snp' and not c.get('leaseGas') and not c.get('direct')
working=subprocess.check_output(['systemctl','--user','show','enclave-metal.service','-p','WorkingDirectory','--value'],text=True).strip()
assert working=='/home/steven/enclave-prod/metal-d760ef58'
backup.mkdir(mode=0o700);(backup/'config.json').write_bytes(old);(backup/'config.json').chmod(0o600)
mode=stat.S_IMODE(config.stat().st_mode)
c.update(dist=plan['image'],leaseGas=plan['leaseGas']);new=(json.dumps(c,indent=2)+'\n').encode();body='[Service]\nWorkingDirectory='+plan['release']+'\n'
def atomic_config(raw):
 tmp=config.with_name(config.name+'.leasegas-tmp');assert not tmp.exists();tmp.write_bytes(raw);tmp.chmod(mode);os.replace(tmp,config)
def restart():
 subprocess.run(['systemctl','--user','daemon-reload'],check=True)
 subprocess.run(['systemctl','--user','restart','enclave-metal.service'],check=True,timeout=40)
result={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'measurement':plan['measurement'],'configBeforeSha256':hashlib.sha256(old).hexdigest(),'configAfterSha256':hashlib.sha256(new).hexdigest(),'release':plan['release'],'image':plan['image'],'state':'starting','rollbackAvailable':True}
def save(): (A/'result.json').write_text(json.dumps(result,indent=2)+'\n')
save();mutated=False
try:
 assert config.read_bytes()==old
 atomic_config(new);mutated=True;drop.write_text(body);drop.chmod(0o644);restart()
 print('Control restarted; awaiting fresh hardware-attested attachment.',flush=True)
 end=time.monotonic()+120
 while time.monotonic()<end:
  try:
   with urllib.request.urlopen('https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32),timeout=12) as r:d=json.load(r)
   if d.get('operatorAllowlist',{}).get('admittedAtAttach')==plan['measurement']:
    subprocess.run(['systemctl','--user','is-active','--quiet','enclave-metal.service'],check=True)
    result.update(state='activated; new measurement attached; lease-payment verification pending',verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat());save();print(result['state'],flush=True);break
  except Exception as e:
   # No response bodies, configuration, guest logs or private keys are printed.
   result['lastObservationError']=type(e).__name__;save()
  time.sleep(5)
 else: raise RuntimeError('new control measurement did not attach within 120 seconds')
except BaseException as e:
 result.update(state='activation failed; rollback pending',error=type(e).__name__);save()
 if mutated:
  assert config.read_bytes()==new,'config changed concurrently: refuse overwriting it'
  atomic_config(old)
  if drop.exists():assert drop.read_text()==body;drop.unlink()
  restart();result['state']='rolled back to previous control release';save();print(result['state'],flush=True)
 raise
