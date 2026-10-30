# Prepared only. Run once after coordinator reviews exact proposal-pins.json.
from pathlib import Path
import hashlib,json,subprocess,base64,os,time
p=Path(__file__).resolve().parent
pins=json.loads((p/'proposal-pins.json').read_text())
for name,h in pins.items():
 f=p/name
 if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=h:raise SystemExit('input drift: '+name)
with (p/'observation-attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'at':time.time(),'scope':'one read-only aggregate observation'},f)
enc=base64.b64encode((p/'admission-observation.ps1').read_bytes().decode().encode('utf-16le')).decode()
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','minipc','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',enc],capture_output=True,timeout=40)
(p/'observation.rc').write_text(str(r.returncode)+'\n')
if r.returncode:print(json.dumps({'rc':r.returncode,'stdoutBytes':len(r.stdout),'stderrBytes':len(r.stderr),'rawOutputWithheld':True}));raise SystemExit(r.returncode)
j=json.loads(r.stdout.decode('utf-8-sig'));(p/'observation.json').write_text(json.dumps(j,indent=2)+'\n');print(json.dumps(j,indent=2))
