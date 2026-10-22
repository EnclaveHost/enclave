import json,pathlib,hashlib,subprocess,urllib.request,time,fcntl,os
stage=pathlib.Path(__file__).resolve().parent
lock=open('/run/lock/enclave-bootstrap-manifest.lock','w');fcntl.flock(lock,fcntl.LOCK_EX)
conf=json.loads(pathlib.Path('/etc/enclave-bootstrap/config.json').read_text())
root=pathlib.Path(conf['directory']);mp=pathlib.Path(conf['manifest'])
assert root.is_absolute() and mp.is_absolute()
old=mp.read_bytes();manifest=json.loads(old);add=json.loads((stage/'manifest.json').read_text())['verifiedObjects']
assert len(add)==2 and len(manifest['verifiedObjects'])+2<=4096
existing={x['cid']:x for x in manifest['verifiedObjects']}
subprocess.run(['python3',str(stage/'network/replicate-artifacts.py'),str(stage/'manifest.json'),str(stage)],check=True)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
for e in add:
 assert e['bytes']<=conf.get('maxObjectBytes',256<<20)
 if e['cid'] in existing:
  assert all(existing[e['cid']][k]==e[k] for k in ['sha256','carSha256','bytes'])
 for ext,key in [('bin','sha256'),('car','carSha256')]:
  src=stage/(e['cid']+'.'+ext);dst=root/src.name
  assert sha(src)==e[key]
  if dst.exists():assert sha(dst)==e[key]
  else:os.link(src,dst)
 if e['cid'] not in existing:manifest['verifiedObjects'].append(e)
new=(json.dumps(manifest,indent=2)+'\n').encode();backup=mp.with_name('manifest.before-shield-public-'+str(time.time_ns())+'.json');backup.write_bytes(old)
assert mp.read_bytes()==old,'manifest changed concurrently'
tmp=mp.with_suffix('.shield-public.tmp');tmp.write_bytes(new);os.replace(tmp,mp)
try:
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],timeout=100,check=True)
 deadline=time.monotonic()+600
 while True:
  try:
   for e in add:
    req=urllib.request.Request('http://127.0.0.1:'+str(conf.get('port',8189))+'/ipfs/'+e['cid'],method='HEAD')
    with urllib.request.urlopen(req,timeout=2) as r:assert int(r.headers['Content-Length'])==e['bytes'] and r.status==200
   break
  except Exception:
   if time.monotonic()>deadline:raise
   time.sleep(1)
except BaseException:
 tmp.write_bytes(old);os.replace(tmp,mp);subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],timeout=100,check=True);raise
print(json.dumps({'activatedPublicArtifacts':[e['cid'] for e in add],'manifest':str(mp),'backup':str(backup),'guestActivated':False}),flush=True)
