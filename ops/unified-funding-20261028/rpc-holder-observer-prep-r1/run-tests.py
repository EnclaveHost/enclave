from pathlib import Path
import json,hashlib,subprocess,os,time
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
pins=json.loads((p/'INPUT-PINS.json').read_text())
def verify():
    for row in pins:assert hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()==row['sha256']
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'unprivileged observer fixtures only; no root helper installed or invoked'},f)
with (p/'tests.txt').open('x') as out:
    r=subprocess.run(['/usr/bin/python3','-B',str(p/'test_observe.py')],cwd=p,
                     env={'PATH':'/usr/bin:/bin','LANG':'C','PYTHONDONTWRITEBYTECODE':'1'},
                     stdout=out,stderr=subprocess.STDOUT,timeout=45)
verify()
(p/'RESULT.json').write_text(json.dumps({'exit':r.returncode,'privilegedQualification':False,'installed':False})+'\n')
raise SystemExit(r.returncode)
