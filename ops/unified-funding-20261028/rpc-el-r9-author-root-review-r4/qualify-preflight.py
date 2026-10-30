from pathlib import Path
import importlib.util,tempfile,os,json,subprocess
p=Path('/home/steven/Documents/Codex/2026-10-23/it/work/rpc-el-r9-sourceonly-author-prep-20261030-r4');r=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('gate',p/'queue_binding.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
passes=[]
with tempfile.TemporaryDirectory(dir=r) as td:
 m.P=Path(td);m.CG=Path(td)/'cg';m.CG.mkdir();q=m.CG/'unit';q.mkdir()
 for n,v in {'memory.max':str(128<<20),'memory.swap.max':'0','cpu.max':'100000 100000'}.items():(q/n).write_text(v)
 m.resources('/unit',True,128);passes.append('finite quota with absent cpuset accepted')
 for name,value,expected in [('cpu.max','max 100000','quota'),('memory.max','1','memory')]:
  f=q/name;old=f.read_text();f.write_text(value)
  try:m.resources('/unit',True,128)
  except SystemExit:passes.append(expected+' rejected')
  else:raise AssertionError(expected)
  f.write_text(old)
 old=m.os.sched_getaffinity;m.os.sched_getaffinity=lambda pid:{0,1}
 try:
  try:m.resources('/unit',True,128)
  except SystemExit:passes.append('wrong affinity rejected')
  else:raise AssertionError('affinity')
 finally:m.os.sched_getaffinity=old
 assert any(m.P.glob('launcher-failure-*.json'))
 for f in m.P.glob('launcher-failure-*.json'):assert f.stat().st_size<=16384 and f.stat().st_mode&0o777==0o600
 passes.append('bounded private failure evidence')
 m.task_affinities([m.proc(os.getpid())[0]]);passes.append('actual own task identity and CPU1 affinity')
(r/'QUALIFICATION.json').write_text(json.dumps({'passed':passes})+'\n')
with (r/'PREFLIGHT.log').open('x') as f:
 x=subprocess.run(['/usr/bin/python3','-B',str(p/'root-preflight.py'),'03d574cdf21725227c6854cf55daf5e2f01157964aaeafbf39c0bf95de18fc00'],stdout=f,stderr=subprocess.STDOUT,timeout=45)
(r/'PREFLIGHT-RESULT.json').write_text(json.dumps({'rc':x.returncode})+'\n')
raise SystemExit(x.returncode)
