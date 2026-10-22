from pathlib import Path
import subprocess,base64,json,datetime
base=Path(__file__).resolve().parent;root=base.parents[1]
for i in range(1,26):
 j=json.loads((root/f'work/lease-enrollment-signing/journals/op-{i:02d}.json').read_text());assert j['status']=='confirmed' and j['planSha256']=='6e1b0bfb10a0d502921215e0624885406a0f2805e45bc2d4934a8d9e63e609f2'
for h in ['us-west','eu-central']:
 p=root/'work/lease-relay-activation/caddy'/(h+'-apply.jsonl');d=json.loads(p.read_text().splitlines()[-1]);assert d['outcome']=='verified-active' and d['public']['ok'] and d['public']['tlsVerified']
# Root runs this once; an uncertain outcome is inspected, never automatically retried.
record=base/'activation-start.json';assert not record.exists(),'activation already attempted; inspect status before any retry'
record.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'C:\\ProgramData\\Enclave\\activation-stage\\lease-final-f7b36d56','fundingConfirmed':25,'relaysVerified':['us-west','eu-central'],'status':'requested; outcome pending'},indent=2)+'\n')
script=r'''$ProgressPreference='SilentlyContinue'; & powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ProgramData\Enclave\activation-stage\lease-final-f7b36d56\20-activate.ps1' -RelaysChecked; exit $LASTEXITCODE'''
with (base/'activation.out').open('w') as out:
 proc=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],stdout=out,stderr=subprocess.STDOUT)
 rc=proc.wait()
(base/'activation-exit.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':rc,'rule':'0 observed; 3 unobserved inspect status; any other error inspect before retry'},indent=2)+'\n')
print('Windows activation exit',rc);raise SystemExit(rc)
