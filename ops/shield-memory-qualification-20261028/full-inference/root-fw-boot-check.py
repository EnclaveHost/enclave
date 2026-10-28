"""Bounded GPU-free firmware qualification; fresh canary only, no production writes."""
from pathlib import Path
import sys,os,json,subprocess,time,uuid,fcntl,hashlib,argparse
m=Path(__file__).resolve().parent;sys.path.insert(0,str(m/'full-bench-prep'));import fullbench as F
ap=argparse.ArgumentParser();ap.add_argument('--target',choices=['candidate-release','candidate-debug'],required=True);ap.add_argument('--case',choices=['control4','control8','notable','substitution'],required=True);ap.add_argument('--execute',action='store_true');ap.add_argument('--test-qemu',action='store_true');ap.add_argument('--attempt',choices=['r1','r2'],default='r1');args=ap.parse_args()
def sha(p):return F.B.sha256_file(str(p))
build=json.loads((m/'fwbuild-candidate-r1'/(args.target+'.json')).read_text());fw=Path(build['firmware'])
if sha(fw)!=build['sha256']:raise SystemExit('firmware drift')
rel=Path('/home/steven/enclave-prod/release-5cab66e4');release=json.loads((rel/'release.json').read_text())
if sha(rel/'kernel')!=release['files']['kernel']['sha256']:raise SystemExit('kernel drift')
b=json.loads((m/'full-images-build-r1/BUILD.json').read_text());im=b['arms']['A']
if sha(im['image'])!=im['sha256']:raise SystemExit('image drift')
q=Path('/usr/bin/qemu-system-x86_64');override=None
if args.case=='substitution' or args.test_qemu:
 q=Path('/home/steven/.cache/enclave-isolation/parallel-vmsa-qemu-hashtest/build/qemu-system-x86_64')
 if args.case=='substitution':
  override=Path('/home/steven/.cache/enclave-isolation/parallel-review-m4b/measinit-probe0.cpio.gz')
  if not override.is_file() or sha(override)==im['sha256']:raise SystemExit('substitution must differ')
 # This binary has only the reviewed test-only initrd-hash override; never used for production.
 source=q.parents[1]
 if subprocess.check_output(['git','--no-optional-locks','-C',str(source),'rev-parse','HEAD'],text=True).strip()!='6635f07208f2b660256fedf58af543063709d0f0':
  raise SystemExit('test QEMU revision drift')
 if subprocess.check_output(['git','--no-optional-locks','-C',str(source),'status','--porcelain'],text=True).strip():raise SystemExit('test QEMU source dirty')
guest=8192 if args.case=='control8' else 4096;cap=guest+2048
spec={'target':args.target,'case':args.case,'firmware_sha256':build['sha256'],'image_sha256':im['sha256'],'qemu':str(q),'qemu_sha256':sha(q),'guest_mib':guest,'cap_mib':cap,'no_gpu':True,'no_disks':True,'no_network':True,'override_sha256':sha(override) if override else None}
print(json.dumps(spec),flush=True)
if not args.execute:raise SystemExit(0)
locks=[]
for n in ('claude-test-queue.lock','claude-test-small-queue.lock'):
 f=(m.parents[1]/n).open('a+')
 try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:raise SystemExit(98)
 locks.append(f)
host=F.Host();guests=host.guests();floor=(18+13)*F.GiB+512*F.MiB
if F.available(host)<floor+cap*F.MiB:raise SystemExit('host reserve would not fit')
out=m/('fw-boot-'+args.target+'-'+args.case+('-testqemu' if args.test_qemu else '')+'-'+args.attempt);out.mkdir(exist_ok=False)
p={'run_id':uuid.uuid4().hex[:16]};unit='fullbench-'+p['run_id']+'-fw.service';serial=out/'serial.log';debug=out/'debug.log';h={'owned':{}}
a=['systemd-run','--user','--unit',unit,'--service-type=exec','-p',f'MemoryMax={cap}M','-p','MemorySwapMax=0','-p','CPUQuota=200%','-p','TasksMax=128','-p','RuntimeMaxSec=120','-p','TimeoutStopSec=10','-p','KillMode=control-group']
if args.case=='substitution' or args.test_qemu:
 compat=m/'test-qemu-compat'
 if sha(compat/'libnfs.so.16.2.0')!='d46de35eb68e1fe261df832f4e7ac1fd3c356c47a9b371585a676e1683ca10d3':raise SystemExit('test-only compatibility library drift')
 a+=['--setenv=LD_LIBRARY_PATH='+str(compat)]
