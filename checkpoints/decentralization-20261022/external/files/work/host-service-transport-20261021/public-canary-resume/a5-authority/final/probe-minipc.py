#!/usr/bin/env python3
"""READ-ONLY minipc (existing root-activate-reviewed.py m.ps): listeners on 31053/18153/18154 (local address + owning
process NAME only), sshd service state + OpenSSH version, AllowTcpForwarding/GatewayPorts lines of sshd_config (names and
values only; no keys), the Default Switch vEthernet IPv4. No users, keys, env or app data. -> probe-minipc.json"""
import base64, importlib.util, json, pathlib
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('t', pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/root-activate-reviewed.py'))
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
P = (r"$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};"
     r"$o.listen=@(foreach($p in 31053,18153,18154){@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue|ForEach-Object{[ordered]@{port=$p;addr=$_.LocalAddress;proc=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}})});"
     r"$sv=Get-Service sshd -ErrorAction SilentlyContinue;$o.sshd=[ordered]@{status=[string]$sv.Status;start=[string]$sv.StartType;version=(Get-Item 'C:\Windows\System32\OpenSSH\sshd.exe' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion};"
     r"$c='C:\ProgramData\ssh\sshd_config';$o.sshdConfig=@(if(Test-Path $c){Get-Content $c|Where-Object{$_ -match '^\s*(AllowTcpForwarding|GatewayPorts|PermitListen|Match|AllowUsers|AllowGroups|PasswordAuthentication)\b'}|ForEach-Object{$_.Trim()}});"
     r"$o.defaultSwitch=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue|Where-Object{$_.InterfaceAlias -like '*Default Switch*'}|ForEach-Object{$_.IPAddress+'/'+$_.PrefixLength});"
     r"$o.controlVm=@(Get-VM -Name enclave-control -ErrorAction SilentlyContinue|ForEach-Object{[ordered]@{state=[string]$_.State;ips=@($_.NetworkAdapters.IPAddresses|Where-Object{$_ -match '^\d+\.'})}});"
     r"$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress")
r = m.ps(P, secs=90)
if r.get('payload'): r = json.loads(base64.b64decode(r['payload']).decode())
(here / 'probe-minipc.json').write_text(json.dumps(r, indent=1) + '\n'); print(json.dumps(r, indent=1))
