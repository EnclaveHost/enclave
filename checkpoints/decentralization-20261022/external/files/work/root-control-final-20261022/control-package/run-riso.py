from pathlib import Path
import importlib.util,json,hashlib,base64
P=Path(__file__).resolve().parent
r=P/'tools/riso-probe.py';assert hashlib.sha256(r.read_bytes()).hexdigest()=='7364c6436ed40dfb06d3947d0b40ad065c660c2ebdf49de5f89e332526dac9cd'
s=importlib.util.spec_from_file_location('riso',r);mod=importlib.util.module_from_spec(s);s.loader.exec_module(mod)
s=importlib.util.spec_from_file_location('transport',mod.T[0]);t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
head=mod.head();mod.LIMIT=7600
ids=json.loads((P/'helper/runs/preflight-20261022T022125Z.json').read_text())['coverage']['expectedIds']
texts=mod.texts(ids,{},head);out={'expectedIds':ids,'manager':None,'apps':[]}
for i,code in enumerate(texts):
 ps=code  # The read-only script is parsed by Windows PowerShell before execution.
 assert len(base64.b64encode((head.replace('SECS','60')+ps).encode('utf-16-le')))<7900
 result=t.ps(ps,60)
 if 'error' in result:raise RuntimeError(result)
 if i==0:out['manager']=result
 else:out['apps'].append(result)
 (P/'riso-read.json').write_text(json.dumps(out,indent=2)+'\n')
 print('read batch',i,flush=True)
v=mod.evaluate(out,{});(P/'riso-evaluation.json').write_text(json.dumps(v,indent=2)+'\n');print(json.dumps(v))
