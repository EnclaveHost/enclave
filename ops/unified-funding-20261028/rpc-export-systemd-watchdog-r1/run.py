from pathlib import Path
import subprocess,hashlib,json,time
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'dummyProcessesOnly':True,'outerMiB':128,'actorMiB':128,'totalMiB':256},f)
with (p/'TEST.txt').open('x') as log:r=subprocess.run(['/usr/bin/python3','-I','-B',str(p/'qualify_systemd_watchdog.py'),'controller',str(p/'actor')],stdout=log,stderr=subprocess.STDOUT,timeout=25)
verify();(p/'RESULT.json').write_text(json.dumps({'exit':r.returncode,'pinsUnchanged':True})+'\n');raise SystemExit(r.returncode)
