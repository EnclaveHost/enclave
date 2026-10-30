from pathlib import Path
import subprocess,json
p=Path(__file__).resolve().parent
try:
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=6','minipc','node --max-old-space-size=32 --max-semi-space-size=1 --input-type=module -'],input=(p/'host-read.mjs').read_text(),capture_output=True,text=True,timeout=28)
 if r.returncode: d={'readOnly':True,'sshExit':r.returncode,'stdoutBytes':len(r.stdout),'stderrBytes':len(r.stderr),'diagnosis':'Observer failed; raw output withheld'}
 else:d=json.loads(r.stdout)
except subprocess.TimeoutExpired:d={'readOnly':True,'diagnosis':'SSH observer timeout; no restart or retry performed'}
(p/'host-result.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps(d,indent=2))
