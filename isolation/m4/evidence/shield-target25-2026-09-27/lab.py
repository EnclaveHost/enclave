from pathlib import Path
import subprocess,json,sys,shutil,os
w=Path(__file__).resolve().parent;r=Path('/home/steven/Projects/enclave-v100-isolation')
label=sys.argv[1];release=Path(sys.argv[2]).resolve();out=w/label;out.mkdir(exist_ok=True)
import hashlib
rid=hashlib.sha256((release/'release.json').read_bytes()).hexdigest()
unit=f'target25-{label}-manager'
cmd=['systemd-run','--user','--unit='+unit,'--collect','--property=LimitMEMLOCK=infinity','--setenv=GUESTD_ENABLE=1','--setenv=PATH=/home/steven/.local/bin:/usr/local/bin:/usr/bin:/bin', '/home/steven/enclave-prod/bin/guestd.ffb5b3e8', '-isolation','/home/steven/enclave-prod/iso-160ef357/isolation','-root',str(out/'manager'),'-listen','127.0.0.1:8097','-data-listen','127.0.0.1:8098','-auth-key','/home/steven/enclave-prod/guestd-pair.key','-guest-mem-mib','65536','-guest-cpus','24','-instance-prefix','tt','-guest-host-floor-mib','16384','-release','-ticket-port','19444','-egress-port','19443','-isolation-release','@/home/steven/enclave-prod/release-85948b98/release.json','-cpu-template','/home/steven/enclave-prod/release-85948b98/template','-shield-template',str(release/'template'),'-shield-release',rid,'-shield-model-file','/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q4-vl-gguf/Qwen3.8-27B-UD-Q4_K_XL.gguf','-shield-shm-dir','/dev/shm/enclave-shield-v100']
subprocess.run(cmd,check=True)
status=(w.parent/'rollout-affinity/manager-status.mjs').read_text();(out/'manager-status.mjs').write_text(status)
create="""import{openGuestdTransport}from'/home/steven/Projects/enclave-v100-isolation/isolation/m4/guestd/supervisor-transport.mjs';const t=openGuestdTransport({url:'http://127.0.0.1:8097',keyFile:'/home/steven/enclave-prod/guestd-pair.key'});const r=await t.request('POST','/vms',{image:'file:///home/steven/enclave-bench/v100-shield-20260927/target25/probe.bundle',name:'target25-canary',gpuShare:.5});console.log(JSON.stringify(r));if(r.status>=300)process.exit(1);"""
for _ in range(20):
 p=subprocess.run(['node',str(out/'manager-status.mjs')],capture_output=True)
 if p.returncode==0:break
 import time;time.sleep(.5)
with (out/'create.json').open('w') as f:subprocess.run(['node','--input-type=module','-e',create],stdout=f,check=True)
s=(w.parent/'rollout-affinity/run-series.py').read_text().replace("'affinity27-canary'","'target25-canary'").replace("str(w.parent/'27b/client.mjs')","'/home/steven/enclave-bench/v100-shield-20260927/27b/client.mjs'").replace("str(w/'release/template/rt/runtime.json')",repr(str(release/'template/rt/runtime.json')))
(out/'run-series.py').write_text(s)
with (out/'bench.log').open('w') as f:subprocess.run(['python3','-u',str(out/'run-series.py')],stdout=f,stderr=subprocess.STDOUT,check=True)
