# Preparation only. Copies source/evidence and hashes; no author/auth/tests/builds/product execution.
from pathlib import Path
import hashlib,json,shutil,re,posixpath,subprocess
p=Path(__file__).resolve().parent;D=p.parent/'wallet-owned-session-create-r1-20261029';A=D/'author-delivery';S=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');U=S.parent/'unified-funding-20261028';N=U/'wallet-owned-create-root-tests-r1';P=p.parent/'wallet-owned-session-product-compile-r1-20261029';F=p.parent/'wallet-owned-session-foundry-r1-20261029'
assert not (p/'seed').exists(),'prepare once'
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def put(n,j):(p/n).write_text(json.dumps(j,indent=2)+'\n')
frozen=json.loads((D/'author-delivery-manifest.json').read_text());pins={};origins={}
assert len(frozen)==202
for rel,h in frozen.items():
 src=A/rel;assert sha(src)==h;origins[rel]=src;pins[str(src)]=h
shutil.copytree(A,p/'seed')
# Add actual constructors/packaging and real SDK source build/test configuration, never replace frozen source.
initial=['supervisor.js','Dockerfile','windows/node/agent.mjs','windows/node/deploy-files.mjs','windows/installer/stage-bundle.sh','windows/installer/build-bundle.ps1','sdk/sessions/build.mjs','sdk/sessions/tsconfig.json']
initial += [str(f.relative_to(S)) for f in (S/'sdk/sessions/test').glob('*.mjs')]
q=initial[:];seen=set();missing=[]
pat=re.compile(r'''(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']''')
while q:
 rel=q.pop(0)
 if rel in seen:continue
 seen.add(rel);key='enclave/'+rel
 if key in origins:src=origins[key]
 else:
  src=S/rel
  if not src.is_file():missing.append({'from':rel,'reason':'missing requested/additional source'});continue
  src=src.resolve();dst=p/'seed'/key;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);origins[key]=src;pins[str(src)]=sha(src)
 if src.suffix not in {'.js','.mjs','.ts'}:continue
 for name in pat.findall(src.read_text()):
  if not name.startswith('.'):continue
  dest=posixpath.normpath(str(Path(rel).parent/name));opts=[dest]
  if dest.endswith('.js'):opts.append(dest[:-3]+'.ts')
  found=next((x for x in opts if 'enclave/'+x in origins or (S/x).is_file()),None)
  if found:q.append(found)
  else:missing.append({'from':rel,'import':name,'reason':'generated/runtime source absent; later execution gate'})
root=N/'candidate/enclave/test/wallet-session/root-discovery.test.mjs';dst=p/'seed/enclave/test/wallet-session/root-discovery.test.mjs';assert not dst.exists();shutil.copyfile(root,dst);origins['enclave/test/wallet-session/root-discovery.test.mjs']=root;pins[str(root)]=sha(root)
refs=[(D/'DELIVERY-REVIEW.md','review/DELIVERY-REVIEW.md'),(D/'TASK.txt','review/ORIGINAL-TASK.txt'),(D/'author-delivery-manifest.json','review/frozen202-manifest.json'),(D/'mutation-audit.json','review/mutation-audit.json'),(D/'terminal-summary.json','review/terminal-summary.json'),(A/'REPORT.md','review/REPORT-R1.md'),(A/'CLOSURE.json','review/CLOSURE-R1.json')]
for n in ['ROOT-REVIEW.md','result.tap','result.rc','source-pins.json','dependency-pins.json','dependency-packages.json','run.py']:refs.append((N/n,'node/'+n))
refs += [(root,'node/root-discovery.test.mjs'),(A/'enclave/test/wallet-session/consumers.test.mjs','node/author-consumers.test.mjs')]
for n in ['RESULT.json','compiler-output.json','compiler-input.json','input-pins.json','PREPARED.json']:refs.append((P/n,'product-compile/'+n))
for n in ['outer.log','compile-sizes.log','PREPARED.json','REVIEW.md','fixture-provenance.json']:refs.append((F/n,'foundry-failure/'+n))
for n in ['future-create-review.md','ledger-rev16d-EnclaveDeployments.sol','deployed-source-map.json']:refs.append((p.parent/'wallet-ownership-migration-review-r1-20261029'/n,'review/'+n))
for src,rel in refs:
 assert src.is_file(),str(src)
 dst=p/'evidence'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);pins[str(src)]=sha(src);pins[str(dst)]=sha(dst)
# Preserve original compiled/shipped SDK and current migration UI as readonly evidence, not editable products.
for src in (D/'evidence/preserved-r3').rglob('*'):
 if src.is_file():
  dst=p/'evidence/preserved-r3'/src.relative_to(D/'evidence/preserved-r3');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);pins[str(src)]=sha(src);pins[str(dst)]=sha(dst)
src=D/'evidence/shipped-sessions.mjs';dst=p/'evidence/shipped-sessions.mjs';shutil.copyfile(src,dst);pins[str(src)]=sha(src);pins[str(dst)]=sha(dst)
shutil.copytree(p/'seed',p/'candidate')
for f in (p/'seed').rglob('*'):
 if f.is_file():pins[str(f)]=sha(f)
for n in ['run.py','collect-terminal.py','readonly-progress.py','turn-metric-investigation.json']:shutil.copyfile(D/n,p/n)
(p/'owned-tmp').mkdir(mode=0o700)
for src in [Path('/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs')]:pins[str(src)]=sha(src)
seed={str(f.relative_to(p/'seed')):sha(f) for f in sorted((p/'seed').rglob('*')) if f.is_file()}
put('seed-pins.json',seed);put('input-pins.json',dict(sorted(pins.items())))
put('seed-provenance.json',{'frozenRoot':str(p/'seed'),'baseFrozenRoot':str(A),'baseFrozenManifestSha256':sha(D/'author-delivery-manifest.json'),'baseFrozenCount':202,'baseFrozenPreserved':all(seed.get(r)==h for r,h in frozen.items()),'addedFiles':[r for r in seed if r not in frozen],'origins':{r:{'path':str(f),'sha256':sha(f)} for r,f in sorted(origins.items())},'currentSourceCommit':subprocess.check_output(['git','-C',str(S),'rev-parse','HEAD'],text=True).strip(),'preAuthorProductEdits':0})
put('dependency-closure.json',{'seedFiles':len(seed),'additionalSourceMissing':missing,'status':'SOURCE_ONLY_AUTHOR_CLOSURE_NOT_RUNTIME_BUILD_PROOF','note':'Generated files/runtime fixtures may be absent; do not build/install/test. Original202 dependency closure retained. Root separately reviews execution inputs.'})
put('account-requirements.json',{'loggedIn':True,'email':'steven.r.batchelor@gmail.com','subscriptionType':'max','checkedNow':False,'gate':'Root independently before admission; unchanged pinned runner independently auth status before author. No auth in preparation.'})
print(json.dumps({'seed':len(seed),'pins':len(pins),'missing':missing,'frozen202Preserved':all(seed.get(r)==h for r,h in frozen.items())},indent=2))
