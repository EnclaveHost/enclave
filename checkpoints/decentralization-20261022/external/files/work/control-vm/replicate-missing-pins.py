from pathlib import Path
import subprocess,json,sys
base=Path('work/control-vm');archive=base/'missing-pin-package.tar.zst'
if not archive.exists():
 with archive.open('wb') as f:subprocess.run(['tar','-I','zstd -T2 -3 --long=27','-C',str(base/'missing-pin-package'),'-cf','-','.'],stdout=f,check=True)
verify='''from pathlib import Path
import json,hashlib,os,shutil,subprocess
p=Path('/opt/enclave-pins-20261019');dst=Path('/opt/enclave-retained/cc96aad');add=json.loads((p/'objects/manifest-additions.json').read_text());dirs=json.loads((p/'directories.json').read_text())
for r in add:
 for ext,h in [('bin',r['sha256']),('car',r['carSha256'])]:
  f=p/'objects'/(r['cid']+'.'+ext);assert hashlib.file_digest(f.open('rb'),'sha256').hexdigest()==h
  t=dst/f.name
  if t.exists():assert hashlib.file_digest(t.open('rb'),'sha256').hexdigest()==h
  else:os.link(f,t)
for r in dirs:
 d=p/'sites'/r['cid'];m=json.loads((d/'manifest.json').read_text());assert hashlib.file_digest((d/'site.car').open('rb'),'sha256').hexdigest()==m['carSHA256']
 for x in m['fileManifest']:assert hashlib.file_digest((d/'site'/x['path']).open('rb'),'sha256').hexdigest()==x['sha256']
 t=Path('/opt/enclave-site')/r['cid']
 if not t.exists():os.symlink(d,t)
 else:assert json.loads((t/'manifest.json').read_text())['carSHA256']==r['carSHA256']
mp=dst/'manifest.json';old=json.loads(mp.read_text());by={x['cid']:x for x in old['verifiedObjects']};added=0
for r in add:
 if r['cid'] in by:assert by[r['cid']]['sha256']==r['sha256']
 else:old['verifiedObjects'].append(r);added+=1
if added:
 backup=dst/'manifest.before-pinned-roots.json';assert not backup.exists();shutil.copy2(mp,backup)
 temp=dst/'manifest.next.json';temp.write_text(json.dumps(old,indent=2)+'\\n');os.replace(temp,mp)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
 for attempt in range(600):
  import urllib.request,time
  try:
   data=urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+add[0]['cid'],timeout=2).read();assert hashlib.sha256(data).hexdigest()==add[0]['sha256'];break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Bootstrap did not become ready')
print(json.dumps({'fileRoots':len(add),'directoryRoots':len(dirs),'verified':True,'fileRootsServed':True,'directoryRoutesActivated':False}))
'''
report=json.loads(Path('outputs/ipfs-missing-pins-replicas.json').read_text()) if Path('outputs/ipfs-missing-pins-replicas.json').exists() else {'replicas':[]}
for host in sys.argv[1:] or ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['ssh',host,'install -d -m 0755 /opt/enclave-pins-20261019'],check=True)
 with archive.open('rb') as f:subprocess.run(['ssh',host,'tar -I "zstd --long=27" -C /opt/enclave-pins-20261019 -xf - --no-same-owner'],stdin=f,check=True)
 r=subprocess.run(['ssh',host,'python3','-'],input=verify,text=True,capture_output=True);assert r.returncode==0,r.stderr[-2000:];d=json.loads(r.stdout);report['replicas'].append({'region':host,**d});print(host+': '+r.stdout.strip(),flush=True)
 Path('outputs/ipfs-missing-pins-replicas.json').write_text(json.dumps(report,indent=2)+'\n')
