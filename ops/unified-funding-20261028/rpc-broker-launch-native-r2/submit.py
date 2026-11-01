from pathlib import Path
import json,subprocess,time
p=Path(__file__).resolve().parent
with (p/'ACTOR-SUBMIT.json').open('x') as f:json.dump({'at':time.time(),'once':True},f)
cmd=json.loads((p/'ACTOR-COMMAND.json').read_text())
with (p/'ACTOR-DISPATCH.log').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=28)
(p/'ACTOR-EXIT.json').write_text(json.dumps({'exit':r.returncode})+'\n');assert r.returncode==0
