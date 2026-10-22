from pathlib import Path
import subprocess
out=Path('work/windows-native-hardening-fixed-review');root=Path('work/enclave');remote='C:\\Users\\claude\\AppData\\Local\\Temp\\enclave-native-hardening-fixed-20261020'
for f in ['windows/installer/EnclaveSetup.cs','windows/tray/TrayTheme.cs','cli/host.ps1','windows/installer/install-host.ps1','windows/installer/update-host.ps1']:
 p=subprocess.run(['scp','-q','-o','BatchMode=yes',str(root/f),'minipc:'+remote.replace('\\','/')+'/'+Path(f).name],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stderr
cmd="& 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe' /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll '/out:"+remote+"\\EnclaveSetup-check.exe' '"+remote+"\\EnclaveSetup.cs' '"+remote+"\\TrayTheme.cs'; exit $LASTEXITCODE"
p=subprocess.run(['ssh','-o','BatchMode=yes','minipc',cmd],capture_output=True,text=True,errors='replace',timeout=60);(out/'setup-compile.log').write_text(p.stdout+p.stderr);print('Full installer compile:',p.returncode,p.stdout,flush=True)
cmd="$base='"+remote+"'; foreach($f in @('host.ps1','install-host.ps1','update-host.ps1')) { $t=$null; $e=$null; $a=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $base $f),[ref]$t,[ref]$e); Write-Output ($f+': '+$e.Count+' parse errors'); foreach($err in $e) { Write-Output $err.Message } }"
p=subprocess.run(['ssh','-o','BatchMode=yes','minipc',cmd],capture_output=True,text=True,errors='replace',timeout=30);(out/'powershell-parse.log').write_text(p.stdout+p.stderr);print(p.stdout,flush=True)
