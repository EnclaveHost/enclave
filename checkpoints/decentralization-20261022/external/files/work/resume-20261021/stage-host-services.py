import pathlib,json,hashlib,tarfile,subprocess,base64,datetime
P=pathlib.Path(__file__).resolve().parent;archive=P.parent/'hosted-services-activation/final-r3/out/enclave-host-services-hs2-windows.tar';pin='d0218596f243ca3480f1c76438f5821d8630008fcef156a86b5e369cbcad8c54'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==pin
with tarfile.open(archive) as tf:
 members=tf.getmembers()
 for m in members:
  path=pathlib.PurePosixPath(m.name);assert not path.is_absolute() and '..' not in path.parts and (m.isdir() or m.isfile()) and path.parts[0]=='enclave-host-services-hs2-windows',m.name
 stage=P.parent/'hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows'
 for line in (stage/'STAGE-SHA256SUMS').read_text().splitlines():
  h,path=line.split('  ',1);assert hashlib.sha256((stage/path).read_bytes()).hexdigest()==h,path

def ps(script,timeout=55):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('SSH '+str(r.returncode)+' '+r.stderr[:1500]+' '+r.stdout[-1500:])
 return r.stdout
folder=r'C:\ProgramData\Enclave\staging\host-services-hs2-20261021-r3'
pre=ps(r'''$ErrorActionPreference='Stop';$d='''+"'"+folder+"'"+r''';if(Test-Path -LiteralPath $d){throw 'Stage exists; reconcile instead of overwriting'};$os=Get-CimInstance Win32_OperatingSystem;$free=[math]::Floor($os.FreePhysicalMemory/1024);if($free -lt 17920){throw "Insufficient free RAM $free MiB"};$n='C:\Program Files\nodejs\node.exe';if(!(Test-Path -LiteralPath $n)){throw 'Node path absent'};foreach($p in 'C:\Program Files\Enclave\host-services\hs2','C:\ProgramData\Enclave\host-services\hs2'){if(Test-Path -LiteralPath $p){throw 'Production install already exists; reconcile'}};if(Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue){throw 'Target task exists'};$ports=@(18188,18189,18153,18154,18190);$used=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ports -contains $_.LocalPort});$udp=@(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object {$ports -contains $_.LocalPort});if($used.Count -or $udp.Count){throw 'Target port already in use'};New-Item -ItemType Directory -Path $d | Out-Null;@{freeMiB=[int]$free;directory=[string]$d;node=[string]$n;preflight='PASS'}|ConvertTo-Json -Compress''')
(P/'host-services-stage-preflight.txt').write_text(pre);print(pre.strip(),flush=True)
remote=folder.replace('\\','/')+'/package.tar'
subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=15',str(archive),'minipc:'+remote],check=True,timeout=60)
script=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$d='''+"'"+folder+"'"+r''';$a=Join-Path $d 'package.tar';if((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash.ToLower() -ne '''+"'"+pin+"'"+r'''){throw 'Archive hash mismatch'};& tar.exe -xf $a -C $d;if($LASTEXITCODE -ne 0){throw 'Extract failed'};$s=Join-Path $d 'enclave-host-services-hs2-windows';Set-Location -LiteralPath $s;Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force;& .\windows\capture-public-inputs.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' *> (Join-Path $d 'capture-public.log');if($LASTEXITCODE -ne 0){throw 'Public capture tool refused'};Write-Output ([IO.File]::ReadAllText((Join-Path $d 'capture-public.log')));Write-Output 'STAGED_ONLY_NO_INSTALL_OR_START' '''
# Explicitly bounded remote watchdog: only holds and terminates this exact session process handle.
watch=r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(120000)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
try:result=ps(watch+script+r'''} finally {if(!$watcher.HasExited){$watcher.Kill()}}''',timeout=135)
except Exception as e:
 (P/'host-services-stage-error.txt').write_text(str(e));raise
(P/'host-services-public-capture.txt').write_text(result);print(result[-10000:]);(P/'host-services-stage-result.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'STAGED_PUBLIC_CAPTURE_COMPLETE','directory':folder,'archiveSha256':pin,'installed':False,'started':False},indent=2)+'\n')
