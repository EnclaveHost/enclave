# Preparation only: complete lexical import aliases without executing product code.
from pathlib import Path
import json,hashlib,shutil,re,posixpath
p=Path(__file__).resolve().parent
S=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');U=S.parent/'unified-funding-20261028'
B=U/'installed-manager-http-baseline-r1/control'
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
read=lambda n:json.loads((p/n).read_text())
write=lambda n,v:(p/n).write_text(json.dumps(v,indent=2)+'\n')
seed=read('seed-pins.json');pins=read('input-pins.json');prov=read('seed-provenance.json');closure=read('dependency-closure.json')
pattern=re.compile(r'''(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']''')
q=list(seed);seen=set();missing=[];added=[]
while q:
 rel=q.pop(0)
 if rel in seen:continue
 seen.add(rel);f=p/'seed'/rel
 if f.suffix not in {'.js','.mjs','.ts','.sol'}:continue
 for name in pattern.findall(f.read_text()):
  if not name.startswith('.'):continue
  dest=posixpath.normpath(str(Path(rel).parent/name))
  if not dest.startswith('enclave/'):missing.append({'source':rel,'import':name,'reason':'outside tree'});continue
  options=[dest]
  if dest.endswith('.js'):options.append(dest[:-3]+'.ts')
  if any((p/'seed'/x).is_file() for x in options):continue
  chosen=None
  for x in options:
   s=S/str(Path(x).relative_to('enclave'))
   if s.is_file():chosen=(x,s);break
  if chosen is None:
   for x in options:
    s=B/str(Path(x).relative_to('enclave'))
    if s.is_file():chosen=(x,s);break
  if chosen is None:missing.append({'source':rel,'import':name,'reason':'missing source/generated runtime dependency'});continue
  x,src=chosen;resolved=src.resolve(strict=True)
  for tree in ['seed','candidate']:
   d=p/tree/x;d.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(resolved,d)
  seed[x]=sha(resolved);pins[str(resolved)]=sha(resolved);pins[str(p/'seed'/x)]=sha(resolved)
  prov['origins'][x]={'path':str(resolved),'declaredPath':str(src),'sha256':sha(resolved),'note':'Lexical import path preserved; source symlink resolved to regular copied bytes, or installed-manager baseline for missing source.'}
  added.append(x);q.append(x)
closure['lexicalAliasAdditions']=added;closure['staticMissing']=missing;closure['staticSourceFiles']=len(seed)
write('dependency-closure.json',closure);write('seed-pins.json',dict(sorted(seed.items())));write('seed-provenance.json',prov);write('input-pins.json',dict(sorted(pins.items())))
prep=read('PREPARED.json');prep['seedEntries']=len(seed);prep['readonlyInputPins']=len(pins)
prep['hashes']={str(f.relative_to(p)):sha(f) for f in p.iterdir() if f.is_file() and f.name not in ['PREPARED.json','preparation-audit.json']}
for f in (p/'overlay-diffs').rglob('*'):
 if f.is_file():prep['hashes'][str(f.relative_to(p))]=sha(f)
write('PREPARED.json',prep)
actual={str(f.relative_to(p/'candidate')):sha(f) for f in (p/'candidate').rglob('*') if f.is_file()};drift=[n for n,h in pins.items() if not Path(n).is_file() or sha(n)!=h]
assert actual==seed and not drift
old=read('preparation-audit.json');old.update({'seedEntries':len(seed),'readonlyPins':len(pins),'readonlyDrift':drift,'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'runnerSha256':sha(p/'run.py'),'lexicalAliasAdditions':added,'staticMissing':missing});write('preparation-audit.json',old)
print(json.dumps(old,indent=2))
