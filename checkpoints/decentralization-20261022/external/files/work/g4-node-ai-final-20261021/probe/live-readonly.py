#!/usr/bin/env python3
"""READ-ONLY minipc inventory for the node-hold package (Claude 60543494). Transport: root's reviewed
nucbox-tls-20261021/root-activate-reviewed.py m.ps (in-session watchdog, encoded <= 7900), loaded only if its sha is the pin.
Reads: file hashes (control tree .mjs, network bin), task/process/VM identities, privacy-config KEY NAMES + app ids +
their expectation appRef/configCid shape, node loopback /v1/host/state id/status/appRef/isolation presence, the status.json
walletAdmission presence, and from node-config*.cmd ONLY the values of ENCLAVE_NETWORK_AGENT_DIR / NODE_DIR and whether
ENCLAVE_NETWORK_WALLET_HOLD is set. No logs, keys, env dumps or other config values. Writes probe/out-<ts>.json."""
import hashlib, importlib.util, json, pathlib, sys, time
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work")
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
if hashlib.sha256(T[0].read_bytes()).hexdigest() != T[1]: sys.exit("transport pin differs")
spec = importlib.util.spec_from_file_location("t", T[0]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
U = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
FILES = U + r"""$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');control=[ordered]@{};bin=[ordered]@{}};
$c='C:\Program Files\Enclave\control';foreach($d in 'windows\node','network','windows\vbslike\datapath'){Get-ChildItem -LiteralPath (Join-Path $c $d) -File -Filter *.mjs -ErrorAction SilentlyContinue|Sort-Object Name|ForEach-Object{$o.control[$d+'\'+$_.Name]=(FileSha $_.FullName).Substring(0,16)}};
Get-ChildItem -LiteralPath 'C:\Program Files\Enclave\network' -File|Sort-Object Name|ForEach-Object{$o.bin[$_.Name]=(FileSha $_.FullName)};
$o|ConvertTo-Json -Compress -Depth 4"""
STATE = U + r"""$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')};$pd='C:\ProgramData\Enclave';
foreach($f in 'run-node.cmd','node-config.cmd','node-config.local.cmd','run-network.cmd'){$o[$f]=FileSha (Join-Path $pd $f)};
$vars=[ordered]@{};foreach($f in 'node-config.cmd','node-config.local.cmd','run-node.cmd'){$p=Join-Path $pd $f;if(Test-Path -LiteralPath $p){foreach($l in [IO.File]::ReadAllLines($p)){
 if($l -match '^\s*set\s+"?(ENCLAVE_NETWORK_AGENT_DIR|NODE_DIR|ENCLAVE_NETWORK_BIN_DIR)=([^"]*)"?\s*$'){$vars[$f+':'+$matches[1]]=$matches[2]}
 elseif($l -match 'ENCLAVE_NETWORK_WALLET_HOLD'){$vars[$f+':ENCLAVE_NETWORK_WALLET_HOLD']='present'}}}};$o.vars=$vars;
$o.tasks=@(Get-ScheduledTask -TaskPath '\Enclave\'|ForEach-Object{$a=$_.Actions[0];$_.TaskName+'='+[string]$_.State+' :: '+[string]$a.Execute+' '+[string]$a.Arguments});
$all=@(Get-CimInstance Win32_Process -OperationTimeoutSec 30);
$o.agent=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -like '*\control\windows\node\agent.mjs*'}|ForEach-Object{"$($_.ProcessId)@$($_.CreationDate.ToUniversalTime().ToString('o'))<$($_.ParentProcessId)"});
$o.privacy=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -match 'privacy-agent\.mjs'}|ForEach-Object{"$($_.ProcessId)@$($_.CreationDate.ToUniversalTime().ToString('o'))<$($_.ParentProcessId)"});
$o.privacyParent=@($all|Where-Object{$_.Name -eq 'node.exe' -and [string]$_.CommandLine -match 'privacy-agent\.mjs'}|ForEach-Object{$pp=$_.ParentProcessId;($all|Where-Object{$_.ProcessId -eq $pp}|ForEach-Object{$_.Name+' '+([string]$_.CommandLine).Substring(0,[math]::Min(120,([string]$_.CommandLine).Length))})});
$o.wg=@($all|Where-Object{$_.Name -eq 'enclave-wg.exe'}).Count;
$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);if($c.Count -eq 1){$p=$all|Where-Object{$_.ProcessId -eq $c[0].OwningProcess};$o.manager="$($p.ProcessId)@$($p.CreationDate.ToUniversalTime().ToString('o'))"};
try{$o.vms=@((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms|ForEach-Object{"$($_.id)|$($_.name)|$($_.status)"})}catch{$o.vms='unavailable'};
$o|ConvertTo-Json -Compress -Depth 4"""
NET = U + r"""$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')};$cf='C:\ProgramData\Enclave\network\privacy-config.json';$o.cfgSha=FileSha $cf;
$c=[IO.File]::ReadAllText($cf)|ConvertFrom-Json;$o.enKeys=@($c.enclaveNetwork.PSObject.Properties.Name);$o.directory=[string]$c.directory;$o.runner=[string]$c.runner;
$o.apps=@($c.apps|ForEach-Object{$e=$null;try{$e=[IO.File]::ReadAllText([string]$_.expectedFile)|ConvertFrom-Json}catch{};[ordered]@{id=[string]$_.deploymentId;appRef=[string]$e.appRef;configCidLen=$(if($e -and $e.configCid -is [string]){([string]$e.configCid).Length}else{-1})}});
$st=Join-Path ([string]$c.directory) 'status.json';$o.statusSha=FileSha $st;try{$s=[IO.File]::ReadAllText($st)|ConvertFrom-Json;$o.statusUpdatedAt=$s.updatedAt;$o.statusVersion=$s.version;$o.statusWallet=$null -ne $s.walletAdmission}catch{$o.statusErr='unreadable'};
$o.walletFile=FileSha 'C:\ProgramData\Enclave\network\wallet-admission.json';
try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state';$o.records=@($h.deployments|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;appRef=[string]$_.appRef;iso=[string]$_.isolation.instance;walletHeld=$_.walletHeld}})}catch{$o.records='unavailable'};
$o|ConvertTo-Json -Compress -Depth 5"""
out = {}
for name, s in (("files", FILES), ("state", STATE), ("network", NET)): out[name] = m.ps(s, 120)
ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()); p = pathlib.Path(__file__).parent / f"out-{ts}.json"
p.write_text(json.dumps(out, indent=1)); print(p)
print(json.dumps({k: (v.get("error") if isinstance(v, dict) else None) for k, v in out.items()}))
