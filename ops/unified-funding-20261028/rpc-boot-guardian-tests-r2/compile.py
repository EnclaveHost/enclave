from pathlib import Path
import subprocess,sys,json,time
sys.path.insert(0,'/src/test/rpc-server')
import test_boot_build as t
start=time.monotonic();rows=[]
def run(name,args):
 r=subprocess.run(args,cwd='/src',timeout=max(.01,60-(time.monotonic()-start)))
 rows.append({'name':name,'exit':r.returncode});Path('/output/compile-checks.json').write_text(json.dumps(rows)+'\n');assert r.returncode==0,name
Path('/output/profile.json').write_bytes(t.wire(t.fixture()))
run('RPC-stages',['/usr/bin/python3','-B','isolation/m3/build-rpc-boot.py','--profile','/output/profile.json','--out','/output/rpc'])
cflags=['/usr/bin/gcc','-static','-O2','-Wall','-Wextra','-Werror','-I','/src/isolation/m3']
run('ordinary-init',cflags+['-o','/output/ordinary-init','isolation/m3/dominit.c'])
run('desktop-init',cflags+['-DNATIVE_DESKTOP','-o','/output/desktop-init','isolation/m3/dominit.c'])
run('guardian-fixture',cflags+['-o','/output/guardian-fixture','test/rpc-server/boot_guardian_fixture.c'])
