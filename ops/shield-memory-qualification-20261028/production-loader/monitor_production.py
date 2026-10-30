from pathlib import Path
import json,time,datetime,os
out=Path(__file__).parent/'production-memory-samples.jsonl'
root=Path('/home/steven/enclave-prod/guestd-root')
end=time.monotonic()+900
with out.open('x') as f:
 while time.monotonic()<end:
  rows=[]
  for rec in root.glob('gd*/instance.json'):
   try:
    r=json.loads(rec.read_text())
    if r.get('Name')!='0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c':continue
    unit=r['Unit'];unit=unit if unit.endswith('.service') else unit+'.service'
    cg=Path('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice')/unit
    row={k:r.get(k) for k in ['ID','Name','Measurement','Releases','MemMiB','Vcpus','Verdict']}
    for name in ['memory.current','memory.peak','memory.max','memory.events']:
     try:row[name]=(cg/name).read_text().strip()
     except FileNotFoundError:pass
    rows.append(row)
   except (ValueError,OSError,KeyError):continue
  mem=next(l for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
  f.write(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'memAvailableKiB':int(mem.split()[1]),'guests':rows})+'\n');f.flush();time.sleep(2)
