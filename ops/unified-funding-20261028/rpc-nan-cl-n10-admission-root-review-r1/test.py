from pathlib import Path
import ast,json,hashlib,sys,types,tempfile,copy,contextlib,io
p=Path('/home/steven/Documents/Codex/2026-10-23/it/work/rpc-nan-cl-n10-admission-prep-20261030');root=Path(__file__).resolve().parent;u=root.parent
sys.path.insert(0,str(p));import binding
pins=json.loads((p/'PREPARED-PINS.json').read_text());assert all(binding.digest(p/n)==h for n,h in pins.items())
b,real_runtime,m=binding.checked_binding()
for n in p.glob('*.py'):ast.parse(n.read_text(),filename=str(n))
obs=json.loads((u/'rpc-nan-cl-n9-admission-r2/FRESH-OBSERVATION.json').read_text())
passed=[]
for case in ['valid','unauthorized','el-not-clean','wrong-pins','wrong-observation','stale','short-horizon','template-refused','partial-output']:
 with tempfile.TemporaryDirectory(prefix='fixture-',dir=root) as td:
  tmp=Path(td);runtime=tmp/'runtime';runtime.mkdir();(runtime/'run-body.py').write_bytes((real_runtime/'run-body.py').read_bytes())
  observation=copy.deepcopy(obs);binding.write_exclusive(tmp/'FRESH-OBSERVATION.json',observation)
  review=json.loads((p/'ROOT-REVIEW-TEMPLATE.json').read_text());creator=next(v for v in obs['processes'] if v['pid']==1281392)
  review.update(authorized=True,elTrialTerminalAndClean=True,observationSha256=binding.digest(tmp/'FRESH-OBSERVATION.json'),observedPendingMiB=0,creatorCmdlineSha256=creator['cmdlineSha256'],existingOtherProcesses=[f"{creator['pid']}:{creator['start']}:{creator['exe']}"],scheduleAndTimersReviewedThroughAt=obs['at']+2500,rootReview='Synthetic loader fixture only; no current authority or remote work.')
  now=obs['at']+1
  if case=='unauthorized':review['authorized']=False
  if case=='el-not-clean':review['elTrialTerminalAndClean']=False
  if case=='wrong-pins':review['runtimePinsSha256']='0'*64
  if case=='wrong-observation':review['observationSha256']='0'*64
  if case=='stale':now=obs['at']+91
  if case=='short-horizon':review['scheduleAndTimersReviewedThroughAt']=obs['at']+2499
  rpath=tmp/('ROOT-REVIEW-TEMPLATE.json' if case=='template-refused' else 'ROOT-REVIEW.json');binding.write_exclusive(rpath,review)
  if case=='partial-output':(runtime/'FRESH-OBSERVATION.json').write_text('sentinel')
  g={'__name__':'loader_fixture'};exec(compile((p/'load-admission.py').read_text(),'actual-loader-fixture','exec'),g)
  g.update(HERE=tmp,checked_binding=lambda:(b,runtime,copy.deepcopy(m)),sys=types.SimpleNamespace(argv=['loader',str(rpath)]),time=types.SimpleNamespace(time=lambda:now))
  caught=None
  try:
   with contextlib.redirect_stdout(io.StringIO()):g['main']()
  except AssertionError as e:caught=str(e)
  if case=='valid':
   assert caught is None,caught
   a=json.loads((runtime/'ROOT-ADMISSION.json').read_text());assert a['admission']['at']==obs['at'] and a['admission']['expiresAt']==obs['at']+2100
   assert a['admissionSha256']==hashlib.sha256(json.dumps(a['admission'],sort_keys=True).encode()).hexdigest()
   assert (tmp/'ROOT-ADMISSION-PREFLIGHT.json').exists()
  else:
   assert caught is not None,case
   assert not (runtime/'ROOT-ADMISSION.json').exists(),case
   if case=='partial-output':assert (runtime/'FRESH-OBSERVATION.json').read_text()=='sentinel'
  passed.append({'case':case,'passed':True,'rejection':caught})
assert all(binding.digest(p/n)==h for n,h in pins.items());binding.checked_binding()
assert not any((real_runtime/n).exists() for n in ['ATTEMPT.json','ROOT-ADMISSION.json','FRESH-OBSERVATION.json'])
(root/'RESULT.json').write_text(json.dumps({'passed':passed,'sourceUnchanged':True,'actualRuntimeUnadmitted':True,'syntheticTimeAndObservation':True,'nativeExecuted':False},indent=2)+'\n')
print('9 loader cases PASS; no current authority or native execution')
