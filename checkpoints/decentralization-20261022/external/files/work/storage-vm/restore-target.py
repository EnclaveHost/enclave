from pathlib import Path
import subprocess,json,os,time,hashlib,datetime,gzip,yaml
root=Path('/home/storageadmin/migration');private=root;name='enclave-indexd-target-rehearsal';reportfile=root/'target-restore-verification.json'
report=json.loads((root/'source-recovery-verification.json').read_text());archive=private/report['file'];assert hashlib.sha256(archive.read_bytes()).hexdigest()==report['sha256'];log=open(private/'full-restore.log','ab');os.chmod(private/'full-restore.log',0o600)
def dex(args,input=None,check=True):return subprocess.run(['docker','exec',*(['-i'] if input is not None else []),name,*args],input=input,capture_output=True,check=check)
inspect=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
assert inspect['HostConfig']['NetworkMode']=='none' and not inspect['HostConfig']['PortBindings'] and inspect['HostConfig']['ReadonlyRootfs']
for attempt in range(30):
 if dex(['pg_isready','-U','postgres','-d','indexd'],check=False).returncode==0:break
 time.sleep(1)
else:raise RuntimeError('isolated PostgreSQL did not become ready')
# Extract only the names our capture helper produced, into RAM inside the isolated container.
gpg=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(private/'backup.pass'),'--decrypt',str(archive)],stdout=subprocess.PIPE,stderr=log)
untar=subprocess.run(['docker','exec','-i',name,'tar','--no-same-owner','-xf','-','-C','/snapshot','indexd.pgdump','consensus.db','indexd.yml','indexd','counts.json','manifest.json'],stdin=gpg.stdout,stdout=log,stderr=log)
gpg.stdout.close();assert gpg.wait()==0 and untar.returncode==0,'decrypt/extraction failed; protected diagnostics retained'
manifest=json.loads(dex(['cat','/snapshot/manifest.json']).stdout)
for filename,row in manifest['files'].items():
 assert filename in ['indexd.pgdump','consensus.db','indexd.yml','indexd','counts.json']
 got=dex(['sha256sum','/snapshot/'+filename]).stdout.decode().split()[0];assert got==row['sha256'],filename+' hash mismatch'
restored=dex(['pg_restore','--username=postgres','--dbname=indexd','--no-owner','--no-acl','--exit-on-error','--clean','--if-exists','/snapshot/indexd.pgdump'],check=False)
log.write(restored.stdout+restored.stderr);assert restored.returncode==0,'database restore failed; protected diagnostics retained'
# The GeoIP lookup database is public auxiliary data, not mutable wallet/consensus state.
with gzip.open(private/'indexd-geolite2.mmdb.gz','rb') as stream:
 result=dex(['sh','-c','umask 077; cat > /snapshot/GeoLite2-City.mmdb'],input=stream.read());assert result.returncode==0
cfg=yaml.safe_load(dex(['cat','/snapshot/indexd.yml']).stdout)
cfg.update({'directory':'/snapshot','autoOpenWebUI':False,'debug':False})
cfg['database']={'host':'127.0.0.1','port':5432,'user':'postgres','password':'','database':'indexd','sslmode':'disable'}
cfg['adminAPI']={'address':'127.0.0.1:9980','password':'<REDACTED:indexd-admin-password>'}
cfg['applicationAPI']={'address':'127.0.0.1:9982','advertiseURL':'http://127.0.0.1:9982'}
cfg['syncer']={'address':'127.0.0.1:9981','bootstrap':False,'enableUPnP':False,'peers':[]}
cfg['explorer']={'enabled':False}
cfg['slabs']={'migrations':False,'migrationWorkers':1}
cfg['log']={'stdout':{'enabled':True,'level':'info','format':'json','enableANSI':False},'file':{'enabled':False,'level':'info','format':'json'}}
# Configuration plaintext never touches the local filesystem or tool output.
dex(['sh','-c','umask 077; cat > /snapshot/offline.yml'],input=yaml.safe_dump(cfg).encode());del cfg
dex(['sh','-c','umask 077; cat > /snapshot/probe'],input=(root/'indexd-offline-probe').read_bytes())
dex(['chmod','0755','/snapshot/indexd','/snapshot/probe'])
subprocess.run(['docker','exec','-d','--env','INDEXD_CONFIG_FILE=/snapshot/offline.yml','--env','GOMEMLIMIT=256MiB',name,'sh','-c','exec /snapshot/indexd > /snapshot/indexd.log 2>&1'],check=True,stdout=log,stderr=log)
health=None
for attempt in range(45):
 result=dex(['/snapshot/probe'],check=False)
 if result.returncode==0:health=json.loads(result.stdout);break
 time.sleep(1)
if health is None:
 # Report only known failure classes, never a raw log or its configuration.
 raw=dex(['cat','/snapshot/indexd.log']).stdout.decode(errors='replace')
 classes=[x for x in ['wallet seed change detected','failed to initialize logger','failed to create MaxMind locator','failed to open consensus database','failed to create chain store','field migrations not found','permission denied','fatal error','failed to create postgres store'] if x in raw]
 raise RuntimeError('indexd startup failed; diagnostic classes: '+','.join(classes))
counts=json.loads(dex(['psql','-U','postgres','-d','indexd','-Atq','-c',"SELECT json_build_object('objects',(SELECT count(*) FROM objects),'slabs',(SELECT count(*) FROM slabs),'contracts',(SELECT count(*) FROM contracts),'accounts',(SELECT count(*) FROM accounts),'invalidIndexes',(SELECT count(*) FROM pg_index WHERE NOT indisvalid),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE NOT convalidated));"]).stdout)
for k,v in manifest['counts'].items():assert counts[k]==v,(k,counts[k],v)
assert counts['invalidIndexes']==0 and counts['unvalidatedConstraints']==0
assert health['walletLoaded'] and health['state']['syncHeight']>0
assert health['state']['scanHeight']==health['state']['syncHeight'],'snapshot subscriber did not catch up'
report.update({'restored':True,'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'isolation':{'network':'none','portsPublished':False,'rootFilesystemReadOnly':True,'storage':'RAM filesystems','indexdStarted':True,'walletNetworkAccess':False},'restoredCounts':counts,'apiVerification':health,'auxiliaryGeoIP':{'file':'indexd-geolite2.mmdb.gz','bytes':(private/'indexd-geolite2.mmdb.gz').stat().st_size,'sha256':hashlib.sha256((private/'indexd-geolite2.mmdb.gz').read_bytes()).hexdigest()},'destination':'minipc Hyper-V enclave-storage','limitation':'Destination process/database/consensus startup offline. No remote slab reads, uploads, wallet rotation, production cutover or independent custody verified.'})
reportfile.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'restored':True,'counts':counts,'apiVerification':health}))
