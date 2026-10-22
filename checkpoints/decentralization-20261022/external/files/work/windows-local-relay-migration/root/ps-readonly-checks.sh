#!/usr/bin/env bash
# ps-readonly-checks.sh - READ-ONLY on the Windows host, for ROOT to run. Every PowerShell source of the release (stage/*.ps1,
# stage/relay/*.ps1, root/*.ps1) is streamed as base64 TEXT and only PARSED by PowerShell 5.1
# (System.Management.Automation.Language.Parser.ParseInput): nothing is written, imported, dot-sourced or executed.
# Each parse error is printed as "<file>:<line>:<column>: <message>" (the parser's message only, never the source text).
# FAILS CLOSED: exit 1 when any file has a parse error, when the remote file list differs from the local one, or when the
# remote result line is missing (ssh/PowerShell failure). Then it reports public host facts, changing nothing: the relay
# data directory and whether a key or send record exists there (yes/no, size), the \Enclave\Relay task, listeners on
# 8549, the installed bundle's and lease-gas-config.cmd's sha256 (the CAS baselines) and icacls availability.
#   bash ps-readonly-checks.sh minipc            (exit 0 only when every file parsed clean)
set -euo pipefail
HOST=${1:?ssh alias of the Windows host}
cd "$(dirname "$0")/.."
shopt -s nullglob; FILES=(stage/*.ps1 stage/relay/*.ps1 root/*.ps1); shopt -u nullglob
mapfile -t FILES < <(printf '%s\n' "${FILES[@]}" | sort)
[ ${#FILES[@]} -gt 0 ] || { echo "FAIL: no PowerShell sources found"; exit 1; }
want=$(printf '%s\n' "${FILES[@]}" | sha256sum | cut -c1-64)
out=$(python3 - "${FILES[@]}" <<'PY' | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" powershell -NoProfile -NonInteractive -Command - 2>&1
import base64, sys
print("$ErrorActionPreference='Stop'"); print("$files=[ordered]@{}")
for f in sys.argv[1:]:
    print(f"$files['{f}']='{base64.b64encode(open(f, 'rb').read()).decode()}'")
print("$bad=0; $names=@()")
print(r"""foreach($k in $files.Keys){ $names+=$k; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($files[$k])); $tok=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($t,[ref]$tok,[ref]$e); if(@($e).Count){ $bad+=@($e).Count; foreach($x in $e){ 'PARSE-ERROR '+$k+':'+$x.Extent.StartLineNumber+':'+$x.Extent.StartColumnNumber+': '+$x.Message } } else { 'parse ok '+$k } }""")
print(r"""$sha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($names -join "`n")+"`n"))).Replace('-','').ToLower()""")
print(r"""'PARSE-RESULT files='+$names.Count+' errors='+$bad+' list='+$sha""")
print(r"""$d=Join-Path $env:ProgramData 'Enclave\lease-relay'
'relay data dir: '+$(if(Test-Path -LiteralPath $d){'present; protected '+(Get-Acl -LiteralPath $d).AreAccessRulesProtected+'; SIDs '+((@((Get-Acl -LiteralPath $d).Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})|Sort-Object -Unique) -join ',')}else{'absent'})
foreach($f in 'relay.key','relay-send.json'){$p=Join-Path $d $f; $f+': '+$(if(Test-Path -LiteralPath $p){'present '+(Get-Item -LiteralPath $p).Length+' bytes'}else{'absent'})}
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue; 'task \Enclave\Relay: '+$(if($t){$t.State}else{'absent'})
'listeners on 8549: '+@(Get-NetTCPConnection -State Listen -LocalPort 8549 -ErrorAction SilentlyContinue).Count
$b=Join-Path $env:ProgramFiles 'Enclave\control\windows\node\lease-gas-runtime.bundle.mjs'; 'installed bundle sha256: '+(Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash.ToLower()+' (CAS baseline 64712447030248173f35e8ac916c737dfd91f719d69335979a83f1cfffb356b6)'
$c=Join-Path $env:ProgramData 'Enclave\lease-gas\lease-gas-config.cmd'; 'lease-gas-config.cmd sha256: '+(Get-FileHash -LiteralPath $c -Algorithm SHA256).Hash.ToLower()+' (CAS baseline 9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e)'
'icacls grant syntax: '+$(if((& icacls.exe /? | Out-String) -match '/grant'){'available'}else{'NOT FOUND'})
'powershell '+$PSVersionTable.PSVersion.ToString()""")
PY
) || true
printf '%s\n' "$out"
line=$(printf '%s\n' "$out" | grep -E '^PARSE-RESULT files=[0-9]+ errors=[0-9]+ list=[0-9a-f]{64}' | tail -1 | tr -d '\r' || true)
[ -n "$line" ] || { echo "FAIL: no PARSE-RESULT from the host (ssh or PowerShell failed): not verified"; exit 1; }
n=$(sed -E 's/.*files=([0-9]+).*/\1/' <<<"$line"); e=$(sed -E 's/.*errors=([0-9]+).*/\1/' <<<"$line"); l=$(sed -E 's/.*list=([0-9a-f]{64}).*/\1/' <<<"$line")
[ "$n" = "${#FILES[@]}" ] && [ "$l" = "$want" ] || { echo "FAIL: the host parsed $n file(s) (list $l), not the ${#FILES[@]} sent (list $want)"; exit 1; }
[ "$e" = 0 ] || { echo "FAIL: $e parse error(s) above"; exit 1; }
echo "OK: all ${#FILES[@]} PowerShell sources parse in PowerShell on $HOST"
