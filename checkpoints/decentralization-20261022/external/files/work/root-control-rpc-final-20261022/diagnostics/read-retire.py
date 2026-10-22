import importlib.util,json,pathlib,hashlib,datetime
W=pathlib.Path.cwd();H=W/'work/root-control-rpc-final-20261022/control-package'
s=importlib.util.spec_from_file_location('post',H/'postflight/postflight.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
r=json.loads((H/'helper/runs/cutover-result-20261022t033638z-f12f68.json').read_text());rows=[json.loads(x) for x in r['journal']['lines']];pin=next(x for x in rows if x.get('step')=='pins')
t=r'''$p='C:\ProgramData\Enclave\logs\node.log';$offset=OFFSETX;$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');offset=$offset};$f=[IO.File]::Open($p,'Open','Read','ReadWrite,Delete');try{if($f.Length -lt $offset){throw 'log rotated'};$n=$f.Length-$offset;if($n -gt 2097152){throw 'log over 2MiB bound'};[void]$f.Seek($offset,'Begin');$t=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()};$o.bytes=$n;$o.retire=@(foreach($l in ($t -split "`n")){if($l -match '(0x[0-9a-fA-F]{8}) isolated domain retired \((.*)\)'){$id=$Matches[1].ToLower();$why=$Matches[2];[ordered]@{idPrefix=$id;expected=(IDSX -contains $id);reasonTags=@(foreach($tag in @('lease','cancel','end','version','recovery','owner','forced','policy','wallet','not ours','not held','not active')){if($why -match [regex]::Escape($tag)){$tag}});reasonSha=(-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($why))|%{$_.ToString('x2')}))}}});$o|ConvertTo-Json -Depth 5 -Compress'''
t=t.replace('OFFSETX',str(pin['nodeLogOffset'])).replace('IDSX',p.arr([x[:10] for x in r['params']['expectedIds']]))
m=p.head();pr=m.ps(p.parse_text(t),60)
if not p.parsed_ok(pr,t):raise SystemExit(json.dumps(pr))
v=m.ps(t,60);out={'sourceSha':hashlib.sha256(t.encode()).hexdigest(),'parse':pr,'result':v}
f=W/'work/root-control-rpc-final-20261022/diagnostics/retire-log-read.json'
with f.open('x') as q:json.dump(out,q,indent=2)
print(json.dumps(v,indent=2))
