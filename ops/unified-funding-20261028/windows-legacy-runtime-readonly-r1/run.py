from pathlib import Path
import base64,subprocess,json
p=Path(__file__).resolve().parent
encoded=base64.b64encode((p/'probe.ps1').read_text().encode('utf-16le')).decode()
cmd=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','minipc','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded]
r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=55)
(p/'result.rc').write_text(str(r.returncode)+'\n')
if r.returncode:print(json.dumps({'ok':False,'returnCode':r.returncode,'stdoutBytes':len(r.stdout),'stderrBytes':len(r.stderr),'rawOutputWithheld':True}));raise SystemExit(r.returncode)
j=json.loads(r.stdout.decode('utf-8-sig'));(p/'result.json').write_text(json.dumps(j,indent=2)+'\n');print(json.dumps(j,indent=2))
