"""Read only the configured launcher path, expected digest, and actual binary digest."""
import importlib.util,json,pathlib
s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=r'''$cfg=@{};foreach($line in Get-Content -LiteralPath 'C:\ProgramData\Enclave\shield-config.cmd'){if($line -match '^\s*set\s+"?(ENCLAVE_WMISERVE_EXE|ENCLAVE_WMISERVE_EXE_SHA256)=(.*)$'){$cfg[$Matches[1]]=$Matches[2].TrimEnd('"')}};$path=$cfg.ENCLAVE_WMISERVE_EXE;if(-not $path){throw 'Launcher path missing'};$f=Get-Item -LiteralPath $path;@{at=(Get-Date).ToUniversalTime().ToString('o');path=$path;expected=$cfg.ENCLAVE_WMISERVE_EXE_SHA256;actual=(FileSha $path);bytes=$f.Length}|ConvertTo-Json -Compress'''
r=m.ps(p,30)
pathlib.Path('work/coupled-cpu-enforcement-20261023/root-validation/launcher-pin.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
