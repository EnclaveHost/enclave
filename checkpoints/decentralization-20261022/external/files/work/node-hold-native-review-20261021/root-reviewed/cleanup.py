import json,pathlib,importlib.util,hashlib
p=pathlib.Path(__file__).resolve().parent
h=p.parents[1]/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(h.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
sp=importlib.util.spec_from_file_location('transport',h);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
stage=json.loads((p/'stage.json').read_text())['stage'];sha=json.loads((p/'pins.json').read_text())['kill-canary.mjs']
assert stage.startswith('C:\\ProgramData\\Enclave\\staging\\hold-kill-') and len(stage.rsplit('-',1)[1])==12
s="$d='"+stage+"';$items=@(Get-ChildItem -LiteralPath $d -Force);if($items.Count -ne 1 -or $items[0].Name -ne 'kill-canary.mjs' -or $items[0].PSIsContainer){throw 'unexpected contents'};if((FileSha (Join-Path $d 'kill-canary.mjs')) -ne '"+sha+"'){throw 'canary changed'};Remove-Item -LiteralPath (Join-Path $d 'kill-canary.mjs');Remove-Item -LiteralPath $d;@{stage=$d;removed=(-not(Test-Path -LiteralPath $d))}|ConvertTo-Json -Compress"
r=m.ps(s,secs=45);(p/'cleanup.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));assert r.get('removed') is True
