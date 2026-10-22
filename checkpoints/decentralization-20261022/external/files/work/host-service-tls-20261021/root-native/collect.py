import pathlib,json,importlib.util,re
p=pathlib.Path(__file__).resolve().parent;s=importlib.util.spec_from_file_location('transport',pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve());m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
e=json.loads((p/'execution.json').read_text());summary=json.loads(e['output'].split('RESULT ',1)[1]);f=summary['receiptCopy'];task=summary['task'];rd=summary['runDir']
assert summary['pass'] and re.fullmatch(r'2026\d{10}-[0-9a-f]{8}',summary['runId']),summary
assert f.endswith('g3-native-receipt-'+summary['runId']+'.json')
script="$f='"+f+"';$r=Get-Content -LiteralPath $f -Raw|ConvertFrom-Json;$t=Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'g3-native-once-"+summary['runId']+"' -ErrorAction SilentlyContinue;@{receipt=$r;receiptSha256=FileSha $f;taskAbsent=(-not [bool]$t);runDirAbsent=(-not (Test-Path -LiteralPath '"+rd+"'))}|ConvertTo-Json -Depth 15 -Compress"
r=m.ps(script,secs=40);(p/'native-proof.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));assert not r.get('error') and r['taskAbsent'] and r['runDirAbsent'] and r['receipt']['pass'],r
