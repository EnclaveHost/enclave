#!/usr/bin/env bash
# collect-minipc.sh - READ-ONLY public facts from minipc after the cutover, as ONE JSON object on stdout (root saves it as
# minipc.json). Nothing is written, started or stopped there; no key, environment, database or journal CONTENT is read.
# The relay log is reduced to its "[relay] <status> <tx hash> paid <wei>" lines (public chain data); the send record to its
# shape (nonce and hash only). The PowerShell statements go on stdin as plain text (one statement per line, like
# ps-readonly-checks.sh); no data file is piped.
#   bash collect-minipc.sh minipc > minipc.json
set -euo pipefail
HOST=${1:?ssh alias, or --print-script to print the PowerShell text only (for a parse check)}
cd "$(dirname "$0")"
gen() { python3 - <<'PY'
import json
e = json.load(open("expectations.json"))
paths = sorted(e["control"])
L = []
L.append("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'")
L.append("$PF=Join-Path $env:ProgramFiles 'Enclave'; $PD=Join-Path $env:ProgramData 'Enclave'; $C=Join-Path $PF 'control'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o'); host=$env:COMPUTERNAME}")
L.append("function Sha([string]$p){ if(Test-Path -LiteralPath $p -PathType Leaf){ (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }")
L.append("function Iso($d){ if($d){ ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }")
L.append("try { $o.vms=@((Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [ordered]@{id=[string]$_.id; status=[string]$_.status} }) } catch { $o.vms=$null; $o.vmsError=$_.Exception.Message }")
L.append("$agent=Join-Path $C 'windows\\node\\agent.mjs'; $o.agents=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { [string]$_.CommandLine -like ('*'+$agent+'*') } | ForEach-Object { [ordered]@{pid=$_.ProcessId; created=(Iso $_.CreationDate)} })")
L.append("$o.loops=@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { [string]$_.CommandLine -like '*run-node.cmd*' } | ForEach-Object { [ordered]@{pid=$_.ProcessId; created=(Iso $_.CreationDate)} })")
L.append("try { $o.healthy=[bool](Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok } catch { $o.healthy=$false }")
L.append("try { $s=Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:9600/v1/host/state'; $o.leaseMode=[string]$s.availability.leaseGas; $o.operator=[string]$s.availability.operator } catch { $o.leaseMode=$null; $o.operator=$null }")
L.append("$ctl=[ordered]@{}")
for p in paths:
    L.append("$ctl['%s']=(Sha (Join-Path $C '%s'))" % (p, p.replace("/", "\\")))
L.append("$o.control=$ctl")
L.append("$lg=Join-Path $PD 'lease-gas'; $o.settings=[ordered]@{'lease-gas-config.cmd'=(Sha (Join-Path $lg 'lease-gas-config.cmd')); 'deployment.json'=(Sha (Join-Path $lg 'deployment.json'))}")
L.append("$call='call \"'+(Join-Path $lg 'lease-gas-config.cmd')+'\"'; $o.settingsCalled=[bool]((Select-String -LiteralPath (Join-Path $PD 'node-config.local.cmd') -SimpleMatch -Pattern $call -Quiet -ErrorAction SilentlyContinue) -or (Select-String -LiteralPath (Join-Path $PD 'node-config.cmd') -SimpleMatch -Pattern $call -Quiet -ErrorAction SilentlyContinue))")
L.append("$o.tasks=[ordered]@{}; foreach($t in 'Node','Shield','Network','Update','Relay'){ $x=Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName $t -ErrorAction SilentlyContinue; $o.tasks[$t]=$(if($x){[string]$x.State}else{'absent'}) }")
L.append("$o.relayProcesses=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { [string]$_.CommandLine -like '*lease-relay\\releases\\*lease-relay.mjs*' }).Count")
L.append("$o.relayListeners=@(Get-NetTCPConnection -State Listen -LocalPort 8549 -ErrorAction SilentlyContinue).Count")
L.append("try { $i=Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:8549/v1/info'; $o.relayInfo=[ordered]@{payee=[string]$i.payee; chainId=[int64]$i.chainId; reserve=[string]$i.reserve; executor=[string]$i.executor} } catch { $o.relayInfo=$null }")
L.append("$rl=Join-Path $PD 'logs\\lease-relay.log'; $o.relayLog=@(); if(Test-Path -LiteralPath $rl){ $o.relayLog=@(Get-Content -LiteralPath $rl -Tail 20000 | ForEach-Object { if($_ -match '\\[relay\\] (success|reverted) (0x[0-9a-fA-F]{64}) paid (\\d+|none)'){ [ordered]@{status=$Matches[1]; hash=$Matches[2].ToLower(); paid=$Matches[3]} } }) }")
L.append("$rs=Join-Path $PD 'lease-relay\\relay-send.json'; $o.relaySend=$(if(Test-Path -LiteralPath $rs){ try { $j=Get-Content -LiteralPath $rs -Raw | ConvertFrom-Json; if($j.hash){ [ordered]@{shape='unresolved'; nonce=$j.nonce; hash=[string]$j.hash} } else { [ordered]@{shape='empty'} } } catch { [ordered]@{shape='unreadable'} } } else { [ordered]@{shape='absent'} })")
L.append("'COLLECT-JSON '+($o | ConvertTo-Json -Depth 6 -Compress)")
print("\n".join(L))
PY
}
if [ "$HOST" = --print-script ]; then gen; exit 0; fi
gen | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" powershell -NoProfile -NonInteractive -Command - | tr -d '\r' | sed -n 's/^COLLECT-JSON //p'
