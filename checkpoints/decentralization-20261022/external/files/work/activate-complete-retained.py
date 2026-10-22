import json,pathlib,subprocess,hashlib,shutil,sys,time,urllib.request
root=pathlib.Path('/opt/enclave-retained/cc96aad');archive=root.parent/'retained-additions.tar.zst'
want=sys.argv[1]
with archive.open('rb') as f:
 if hashlib.file_digest(f,'sha256').hexdigest()!=want:raise RuntimeError('archive checksum mismatch')
subprocess.run(['tar','--use-compress-program=zstd --long=27','--skip-old-files','-xf',str(archive),'-C',str(root)],check=True)
next_manifest=root/'manifest.next.json';rows=json.loads(next_manifest.read_text())['verifiedObjects']
if len(rows)!=936 or sum(e['bytes'] for e in rows)!=4690923948:raise RuntimeError('unexpected inventory')
log=pathlib.Path('/var/log/enclave-retained-complete-verification.log')
if '--activate-only' not in sys.argv:
 with log.open('w') as out:subprocess.run(['python3',str(root/'replicate-artifacts.py'),str(next_manifest),str(root)],stdout=out,check=True)
lines=log.read_text().splitlines()
if len(lines)!=936 or any(json.loads(line)['verified']!=i+1 or json.loads(line)['cid']!=rows[i]['cid'] for i,line in enumerate(lines)):raise RuntimeError('verification incomplete')
if '--prepare-only' in sys.argv:
 print(json.dumps({'prepared':True,'verifiedCids':936}),flush=True);sys.exit(0)
manifest=root/'manifest.json';backup=root/'manifest.before-complete.json'
if not backup.exists():shutil.copy2(manifest,backup)
next_manifest.replace(manifest)
subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
deadline=time.monotonic()+180
while time.monotonic()<deadline:
 try:
  req=urllib.request.Request('http://127.0.0.1:8189/ipfs/bafybeia5ep5txxswpmdu5gez4v4albuwzgyhquncgvf6imwicbwpe2od44',method='HEAD')
  with urllib.request.urlopen(req,timeout=3) as r:
   if r.status!=200 or int(r.headers['Content-Length'])!=1455741:raise RuntimeError('wrong bootstrap response')
  print(json.dumps({'ready':True,'verifiedCids':936,'verifiedBytes':4690923948}),flush=True);break
 except Exception:time.sleep(2)
else:
 shutil.copy2(backup,next_manifest);next_manifest.replace(manifest)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
 raise RuntimeError('new replica failed readiness; previous manifest restored')
