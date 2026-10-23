import pathlib,importlib.util,json
s=importlib.util.spec_from_file_location('h','work/nucbox-tls-20261021/root-activate-reviewed.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
r=h.ps("$p='C:\\Program Files\\Enclave\\network\\admitted-shield-policy.json';$j=Get-Content $p -Raw|ConvertFrom-Json;@{hash=(FileSha $p);cpu=$j.cpu;witness=$j.witness}|ConvertTo-Json -Depth 6 -Compress",25);pathlib.Path('work/cpu-quota-activation-20261023/policy-fields.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
