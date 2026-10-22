import subprocess,base64,json
from pathlib import Path
script=r'''$ErrorActionPreference='Stop'; $z='C:\ProgramData\Enclave\activation-stage\lease-final-f7b36d56.zip'; $s='C:\ProgramData\Enclave\activation-stage\lease-final-f7b36d56'; if ((Get-FileHash -LiteralPath $z -Algorithm SHA256).Hash.ToLower() -ne 'f7b36d564fd96f07801e1230227e071ad11f0bbe268837128dd4796d205ad063') {throw 'archive mismatch'}; if (Test-Path -LiteralPath $s) {throw 'stage already exists; inspect before retry'}; Expand-Archive -LiteralPath $z -DestinationPath $s; [pscustomobject]@{stage=$s;archiveHash='f7b36d564fd96f07801e1230227e071ad11f0bbe268837128dd4796d205ad063';activated=$false} | ConvertTo-Json -Compress'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=45)
print(r.stdout);assert r.returncode==0,r.stderr
Path('outputs/app-lease-gas-review/windows-final-remote-staging.json').write_text(r.stdout)
