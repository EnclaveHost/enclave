import importlib.util,json,pathlib
s=importlib.util.spec_from_file_location('t','work/nucbox-tls-20261021/root-activate-reviewed.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
p=r'''[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$h=Invoke-RestMethod -TimeoutSec 5 http://127.0.0.1:9600/v1/host/state;[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');deployment=@($h.deployments|Where-Object {$_.id -like '0x59f1273d*'}|Select-Object id,status);certLines=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 30000|Where-Object {$_ -match '0x59f1273d certificate:'}|Select-Object -Last 6|ForEach-Object {([string]$_) -replace '[^\x20-\x7E]','~'})}|ConvertTo-Json -Depth 5 -Compress'''
r=t.ps(p,30)
pathlib.Path('outputs/decentralization-audit/enclavedns-cert-log-20261023T0408Z.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
raise SystemExit(1 if 'error' in r else 0)
