import argparse,pathlib,json,subprocess,hashlib,importlib.util,datetime
p=pathlib.Path(__file__).resolve().parent;m=json.loads((p/'manifest.json').read_text());remote=m['stage'];ps=p/'activate.ps1';sha=hashlib.sha256(ps.read_bytes()).hexdigest();manifestSha=hashlib.sha256((p/'manifest.json').read_bytes()).hexdigest()
s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
a=argparse.ArgumentParser();a.add_argument('step',choices=['stage','prepare','preflight','stop','install','start-shield','start-network','start-node','verify','rollback','rollback-start-shield','rollback-start-network','rollback-start-node']);step=a.parse_args().step
if step=='stage':
 r=h.ps("$p='"+remote+"';if(Test-Path $p){throw 'Stage exists'};New-Item -ItemType Directory -Path ($p+'\\payload') -Force|Out-Null;@{ok=$true}|ConvertTo-Json -Compress",25);assert r.get('ok'),r
 for src in [p/'manifest.json',ps]+list((p/'payload').glob('*.mjs')):
  rel=src.relative_to(p).as_posix();subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=10',str(src),'minipc:'+remote.replace('\\','/')+'/'+rel],check=True,capture_output=True,timeout=45)
 r=h.ps("if((FileSha '"+remote+"\\manifest.json') -ne '"+manifestSha+"'){throw 'Manifest changed'};$f='"+remote+"\\activate.ps1';if((FileSha $f) -ne '"+sha+"'){throw 'Script hash mismatch'};$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e);@{ok=($e.Count -eq 0);errors=@($e|ForEach-Object {$_.Message});scriptSha256=(FileSha $f)}|ConvertTo-Json -Compress",25)
else:
 prev={'prepare':'stage','preflight':'prepare','stop':'preflight','install':'stop','start-shield':'install','start-network':'start-shield','start-node':'start-network'}
 if step in prev:
  last=json.loads((p/'last.json').read_text());assert last['step']==prev[step] and last['result'].get('ok'), 'Missing successful preceding phase'
  if step in ['stop','install']:assert (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(last['at'])).total_seconds()<300,'Stale preceding phase'
 r=h.ps("if((FileSha '"+remote+"\\manifest.json') -ne '"+manifestSha+"'){throw 'Manifest changed'};$f='"+remote+"\\activate.ps1';if((FileSha $f) -ne '"+sha+"'){throw 'Script changed'};& ([ScriptBlock]::Create([IO.File]::ReadAllText($f))) -Stage '"+remote+"' -Step '"+step+"'",80)
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'step':step,'scriptSha256':sha,'result':r};f=p/(step+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S')+'.json');f.write_text(json.dumps(receipt,indent=2)+'\n')
if r.get('ok'):(p/'last.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt));raise SystemExit(0 if r.get('ok') else 1)
