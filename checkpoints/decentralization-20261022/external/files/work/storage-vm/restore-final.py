from pathlib import Path
import subprocess,os,hashlib,json,yaml,shutil,datetime
root=Path('/var/lib/enclave-indexd/final-source');state=Path('/var/lib/enclave-indexd/state');cfgfile=Path('/etc/enclave-indexd/indexd.yml')
assert not Path('/etc/enclave-indexd/ALLOW_LIVE_START').exists(),'Target writer already enabled'
assert subprocess.run(['systemctl','is-active','--quiet','enclave-indexd']).returncode!=0
assert not (state/'consensus.db').exists(),'Target consensus already restored; inspect before retry'
m=json.loads((root/'manifest.json').read_text());assert m['sourceFenced'] and m['sourceResumed'] is False
for name,row in m['files'].items():
 assert name in ['indexd.pgdump','consensus.db','indexd.yml','indexd','GeoLite2-City.mmdb','counts.json']
 with (root/name).open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256'],name+' hash mismatch'
staged=yaml.safe_load(cfgfile.read_text());cfg=yaml.safe_load((root/'indexd.yml').read_text());cfg['database']=staged['database'];cfg['directory']=str(state);cfg['autoOpenWebUI']=False
cfg['log']['file']['path']=str(state/'logs/indexd.log')
cfgfile.write_text(yaml.safe_dump(cfg));os.chmod(cfgfile,0o640)
(state/'logs').mkdir(exist_ok=True)
for src,dst in [('consensus.db',state/'consensus.db'),('GeoLite2-City.mmdb',state/'GeoLite2-City.mmdb'),('indexd',Path('/opt/enclave-indexd/indexd'))]:shutil.copyfile(root/src,dst)
os.chmod('/opt/enclave-indexd/indexd',0o755);subprocess.run(['chown','-R','enclave-indexd:enclave-indexd',str(state)],check=True)
with (root/'indexd.pgdump').open('rb') as stream:
 r=subprocess.run(['docker','exec','-i','enclave-indexd-postgres','pg_restore','--username=postgres','--dbname=indexd','--role=indexd','--no-owner','--no-acl','--exit-on-error'],stdin=stream,capture_output=True)
if r.returncode:
 p=root/'restore-diagnostics.log';p.write_bytes(r.stdout+r.stderr);p.chmod(0o600);raise RuntimeError('Database restore failed; private diagnostics retained')
sql="SELECT json_build_object('objects',(SELECT count(*) FROM objects),'slabs',(SELECT count(*) FROM slabs),'contracts',(SELECT count(*) FROM contracts),'accounts',(SELECT count(*) FROM accounts),'invalidIndexes',(SELECT count(*) FROM pg_index WHERE NOT indisvalid),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE NOT convalidated));"
r=subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',sql],capture_output=True,check=True)
counts=json.loads(r.stdout)
for k,v in m['counts'].items():assert counts[k]==v
assert counts['invalidIndexes']==0 and counts['unvalidatedConstraints']==0
report={'restoredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSnapshot':m['capturedAt'],'restoredCounts':counts,'allFileHashesVerified':True,'targetWriterStarted':False}
(root/'restore-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
