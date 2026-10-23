import pathlib,json,subprocess,datetime,sys
p=pathlib.Path(__file__).resolve().parent
proof=json.loads((p/'dns-artifact-proof.json').read_text());apply='--apply' in sys.argv
expected=json.loads((p/'cache-preflight.json').read_text())['result']['manifestSha256'] if apply else None
remote=r'''
import pathlib,json,hashlib,sys,os,subprocess,datetime,urllib.request
P=__PROOF__;apply=__APPLY__;expected=__EXPECTED__
def sha(b):return hashlib.sha256(b).hexdigest()
cfg=json.loads(pathlib.Path('/etc/enclave-bootstrap/config.json').read_text())
assert cfg['directory']=='/opt/enclave-retained/cc96aad' and cfg['manifest']==cfg['directory']+'/manifest.json' and cfg['port']==8189
root=pathlib.Path(cfg['directory']);mp=pathlib.Path(cfg['manifest']);old=mp.read_bytes();m=json.loads(old)
assert len(m['verifiedObjects'])<4096 and not any(x['cid']==P['cid'] for x in m['verifiedObjects'])
assert not (root/(P['cid']+'.bin')).exists() and not (root/(P['cid']+'.car')).exists()
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifestSha256':sha(old),'entriesBefore':len(m['verifiedObjects']),'cid':P['cid'],'apply':apply}
if not apply:print(json.dumps(o));sys.exit(0)
assert sha(old)==expected,'manifest changed'
for ext,h in [('bin',P['sha256']),('car',P['carSha256'])]:
 src=root/(P['cid']+'.'+ext+'.ram96-recovery-part');assert sha(src.read_bytes())==h
for ext in ('bin','car'):os.rename(root/(P['cid']+'.'+ext+'.ram96-recovery-part'),root/(P['cid']+'.'+ext))
backup=mp.with_name('manifest.pre-ram96-dns-recovery.json')
with backup.open('xb')as f:f.write(old);f.flush();os.fsync(f.fileno())
m['verifiedObjects'].append({k:P[k] for k in ['cid','sha256','carSha256','bytes','carBytes']})
new=json.dumps(m,indent=2).encode()+b'\n';temp=mp.with_name('manifest.ram96-dns-recovery.tmp')
try:
 with temp.open('xb')as f:f.write(new);f.flush();os.fsync(f.fileno())
 os.replace(temp,mp)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway.service'],check=True,timeout=45)
 subprocess.run(['systemctl','is-active','--quiet','enclave-bootstrap-gateway.service'],check=True,timeout=5)
 # Startup verifies all retained files before the listener opens. Root checks HTTP separately.
 o.update(manifestAfterSha256=sha(new),entriesAfter=len(m['verifiedObjects']),restart='requested and service active',backup=str(backup))
 print(json.dumps(o))
except Exception:
 mp.write_bytes(old);subprocess.run(['systemctl','restart','enclave-bootstrap-gateway.service'],timeout=45)
 raise
'''.replace('__PROOF__',repr(proof)).replace('__APPLY__',repr(apply)).replace('__EXPECTED__',repr(expected))
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=6','us-west']
if apply:
 for ext in ['bin','car']:
  src=p/'dns-artifact'/(proof['cid']+'.'+ext)
  subprocess.run(['scp','-q',str(src),'us-west:/opt/enclave-retained/cc96aad/'+src.name+'.ram96-recovery-part'],check=True,timeout=40)
r=subprocess.run(ssh+['python3 -'],input=remote,text=True,capture_output=True,timeout=100)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':r.returncode,'result':json.loads(r.stdout) if r.returncode==0 else r.stdout,'error':r.stderr[-1500:]}
(p/('cache-applied.json'if apply else'cache-preflight.json')).write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o));sys.exit(r.returncode)
