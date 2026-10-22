import pathlib,json,importlib.util
p=pathlib.Path(__file__).resolve().parent;st=json.loads((p/'stage.json').read_text());pr=json.loads((p/'native-proof.json').read_text());e=json.loads((p/'execution.json').read_text());su=json.loads(e['output'].split('RESULT ',1)[1]);assert pr['receipt']['pass'] and pr['taskAbsent'] and pr['runDirAbsent']
s=importlib.util.spec_from_file_location('transport',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
d=st['stage'];f=su['receiptCopy'];assert 'g3-root-' in d and f.endswith(su['runId']+'.json')
script="$d='"+d+"';$f='"+f+"';if((FileSha $f) -ne '"+pr['receiptSha256']+"'){throw 'receipt drifted'};$items=@(Get-ChildItem -LiteralPath $d -Force);if($items.Count -ne 2){throw 'unexpected stage files'};"
for name,sha in st['pins'].items():script+="$p=Join-Path $d '"+name+"';if((FileSha $p) -ne '"+sha+"'){throw 'stage file drifted'};"
for name in st['pins']:script+="Remove-Item -LiteralPath (Join-Path $d '"+name+"') -Force;"
script+="Remove-Item -LiteralPath $d;Remove-Item -LiteralPath $f -Force;@{stageAbsent=(-not(Test-Path -LiteralPath $d));receiptAbsent=(-not(Test-Path -LiteralPath $f));taskAbsent=(-not[bool](Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'g3-native-once-"+su['runId']+"' -ErrorAction SilentlyContinue));runDirAbsent=(-not(Test-Path -LiteralPath '"+su['runDir']+"'))}|ConvertTo-Json -Compress"
r=m.ps(script,secs=40);(p/'cleanup.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));assert not r.get('error') and all(r.get(k) is True for k in ['stageAbsent','receiptAbsent','taskAbsent','runDirAbsent']),r
