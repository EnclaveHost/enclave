import subprocess,base64,pathlib
ps=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$o.node=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 60000 | Where-Object {$_ -match '59f1273d'} | Select-Object -Last 65)
$o.manager=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\shield.log' -Tail 10000 | Where-Object {$_ -match '59f1273d'} | Select-Object -Last 35)
$o.shieldDirs=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave' -Directory | Select-Object Name)
$o.vmCount=@(Get-VM -ErrorAction SilentlyContinue).Count
'RESULT '+($o|ConvertTo-Json -Depth 4 -Compress)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,timeout=90)
(pathlib.Path(__file__).parent/'root-logs.out').write_bytes(r.stdout+r.stderr);print(r.stdout.decode(errors='replace')[:20000]);print('SSH_EXIT',r.returncode);raise SystemExit(r.returncode)
