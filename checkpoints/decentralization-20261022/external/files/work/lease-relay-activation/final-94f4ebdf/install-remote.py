import os,json,hashlib,pathlib,stat,subprocess
P=pathlib.Path
stage=P('/var/tmp/enclave-lease-stage-f54f41a865074182')
artifact='94f4ebdf93d727ed21c1b3aa6ae25114a40f5add40e9b708d4b60f2db7cbc322'
manifest=json.loads((stage/'staging-manifest.json').read_text())
assert manifest['files']['lease-relay.mjs']==artifact
for name,digest in manifest['files'].items():
 p=stage/name;assert not p.is_symlink() and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==digest
assert subprocess.run(['systemctl','is-active','--quiet','enclave-lease-relay']).returncode!=0,'existing active relay requires review'
key=P('/var/lib/enclave-lease-relay/relay.key');st=key.lstat();assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600
release=P('/opt/enclave-lease-relay/releases')/artifact
config=P('/etc/enclave-lease-relay')
for p in [release,config]:
 p.mkdir(parents=True,exist_ok=True,mode=0o755);assert not p.is_symlink() and p.stat().st_uid==0
mapping={'lease-relay.mjs':release/'lease-relay.mjs','lease-relay-check.mjs':release/'lease-relay-check.mjs','build-manifest.json':release/'manifest.json','deployment.json':config/'deployment.json','relay.env':config/'relay.env','enclave-lease-relay.service':P('/etc/systemd/system/enclave-lease-relay.service')}
# Preflight every destination before creating any file. Never overwrite a prior deployment or settings.
for name,p in mapping.items():
 if p.exists() or p.is_symlink():
  assert not p.is_symlink() and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==manifest['files'][name],str(p)+' differs'
current=P('/opt/enclave-lease-relay/current')
assert not current.exists() and not current.is_symlink() or current.is_symlink() and current.resolve()==release
for name,p in mapping.items():
 if not p.exists():
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600 if name=='relay.env' else 0o644)
  with os.fdopen(fd,'wb') as f:f.write((stage/name).read_bytes());f.flush();os.fsync(f.fileno())
 assert hashlib.sha256(p.read_bytes()).hexdigest()==manifest['files'][name]
if not current.is_symlink():current.symlink_to(release)
subprocess.run(['systemctl','daemon-reload'],check=True,timeout=30)
print(json.dumps({'status':'installed; not started or enabled','artifact':artifact,'release':str(release),'keyContentsRead':False,'files':{str(p):manifest['files'][n] for n,p in mapping.items()}}))
