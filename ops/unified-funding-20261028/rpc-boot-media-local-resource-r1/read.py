from pathlib import Path
import json,subprocess,time,os,hashlib
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
def memory():return int(next(l.split()[1] for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')))//1024
def identity():
 v=subprocess.check_output(['/usr/bin/systemctl','--user','show','enclave-guestd.service','-p','MainPID','-p','InvocationID','-p','ActiveState'],text=True,timeout=3)
 d=dict(l.split('=',1)for l in v.splitlines());pid=d['MainPID'];d['startTicks']=Path('/proc/'+pid+'/stat').read_text().rsplit(')',1)[1].split()[19];d['exe']=str(Path('/proc/'+pid+'/exe').resolve());return d
with(p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'readOnly':True},f)
a=identity();before=memory();cfg=json.loads((p/'CONFIG.json').read_text());assert a['ActiveState']=='active' and a['exe']==cfg['installedGuestdExecutable']
assert hashlib.file_digest(Path(a['exe']).open('rb'),'sha256').hexdigest()==cfg['installedGuestdExecutableSha256']
x=json.loads(subprocess.check_output(['/usr/bin/node',str(p/'guestd-read.mjs')],text=True,timeout=20));after=memory();b=identity();assert a==b and x['ok'] and x['reservationsStable'] and x['after']['host']['unreadUnits']==0
available=min(before,after,x['memAvailableLowerMiB']);pending=x['pendingUpperMiB'];residual=available-pending-640
out={'at':time.time(),'identity':a,'guestd':x,'availableMiB':available,'pendingMiB':pending,'prospectiveMediaAndOuterMiB':640,'residualAfterPendingMediaMiB':residual,'operationalFloorMiB':27648,'fitsKnownEnvelope':residual>=27648,'admitted':False}
with(p/'RESULT.json').open('x')as f:json.dump(out,f,indent=2)
print(json.dumps({k:out[k]for k in ['availableMiB','pendingMiB','residualAfterPendingMediaMiB','fitsKnownEnvelope','admitted']}))
