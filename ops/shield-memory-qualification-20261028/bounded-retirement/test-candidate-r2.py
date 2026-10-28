from pathlib import Path
import subprocess,json,os,hashlib
p=Path(__file__).parent;c=p/'candidate';o=p/'candidate-tests-r2';o.mkdir(exist_ok=False)
def digest(f):
 with f.open('rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
files=['shield-original-source.hpp','enclave_shield_loader.cpp','test_bounded_retirement.cpp']
pins={n:digest(c/n) for n in files}
cmd=['c++','-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wno-deprecated-declarations',str(c/'test_bounded_retirement.cpp'),'-lcrypto','-pthread','-o',str(o/'test')]
with (o/'compile.log').open('w') as f:subprocess.run(cmd,check=True,stdout=f,stderr=subprocess.STDOUT,timeout=120)
with (o/'tests.log').open('w') as f:subprocess.run([str(o/'test')],check=True,stdout=f,stderr=subprocess.STDOUT,timeout=30,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=1:abort_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'})
assert pins=={n:digest(c/n) for n in files},'candidate changed during tests'
(o/'RESULT.json').write_text(json.dumps({'sourcePins':pins,'command':cmd,'result':'passed','sanitizers':['address','undefined'],'productionEnabled':False,'fullGpuQualified':False},indent=2)+'\n')
print((o/'tests.log').read_text())
