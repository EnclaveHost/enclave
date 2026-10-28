from pathlib import Path
import json,subprocess,hashlib
m=Path(__file__).resolve().parent
g=json.loads((m/'ROOT-GUESTD-PROBE-INPUT.json').read_text())
for k in ['probe','client']:
 if hashlib.sha256(Path(g[k]).read_bytes()).hexdigest()!=g[k+'_sha256']:raise SystemExit('probe/client drift')
r=subprocess.run(['node',g['probe'],'--client',g['client'],'--client-sha256',g['client_sha256'],'--key-file',g['key_file'],'--url',g['url']],capture_output=True,text=True,timeout=25)
if r.returncode:print(r.stdout);raise SystemExit(r.returncode)
x=json.loads(r.stdout)
(m/'ROOT-LIVE-COMMITMENTS.json').write_text(json.dumps(x,indent=2)+'\n')
print(json.dumps(x,indent=2))
