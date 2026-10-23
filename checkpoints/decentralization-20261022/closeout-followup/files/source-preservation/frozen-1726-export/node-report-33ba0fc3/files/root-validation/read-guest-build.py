"""Read only public guest-image and launcher pins needed to prepare the CPU canary."""
import importlib.util,json,pathlib
s=importlib.util.spec_from_file_location('helper','work/nucbox-tls-20261021/root-activate-reviewed.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=r'''$keys=@('ENCLAVE_BOOT_FORM','ENCLAVE_GUEST_IGVM','ENCLAVE_GUEST_IGVM_SHA256','ENCLAVE_GUEST_STATE_MASTER','ENCLAVE_GUEST_STATE_MASTER_SHA256','ENCLAVE_GUEST_STATE_ARCHIVE_DIR','ENCLAVE_HYPERV_MODULE','ENCLAVE_WMISERVE','ENCLAVE_UEFI_BOOT_MEDIUM','ENCLAVE_UEFI_BOOT_MEDIUM_SHA256','NODE_VCPUS');$rows=@(foreach($file in @('shield-config.cmd','node-config.cmd','node-config.local.cmd')){$path=Join-Path 'C:\ProgramData\Enclave' $file;if(Test-Path -LiteralPath $path){foreach($line in Get-Content -LiteralPath $path){if($line -match '^\s*set\s+"?([^=]+)=(.*)$' -and $keys -contains $Matches[1]){[ordered]@{file=$file;key=$Matches[1];value=$Matches[2].TrimEnd('"')}}}}});@{at=(Get-Date).ToUniversalTime().ToString('o');settings=$rows}|ConvertTo-Json -Depth 4 -Compress'''
r=m.ps(p,30)
pathlib.Path('work/coupled-resource-shares-20261023/root-validation/guest-build.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
