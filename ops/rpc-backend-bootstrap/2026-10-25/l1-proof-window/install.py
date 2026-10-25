import hashlib,json,pathlib,subprocess,os,datetime,stat
oldsha='713b0ddf4c99d12ca38e32e0e7b83a6ccb312230c70033ece976b8f7f11a4f57'
newsha='75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92'
p=pathlib.Path('/opt/enclave-rpc/chain_service.py')
old=p.read_bytes();assert hashlib.sha256(old).hexdigest()==oldsha
new=pathlib.Path('/tmp/enclave-l1-proof-window-75c879ec.py').read_bytes()
assert hashlib.sha256(new).hexdigest()==newsha;compile(new,str(p),'exec')
cfg=pathlib.Path('/etc/enclave-rpc/chain.json');before=cfg.read_bytes()
cfgstat=cfg.stat();assert stat.S_IMODE(cfgstat.st_mode)==0o644 and cfgstat.st_uid==0
d=json.loads(before);assert d['baseBootstrap']['coverageVerified'] is False
assert d['baseRetention']=={'historyFromBlock':48000000,'stateHistoryFromBlock':52500000}
assert subprocess.run(['systemctl','is-active','enclave-base-holder.service'],capture_output=True,text=True).stdout.strip()=='inactive'
units=['enclave-l1-el.service','enclave-l1-cl.service','enclave-rpc-base-snapshot.service']
pids={u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip() for u in units}
assert all(int(v)>0 for v in pids.values())
backup=pathlib.Path('/root/enclave-rpc-l1-proof-window-75c879ec');backup.mkdir(mode=0o700)
(backup/'chain_service.py.before').write_bytes(old)
tmp=p.with_name('.chain_service.proof-window-75c879ec.new')
with tmp.open('xb') as f:f.write(new);f.flush();os.fsync(f.fileno())
tmp.chmod(stat.S_IMODE(p.stat().st_mode));os.replace(tmp,p)
fd=os.open(p.parent,os.O_RDONLY);os.fsync(fd);os.close(fd)
identities={}
for user in ['rpcl1el','rpcl1cl','rpcbase']:
 result=subprocess.run(['runuser','-u',user,'--','python3','-I',str(p),'coverage-identity'],capture_output=True,text=True,check=True)
 identities[user]=json.loads(result.stdout)['chainConfigSha256']
assert len(set(identities.values()))==1
assert cfg.read_bytes()==before and stat.S_IMODE(cfg.stat().st_mode)==0o644
for u,pid in pids.items():assert subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip()==pid
r={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'oldSha256':oldsha,'newSha256':newsha,
   'configUnchanged':True,'configMode':'0644','configIdentities':identities,'pidsBeforeRestart':pids,
   'coverageVerified':False,'baseStillInactive':True,'restartNotYetPerformed':True}
(backup/'install-receipt.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
