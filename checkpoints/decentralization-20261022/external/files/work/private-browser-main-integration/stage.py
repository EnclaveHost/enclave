from pathlib import Path
import json,hashlib,stat,shutil,subprocess,datetime
W=Path('/home/steven/Documents/Codex/2026-10-18/wo');M=W/'work/enclave';D=W/'work/private-browser-main-integration';S=D/'staged';B=D/'before';C=W/'work/private-browser-final-release/tree'
patches=[(W/'work/private-browser-final-release/frozen-prior/private-browser-access.patch','ca97f7266c93abd14c3fcba30177370ddf328c9e32598ec7309e5efbbc531a3c'),(W/'work/private-browser-final-release/deliver/live-edit-acceptance.patch','46e4506081a228275965e57fe47472949db386c9262a63905e96dc01a8e2e2f3')]
def state(p):return {'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':oct(stat.S_IMODE(p.stat().st_mode))} if p.exists() else {'absent':True}
assert not S.exists();S.mkdir();paths=[]
for p,h in patches:
 assert hashlib.sha256(p.read_bytes()).hexdigest()==h
 for l in subprocess.check_output(['git','apply','--numstat',str(p)],text=True).splitlines():
  n=l.split('\t')[-1];assert '..' not in Path(n).parts and not Path(n).is_absolute()
  if n not in paths:paths.append(n)
rows=[]
for n in paths:
 rows.append({'path':n,'before':state(M/n)})
 if (M/n).exists():
  for root in [S,B]:(root/n).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(M/n,root/n)
for p,h in patches:
 subprocess.run(['git','apply','--check',str(p)],cwd=S,check=True)
 subprocess.run(['git','apply',str(p)],cwd=S,check=True)
for r in rows:
 r['staged']=state(S/r['path']);r['worker']=state(C/r['path'])
d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'staged; root relay-only supervisor difference pending review','paths':rows,'mainModified':False,'patches':[{'path':str(p),'sha256':h} for p,h in patches]};(D/'inventory.json').write_text(json.dumps(d,indent=2)+'\n')
print('Staged',len(rows),'paths. Differences from tested worker:',[r['path'] for r in rows if r['staged']!=r['worker']])
