from pathlib import Path
import json,subprocess,time,os
cfg=CONFIG
p=Path
assert p('/proc/sys/kernel/random/boot_id').read_text().strip()==cfg['bootId']
mem=int(next(x.split()[1] for x in p('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
groups={}
for name,cap in cfg['serviceCapsMiB'].items():
 q=p('/sys/fs/cgroup/system.slice')/name;v={k:(q/k).read_text().strip() for k in ('memory.current','memory.max','memory.swap.max')};assert v['memory.max']==str(cap<<20);groups[name]=v
jobs=subprocess.check_output(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager'],text=True,timeout=3)
assert not jobs.strip()
processes=[]
for q in p('/proc').iterdir():
 if not q.name.isdigit():continue
 try:processes.append({'pid':int(q.name),'exe':str((q/'exe').resolve(strict=True)),'cgroup':(q/'cgroup').read_text().strip()})
 except FileNotFoundError:pass
 assert len(processes)<=512
remain=mem-sum(max(0,int(v['memory.max'])-int(v['memory.current'])) for v in groups.values())-(256<<20)
print(json.dumps({'at':time.time(),'boot':cfg['bootId'],'availableBytes':mem,'groups':groups,'processes':processes,'jobs':jobs,'residualAfter256MiBTrialAndFullServiceGrowth':remain,'aboveOperational1536MiB':remain>=1536<<20,'readOnly':True}))
