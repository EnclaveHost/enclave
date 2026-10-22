# ROOT EXECUTES from /home/steven/Documents/Codex/2026-10-18/wo (prepared by Claude 5a07654a; derived from
# linux-lease-root-release/activation/activate.py). Differences from that script, and nothing else:
#  - paths: this directory, a FRESH private-backup/ here (the c083 activation's backup and result are never touched);
#  - preconditions also require the c083 activation to be rolled back (its result says so, its drop-in is gone) and the
#    corrected admission to be installed;
#  - the new image is KEPT only when, after the corrected measurement attaches, BOTH existing apps are adopted under it:
#    the public "[claim] <id> adopted:" line for each, from this host's enclave-metal journal since this restart. Only those
#    claim lines are read (journalctl -o cat, filtered here); nothing else from the journal is printed or stored. No
#    adoption of both within ADOPT_SECONDS rolls back exactly as an attach failure does (refusal lines are recorded).
# App-paid renewals are verified AFTER this script (README: the existing read-only audit), not here.
from pathlib import Path
import os,json,hashlib,subprocess,datetime,time,urllib.request,secrets,stat,re
W=Path('/home/steven/Documents/Codex/2026-10-18/wo');A=Path(__file__).resolve().parent
plan=json.loads((A/'plan.json').read_text());ad=json.loads((A/'admission.json').read_text())
OLDA=W/'work/linux-lease-root-release/activation'
os.umask(0o077)
ADOPT_SECONDS=300
assert ad['stage'] in ('installed; public endpoint recheck pending','verified active; old control still connected')
assert json.loads((OLDA/'result.json').read_text()).get('productionActivated') is False,'the c083 activation is not recorded as rolled back'
pre=json.loads((W/'outputs/decentralization-audit/linux-conduit-funding-preflight.json').read_text());age=time.time()-float(pre['block']['timestamp'])
assert age<360,'refresh funding/lease preflight before cutover'
assert all(int(r['leaseRemainingSeconds'])-age>480+ADOPT_SECONDS for r in pre['rows']),'not enough lease margin for adoption check and controlled rollback'
assert all(r['reserve']['enabled'] and int(r['reserve']['balanceWei'])>0 for r in pre['rows'])
config=Path('/home/steven/Projects/enclave/metal/config.json');drop=Path('/home/steven/.config/systemd/user/enclave-metal.service.d/95-app-funded-leases.conf');backup=A/'private-backup'
assert not backup.exists() and not drop.exists() and not (A/'result.json').exists()
old=config.read_bytes();c=json.loads(old)
assert c['dist']=='/home/steven/enclave-prod/dist-sdshield-2857356cd' and c.get('mode')=='snp' and not c.get('leaseGas') and not c.get('direct')
working=subprocess.check_output(['systemctl','--user','show','enclave-metal.service','-p','WorkingDirectory','--value'],text=True).strip()
assert working=='/home/steven/enclave-prod/metal-d760ef58'
for k in ('release','image'): assert Path(plan[k]).is_dir()
backup.mkdir(mode=0o700);(backup/'config.json').write_bytes(old);(backup/'config.json').chmod(0o600)
mode=stat.S_IMODE(config.stat().st_mode)
c.update(dist=plan['image'],leaseGas=plan['leaseGas']);new=(json.dumps(c,indent=2)+'\n').encode();body='[Service]\nWorkingDirectory='+plan['release']+'\n'
def atomic_config(raw):
 tmp=config.with_name(config.name+'.leasegas-tmp');assert not tmp.exists();tmp.write_bytes(raw);tmp.chmod(mode);os.replace(tmp,config)
def restart():
 subprocess.run(['systemctl','--user','daemon-reload'],check=True)
 subprocess.run(['systemctl','--user','restart','enclave-metal.service'],check=True,timeout=40)
ids=plan['adoptionRequired']
def claim_lines(since):
 out=subprocess.run(['journalctl','--user','-u','enclave-metal.service','--since',since,'-o','cat','--no-pager'],capture_output=True,text=True,timeout=30).stdout
 return [l for l in out.splitlines() if l.startswith('[claim] ') and any(i in l for i in ids)]
result={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'measurement':plan['measurement'],'configBeforeSha256':hashlib.sha256(old).hexdigest(),'configAfterSha256':hashlib.sha256(new).hexdigest(),'release':plan['release'],'image':plan['image'],'state':'starting','rollbackAvailable':True,'adoption':{}}
def save(): (A/'result.json').write_text(json.dumps(result,indent=2)+'\n')
save();mutated=False
try:
 assert config.read_bytes()==old
 since=datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
 atomic_config(new);mutated=True;drop.write_text(body);drop.chmod(0o644);restart()
 print('Control restarted; awaiting fresh hardware-attested attachment.',flush=True)
 end=time.monotonic()+120
 while time.monotonic()<end:
  try:
   with urllib.request.urlopen('https://api.enclave.host/v1/enclaves/metal0/attestation?nonce='+secrets.token_hex(32),timeout=12) as r:d=json.load(r)
   if d.get('operatorAllowlist',{}).get('admittedAtAttach')==plan['measurement']:
    subprocess.run(['systemctl','--user','is-active','--quiet','enclave-metal.service'],check=True)
    result.update(state='new measurement attached; adoption of both apps pending',attachedAt=datetime.datetime.now(datetime.timezone.utc).isoformat());save();print(result['state'],flush=True);break
  except Exception as e:
   # No response bodies, configuration, guest logs or private keys are printed.
   result['lastObservationError']=type(e).__name__;save()
  time.sleep(5)
 else: raise RuntimeError('new control measurement did not attach within 120 seconds')
 end=time.monotonic()+ADOPT_SECONDS
 while time.monotonic()<end:
  lines=claim_lines(since)
  for i in ids:
   if i not in result['adoption'] and any(l.startswith('[claim] '+i+' adopted:') for l in lines):
    result['adoption'][i]=next(l for l in lines if l.startswith('[claim] '+i+' adopted:'));save();print(result['adoption'][i],flush=True)
  # refusals are recorded, not acted on: a boot-time refusal may clear; only adoption of both within the window keeps it
  result['refusals']=[l[:200] for l in lines if 'no free capacity' in l or 'holding new claims' in l][-6:];save()
  if len(result['adoption'])==len(ids): break
  time.sleep(5)
 else: raise RuntimeError('both existing apps were not adopted within %d seconds'%ADOPT_SECONDS)
 result.update(state='activated; both apps adopted under the new measurement; app-paid renewal verification pending',verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),productionActivated=True);save();print(result['state'],flush=True)
except BaseException as e:
 result.update(state='activation failed; rollback pending',error=type(e).__name__,detail=str(e)[:300]);save()
 if mutated:
  assert config.read_bytes()==new,'config changed concurrently: refuse overwriting it'
  atomic_config(old)
  if drop.exists():assert drop.read_text()==body;drop.unlink()
  restart();result.update(state='rolled back to previous control release',productionActivated=False);save();print(result['state'],flush=True)
 raise
