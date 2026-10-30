from pathlib import Path
import json,subprocess,hashlib,sys,os
m=Path(__file__).resolve().parent
sys.path.insert(0,str(m/'full-bench-prep'))
import fullbench as F
subprocess.run([sys.executable,str(m/'full-bench-prep/client-timeout/derive_client.py'),'verify','--manifest',str(m/'client-timeout-build-r1/derivation-manifest.json')],check=True)
out=m/'full-smoke-fw-r5'
g=json.loads((m/'ROOT-GUESTD-PROBE-INPUT.json').read_text());g['probe_sha256']=F.B.sha256_file(g['probe'])
r=subprocess.run([sys.executable,str(m/'root-read-commitments.py')],capture_output=True,text=True,timeout=30)
if r.returncode:raise SystemExit('fresh commitments probe failed')
g['snapshot']=F.check_snapshot(json.loads((m/'ROOT-LIVE-COMMITMENTS.json').read_text()))
others=[]
for unit,budget in [('enclave-metal.service',4864),('enclave-custodian-v2.service',3840)]:
 x=F.show(F.Host(),unit)
 if x.get('ActiveState')!='active':raise SystemExit('production unit not active')
 others.append({'name':unit,'cgroup':x['ControlGroup'],'budget_mib':budget})
cards={}
for uuid,pid in [('GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c',5685),('GPU-042eb279-e6e6-9866-5823-015b8d26946a',5683)]:
 allowed=[]
 for p,mib in [(pid,5000),(355837,64)]:
  start=F.Host().pid_start(p)
  if start is None:raise SystemExit('GPU process identity absent')
  allowed.append({'pid':p,'start':start,'required':True,'used_mib_max':mib})
 cards[uuid]={'allowed':allowed,'unlisted_mib_max':128}
res={'kind':'fullbench-reservations/1','guestd':g,'memory':{'other_units':others,'helper_cap_mib':512,'extra_headroom_mib':1024},'gpu':{'context_headroom_mib':1024,'cards':cards}}
rp=m/'ROOT-FULL-RESERVATIONS.json';rp.write_text(json.dumps(res,indent=2)+'\n')
w=json.loads((m/'full-bench-prep/workload.json').read_text());w['note']='Startup/attestation/8-token smoke only, not pressure or throughput qualification';w['rounds']=1;w['steps']=w['steps'][:1];w['steps'][0]['query']['steps']=8
wp=m/'full-smoke-workload.json';wp.write_text(json.dumps(w,indent=2)+'\n')
b=json.loads((m/'full-images-build-r1/BUILD.json').read_text())
if set(b['arms'])!={'A','B','A1'}:raise SystemExit('images incomplete')
worker='/home/steven/enclave-prod/v100-shield-9e5190078/shielded-worker'
(m/'full-smoke-banks').mkdir(exist_ok=True)
a=['plan','--out',str(out),'--qemu','/usr/bin/qemu-system-x86_64','--worker',worker,'--worker-sha256',F.B.sha256_file(worker),'--client',str(m/'client-timeout-build-r1/client-bench-timeout.mjs'),'--fwd',str(m/'full-tools-build-r1/fwd'),'--node','/usr/bin/node','--vcek','/home/steven/.cache/enclave-isolation/m3-clean/vcek.der','--min-tcb','/home/steven/.cache/enclave-isolation/m3-clean/min-tcb.json','--amd-chain','Turin=/home/steven/enclave-prod/iso-sdshield-1c3cdbb8/test/fixtures/amd/Turin-cert_chain.pem','--app-sha',b['app_sha256'],'--allowed-cpus','8-15,24-31','--bank-dir',str(m/'full-smoke-banks'),'--bank-gib','64','--guest-mib','57344','--worker-memory-max-mib','1024','--vram-gb','16','--reservations',str(rp),'--workload',str(wp),'--order','B']
for u in cards:a+=['--gpu-uuid',u]
pred=json.loads((m/'full-firmware-predictions-r1.json').read_text())
a+=['--experimental-firmware',pred['firmware'],'--experimental-firmware-sha256',pred['firmware_sha256']]
for arm,v in pred['arms'].items():a+=['--image',arm+'='+v['image'],'--measurement',arm+'='+v['measurement']]
rc=F.main(a)
if rc:raise SystemExit(rc)
p=out/'plan.json';plan=json.loads(p.read_text())
if plan['plan_time_problems']:raise SystemExit('plan preflight failed: '+str(plan['plan_time_problems']))
# Bound this smoke, then approve these exact bytes after root review.
plan['runtime_max_sec']=1200;plan['arm_wall_max_sec']=1260;plan['total_wall_max_sec']=1260*len(plan['arms'])
p=out/'bounded-plan.json'
F.write_new(str(p),(json.dumps(plan,indent=2,sort_keys=True)+'\n').encode())
print('Reviewed-plan SHA256:',F.B.sha256_file(str(p)))
