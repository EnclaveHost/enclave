#!/usr/bin/env python3
"""READ-ONLY skeleton of C:\\ProgramData\\Enclave\\run-node.cmd (the launcher): sha256, mtime, and per line ONLY its kind -
rem | echo-off | set <NAME> (values never returned, except BASE_RPC* host names) | call <.cmd path> | label | goto | cd |
launch (the agent.mjs line, as a flag) | log-echo | ping | blank | other. Plus, for the .cmd node-config.local.cmd calls
(lease-gas\\lease-gas-config.cmd): sha256 and ONLY its BASE_RPC* lines (host names) and call/goto/exit line numbers.
Uses read-rpc-assignments.py's Parse for that file. -> run-node-skeleton.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('r', here / 'read-rpc-assignments.py'); R = importlib.util.module_from_spec(s); s.loader.exec_module(R)
K = r"""$f='C:\ProgramData\Enclave\run-node.cmd';$LN=[IO.File]::ReadAllText($f) -split "`r?`n";
$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');sha=FileSha $f;mtime=(Get-Item -LiteralPath $f).LastWriteTimeUtc.ToString('o');lines=@()};
for($i=0;$i -lt $LN.Count;$i++){$l=$LN[$i].Trim();$n=$i+1;$k='other';$x=$null;
if($l -eq ''){$k='blank'}elseif($l -match '^(?i)@?rem\b'){$k='rem'}elseif($l -match '^(?i)@echo off$'){$k='echo-off'}
elseif($l -match '^(?i)@?set\s+"?([A-Za-z_][A-Za-z0-9_]*)='){$k='set';$x=$Matches[1];if($x -match '^(?i)BASE_RPCS?$'){$x=$x+' '+((@([regex]::Matches($l,'https://(?:[^/@\s,;"]*@)?([A-Za-z0-9.-]+)')|ForEach-Object{$_.Groups[1].Value})) -join ',')}}
elseif($l -match '^(?i)call\s+"?([^"]+\.cmd)"?'){$k='call';$x=$Matches[1]}elseif($l -match '^:'){$k='label'}elseif($l -match '^(?i)goto\b'){$k='goto'}
elseif($l -match '^(?i)cd\b'){$k='cd'}elseif($l -match 'agent\.mjs'){$k='launch'}elseif($l -match '^(?i)echo\b.*\[run\]'){$k='log-echo'}elseif($l -match '^(?i)ping\b'){$k='ping'}
$o.lines+=[ordered]@{ln=$n;kind=$k;detail=$x}};
$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
if __name__ == "__main__":
    if "--size" in sys.argv:
        print(len(base64.b64encode((R.m.HEAD.replace("SECS", "90") + R.flat(K)).encode("utf-16-le")))); sys.exit(0)
    out = {"runNode": R.run(K), "leaseGasCmd": R.run(R.files([r"%PD%\lease-gas\lease-gas-config.cmd"]))}
    (here / 'run-node-skeleton.json').write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out)[:200])
    sys.exit(1 if any(v.get('error') for v in out.values()) else 0)
