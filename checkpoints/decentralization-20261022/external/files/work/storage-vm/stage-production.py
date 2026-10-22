from pathlib import Path
import subprocess,os,secrets,tarfile,hashlib,json,yaml,gzip,time,shutil
root=Path('/home/storageadmin/migration');cfgdir=Path('/etc/enclave-indexd');state=Path('/var/lib/enclave-indexd/state')
assert not (cfgdir/'ALLOW_LIVE_START').exists(),'Live start already authorized; inspect before staging'
if subprocess.run(['id','enclave-indexd'],capture_output=True).returncode:subprocess.run(['useradd','--system','--home-dir','/var/lib/enclave-indexd','--shell','/usr/sbin/nologin','enclave-indexd'],check=True)
for p in [cfgdir,state,Path('/var/lib/enclave-indexd/postgres'),Path('/opt/enclave-indexd'),Path('/usr/local/lib/enclave-storage')]:p.mkdir(parents=True,exist_ok=True)
assert not (cfgdir/'postgres.env').exists(),'Production configuration already staged'
adminpw=secrets.token_urlsafe(48);apppw=secrets.token_urlsafe(48)
(cfgdir/'postgres.env').write_text('POSTGRES_PASSWORD='+adminpw+'\nPOSTGRES_DB=indexd\nPGDATA=/var/lib/postgresql/data\n');os.chmod(cfgdir/'postgres.env',0o600)
p=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(root/'backup.pass'),'--decrypt',str(root/'indexd-full-20261019.tar.gpg')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
found={}
with tarfile.open(fileobj=p.stdout,mode='r|') as t:
 for m in t:
  if m.name in ['indexd.yml','indexd','manifest.json']:found[m.name]=t.extractfile(m).read()
assert p.wait()==0 and len(found)==3
manifest=json.loads(found['manifest.json'])
for name in ['indexd.yml','indexd']:assert hashlib.sha256(found[name]).hexdigest()==manifest['files'][name]['sha256']
cfg=yaml.safe_load(found['indexd.yml']);cfg['directory']=str(state);cfg['autoOpenWebUI']=False
cfg['database']={'host':'127.0.0.1','port':5432,'user':'indexd','password':apppw,'database':'indexd','sslmode':'disable'}
(cfgdir/'indexd.yml').write_text(yaml.safe_dump(cfg));os.chmod(cfgdir/'indexd.yml',0o640)
subprocess.run(['chown','root:enclave-indexd',str(cfgdir/'indexd.yml')],check=True)
Path('/opt/enclave-indexd/indexd').write_bytes(found['indexd']);os.chmod('/opt/enclave-indexd/indexd',0o755)
with gzip.open(root/'indexd-geolite2.mmdb.gz','rb') as stream:(state/'GeoLite2-City.mmdb').write_bytes(stream.read())
subprocess.run(['chown','-R','enclave-indexd:enclave-indexd',str(state)],check=True);os.chmod(state,0o700)
for name in ['enclave-indexd.service','enclave-indexd-postgres.service']:shutil.copyfile(root/name,Path('/etc/systemd/system')/name)
shutil.copyfile(root/'wait-postgres','/usr/local/lib/enclave-storage/wait-postgres');os.chmod('/usr/local/lib/enclave-storage/wait-postgres',0o755)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','enclave-indexd-postgres','enclave-indexd'],check=True,capture_output=True)
subprocess.run(['systemctl','start','enclave-indexd-postgres'],check=True)
for attempt in range(60):
 r=subprocess.run(['docker','exec','enclave-indexd-postgres','pg_isready','-U','postgres','-d','indexd'],capture_output=True)
 if r.returncode==0:break
 time.sleep(1)
else:raise RuntimeError('PostgreSQL did not initialize')
# Password is generated locally; it is sent only through stdin, never command arguments or logs.
sql="CREATE ROLE indexd LOGIN PASSWORD '"+apppw+"' NOSUPERUSER NOCREATEDB NOCREATEROLE; ALTER DATABASE indexd OWNER TO indexd;"
r=subprocess.run(['docker','exec','-i','enclave-indexd-postgres','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=sql.encode(),capture_output=True)
assert r.returncode==0,'Database role initialization failed (protected credentials withheld)'
subprocess.run(['systemctl','start','enclave-indexd'],check=True)
active=subprocess.run(['systemctl','is-active','enclave-indexd'],capture_output=True,text=True).stdout.strip();assert active=='inactive','Writer start guard failed'
report={'postgresReady':True,'indexdStaged':True,'indexdActive':False,'startGuardVerified':True,'productionStateRestored':False,'binarySHA256':manifest['files']['indexd']['sha256'],'postgresImage':'postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336'}
(root/'production-staging.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
