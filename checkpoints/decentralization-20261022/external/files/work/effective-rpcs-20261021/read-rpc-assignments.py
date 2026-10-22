#!/usr/bin/env python3
"""READ-ONLY, in place, through the existing root-activate-reviewed.py ps() transport (in-session watchdog, primitive JSON).
For the node launcher chain C:\\ProgramData\\Enclave\\run-node.cmd -> node-config.cmd -> node-config.local.cmd (+ any .cmd
they `call`, depth 2), per file:
  - sha256, byte size, BOM/UTF-16 flags, line-ending counts, line count;
  - ONLY lines naming BASE_RPC*: line no, the command prefix before the name (<= 60 chars), the exact name, quote
    structure, separator counts, %VAR% references, the https HOST NAMES, flags (not values) for a path/query/userinfo/
    non-https entry;
  - control-flow line numbers/keywords only (call target if a .cmd path, goto/exit/setlocal/endlocal/labels/if/parens).
Also: Machine/User/Process(this shell) env vars named BASE_RPC*: presence + host names only; the Node task action and the
agent's parent cmd matching run-node.cmd (booleans). No other line, value, env or command line is returned. -> rpc-assignments.json"""
import base64, importlib.util, json, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('t', here.parent / 'nucbox-tls-20261021' / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
P = r"""function Hosts($v){@([regex]::Matches($v,'https://(?:[^/@\s,;"]*@)?([A-Za-z0-9.-]+)')|ForEach-Object{$_.Groups[1].Value})}
function Flags($v){$e=@($v -split '[,;\s"]+'|Where-Object{$_});[ordered]@{entries=$e.Count;nonHttps=@($e|Where-Object{$_ -notmatch '^https://'}).Count;pathOrQuery=@($e|Where-Object{$_ -match '^https://[^/]+/.|[?#]'}).Count;userinfo=@($e|Where-Object{$_ -match '^https://[^/]*@'}).Count}}
function Parse($f){$b=[IO.File]::ReadAllBytes($f);$t=[IO.File]::ReadAllText($f);$LN=$t -split "`r?`n|`r";
$o=[ordered]@{file=$f;sha=FileSha $f;bytes=$b.Length;bom=$(if($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB){'utf8'}elseif($b.Length -ge 2 -and $b[0] -eq 0xFF){'utf16le'}else{'none'});nul=(@($b|Where-Object{$_ -eq 0}).Count -gt 0);crlf=([regex]::Matches($t,"`r`n")).Count;lf=([regex]::Matches($t,"(?<!`r)`n")).Count;lines=$LN.Count;rpc=@();flow=@();calls=@()};
for($i=0;$i -lt $LN.Count;$i++){$l=$LN[$i];$n=$i+1;
 $r=[regex]::Match($l,'(?i)^(.{0,60}?)("?)(BASE_RPCS?)(=)(.*)$');
 if($r.Success){$v=$r.Groups[5].Value;$o.rpc+=[ordered]@{ln=$n;prefix=$r.Groups[1].Value.Trim();quoteBeforeName=($r.Groups[2].Value -eq '"');name=$r.Groups[3].Value;quotes=([regex]::Matches($v,'"')).Count;endsQuote=$v.TrimEnd().EndsWith('"');commas=([regex]::Matches($v,',')).Count;semis=([regex]::Matches($v,';')).Count;spaces=([regex]::Matches($v.Trim(),' ')).Count;trailingSpace=($v -ne $v.TrimEnd());pctRefs=@([regex]::Matches($v,'%[A-Za-z_][A-Za-z0-9_]*%')|ForEach-Object{$_.Value});amp=($v -match '[&|<>^]');hosts=Hosts $v;flags=Flags $v}}
 elseif($l -match '(?i)BASE_RPC'){$o.rpc+=[ordered]@{ln=$n;other=$true;prefix=([regex]::Match($l,'(?i)^.{0,40}?(?=BASE_RPC)').Value.Trim())}}
 $k=[regex]::Match($l,'(?i)^\s*@?\s*(call|goto|exit|setlocal|endlocal|if|:[A-Za-z]|\(|\))').Groups[1].Value;
 if($k){$c=[regex]::Match($l,'(?i)call\s+"?([^"]+\.cmd)"?');$o.flow+=[ordered]@{ln=$n;kw=$k.ToLower();call=$(if($c.Success){$c.Groups[1].Value}else{''});endsParen=($l.TrimEnd().EndsWith('('))};if($c.Success){$o.calls+=$c.Groups[1].Value}}}
$o}
$PD='C:\ProgramData\Enclave';$r=[ordered]@{at=[DateTime]::UtcNow.ToString('o');files=@(foreach($f in @(FILELIST)){$f=$f -replace '%PD%',$PD;if(Test-Path -LiteralPath $f){Parse $f}else{[ordered]@{file=$f;absent=$true}}})};
$j=$r|ConvertTo-Json -Depth 7 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
X = r"""$PD='C:\ProgramData\Enclave';function Flags($v){$e=@($v -split '[,;\s"]+'|Where-Object{$_});[ordered]@{entries=$e.Count;nonHttps=@($e|Where-Object{$_ -notmatch '^https://'}).Count;pathOrQuery=@($e|Where-Object{$_ -match '^https://[^/]+/.|[?#]'}).Count;userinfo=@($e|Where-Object{$_ -match '^https://[^/]*@'}).Count}};function Hosts($v){@([regex]::Matches($v,'https://(?:[^/@\s,;"]*@)?([A-Za-z0-9.-]+)')|ForEach-Object{$_.Groups[1].Value})}
$ev=[ordered]@{};foreach($sc in 'Machine','User','Process'){$h=[Environment]::GetEnvironmentVariables($sc);foreach($k in @($h.Keys|Where-Object{$_ -match '^(?i)BASE_RPCS?$'})){$ev["$sc/$k"]=[ordered]@{hosts=Hosts ([string]$h[$k]);flags=Flags ([string]$h[$k])}}};
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue;$a=@($t.Actions)[0];
$ag=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{[string]$_.CommandLine -like '*\control\windows\node\agent.mjs*'});
$pc=@($ag|ForEach-Object{$pp=Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)";[ordered]@{agent=$_.ProcessId;parent=$pp.ProcessId;parentIsRunNode=([string]$pp.CommandLine -like ('*'+$PD+'\run-node.cmd*'));parentStart=$pp.CreationDate.ToUniversalTime().ToString('o')}});
$r=[ordered]@{at=[DateTime]::UtcNow.ToString('o');env=$ev;task=[ordered]@{found=[bool]$t;exactAction=([string]$a.Execute -eq 'cmd.exe' -and [string]$a.Arguments -eq ('/c "'+$PD+'\run-node.cmd"'))};agents=$pc};
$j=$r|ConvertTo-Json -Depth 7 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"""
def flat(t):
    out = ""
    for l in t.split("\n"):
        l = l.strip()
        if not l: continue
        out += l if (not out or out.endswith((";", "{")) or l.startswith(("elseif", "else", "}"))) else ";" + l
    return out
def run(script):
    r = m.ps(flat(script), secs=90)
    if r.get('payload'): r = json.loads(base64.b64decode(r['payload']).decode('utf-8'))
    return r
def files(lst): return P.replace("FILELIST", ",".join("'%s'" % f.replace("'", "") for f in lst))
if __name__ == "__main__":
    if "--size" in sys.argv:
        for t in (files([r"%PD%\run-node.cmd", r"%PD%\node-config.cmd"]), X): print(len(base64.b64encode((m.HEAD.replace("SECS","90")+flat(t)).encode("utf-16-le"))))
        sys.exit(0)
    out = {"files": [], "calls": []}; todo = [r"%PD%\run-node.cmd"]; seen = set(); depth = 0
    while todo and depth < 3:
        todo = [f for f in todo if f.lower() not in seen]; seen |= {f.lower() for f in todo}
        if not todo: break
        r = run(files(todo)); out["calls"].append({"at": r.get("at"), "error": r.get("error")})
        if r.get("error"): break
        fs = r["files"] if isinstance(r["files"], list) else [r["files"]]
        out["files"] += fs; todo = [c for f in fs for c in (f.get("calls") or [])]; depth += 1
    out["extra"] = run(X)
    (here / 'rpc-assignments.json').write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out, indent=1))
    sys.exit(1 if any(c.get("error") for c in out["calls"]) or out["extra"].get("error") else 0)
