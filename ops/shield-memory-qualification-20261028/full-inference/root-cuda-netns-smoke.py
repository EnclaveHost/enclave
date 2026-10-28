"""Owned idle CUDA context test; no guest, model, tensor request, or production mutation."""
from pathlib import Path
import subprocess, json, os, time, uuid, hashlib
m=Path(__file__).resolve().parent
out=m/'cuda-netns-smoke-r1';out.mkdir(exist_ok=False)
binary='/home/steven/enclave-prod/v100-shield-9e5190078/shielded-worker'
cards=['GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c','GPU-042eb279-e6e6-9866-5823-015b8d26946a']
def run(a):return subprocess.run(a,text=True,capture_output=True,timeout=15)
def show(u):return dict(x.split('=',1) for x in run(['systemctl','--user','show',u,'-p','LoadState,ActiveState,InvocationID,MainPID,ControlGroup']).stdout.splitlines() if '=' in x)
def start(pid):
 try:return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
 except FileNotFoundError:return None
prod={p:start(p) for p in (5683,5685,3817658,3967858,3970560)}
if not all(prod.values()):raise SystemExit('Production identity absent; replan')
r={'scope':'CUDA initialization and listening inside PrivateNetwork only; no model or inference qualification','worker_sha256':hashlib.sha256(Path(binary).read_bytes()).hexdigest(),'arms':[]}
try:
 for i,card in enumerate(cards):
  avail=int(next(l.split()[1] for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')))*1024
  if avail<20*(1<<30) or any(start(p)!=s for p,s in prod.items()):raise RuntimeError('resource/production identity changed')
  unit='shield-netns-smoke-'+uuid.uuid4().hex[:12]+'.service'
  ring=Path('/dev/shm')/(unit+'.ring')
  if show(unit).get('LoadState')!='not-found':raise RuntimeError('unit already exists')
  fd=os.open(ring,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.ftruncate(fd,64<<20);os.close(fd)
  rec={'card':card,'unit':unit};r['arms'].append(rec)
  owned=None;pid=None;pid_start=None
  try:
   z=run(['systemd-run','--user','--unit',unit,'--service-type=exec','-p','PrivateNetwork=yes','-p','MemoryMax=512M','-p','MemorySwapMax=0','-p','CPUQuota=100%','-p','RuntimeMaxSec=30','-p','TimeoutStopSec=5','-p','KillMode=control-group','--setenv=CUDA_VISIBLE_DEVICES='+card,'--',binary,'--host','127.0.0.1','--port',str(19621+i),'--vsock-port','0','--vram-gb','16','--shm',str(ring)])
   owned=show(unit);pid=int(owned.get('MainPID','0'));pid_start=start(pid)
   if z.returncode or not pid or not pid_start or not owned.get('InvocationID'):raise RuntimeError('start did not establish identity')
   time.sleep(3)
   cur=show(unit)
   log=run(['journalctl','--user','-u',unit,'--no-pager','-o','cat']).stdout
   (out/f'worker-{i}.log').write_text(log)
   gpu=run(['nvidia-smi','--query-compute-apps=gpu_uuid,pid,used_memory','--format=csv,noheader,nounits'])
   rec['cuda_pid_observed']=any(card in l and f', {pid},' in l for l in gpu.stdout.splitlines())
   rec['listening']='listening on 127.0.0.1:'+str(19621+i) in log
   rec['private_network']=run(['systemctl','--user','show',unit,'-p','PrivateNetwork','--value']).stdout.strip()=='yes'
   rec['ok']=cur.get('ActiveState')=='active' and cur.get('InvocationID')==owned['InvocationID'] and rec['listening'] and rec['private_network'] and rec['cuda_pid_observed']
  finally:
   cur=show(unit)
   if owned and cur.get('InvocationID')==owned.get('InvocationID'):run(['systemctl','--user','stop',unit])
   after=show(unit)
   gone=after.get('LoadState')=='not-found' or (after.get('ActiveState') in ('inactive','failed') and (not pid_start or start(pid)!=pid_start))
   cg=(owned or {}).get('ControlGroup')
   if cg:
    cp=Path('/sys/fs/cgroup'+cg)/'cgroup.procs'
    gone=gone and (not cp.exists() or not cp.read_text().strip())
   rec['cleanup_gone']=gone
   if gone:ring.unlink()
   if not gone:raise RuntimeError('owned worker cleanup unproven; ring retained')
  if not rec.get('ok'):raise RuntimeError('CUDA network namespace smoke failed')
 r['production_identities_unchanged']=all(start(p)==s for p,s in prod.items())
 r['ok']=r['production_identities_unchanged'] and all(a.get('ok') and a['cleanup_gone'] for a in r['arms'])
finally:
 (out/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r,indent=2))
