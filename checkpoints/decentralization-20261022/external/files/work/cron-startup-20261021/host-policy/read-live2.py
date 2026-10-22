#!/usr/bin/env python3
"""READ-ONLY metadata: mtime of node-config.local.cmd (no content); the HOST NAMES only of chain.rpc in the privacy agent's
privacy-config.json (no other field read out); the node and agent process start times. -> read-live2.json"""
import json, pathlib, importlib.util
s = importlib.util.spec_from_file_location('rl', pathlib.Path(__file__).with_name('read-live.py'))
src = pathlib.Path(__file__).with_name('read-live.py').read_text().split('D = r"C:')[0]
ns = {}; exec(src, ns); ps = ns['ps']
script = ("$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};"
  "$c=@(Get-ChildItem -Path 'C:\\Program Files\\Enclave','C:\\ProgramData\\Enclave' -Recurse -Filter 'node-config.local.cmd' -File -ErrorAction SilentlyContinue | Select-Object -First 2);"
  "$o.nodeConfigLocal=@($c|ForEach-Object{$_.LastWriteTimeUtc.ToString('o')});"
  "$p=@(Get-ChildItem -Path 'C:\\Program Files\\Enclave','C:\\ProgramData\\Enclave' -Recurse -Filter 'privacy-config.json' -File -ErrorAction SilentlyContinue | Select-Object -First 3);"
  "$o.privacy=@(foreach($x in $p){$j=Get-Content -Raw -LiteralPath $x.FullName|ConvertFrom-Json;[ordered]@{mtime=$x.LastWriteTimeUtc.ToString('o');rpcHosts=@($j.chain.rpc|ForEach-Object{([uri]$_).Host})}});"
  "$o.procs=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"|Where-Object{$_.CommandLine -match 'agent\\.mjs|privacy-agent\\.mjs'}|ForEach-Object{[ordered]@{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');role=$(if($_.CommandLine -match 'privacy-agent'){'privacy-agent'}else{'node-agent'})}});"
  "$o|ConvertTo-Json -Depth 4 -Compress")
out = ps(script)
pathlib.Path(__file__).with_name("read-live2.json").write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
