from pathlib import Path
import ast,contextlib,tempfile,json,time,os,subprocess
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-el-r9-direct-source-r3');r=Path(__file__).resolve().parent
passed=[]
node=next(n for n in ast.parse((p/'source/client-operations.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='clean_trial')
for alive in (True,False):
 with tempfile.TemporaryDirectory(dir=r) as td:
  root=Path(td);events=[];unit='test.service';info={'InvocationID':'a'*32}
  def saved(x):
   events.append('mandatory-death')
   if alive:raise AssertionError('exit-main-still-alive')
  def optional(x):events.append('receipt');raise FileNotFoundError('missing fixture receipt')
  state={'clients':{'el':info},'clientLaunchIntents':{'el':{}},'deviceNumber':'1:2'}
  g={'time':time,'fcntl':__import__('fcntl'),'LOCK':root/'lock','DONE':root/'done','state':lambda:state,'stop_request':lambda _:None,
     'UNITS':{'el':unit},'M':{'identities':{'el':{'name':'fixture'}}},'PAYLOAD':root,'owned_info':lambda *a:{'LoadState':'loaded','InvocationID':'a'*32},
     'cmd':lambda label,*a,**k:events.append(label),'dead':lambda *a:{'LoadState':'not-found'},'saved_client_dead':saved,'retained_exit_receipt':optional,
     'detach':lambda *a:events.append('detach'),'NBD_UNIT':'nbd.service','SLICE':'fixture.slice','P':lambda *a:root/'absent',
     'atomic_json':lambda path,value:path.write_text(json.dumps(value))}
  exec(compile(ast.Module(body=[node],type_ignores=[]),'clean-trial-orchestration','exec'),g)
  result=g['clean_trial']('fixture')
  if alive:assert not result['ok'] and 'detach' not in events and 'receipt' not in events;passed.append('live PID prevents detach despite missing receipt')
  else:assert result['ok'] and events.index('mandatory-death')<events.index('receipt')<events.index('detach') and result['exitEvidenceErrors'];passed.append('confirmed death permits cleanup but records missing receipt')
(r/'ORCHESTRATION.json').write_text(json.dumps({'passed':passed,'native':False})+'\n')
for script in ['assemble.py','check-runtime.py']:
 with (r/(script+'.log')).open('x') as f:
  x=subprocess.run(['/usr/bin/python3','-B',str(p/script)],stdout=f,stderr=subprocess.STDOUT,timeout=45)
 (r/(script+'.result.json')).write_text(json.dumps({'rc':x.returncode})+'\n')
 if x.returncode:raise SystemExit(x.returncode)
