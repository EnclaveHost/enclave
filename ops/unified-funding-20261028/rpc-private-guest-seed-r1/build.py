from pathlib import Path
import os,time,json,hashlib,base64,zlib,sys,importlib.util,subprocess,stat
os.umask(0o077)
blob=json.loads(zlib.decompress(base64.b64decode(sys.argv[1])))
started=time.monotonic();root=Path(blob['root'])
def guard():
 assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==blob['bootId']
 mem=next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
 disk=os.statvfs(root if root.exists() else root.parent);free=disk.f_bavail*disk.f_frsize
 assert mem>=2*1024**3+128*1024**2 and free>=16*1024**3 and time.monotonic()-started<100
 return {'memAvailableBytes':mem,'diskFreeBytes':free}
assert 0<=time.time_ns()-blob['admissionObservationUtcNs']<300_000_000_000
before=guard();root.mkdir(mode=0o700)
for name,row in blob['sources'].items():
 assert name in ['credentials.py','prepare_seed.py'];data=base64.b64decode(row['data']);assert hashlib.sha256(data).hexdigest()==row['sha256']
 with (root/name).open('xb') as f:f.write(data)
def load(name):
 spec=importlib.util.spec_from_file_location(name,root/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
credentials=load('credentials');seed=load('prepare_seed')
generated=credentials.generate(root,blob['attempt'],blob['config']['instance'],blob['tools']);guard()
c=blob['config'];c['credentials']={'bundle':generated['path'],'publicReceiptSha256':generated['publicReceiptSha256'],'tools':blob['tools']}
result=seed.build(c);guard()
schema=subprocess.run(['/usr/bin/cloud-init','schema','--config-file',str(root/'output/readback/user-data')],capture_output=True,timeout=15)
# Diagnostics could quote user-data on failure; retain them only in the private artifact root.
assert len(schema.stdout)+len(schema.stderr)<=65536
(root/'schema.stdout').write_bytes(schema.stdout);(root/'schema.stderr').write_bytes(schema.stderr)
public={'result':result,'privateBundle':generated['path'],'publicCredentialReceiptSha256':generated['publicReceiptSha256'],'schemaExit':schema.returncode,'cloudInitExecuted':False,'before':before,'after':guard(),'seconds':time.monotonic()-started,'invocation':os.environ.get('INVOCATION_ID'),'sourcePins':{name:row['sha256'] for name,row in blob['sources'].items()}}
(root/'PUBLIC-RESULT.json').write_text(json.dumps(public,indent=2)+'\n')
print(json.dumps(public));raise SystemExit(schema.returncode)
