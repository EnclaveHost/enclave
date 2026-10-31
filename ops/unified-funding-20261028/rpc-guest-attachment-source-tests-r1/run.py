from pathlib import Path
import subprocess,json,hashlib,time
p=Path(__file__).resolve().parent
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items(): assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
verify();start=time.monotonic()
cmd=['/usr/bin/bwrap','--unshare-all','--uid','0','--gid','0','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--ro-bind',str(p/'frozen'),'/src','--chdir','/src','--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp','/usr/bin/python3','-B','-m','unittest','discover','-s','test/rpc-guest','-p','test_attach_storage.py','-v']
with (p/'TEST.log').open('x') as log: r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,timeout=90)
verify();(p/'RESULT.json').write_text(json.dumps({'exit':r.returncode,'seconds':time.monotonic()-start,'pins':len(pins),'drift':0,'networkNamespace':True,'nativeClientsExecuted':False})+'\n')
raise SystemExit(r.returncode)
