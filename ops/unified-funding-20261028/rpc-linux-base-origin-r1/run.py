from pathlib import Path
import subprocess,json,time
p=Path(__file__).resolve().parent
with (p/'TRANSPORT-INTENT.json').open('x') as f:json.dump({'at':time.time(),'once':True},f)
r=subprocess.run(json.loads((p/'COMMAND.json').read_text()),input=(p/'remote.py').read_text(),capture_output=True,text=True,timeout=74)
(p/'RESULT.json').write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr})+'\n')
