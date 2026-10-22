import subprocess,base64
from pathlib import Path
script=r'''$ErrorActionPreference='Stop'; $s='C:\ProgramData\Enclave\activation-stage\hardening-fb926d42'; foreach($p in Get-ChildItem -LiteralPath $s -Filter '*.ps1') {$tokens=$null;$parseErrors=$null;[Management.Automation.Language.Parser]::ParseFile($p.FullName,[ref]$tokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){$parseErrors|ForEach-Object{Write-Output ($p.Name+': '+$_.Message)};throw 'PowerShell syntax refused'}}; Write-Output 'PowerShell parser: all scripts accepted'; & powershell -NoProfile -ExecutionPolicy Bypass -File "$s\00-verify-stage.ps1"; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; & powershell -NoProfile -ExecutionPolicy Bypass -File "$s\10-preflight.ps1"; exit $LASTEXITCODE'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=120)
Path('outputs/app-lease-gas-review/windows-hardening-preflight.txt').write_text(r.stdout+'\n'+r.stderr)
print(r.stdout);print(r.stderr);raise SystemExit(r.returncode)
