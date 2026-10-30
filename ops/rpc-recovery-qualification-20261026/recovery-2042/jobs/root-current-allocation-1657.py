import hashlib,json,os,subprocess,time
from pathlib import Path
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025');B=Path('/home/steven/Documents/Codex/2026-10-26/my');image=B/'work/tr004-readonly/enclave-rpc-production/base-origin.qcow2';view=B/'work/tr004/base-view/nbd';out=P/'logs/base-journal-copy-1626/current-allocation.json';tool=P/'extent-recovery-stage/r5/runs/run-20261026T203604Z-2321914/ext4-extent-overlap'
assert (P/'logs/root-extent-overlap-tests-1653.rc').read_text().strip()=='0'
assert hashlib.sha256(tool.read_bytes()).hexdigest()=='61d110416c9779c71c4b57edd7dd993bd6031ca202de12871422756d6c3e6520'
assert 'ro' in subprocess.check_output(['findmnt','-rn','-T',str(image),'-o','OPTIONS'],text=True).strip().split(',')
assert Path('/proc/2253798/fd/10').resolve()==image
info=Path('/proc/2253798/fdinfo/10').read_text();flags=int(next(x.split()[1] for x in info.splitlines() if x.startswith('flags:')),8);assert flags & os.O_ACCMODE==os.O_RDONLY
before=image.stat();start=time.time()
r=subprocess.run(['python3','-I','-B',str(P/'extent-recovery-stage/r5/src/overlap.py'),'--tool',str(tool),'--candidate',str(P/'logs/base-journal-copy-1626/candidate-extent-coverage.json'),'--device',str(view),'--crosscheck','--timeout','300','--out',str(out)],timeout=320)
after=image.stat();unchanged=all(getattr(before,k)==getattr(after,k) for k in ('st_size','st_ino','st_mtime_ns','st_ctime_ns'));record={'readOnly':True,'sourceUnchanged':unchanged,'rc':r.returncode,'seconds':time.time()-start};(out.parent/'current-allocation-run.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));assert unchanged and r.returncode==0
x=json.loads(out.read_text());print(json.dumps({'summary':x['summary'],'complete':x['complete'],'firstOverlaps':x['overlaps'][:3]},indent=2))
