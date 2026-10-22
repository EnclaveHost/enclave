from pathlib import Path
import hashlib,importlib.util,json,base64
r=Path(__file__).resolve().parent;t=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/root-activate-reviewed.py');assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$b='C:\Program Files\Enclave\control';$paths=@('network\wallet-admission.mjs','network\privacy-agent.mjs','windows\node\host.mjs','windows\node\agent.mjs','windows\node\host-admission.bundle.mjs');$files=@();foreach($f in $paths){$p=Join-Path $b $f;if(Test-Path -LiteralPath $p){$files+=@{path=$f;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()}}};$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');files=$files};$j=$o|ConvertTo-Json -Depth 4 -Compress;[Console]::WriteLine('{"payload":"'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))+'"}')'''
x=m.ps(ps,60)
if 'payload' in x:x=json.loads(base64.b64decode(x['payload']).decode('utf-8'))
(r/'admission-source-hashes.json').write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x,indent=2))
