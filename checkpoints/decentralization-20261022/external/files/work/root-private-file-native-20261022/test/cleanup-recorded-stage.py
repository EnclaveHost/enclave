import importlib.util, pathlib, hashlib, json, sys
P=pathlib.Path(__file__).resolve().parent.parent
r=json.loads((P/'component-result.json').read_text())
assert r['stage']==r'C:\ProgramData\Enclave\staging\private-file-check-5e53910ee067'
assert r['created']['created']==r['stage']
assert r['validation']['build']['exited'] is True
assert r['validation']['test']['exited'] is True and r['validation']['test']['complete'] is True
assert not r['validation']['test']['timedOut']
assert hashlib.sha256((P/'native/PrivateFileCheck.cs').read_bytes()).hexdigest()=='4519c84d5ce04e6630e14f8596f4c129fefe57feaf70e911e6612fc3279c2fcf'
# Reviewed C# source creates no processes. The failed program exited; evidence
# and the owner diagnostic are retained locally before deleting dummy test files.
assert (P/'owner-replace-diagnostic.json').is_file()
T=P.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',T);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
code=r"""$s='C:\ProgramData\Enclave\staging\private-file-check-5e53910ee067';
if(Test-Path -LiteralPath $s){
 $all=@(Get-Item -LiteralPath $s)+@(Get-ChildItem -LiteralPath $s -Force -Recurse);
 if(@($all|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'reparse point: preserve stage'};
 $expected=@('PrivateFileCheck.cs','Check.exe','target.cmd','backup','backup\target.cmd');
 $actual=@(Get-ChildItem -LiteralPath $s -Force -Recurse|ForEach-Object{$_.FullName.Substring($s.Length+1)});
 if(@(Compare-Object $expected $actual).Count){throw 'unexpected contents: preserve stage'};
 if((FileSha ($s+'\PrivateFileCheck.cs')) -ne '4519c84d5ce04e6630e14f8596f4c129fefe57feaf70e911e6612fc3279c2fcf'){throw 'source changed'};
 Remove-Item -LiteralPath $s -Recurse -Force;
};@{gone=(-not(Test-Path -LiteralPath $s));scope='recorded exited dummy NTFS check only'}|ConvertTo-Json -Compress
"""
res=m.ps(code,30)
(P/'cleanup-result.json').write_text(json.dumps(res,indent=2)+'\n')
print(json.dumps(res));sys.exit(0 if res.get('gone') is True else 1)
