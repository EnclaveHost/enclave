import pathlib,hashlib,subprocess,json,datetime
p=pathlib.Path('/etc/enclave-rpc/chain.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='81988aeef841cc073b359ab29993641b06e71d72190ddc5df606057ddd7b5eb7'
assert p.stat().st_uid==0 and p.stat().st_gid==0 and p.stat().st_mode&0o777==0o600
p.chmod(0o644) # Restore stage_node_units.py installer mode; this config is public, JWT is separate.
r={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'oldMode':'0600','restoredInstallerMode':'0644','configSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'serviceIdentityChecks':{}}
for u in ('rpcl1el','rpcl1cl','rpcbase'):
 a=subprocess.run(['runuser','-u',u,'--','python3','-I','/opt/enclave-rpc/chain_service.py','coverage-identity'],capture_output=True,text=True)
 assert a.returncode==0,(u,a.stderr)
 r['serviceIdentityChecks'][u]=json.loads(a.stdout)['chainConfigSha256']
print(json.dumps(r,indent=2))
