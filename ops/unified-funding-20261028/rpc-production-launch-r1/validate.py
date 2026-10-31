from pathlib import Path
import importlib.util,json,hashlib,os,ast
p=Path(__file__).resolve().parent;spec=json.loads((p/'SPEC.json').read_text());s=Path(spec['sourceRoot']);pins=json.loads((p/'PINS.json').read_text())
for name,sha in pins.items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==sha
m=importlib.util.spec_from_file_location('run_startup',s/'rpc/run_startup.py');r=importlib.util.module_from_spec(m);m.loader.exec_module(r);c=r.c
v=c.protocol.decode(c.read_pinned(spec['template']));r.w.transport(v['windows']['transport'],p/'unused')
for phase in r.w.PHASES:
 b=v['windows']['binaries'][phase]
 for k,n in zip(('controller','entry'),r.w.IMAGES[phase]):r.w.image(b[k],n)
r.w.image(v['windows']['binaries']['start-once']['cleanup'],'cleanup-controller.exe')
r.w.image(v['windows']['filesHelper'],'transition-files.exe');r.w.image(v['windows']['endpointHelper'],'vm-endpoint.exe')
r.w.staged(v['handoff'],'handoff.json');media=c.protocol.decode(c.read_pinned(v['media']));assert media['instance']==spec['instance']
profile=c.protocol.decode(c.read_pinned(v['localGuestOwner']['profile']));assert profile['vmAttempt']==spec['vmAttempt'] and profile['ownerBootId']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()==spec['ownerBootId']
for name,sha in v['localGuestOwner']['sourcePins'].items():assert hashlib.sha256((s/'rpc'/name).read_bytes()).hexdigest()==sha
cred=c.protocol.decode(c.read_pinned(v['export']['credentialReceipt']));assert cred['attempt']==spec['attempt'] and cred['instance']==spec['instance']
for role,row in v['export']['roles'].items():
 c.directory(row['parent']);assert not (Path(row['parent'])/(spec['attempt']+'-'+role)).exists()
 for name,meta in row['originals']:r.prepare.volume.directory(Path(name).parent);assert r.prepare.volume.metadata(name)==meta
 for kind,key in [('server','tls'),('client','clientTls')]:r.prepare.tls_directory(row[key],role,kind,cred['roles'][role])
for key in ('stateParent',):c.directory(v['export'][key])
c.directory(Path(v['export']['output']).parent);c.directory(spec['clockParent']);assert not (Path(spec['clockParent'])/spec['attempt']).exists()
assert len(set(v['nonces'].values())|{spec['attempt'],spec['vmAttempt']})==11
admission=r.resource_admission(v)
(p/'STATIC-VALIDATION.json').write_text(json.dumps({'sourcePins':len(pins),'localAdmission':admission,'templateSha256':spec['template']['sha256'],'originalsUnchanged':True,'privateCredentialsMetadataOnly':True,'productionClockBegun':False,'nativeExecuted':False},indent=2)+'\n')
