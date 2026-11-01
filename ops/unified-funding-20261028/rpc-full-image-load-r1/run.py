from pathlib import Path
import json,hashlib,subprocess,time,stat,os
p=Path(__file__).resolve().parent;u=p.parent;s=u.parent/'source';q=u/'rpc-full-image-build-r3';tree=q/'output/readback'
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'inertVersionOnly':True},f)
pin=json.loads((p/'BUILD-RECEIPT-PIN.json').read_text());raw=Path(pin['path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==pin['sha256'];receipt=json.loads(raw)
expected=set()
for e in receipt['entries']:
 path=tree/e['path'];st=path.lstat();assert stat.S_IMODE(st.st_mode)==e['mode']
 if e['type']=='file':
  assert stat.S_ISREG(st.st_mode) and st.st_size==e['bytes'] and hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==e['sha256'];expected.add(e['path'])
 else:assert stat.S_ISDIR(st.st_mode)
assert {str(x.relative_to(tree)) for x in tree.rglob('*') if not x.is_dir()}==expected
pins=json.loads((q/'PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
rows=[];started=time.monotonic()
for label,args,contains in [('runtime-version',['/plat/rt/ld-linux-x86-64.so.2','--library-path','/plat/rt','/plat/rt/wasmtime','--version'],'wasmtime 49.0.3'),('verity-version',['/lib64/ld-linux-x86-64.so.2','--library-path','/usr/lib:/usr/lib64','/veritysetup','--version'],'veritysetup ')]:
 cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind',str(tree),'/','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/']+args
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 r=subprocess.run(cmd,capture_output=True,text=True,timeout=min(5,max(.01,20-(time.monotonic()-started))))
 (p/(label+'.log')).write_text(r.stdout+r.stderr);rows.append({'phase':label,'exit':r.returncode,'output':r.stdout.strip()});assert r.returncode==0 and contains in r.stdout,label
result={'phases':rows,'elapsed':time.monotonic()-started,'imageReceiptSha256':pin['sha256'],'filesChecked':len(expected),'sourcePins':len(pins),'deployed':False,'nbdLoaded':False,'guestBooted':False}
(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
