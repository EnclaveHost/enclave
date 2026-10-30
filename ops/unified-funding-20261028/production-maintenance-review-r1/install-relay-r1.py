"""One coordinator-owned activation; gate/watchdog and exact baseline required. No signing or journal reset."""
import pathlib,sys,json,os,time,fcntl,hashlib,subprocess,shutil,urllib.request
sys.path.insert(0,'/opt/enclave-funding-staged/maintenance-r1')
import session_gate as g
import interruption_watchdog as w
assert os.geteuid()==0 and sys.argv[1:]==['--apply']
op='funding-activation-r1-20261028';wd=w.WATCH/op
lock=os.open(wd/'activation.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
watch=g.load(wd/'watchdog.json');assert watch['deadlineUnix']-time.time()>180 and 'outcome' not in watch
assert w.relay_identity()==watch['baseline'] and not(wd/'activation-started.json').exists()
routes,_=g.read_routes();assert [r for r in routes if r.get('@id')==g.gate_route(op)['@id']]==[g.gate_route(op)]
base=pathlib.Path('/opt/nan-relay');stage=pathlib.Path('/opt/enclave-funding-staged/activation-r1-20261028')
pins={'sessions.mjs':'76341ba39b14463495ce5d9736f115e759751a6f9eaae2d77dbb113327c8530c','funding-route.mjs':'1989f3ebf88833ac492e4f121ff33d564b1798eae1e5239b1aae444b63b572cd','funding-abi.mjs':'6bb37e658aca45fd416d5ea17dda3109e1b41791e674976a60425d579f485cd7','fee-policy.mjs':'32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd','funding-activation.mjs':'7554454dbe091f4bcc7ef8e15ac5dd8082c8be6d94256f52b1c8fadcfc198645'}
protected={'api-relay.js':'481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d','sessions-abi.mjs':'e9c2464c529d0665e4b2e38bdaa0bf8c703346f046b85521aba755bfc1b2a0a6','snp-verify.mjs':'10520dd25d6a7a40225a7076521c383fc3eb296b1f290ac6b9e9fbbd1697de91'}
sha=lambda b:hashlib.sha256(b).hexdigest()
for n,h in protected.items():assert sha((base/n).read_bytes())==h
for n,h in pins.items():
 assert not(stage/n).is_symlink() and sha((stage/n).read_bytes())==h
 if n!='sessions.mjs':assert not os.path.lexists(base/n)
assert not(base/'sessions.mjs').is_symlink()
journal=pathlib.Path('/var/lib/enclave-relay/sessions-relayer.json');jbytes=journal.read_bytes()
assert sha(jbytes)=='0ce01a81d6d6802b2eb1258ed4b8657a0f6c83556ff388ad3e2be565e6b96232'
assert all(x['status']=='mined' for x in json.loads(jbytes)['txs'])
idx=json.loads(pathlib.Path('/var/lib/enclave-relay/sessions-index.json').read_text());assert all(int(str(x['expiresAt']).removesuffix('n'))>time.time()+1200 for x in idx['sessions'].values() if not x.get('ended'))
oldpid=watch['baseline']['pid'];oldenv=pathlib.Path(f'/proc/{oldpid}/environ').read_bytes()
unit=pathlib.Path('/etc/systemd/system/enclave-api-relay.service');dropdir=pathlib.Path(str(unit)+'.d');drop=dropdir/'zzzzzzzz-unified-funding-20261028.conf';assert not os.path.lexists(drop)
oldfiles=[unit]+sorted(dropdir.glob('*.conf'));oldpins={str(f):sha(f.read_bytes()) for f in oldfiles}
root=pathlib.Path('/var/lib/enclave-maintenance/funding-activation');g.secure_dir(root,create=True)
backup=root/op;backup.mkdir(mode=0o700);g.sync_dir(root)
for f in [base/'sessions.mjs',journal,pathlib.Path('/var/lib/enclave-relay/sessions-index.json')]+oldfiles:
 dest=backup/f.relative_to('/');dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with dest.open('xb') as s:s.write(f.read_bytes());s.flush();os.fsync(s.fileno())
 os.chmod(dest,0o600)
with (backup/'original-environ-private.bin').open('xb') as s:s.write(oldenv);s.flush();os.fsync(s.fileno())
os.chmod(backup/'original-environ-private.bin',0o600)
for d in sorted((x for x in backup.rglob('*') if x.is_dir()),key=lambda x:len(x.parts),reverse=True):g.sync_dir(d)
g.sync_dir(backup)
g.save(backup/'baseline.json',{'pid':oldpid,'sources':protected,'journalSha256':sha(jbytes),'unitDropInHashes':oldpins,'newSources':pins})
config='/etc/enclave-funding/activation-20261028-r1'
env={'SESSIONS_FUNDING_OWNER_CONTROLS':'1','SESSIONS_FUNDING_INTAKE':'1','SESSIONS_FUNDING_OWNER_MANIFEST':config+'/owner-controls.json','SESSIONS_FUNDING_MANIFEST':config+'/intake-manifest.json','SESSIONS_FUNDING_FEE_POLICY':config+'/fee-policy.json','SESSIONS_FUNDING_RELAYER':'0xf4B78D91911e1c064A02E4D28C69E2De6056bE57'}
parse=lambda b:dict(x.split(b'=',1) for x in b.split(bytes([0])) if b'=' in x)
assert not any(k.encode() in parse(oldenv) for k in env)
for n,h in {'owner-controls.json':'85f760b12491cecffae4a7a9f158d10a590205d05c4039c9d7b7295a5628f3c5','intake-manifest.json':'2fb3fcced1e297e3efe420a127c65b597924c09ac5aaae8958783988fb0e067c','fee-policy.json':'efb44bc31c5a30dfa1078cf4b9a4d9af66e8449fc9167943e410766bad8013e3'}.items():assert sha((pathlib.Path(config)/n).read_bytes())==h
assert sha(journal.read_bytes())==sha(jbytes) and w.relay_identity()==watch['baseline']
freshWatch=g.load(wd/'watchdog.json')
assert 'outcome' not in freshWatch and freshWatch['bootId']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
assert freshWatch['deadlineUnix']-time.time()>300 and freshWatch['deadlineMonotonic']-time.monotonic()>300
assert subprocess.check_output(['systemctl','is-active','enclave-funding-session-window-r1-20261028.service'],text=True).strip()=='active'
assert freshWatch['baseline']==watch['baseline'] and w.relay_identity()==watch['baseline']
g.save(wd/'activation-started.json',{'at':time.time(),'backup':str(backup),'newSources':pins})
g.save(backup/'state.json',{'phase':'source-switch-started','at':time.time()})
for n,h in pins.items():
 temp=base/('.'+n+'.funding-r1-new');assert not os.path.lexists(temp)
 with temp.open('xb') as s:s.write((stage/n).read_bytes());s.flush();os.fsync(s.fileno())
 os.chmod(temp,0o644);assert sha(temp.read_bytes())==h;os.replace(temp,base/n)
g.sync_dir(base)
with drop.open('x') as s:s.write('[Service]\n'+''.join('Environment="'+k+'='+v+'"\n' for k,v in env.items()));s.flush();os.fsync(s.fileno())
os.chmod(drop,0o644);g.sync_dir(dropdir)
assert all(sha(pathlib.Path(f).read_bytes())==h for f,h in oldpins.items())
g.save(backup/'state.json',{'phase':'restart-unknown','at':time.time()})
subprocess.run(['systemctl','daemon-reload'],check=True,timeout=20)
subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=210)
newpid=int(subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','--value'],text=True).strip());assert newpid>0 and newpid!=oldpid
volatile={b'INVOCATION_ID',b'JOURNAL_STREAM',b'SYSTEMD_EXEC_PID',b'CREDENTIALS_DIRECTORY'}
a=parse(oldenv);b=parse(pathlib.Path(f'/proc/{newpid}/environ').read_bytes())
assert {k:v for k,v in a.items() if k not in volatile}=={k:v for k,v in b.items() if k not in volatile and k.decode() not in env},'original environment changed'
assert all(b[k.encode()]==v.encode() for k,v in env.items())
assert all(sha((base/n).read_bytes())==h for n,h in {**pins,**protected}.items())
assert all(sha(pathlib.Path(f).read_bytes())==h for f,h in oldpins.items())
assert sha(journal.read_bytes())==sha(jbytes),'journal changed; reconcile before reopening writes'
result={'phase':'source-restart-verified-gate-retained','at':time.time(),'oldPid':oldpid,'newPid':newpid,'journalSha256':sha(jbytes),'environmentPreserved':True,'priorUnitDropInsPreserved':True,'backup':str(backup),'financialSends':False}
g.save(backup/'state.json',result);print(json.dumps(result))
# Lock closes at exit; marker remains. Root must review actual HTTP health then exact CAS-remove owned gate.
