from pathlib import Path
import os,json
p=Path(__file__).resolve().parent
a=[];pid=os.getpid()
for _ in range(12):
 d=Path('/proc')/str(pid);s=(d/'stat').read_text().rsplit(')',1)[1].split();cg=(d/'cgroup').read_text().strip()[3:];q=Path('/sys/fs/cgroup')/cg.lstrip('/')
 a.append({'pid':pid,'ppid':int(s[1]),'startTicks':s[19],'exe':str((d/'exe').resolve()),'cgroup':cg,'affinity':sorted(os.sched_getaffinity(pid)),'memoryMax':(q/'memory.max').read_text().strip(),'swapMax':(q/'memory.swap.max').read_text().strip(),'cpuMax':(q/'cpu.max').read_text().strip()})
 if cg.endswith('enclave-rpc-author-queue-topology-r1-20261030.service'):break
 pid=int(s[1])
 if pid<=1:raise RuntimeError('outer service absent')
else:raise RuntimeError('ancestor bound')
(p/'RESULT.json').write_text(json.dumps(a,indent=2)+'\n')
print(json.dumps(a))
