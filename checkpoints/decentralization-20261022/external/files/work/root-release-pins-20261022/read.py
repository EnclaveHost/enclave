import pathlib,hashlib,importlib.util,json
W=pathlib.Path.cwd();t=W/'work/nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$r='C:\Program Files\Enclave';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');files=[ordered]@{}};foreach($n in @('control\windows\node\host-onchain.mjs','control\windows\node\keys.mjs','control\windows\node\release-channel.mjs','update-host.ps1')){$o.files[$n]=FileSha (Join-Path $r $n)};$o|ConvertTo-Json -Depth 4 -Compress'''
r=m.ps(ps,60)
p=W/'work/root-release-pins-20261022/result.json'
with p.open('x') as f:json.dump(r,f,indent=2)
print(json.dumps(r,indent=2))
