import importlib.util,json,pathlib,datetime,base64
p=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('transport',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps(r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');logs=@{}};
foreach($name in @('node.log','network.log','shield.log')){
 $f=Join-Path 'C:\ProgramData\Enclave\logs' $name;
 if(Test-Path -LiteralPath $f){$o.logs[$name]=@(Get-Content -LiteralPath $f -Tail 10000|Where-Object {$_ -match '59f1273d' -and $_ -match 'start|stop|exit|fail|retir|install|circuit|egress|ready|lease|refus'}|Select-Object -Last 25|ForEach-Object {$x=[string]$_;$x=[regex]::Replace($x,'(?i)((?:secret|token|password|authorization|api_key)\s*[:=]\s*)[^\s,;]+','$1[REDACTED]');$x.Substring(0,[Math]::Min(1100,$x.Length))})}
};$j=$o|ConvertTo-Json -Depth 5 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress""",secs=75)
if r.get('payload'):r=json.loads(base64.b64decode(r['payload']).decode('utf-8'))
(p/'dns-restart-log.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));assert not r.get('error'),r
