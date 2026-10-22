from pathlib import Path
import subprocess,base64,json,datetime,time,urllib.request,signal
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');report_path=root/'outputs/checker-migration.json'
report=json.loads(report_path.read_text());opts=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
origins=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188']
addresses={o.split('//')[1].split(':')[0] for o in origins}
def ps(s):
 r=subprocess.run(['ssh',*opts,'minipc-zt','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True,text=True,timeout=35)
 if r.returncode:raise RuntimeError('Windows check failed; raw output withheld')
 return json.loads(r.stdout)
def nan(s):return subprocess.check_output(['ssh',*opts,'nan','bash','-s'],input=s,text=True,timeout=35)
def save():report_path.write_text(json.dumps(report,indent=2)+'\n')
def state():
 result=ps(r'''$ErrorActionPreference='Stop';$p='C:\ProgramData\Enclave\network-checker\live-verdicts.json';$raw='[]';if(Test-Path $p){$raw=[IO.File]::ReadAllText($p)};[pscustomobject]@{taskState=[int](Get-ScheduledTask -TaskPath '\Enclave\' -TaskName NetworkChecker).State;verdictsText=$raw;processCount=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'network-checker[\\/]checker\.mjs'}).Count}|ConvertTo-Json -Compress''')
 result['verdicts']=json.loads(result.pop('verdictsText'))
 assert isinstance(result['verdicts'],list)
 return result
def stop_target():
 ps(r'''$ErrorActionPreference='Stop';Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName NetworkChecker;Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName NetworkChecker|Out-Null;Get-CimInstance Win32_Process|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'network-checker[\\/](checker|run-checker)\.mjs'}|ForEach-Object {Stop-Process -Id $_.ProcessId -Force};'true' ''')
def interrupted(*args):raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
stopped=False;started=time.monotonic()
try:
 # The shadow round passed all nine checks; never overlap holders of this identity.
 preflight=json.loads((root/'outputs/checker-windows-preflight.json').read_text())
 assert all(all(p['checks'].values()) for p in preflight['repeat']['providers'])
 with urllib.request.urlopen(origins[0]+'/v1/network/providers',timeout=15) as r:prior=json.load(r)
 coverage=[]
 for e in prior['providers']:
  q=max(e['qualifications'],key=lambda q:q['qualification']['issuedAt'])['qualification']
  assert all(q['checks'].values()) and q['expiresAt']-time.time()*1000>420000,'insufficient healthy handoff coverage'
  coverage.append(q)
 assert len(coverage)==4
 old=nan('systemctl show enclave-network-checker --property=ExecStart --property=ActiveState')
 assert '/opt/enclave-network-checker/current/wg-qualify.mjs' in old and 'ActiveState=active' in old
 stopped=True
 result=nan('set -eu\nsystemctl stop enclave-network-checker\nsystemctl disable enclave-network-checker\nsystemctl show enclave-network-checker --property=MainPID --property=ActiveState --property=UnitFileState')
 assert 'MainPID=0' in result and 'ActiveState=inactive' in result and 'UnitFileState=disabled' in result
 floor=int(time.time()*1000)
 report.update(status='verifying',nanCheckerStopped=True,nanStoppedAtMs=floor,nanSystemd=result.strip(),previousHealthyCoverage=coverage,probeIdentityHandoff='serialized; provider replaces concurrent probes signed by the same checker')
 report.pop('error',None);save()
 ps("$ErrorActionPreference='Stop';Enable-ScheduledTask -TaskPath '\\Enclave\\' -TaskName NetworkChecker|Out-Null;Start-ScheduledTask -TaskPath '\\Enclave\\' -TaskName NetworkChecker;'true'".replace('\\\\','\\'))
 print('Nan checker stopped and disabled; Windows checker started without overlapping probes',flush=True)
 while time.monotonic()-started<360:
  current=state();verdicts=current.get('verdicts') or []
  if not verdicts or min(v['qualification']['issuedAt'] for v in verdicts)<=floor:
   time.sleep(15);continue
  assert {v['qualification']['address'] for v in verdicts}==addresses,'unexpected provider set'
  if not all(all(v['qualification']['checks'].values()) for v in verdicts):raise RuntimeError('replacement full round failed qualification checks')
  assert current['taskState']==4 and current['processCount']==1,'replacement process unavailable'
  for origin in origins:
   with urllib.request.urlopen(origin+'/v1/network/providers',timeout=15) as r:live=json.load(r)
   by_address={e['record']['record']['address']:e for e in live['providers']}
   for v in verdicts:
    assert any(q['qualification']==v['qualification'] and q['signature']==v['signature'] for q in by_address[v['qualification']['address']]['qualifications']),'directory does not hold replacement verdict'
  with urllib.request.urlopen('https://7ae476a3.app.enclave.host/api/status',timeout=20) as r:guest=json.load(r)
  assert guest['state']=='ready' and guest['files']==1239 and not guest.get('missing') and not guest.get('error')
  report.update(status='complete',verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),freshRound=[v['qualification'] for v in verdicts],verifiedDirectories=origins,guest={k:guest[k] for k in ['state','files','rootCid']},scope='Existing Enclave checker moved off Nan; checker trust and administration remain unchanged, not an independent quorum.')
  save();print('Fresh post-Nan verdicts verified on all four directories; adapter ready',flush=True);break
 else:raise RuntimeError('checker cutover verification timed out')
except BaseException as e:
 stop_target()
 if stopped:nan('set -eu\nsystemctl enable --now enclave-network-checker\nsystemctl is-active enclave-network-checker')
 report.update(status='rolled back',nanCheckerStopped=False,error=str(e),rollbackAt=datetime.datetime.now(datetime.timezone.utc).isoformat());save();raise
