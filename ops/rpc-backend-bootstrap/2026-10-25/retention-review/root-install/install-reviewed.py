#!/usr/bin/env python3
import hashlib,json,pathlib,subprocess,os,datetime
oldsha='a60ae322d9a70f2d154cc5ae10880159ccf65e2bc82fa6c3aa802ec22d7a3ca7';newsha='dc9f4ad9740602820e9419bfe8cc23f96b3c1e9deb74a09a694477a640d5c276'
p=pathlib.Path('/opt/enclave-rpc/chain_service.py');old=p.read_bytes();assert hashlib.sha256(old).hexdigest()==oldsha
new=pathlib.Path('/tmp/enclave-chain-service-retention-dc9f4ad9.py').read_bytes();assert hashlib.sha256(new).hexdigest()==newsha;compile(new,str(p),'exec')
cfg=pathlib.Path('/etc/enclave-rpc/chain.json');before=cfg.read_bytes();d=json.loads(before);assert d['baseBootstrap']['coverageVerified'] is False and 'coverageAcceptance' not in d['baseBootstrap']
assert subprocess.run(['systemctl','is-active','enclave-base-holder.service'],capture_output=True,text=True).stdout.strip()=='inactive'
assert subprocess.run(['systemctl','is-enabled','enclave-base-holder.path'],capture_output=True,text=True).stdout.strip()=='disabled'
protected={u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip() for u in ['enclave-l1-el.service','enclave-l1-cl.service','enclave-rpc-base-snapshot.service']};assert all(int(v)>0 for v in protected.values())
backup=pathlib.Path('/root/enclave-rpc-retention-dc9f4ad9');backup.mkdir(mode=0o700)
(backup/'chain_service.py.before').write_bytes(old)
snap=pathlib.Path('/etc/enclave-rpc/coverage/snapshot-manifest.json').read_bytes();assert hashlib.sha256(snap).hexdigest()=='1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
tmp=p.with_name('.chain_service.retention-dc9f4ad9.new')
with tmp.open('xb') as f:f.write(new);f.flush();os.fsync(f.fileno())
tmp.chmod(0o755);os.replace(tmp,p)
identity=subprocess.run(['python3','-I',str(p),'coverage-identity'],capture_output=True,text=True,check=True);ident=json.loads(identity.stdout)
assert ident['snapshotManifestSha256']==hashlib.sha256(snap).hexdigest()
check=subprocess.run(['python3','-I',str(p),'coverage-check'],capture_output=True,text=True)
assert check.returncode!=0 and 'Base snapshot blob coverage not approved' in check.stderr
assert cfg.read_bytes()==before
for u,pid in protected.items():assert subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip()==pid
r={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'oldSha256':oldsha,'newSha256':newsha,'identity':ident,'coverageCheckExit':check.returncode,'coverageCheckRefusal':'Base snapshot blob coverage not approved','coverageVerified':False,'chainConfigUnchanged':True,'retentionPolicyConfigured':False,'historyFloorReviewPending':True,'protectedPidsUnchanged':protected,'baseStillDisabled':True}
(backup/'receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
