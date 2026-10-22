import subprocess,base64,sys,re,json,datetime
from pathlib import Path
step=sys.argv[1]; extra=sys.argv[2:]
assert re.fullmatch(r"(?:00-verify-stage|10-preflight|12-prepare-relay-dir|14-relay-migration-check|15-install-relay|20-activate|30-verify|90-rollback|95-rollback-relay)",step)
assert all(x in ['-Reviewed','-AfterRelay'] for x in extra)
stage=r'C:\ProgramData\Enclave\activation-stage\local-relay-20261021'
script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '"+stage+"\\"+step+".ps1' "+' '.join(extra)+"; exit $LASTEXITCODE"
enc=base64.b64encode(script.encode('utf-16le')).decode()
start=datetime.datetime.now(datetime.timezone.utc).isoformat(); stamp=start.replace(':','').replace('+','_')
log=Path('work/windows-local-relay-root-activation')/(step+'-'+stamp+'.out')
with log.open('xb') as f:
 p=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',enc],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for line in p.stdout:
  f.write(line);f.flush();sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
 rc=p.wait()
record={'step':step,'arguments':extra,'startedAt':start,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':rc,'log':str(log)}
Path(str(log)+'.json').write_text(json.dumps(record,indent=2)+'\n')
raise SystemExit(rc)
