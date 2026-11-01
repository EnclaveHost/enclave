from pathlib import Path
import subprocess,hashlib,json,time,os
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';prior=p.parent/'rpc-native-root-build-r2';w=prior/'work'
pins=json.loads((p/'PINS.json').read_text())
def digest(f):
 with f.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def verify():
 for n,h in pins.items():assert digest(s/n)==h and digest(prior/'frozen'/n)==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'once':True,'reusedImage':True,'rebuiltImage':False},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
image=json.loads((w/'image/RESULT.json').read_text())
assert digest(w/'image/root.img')==image['root']['imageSha256']
assert digest(w/'image/hash.img')==image['root']['hashSha256']
inventory=json.loads((w/'assembled/INVENTORY.json').read_text())
for name,rec in inventory['files'].items():
 f=w/'readback'/name;assert not f.is_symlink() and f.stat().st_size==rec['bytes'] and digest(f)==rec['sha256'],name
assert {str(f.relative_to(w/'readback')) for f in (w/'readback').rglob('*') if f.is_file()}==set(inventory['files'])
start=time.monotonic();deadline=start+45;commands=[]
for client in ('reth','lighthouse','base'):
 cmd=['/usr/bin/bwrap','--die-with-parent','--unshare-all','--ro-bind',str(w/'readback'),'/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--cap-drop','ALL','--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','HOME','/tmp','/opt/enclave-rpc/bin/'+client,'--version']
 commands.append(cmd);(p/'COMMANDS.json').write_text(json.dumps(commands,indent=2)+'\n')
 remaining=deadline-time.monotonic();assert remaining>0
 with (p/(client.upper()+'.log')).open('x') as log:
  subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=log,timeout=min(15,remaining),check=True)
verify()
result={'exit':0,'elapsed':time.monotonic()-start,'checks':3,'sourcePinsUnchanged':True,'imageSha256':image['root']['imageSha256'],
 'rootHash':image['root']['rootHash'],'imageFilesVerified':len(inventory['files']),'imageRebuilt':False,
 'chainDataUsed':False,'nodeStarted':False,'appDeployed':False,'rpcReady':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))
