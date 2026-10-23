import pathlib,importlib.util,json
s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps("$v=Get-VM -Name 'enclave-control';@{name=$v.Name;state=$v.State.ToString();addresses=@((Get-VMNetworkAdapter -VMName 'enclave-control').IPAddresses);checkpoints=@(Get-VMSnapshot -VMName 'enclave-control'|Select-Object Name,CreationTime)}|ConvertTo-Json -Depth 4 -Compress",25)
pathlib.Path('work/coupled-cpu-enforcement-20261023/root-validation/control-address.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
