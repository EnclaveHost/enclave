import ast,base64,subprocess,json,datetime
from pathlib import Path
p=Path('work/windows-local-relay-root-activation/stage.py')
script=next(ast.literal_eval(n.value) for n in ast.parse(p.read_text()).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='script' for t in n.targets))
enc=base64.b64encode(script.encode('utf-16le')).decode()
ps="$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { [string]$_.CommandLine -match ('-EncodedCommand\\s+'+[Regex]::Escape('"+enc+"')+'[\" ]*$') }); $p | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress; if($p.Count -gt 2){throw 'Unexpected process count'}; foreach($x in $p){Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue}; Start-Sleep -Seconds 1; $left=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { [string]$_.CommandLine -match ('-EncodedCommand\\s+'+[Regex]::Escape('"+enc+"')+'[\" ]*$') }); 'Remaining failed upload processes: '+$left.Count; if($left.Count){exit 1}"
r=subprocess.run(['ssh','-o','BatchMode=yes','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,timeout=30)
Path('work/windows-local-relay-root-activation/failed-upload-cleanup.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reason':'Parent upload terminal1 after150s; precise encoded-command fingerprint matches only failed upload wrappers, not production services or tests','exit':r.returncode,'output':r.stdout.decode(errors='replace')},indent=2)+'\n')
print(r.stdout.decode(errors='replace'));raise SystemExit(r.returncode)
