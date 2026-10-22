from pathlib import Path
import base64,datetime,hashlib,json,subprocess,time,urllib.request
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
bundle=root/'outputs/network-authority-release/privacy-agent.mjs'
sha=hashlib.sha256(bundle.read_bytes()).hexdigest()
pins=json.loads((root/'outputs/network-authority-release/authority-pins.json').read_text())
opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
def ps(s):
 r=subprocess.run(['ssh',*opts,'minipc-zt','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True,text=True,timeout=45)
 if r.returncode:raise RuntimeError('Windows command failed; captured output withheld')
 return json.loads(r.stdout)
common=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$stage='C:\ProgramData\Enclave\nan-retirement';$agent='C:\Program Files\Enclave\network\privacy-agent.mjs';$config='C:\ProgramData\Enclave\network\privacy-config.json';'''
probe=common+r'''$c=Get-Content $config -Raw|ConvertFrom-Json;$s=Get-Content 'C:\ProgramData\Enclave\network\state\status.json' -Raw|ConvertFrom-Json;[pscustomobject]@{updatedAt=$s.updatedAt;apps=@($s.apps).Count;ready=@($s.apps|Where-Object {$_.ready}).Count;fallback=@($s.apps|Where-Object {$_.fallbackActive}).Count;hash=(Get-FileHash $agent).Hash;pins=$c.chain.authorityPins;directories=$c.enclaveNetwork.directories;processes=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'network\\privacy-agent\.mjs'}|Select-Object ProcessId,CreationDate)}|ConvertTo-Json -Depth 6'''
before=ps(probe)
assert before['apps']==before['ready']==10 and before['fallback']==0
assert before['hash'].lower()=='4ee3264a0ed7a2647c7d83611ed5e4033edcda1678ad79b02824892839f9f192'
subprocess.run(['scp','-q',*opts,str(bundle),'minipc-zt:C:/ProgramData/Enclave/nan-retirement/privacy-agent-pinned-8b37c37.mjs'],check=True,timeout=60)
restart=r'''Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'network\\privacy-agent\.mjs'}|ForEach-Object {Stop-Process -Id $_.ProcessId -Force};Start-ScheduledTask -TaskPath '\Enclave\' -TaskName Network;'''
install=common+r'''if ((Get-FileHash "$stage\privacy-agent-pinned-8b37c37.mjs").Hash.ToLower() -ne 'SHA') {throw 'hash mismatch'};if ((Test-Path "$stage\privacy-agent.before-pins.mjs") -or (Test-Path "$stage\privacy-config.before-pins.json")) {throw 'backup exists'};Copy-Item $agent "$stage\privacy-agent.before-pins.mjs";Copy-Item $config "$stage\privacy-config.before-pins.json";$c=Get-Content $config -Raw|ConvertFrom-Json;$pins='PINS'|ConvertFrom-Json;if ($c.enclaveNetwork.registry -and $c.enclaveNetwork.registry.ToLower() -ne $pins.registry) {throw 'registry conflict'};$c.chain|Add-Member -NotePropertyName authorityPins -NotePropertyValue $pins -Force;[IO.File]::WriteAllText($config+'.pins-tmp',($c|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false));Copy-Item "$stage\privacy-agent-pinned-8b37c37.mjs" $agent -Force;Move-Item ($config+'.pins-tmp') $config -Force;'''
install=install.replace('SHA',sha).replace('PINS',json.dumps(pins,separators=(',',':')))+restart+"'true'"
started=time.monotonic();attempts=[]
try:
 ps(install)
 print('Windows privacy agent installed; verifying circuit recovery',flush=True)
 for i in range(30):
  try:
   after=ps(probe)
   assert after['hash'].lower()==sha and after['pins']==pins
   assert after['updatedAt']!=before['updatedAt'] and after['processes']!=before['processes']
   assert after['apps']==after['ready']==10 and after['fallback']==0
   assert after['directories']==before['directories']
   with urllib.request.urlopen('https://7ae476a3.app.enclave.host/api/status',timeout=20) as r:guest=json.load(r)
   assert guest['state']=='ready' and guest['files']==1239 and not guest.get('missing')
   break
  except Exception as e:
   attempts.append({'seconds':round(time.monotonic()-started,1),'error':str(e)[:180]});time.sleep(5)
 else:raise RuntimeError('Windows privacy agent failed recovery gates')
 result={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release':'8b37c37','before':before,'after':after,'secondsToValidation':round(time.monotonic()-started,1),'transientFailures':attempts,'guest':{k:guest[k] for k in ['state','files','rootCid']},'scope':'Network authority pins only; node wallet admission and legacy relay paths are not activated or removed.'}
 (root/'outputs/windows-network-pins-rollout.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result),flush=True)
except Exception:
 ps(common+r'''if ((Test-Path "$stage\privacy-agent.before-pins.mjs") -and (Test-Path "$stage\privacy-config.before-pins.json")) {Copy-Item "$stage\privacy-agent.before-pins.mjs" $agent -Force;Copy-Item "$stage\privacy-config.before-pins.json" $config -Force;'''+restart+'''};'true' ''')
 raise
