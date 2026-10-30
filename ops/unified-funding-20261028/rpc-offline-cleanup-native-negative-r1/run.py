from pathlib import Path
import os,sys,json,hashlib,tempfile,time
p=Path(__file__).resolve().parent
pins=json.loads((p/'INPUT-PINS.json').read_text())
def sha(f):
 with open(f,'rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
def verify():
 for f,h in pins.items():assert sha(f)==h,f
verify();assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'fresh disposable raw image startup-failure cleanup only'},f)
source=p.parent/'rpc-offline-cleanup-root-repaired-r1/candidate'
sys.path.insert(0,str(source));import offline_mask as om
root=Path('/vm/enclave-volumes/rpc-production-maint')
assert root.is_dir() and not root.is_symlink()
assert os.statvfs(root).f_bavail*os.statvfs(root).f_frsize>301*(1<<30)
t=Path(tempfile.mkdtemp(prefix='synthetic-export-negative-',dir=root));os.chmod(t,0o700)
raw=t/'fresh.raw'
with raw.open('xb') as f:f.truncate(1<<20)
before=sha(raw);mnt=t/'mount';mnt.mkdir();exposed=mnt/'raw'
(p/'TEMP.json').write_text(json.dumps({'path':str(t),'syntheticOnly':True}))
fx=om.OsEffects();registered=[];rejected=None
try:
 fx.export_start(['/usr/bin/nbdfuse','-r',str(exposed),'[','/usr/bin/qemu-nbd','-r','-f','raw',str(raw),']'],str(mnt),str(exposed),raw.stat().st_size+512,5,65536,registered.append,'/usr/bin/fusermount3')
except om.Refusal as e:rejected=str(e)
assert rejected and 'appeared with size' in rejected,rejected
assert len(registered)==1
h=registered[0];closed=h.get('closed')
assert closed and closed['result']=='complete' and closed['drainerJoined'] and not closed['survivors'],closed
assert not om._mounted(str(mnt)) and not Path('/proc/'+str(h['pid'])).exists()
assert sha(raw)==before
verify()
result={'case':'mounted_wrong_size','refusal':rejected,'teardown':closed,'mountGone':True,'leaderGone':True,'fixtureUnchanged':True,'syntheticOnly':True,'productionQualified':False}
(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
