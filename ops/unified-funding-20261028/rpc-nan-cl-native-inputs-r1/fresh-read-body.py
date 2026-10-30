from pathlib import Path
import json,hashlib,time,os
P=Path
sha=lambda p:hashlib.file_digest(P(p).open('rb'),'sha256').hexdigest()
assert os.geteuid()==0
out={'at':time.time(),'readOnly':True,'boot':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'processes':[],'scheduleFiles':[],'scheduleDirectories':[],'errors':[]}
assert out['boot']=='4b84b9bd-a89d-4b37-94cb-26334dbf4666'
start=time.monotonic();count=0
for q in P('/proc').iterdir():
 if not q.name.isdigit():continue
 count+=1;assert count<=512 and time.monotonic()-start<5
 try:
  exe=str((q/'exe').resolve(strict=True));st=(q/'stat').read_text();ticks=st[st.rfind(')')+2:].split()[19]
  out['processes'].append({'pid':int(q.name),'start':ticks,'exe':exe,'cgroup':(q/'cgroup').read_text().strip(),'cmdlineSha256':hashlib.sha256((q/'cmdline').read_bytes()).hexdigest()})
 except FileNotFoundError:continue
creator=next(x for x in out['processes'] if x['pid']==1281392)
assert creator['start']=='867080689' and creator['exe']=='/usr/bin/bash' and creator['cmdlineSha256']=='8a016019ad176a0fcc7113d7117b64a69fdde83a4f54ffc33dc2017f147ea65f'
assert str(P('/proc/1281392/cwd').resolve(strict=True))=='/root/padspill-20261005'
for name in ('/etc/cron.d','/etc/cron.hourly','/etc/cron.daily','/etc/cron.weekly','/etc/cron.monthly','/var/spool/cron/crontabs'):
 q=P(name);entries=[]
 with os.scandir(q) as it:
  for entry in it:
   assert len(entries)<128
   st=entry.stat(follow_symlinks=False);assert entry.is_file(follow_symlinks=False) and st.st_size<=65536
   entries.append(entry.name);out['scheduleFiles'].append({'path':entry.path,'sha256':sha(entry.path)})
 out['scheduleDirectories'].append({'path':name,'entries':sorted(entries)})
out['scheduleFiles'].append({'path':'/etc/crontab','sha256':sha('/etc/crontab')})
for label,argv in [('atQueue',['/usr/bin/atq']),('jobs',['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager']),('timers',['/usr/bin/systemctl','list-timers','--all','--no-legend','--no-pager']),('memory',['/usr/bin/cat','/proc/meminfo']),('listeners',['/usr/bin/ss','-lntup'])]:
 r=capture(argv,5,limit=16384);out[label]=r;assert r['rc']==0 and not r['reason'] and not r['truncated'],label
assert not out['atQueue']['stdout'].strip()
out['creatorClassification']='two-launches-before-wait-no-repeated-allocator';print(json.dumps(out))
