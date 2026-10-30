from pathlib import Path
import subprocess,json
p=Path(__file__).resolve().parent
for name in ['check-source.py','assemble.py']:
 with (p/(name+'.log')).open('x') as f:r=subprocess.run(['/usr/bin/python3','-B',str(p/name)],stdout=f,stderr=subprocess.STDOUT,timeout=45)
 (p/(name+'.result.json')).write_text(json.dumps({'rc':r.returncode})+'\n')
 if r.returncode:raise SystemExit(r.returncode)