if override:a+=['--setenv=ENCLAVE_TEST_HASH_INITRD='+str(override)]
a+=['--',str(q),'-machine','q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1','-object','sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes='+('off' if args.case=='notable' else 'on'),'-object',f'memory-backend-memfd,id=ram1,size={guest}M,share=true','-cpu','host','-smp','2','-m',f'{guest}M','-bios',str(fw),'-kernel',str(rel/'kernel'),'-initrd',im['image'],'-append',release['cmdline'],'-nodefaults','-no-user-config','-nic','none','-monitor','none','-display','none','-serial','file:'+str(serial),'-debugcon','file:'+str(debug),'-global','isa-debugcon.iobase=0x402','-no-reboot']
r={'scope':'GPU-free boot/rejection qualification; not inference or independently verified attestation','spec':spec,'argv':a,'samples':[],'outcome':'not_started'}
try:
 rec=F.start_unit(host,p,h,'guest',a,str(q));r['identity']=rec
 end=time.monotonic()+100
 while time.monotonic()<end:
  F.RG.check(guests,host.guests(exclude_pid=rec['main_pid']),13*F.GiB)
  avail=F.available(host);r['samples'].append({'t':time.time(),'host_available':avail})
  if avail<floor:raise RuntimeError('resource pressure')
  txt=serial.read_text(errors='replace') if serial.exists() else '';dbg=debug.read_text(errors='replace') if debug.exists() else ''
  if 'DOM ' in txt:r['outcome']='reached_dominit';break
  if 'Failed to load initrd: 0x8000000000000009' in txt:r['outcome']='efi_out_of_resources';break
  expected='Hash comparison failed for "initrd"' if args.case=='substitution' else 'no hashes table'
  if args.case in ('substitution','notable') and expected in dbg:
   r['outcome']='explicit_verifier_refusal';break
  if F.show(host,unit).get('ActiveState') not in ('active','activating'):r['outcome']='guest_ended';break
  time.sleep(1)
 else:r['outcome']='timeout'
except Exception as e:r['error']=repr(e)
finally:
 rec=h['owned'].get('guest');errs=F.stop_owned(host,p,rec) if rec else ['ownership unavailable']
 r['cleanup_errors']=errs;r['cleanup']='clean' if not errs else 'failed'
 j=subprocess.run(['journalctl','--user','-u',unit,'--no-pager','-o','cat','-n','80'],text=True,capture_output=True,timeout=5);(out/'unit.log').write_text(j.stdout+j.stderr)
 txt=serial.read_text(errors='replace') if serial.exists() else '';dbg=debug.read_text(errors='replace') if debug.exists() else ''
 r['kernel_entered']='DOM ' in txt or 'Linux version' in txt
 r['fallback']='Grub Bootloader' in txt or 'Failed to find any grub configuration' in txt
 r['substitution_active']='TEST: hashing initrd substitute' in j.stdout
 r['verifier_success']={s:('Hash comparison succeeded for "'+s+'"') in dbg for s in ['kernel','initrd','cmdline']}
 r['accepted']=r['cleanup']=='clean' and 'error' not in r and (r['outcome']=='reached_dominit' if args.case.startswith('control') else not r['kernel_entered'] and (r['outcome']=='explicit_verifier_refusal' if args.target.endswith('debug') else r['fallback']))
 if args.case.startswith('control') and args.target.endswith('debug'):
  r['accepted']=r['accepted'] and all(r['verifier_success'].values()) and 'not found in table' not in dbg
 if args.case in ('notable','substitution'):
  r['accepted']=r['accepted'] and 'EFI stub:' not in txt
 if args.case=='substitution':r['accepted']=r['accepted'] and r['substitution_active']
 (out/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n')
 for f in locks:f.close()
print(json.dumps({k:v for k,v in r.items() if k not in ('argv','samples')},indent=2))
raise SystemExit(0 if r['accepted'] else 1)
