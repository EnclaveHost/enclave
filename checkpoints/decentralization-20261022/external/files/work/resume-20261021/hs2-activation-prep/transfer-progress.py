import base64,subprocess,json,datetime
from pathlib import Path
s=r"$ProgressPreference='SilentlyContinue';$p='C:\ProgramData\Enclave\staging\hs2-artifacts-20261021';$f=@(Get-ChildItem -LiteralPath $p -File -ErrorAction Stop|Where-Object {$_.Name -match '\.(bin|car)$'});@{files=$f.Count;bytes=[long](($f|Measure-Object Length -Sum).Sum);at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress"
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(s.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=45)
if r.returncode:raise SystemExit(r.returncode)
d=json.loads(r.stdout.strip());d['expectedFiles']=1872;d['expectedBytes']=9383550621
Path(__file__).with_suffix('.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d))
