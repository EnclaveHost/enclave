from pathlib import Path
import hashlib,json,subprocess,time,os,shutil

p=Path(__file__).resolve().parent
s=p.parent.parent/'source'
w=p/'work'
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'once':True,'chainDataUsed':False},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
assert shutil.disk_usage(w).free > (16+3)*(1<<30)
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
start=time.monotonic();deadline=start+180
commands=[]
def run(args,name,bound=90,cwd=None):
 remaining=deadline-time.monotonic();assert remaining>0
 commands.append({'name':name,'args':args,'cwd':str(cwd) if cwd else None})
 (p/'COMMANDS.json').write_text(json.dumps(commands,indent=2)+'\n')
 with (p/(name+'.log')).open('x') as log:
  subprocess.run(args,cwd=cwd,stdin=subprocess.DEVNULL,stdout=log,stderr=log,timeout=min(bound,remaining),check=True)
def box(args):
 return ['/usr/bin/bwrap','--die-with-parent','--unshare-all','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(w),str(w),'--clearenv','--setenv','PATH','/usr/sbin:/usr/bin:/sbin:/bin','--setenv','HOME','/tmp',*args]
src=p/'frozen/rpc/native'
runtime=p.parent/'rpc-guest-runtime-bundle-r1/output-parent/bundle/runtime.tar'
run(box(['/usr/bin/python3','-I','-B',str(src/'assemble_root.py'),'plan','--sysroot','/','--runtime-tar',str(runtime),'--output',str(w/'PLAN.json')]),'PLAN')
run(box(['/usr/bin/python3','-I','-B',str(src/'assemble_root.py'),'assemble','--plan',str(w/'PLAN.json'),'--output',str(w/'assembled')]),'ASSEMBLE')
assembled=json.loads((w/'assembled/RESULT.json').read_text())
run(box(['/usr/bin/python3','-I','-B',str(src/'build_image.py'),'--archive',str(w/'assembled/root.tar'),'--sha256',assembled['rootTarSha256'],'--output',str(w/'image')]),'IMAGE')
(w/'readback').mkdir()
run(box(['/usr/sbin/debugfs','-R','rdump / readback',str(w/'image/root.img')]),'IMAGE-READBACK',cwd=w)
inventory=json.loads((w/'assembled/INVENTORY.json').read_text())
actual={str(f.relative_to(w/'readback')) for f in (w/'readback').rglob('*') if f.is_file()}
assert actual==set(inventory['files']), (actual-set(inventory['files']),set(inventory['files'])-actual)
for path,record in inventory['files'].items():
 f=w/'readback'/path;assert not f.is_symlink() and f.stat().st_size==record['bytes'],path
 with f.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==record['sha256'],path
assert not list((w/'readback/lost+found').iterdir())
def smoke(args):
 return ['/usr/bin/bwrap','--die-with-parent','--unshare-all','--ro-bind',str(w/'readback'),'/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--cap-drop','ALL','--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8',*args]
code="import ssl,hashlib,tomllib,urllib.request,json,ctypes,subprocess,sys,os,errno; c=ssl.create_default_context(); assert len(c.get_ca_certs())>0; assert not os.path.exists('/etc/enclave-rpc/jwt.hex'); assert not os.path.exists('/etc/enclave-rpc-vm/disks.json'); assert not os.listdir('/srv/enclave-l1-pair'); assert not os.listdir('/srv/enclave-base-holder'); print(json.dumps({'python':sys.version,'caCertificates':len(c.get_ca_certs()),'privateStateAbsent':True}));\ntry: open('/etc/write-refused','w')\nexcept OSError as e: assert e.errno==errno.EROFS\nelse: raise AssertionError('root writable')"
run(smoke(['/usr/bin/python3','-I','-B','-c',code]),'PYTHON-SMOKE',15)
run(smoke(['/usr/bin/findmnt','--version']),'FINDMNT-SMOKE',15)
for client in ('reth','lighthouse','base'):
 run(smoke(['/opt/enclave-rpc/bin/'+client,'--version']),client.upper()+'-SMOKE',15)
verify()
result={'exit':0,'elapsed':time.monotonic()-start,'pins':len(pins),'pinsUnchanged':True,'assembled':assembled,
        'image':json.loads((w/'image/RESULT.json').read_text()),'imageFilesReadback':len(actual),
        'isolatedSmokeChecks':5,'chainDataUsed':False,'vmLaunched':False,'rpcReady':False,'appDeployed':False}
(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ('exit','elapsed','pins','imageFilesReadback','isolatedSmokeChecks','rpcReady')}))
