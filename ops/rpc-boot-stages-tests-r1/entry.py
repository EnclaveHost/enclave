from pathlib import Path
import subprocess,json,sys,time,hashlib
sys.path.insert(0,'/src/test/rpc-server')
import test_boot_build as t
start=time.monotonic();rows=[]
def run(name,args,cwd='/src',want=0):
 r=subprocess.run(args,cwd=cwd,timeout=max(.01,110-(time.monotonic()-start)))
 rows.append({'name':name,'exit':r.returncode,'expected':want})
 assert (r.returncode==0) if want==0 else (r.returncode!=0),name
run('strict-profile-tests',['/usr/bin/python3','-B','-m','unittest','discover','-s','test/rpc-server','-p','test_boot_build.py','-v'])
Path('/output/profile.json').write_bytes(t.wire(t.fixture()))
run('RPC-stages',['/usr/bin/python3','-B','isolation/m3/build-rpc-boot.py','--profile','/output/profile.json','--out','/output/rpc'])
cflags=['/usr/bin/gcc','-static','-O2','-Wall','-Wextra','-Werror','-I','/src/isolation/m3']
run('ordinary-init',cflags+['-o','/output/ordinary-init','isolation/m3/dominit.c'])
run('desktop-init',cflags+['-DNATIVE_DESKTOP','-o','/output/desktop-init','isolation/m3/dominit.c'])
# Existing desktop helper conditional branch must still compile with its three roles.
root=t.fixture()['root']; desktop={'root':root,'models':{'dataBlocks':1024,'hashStartBlock':1024,'rootHash':'a'*64,'salt':'b'*64,'imageBytes':8388608}}
Path('/output/native-boot-profile.h').write_bytes(t.build.base.render_header(desktop,'c'*64))
run('desktop-helper',cflags+['-I','/output','-o','/output/desktop-boot','isolation/m3/native-boot.c'])
run('mixed-profile-refused',cflags+['-DNATIVE_DESKTOP','-DNATIVE_RPC','-o','/output/INVALID','isolation/m3/dominit.c'],want=1)
run('clock-fixture',cflags+['-o','/output/clock-fixture','test/rpc-server/boot_clock_fixture.c'])
run('C-exec-Go-clock',['/usr/bin/go','test','-count=1','-p','1','-run','^TestBootClockCInterop$','-v','./rpcservice'],cwd='/src/isolation/m3')
Path('/output/checks.json').write_text(json.dumps({'checks':rows,'elapsed':time.monotonic()-start,'nativeMountsExecuted':False,'booted':False})+'\n')
