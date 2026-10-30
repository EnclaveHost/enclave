from pathlib import Path
import subprocess,json,base64,time,sys,os,selectors
p=Path(__file__).resolve().parent;cfg=json.loads((p/'CONFIG.json').read_text());mode=sys.argv[1];assert mode in ('observe','test');assert os.sched_getaffinity(0)=={1}
with(p/(mode+'-ATTEMPT.json')).open('x')as f:json.dump({'at':time.time(),'mode':mode},f)
script=('CONFIG='+repr(cfg)+'\n'+(p/'observe.py').read_text()) if mode=='observe' else (p/'test-remote.py').read_text()
unit='enclave-owned-guest-pure-'+mode+'-r2-20261030'
cmd='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit='+unit+' --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=AllowedCPUs=1 --property=RuntimeMaxSec=20 '
if mode=='test':cmd+='--property=DynamicUser=yes --property=PrivateNetwork=yes --property=PrivateTmp=yes --property=ProtectSystem=strict --property=ProtectHome=yes --property=NoNewPrivileges=yes '
cmd+='/usr/bin/python3 -B -'
argv=['/usr/bin/ssh','-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc','-oHostKeyAlias=[127.0.0.1]:32423','-oUserKnownHostsFile='+cfg['knownHosts'],cfg['target'],cmd]
r=subprocess.run(argv,input=script,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
assert len(r.stdout.encode())<=131072 and len(r.stderr.encode())<=16384
out={'rc':r.returncode,'at':time.time(),'stdout':r.stdout,'stderr':r.stderr,'unit':unit}
with(p/(mode+'-RESULT.json')).open('x')as f:json.dump(out,f,indent=2)
print(json.dumps({'mode':mode,'rc':r.returncode}));raise SystemExit(r.returncode)
