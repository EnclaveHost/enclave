"""One GPU-free4GiB SNP boot of the exact failed image; no chain/model/pad disks."""
from pathlib import Path
import sys,os,json,subprocess,time,uuid,fcntl
m=Path(__file__).resolve().parent;sys.path.insert(0,str(m/'full-bench-prep'));import fullbench as F
locks=[]
for n in ('claude-test-queue.lock','claude-test-small-queue.lock'):
 f=(m.parents[1]/n).open('a+')
 try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:raise SystemExit(98)
 locks.append(f)
host=F.Host();guests=host.guests();need=(18+13)*F.GiB+4864*F.MiB+512*F.MiB
if F.available(host)<need:raise SystemExit('host reserve would not fit')
out=m/'efi-t1-r1';out.mkdir(exist_ok=False)
b=json.loads((m/'full-images-build-r1/BUILD.json').read_text());im=b['arms']['A']
if F.B.sha256_file(im['image'])!=im['sha256']:raise SystemExit('image drift')
rel=Path('/home/steven/enclave-prod/release-5cab66e4');release=json.loads((rel/'release.json').read_text())
for k in ('kernel','firmware.fd'):
 if F.B.sha256_file(rel/k)!=release['files'][k]['sha256']:raise SystemExit('release drift')
p={'run_id':uuid.uuid4().hex[:16]};unit='fullbench-'+p['run_id']+'-efi.service'
serial=out/'serial.log';h={'owned':{}}
a=['systemd-run','--user','--unit',unit,'--service-type=exec','-p','MemoryMax=4864M','-p','MemorySwapMax=0','-p','CPUQuota=200%','-p','TasksMax=128','-p','RuntimeMaxSec=120','-p','TimeoutStopSec=10','-p','KillMode=control-group','--','/usr/bin/qemu-system-x86_64','-machine','q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1','-object','sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on','-object','memory-backend-memfd,id=ram1,size=4096M,share=true','-cpu','host','-smp','2','-m','4096M','-bios',str(rel/'firmware.fd'),'-kernel',str(rel/'kernel'),'-initrd',im['image'],'-append',release['cmdline'],'-nodefaults','-no-user-config','-nic','none','-monitor','none','-display','none','-serial','file:'+str(serial),'-no-reboot']
r={'scope':'GPU-free boot diagnostic only; no attestation/inference result','argv':a,'image_sha256':im['sha256'],'image_bytes':Path(im['image']).stat().st_size,'samples':[]}
try:
 rec=F.start_unit(host,p,h,'guest',a,'/usr/bin/qemu-system-x86_64');r['identity']=rec
 end=time.monotonic()+100
 while time.monotonic()<end:
  F.RG.check(guests,host.guests(exclude_pid=rec['main_pid']),13*F.GiB)
  avail=F.available(host);r['samples'].append({'t':time.time(),'host_available':avail})
  if avail<need:raise RuntimeError('resource pressure')
  txt=serial.read_text(errors='replace') if serial.exists() else ''
  if 'Failed to load initrd: 0x8000000000000009' in txt:r['outcome']='same_efi_out_of_resources';break
  if 'DOM ' in txt:r['outcome']='reached_dominit';break
  if F.show(host,unit).get('ActiveState') not in ('active','activating'):r['outcome']='guest_ended';break
  time.sleep(1)
 else:r['outcome']='timeout'
except Exception as e:r['error']=repr(e)
finally:
 rec=h['owned'].get('guest');errs=F.stop_owned(host,p,rec) if rec else ['ownership unavailable']
 r['cleanup_errors']=errs;r['cleanup']='clean' if not errs else 'failed'
 (out/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n')
 for f in locks:f.close()
print(json.dumps({k:v for k,v in r.items() if k not in ('argv','samples')},indent=2))
