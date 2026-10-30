from pathlib import Path
import subprocess,os,json,hashlib
p=Path(__file__).parent;c=p/'init-release-prep';o=p/'init-prep-tests';o.mkdir(exist_ok=False)
files=[x for x in c.iterdir() if x.suffix in ['.py','.h','.c']]
def digest(f):
 with f.open('rb') as h:return hashlib.file_digest(h,'sha256').hexdigest()
pins={x.name:digest(x) for x in files}
with (o/'python.log').open('w') as f:subprocess.run(['python3','-m','unittest','discover','-v','-s',str(c),'-p','test_*.py'],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=60)
with (o/'marker.log').open('w') as f:
 subprocess.run(['gcc','-std=c11','-O1','-g','-Wall','-Wextra','-fsanitize=address,undefined','-fno-sanitize-recover=undefined','-I',str(c),str(c/'test_retire_marker.c'),'-o',str(o/'marker')],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=60)
 subprocess.run([str(o/'marker')],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=10,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=1:abort_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'})
assert pins=={x.name:digest(x) for x in files},'source changed during tests'
(o/'RESULT.json').write_text(json.dumps({'sourcePins':pins,'result':'passed','productionEnabled':False},indent=2)+'\n')
print((o/'python.log').read_text()[-800:]);print((o/'marker.log').read_text())
