from pathlib import Path
import subprocess,base64,json,datetime
id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c'
body=json.dumps({'id':id,'force':True},separators=(',',':'))
script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try { Invoke-RestMethod -TimeoutSec 70 -Method Post -ContentType 'application/json' -Body '"+body+"' 'http://127.0.0.1:9600/v1/claim-hint' | ConvertTo-Json -Depth 5 -Compress } catch { if ($_.Exception.Response) { $r=$_.Exception.Response; $reader=New-Object System.IO.StreamReader($r.GetResponseStream()); [pscustomobject]@{status=[int]$r.StatusCode;body=$reader.ReadToEnd()} | ConvertTo-Json -Compress } else { throw } }"
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],text=True,capture_output=True,timeout=90)
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'action':'one operator-authorized retry of failed DNS guest; ownership, catalog, platform policy, lease funding and isolation checks retained','id':id,'exit':r.returncode,'output':r.stdout,'error':r.stderr}
Path('outputs/storage-adapter-incident/dns-operator-retry.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
