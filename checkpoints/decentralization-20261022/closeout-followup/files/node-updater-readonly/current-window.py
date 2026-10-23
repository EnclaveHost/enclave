import importlib.util,json,pathlib
s=importlib.util.spec_from_file_location('t','work/nucbox-tls-20261021/root-activate-reviewed.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
p=r'''[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$h=Invoke-RestMethod -TimeoutSec 5 http://127.0.0.1:9600/v1/host/state;$u=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Update;$i=$u|Get-ScheduledTaskInfo;[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');deployments=@($h.deployments|Where-Object {$_.status -eq 'running'}|Select-Object id,status,leaseUntil);update=@{state=[string]$u.State;last=$i.LastRunTime.ToUniversalTime().ToString('o');next=$i.NextRunTime.ToUniversalTime().ToString('o');result=$i.LastTaskResult};hostSha=(Get-FileHash 'C:\Program Files\Enclave\control\windows\node\host.mjs').Hash;chainSha=(Get-FileHash 'C:\Program Files\Enclave\control\windows\node\chain.mjs').Hash}|ConvertTo-Json -Depth 6 -Compress'''
r=t.ps(p,25)
print(json.dumps(r))
