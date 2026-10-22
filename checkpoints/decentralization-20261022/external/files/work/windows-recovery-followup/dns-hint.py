from pathlib import Path
import subprocess,base64,json,datetime
id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c'
body=json.dumps({'id':id,'force':False},separators=(',',':'))
script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Invoke-RestMethod -TimeoutSec 70 -Method Post -ContentType 'application/json' -Body '"+body+"' 'http://127.0.0.1:9600/v1/claim-hint' | ConvertTo-Json -Depth 5 -Compress"
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],text=True,capture_output=True,timeout=90)
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'action':'one normal nonforced DNS reconciliation after guest health failure','id':id,'exit':r.returncode,'output':r.stdout,'error':r.stderr}
Path('outputs/storage-adapter-incident/dns-reconcile-hint.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
