from pathlib import Path
import json,hashlib,base64,subprocess,os
p=Path('/home/controladmin/rpc-guest-config-seed-20261031-r1');r=json.loads((p/'RESULT.json').read_text());iso=p/'seed.iso'
with iso.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==r['sha256']=='8854ff07a66ba6fa6c8238145a036003917a5c8ad3fe4ddaecdde881ba217bfc'
assert iso.stat().st_size==r['bytes']==13146112
user=(p/'readback/user-data').read_text();assert user.startswith('#cloud-config\n');c=json.loads(user.split('\n',1)[1]);records=r['records']
assert len(c['write_files'])==len(records) and {x['path'] for x in c['write_files']}==set(records)
for row in c['write_files']:
 data=base64.b64decode(row['content'],validate=True);expected=records[row['path']]
 assert row['owner']=='root:root' and row['permissions']==expected['mode'] and len(data)==expected['bytes'] and hashlib.sha256(data).hexdigest()==expected['sha256']
assert '/etc/enclave-rpc/jwt.hex' not in records
assert c['runcmd']==[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start','enclave-rpc-identity.service']]
assert not c['package_update'] and not c['package_upgrade'] and not c['ssh_pwauth'] and c['disable_root']
schema=subprocess.run(['/usr/bin/cloud-init','schema','--config-file',str(p/'readback/user-data')],capture_output=True,text=True,timeout=15)
assert len(schema.stdout)+len(schema.stderr)<16384
print(json.dumps({'hashAgrees':True,'bytes':r['bytes'],'seedSha256':r['sha256'],'verifiedFiles':len(records),'schemaExit':schema.returncode,'schemaStdout':schema.stdout,'schemaStderr':schema.stderr,'cloudInitExecuted':False,'noEngineSecret':True,'invocation':os.environ.get('INVOCATION_ID')}))
raise SystemExit(schema.returncode)
