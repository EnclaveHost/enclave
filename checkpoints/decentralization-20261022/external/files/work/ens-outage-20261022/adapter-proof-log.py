from pathlib import Path
import hashlib,importlib.util,json
r=Path(__file__).resolve().parent;t=r.parent/'nucbox-tls-20261021/root-activate-reviewed.py';assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$lines=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 450|Where-Object{$_ -match '(?i)7ae476a3|proof|certificate|acme|letsencrypt|checkpoint' -and $_ -notmatch '(?i)secret|password|token|key='}|Select-Object -Last 70);$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');log=[string]::Join("`n",$lines)};$o|ConvertTo-Json -Depth 3 -Compress'''
x=m.ps(ps,60)
(r/'adapter-proof-log.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x,indent=2))
