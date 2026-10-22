import json,hashlib,subprocess,re,posixpath,datetime,os
from pathlib import Path
repo=Path('work/enclave');old=json.loads(Path('work/windows-final-source-inventory.json').read_text())
files={i['path'] for group in old['commitSet'].values() for i in group}
files.update(['windows/vbslike/manager/backend.mjs','cli/host.ps1','windows/installer/build-bundle.ps1','windows/installer/stage-bundle.sh','docs/network/independent-shield-image.md','test/windows-native/bundle-provenance.ps1'])
pat=re.compile(r'''(?:import\s+[^"'`;]*?from\s*|export\s+[^"'`;]*?from\s*|import\s*\(\s*|import\s*)["'`](\.{1,2}/[^"'`]+)["'`]''')
seen=set();todo=list(old['entries']);missing=[];dirty=[]
while todo:
 f=todo.pop()
 if f in seen:continue
 seen.add(f);p=repo/f
 if not p.is_file():missing.append(f);continue
 if p.suffix not in ['.mjs','.js','.cjs']:continue
 for rel in pat.findall(p.read_text()):
  if '${' not in rel:todo.append(posixpath.normpath(posixpath.join(posixpath.dirname(f),rel)))
for f in sorted(seen-files):
 p=repo/f
 if not p.exists():continue
 r=subprocess.run(['git','-C',str(repo),'show','HEAD:'+f],capture_output=True)
 content=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
 if r.returncode or r.stdout!=content:dirty.append(f)
head=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
d={'format':'enclave-windows-source-closure/2','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'files':[{'path':f,'sha256':hashlib.sha256((repo/f).read_bytes()).hexdigest()} for f in sorted(files)],'importCount':len(seen),'missing':missing,'dirtyDependenciesOutsideSet':dirty}
Path('work/windows-coordinator-source-closure.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps({k:v for k,v in d.items() if k!='files'},indent=2));print('source files',len(files))
