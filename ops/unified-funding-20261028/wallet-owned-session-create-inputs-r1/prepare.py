from pathlib import Path
import hashlib,json,shutil,re,difflib,subprocess
p=Path(__file__).resolve().parent
S=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');U=S.parent/'unified-funding-20261028'
I=U/'wallet-migration-installed-policy-r1';Q=U/'relay-quarantine-prep-r1/generated/relay'
D=p.parent/'wallet-release-prod-r1-20261029';M=p.parent/'wallet-ownership-migration-review-r1-20261029'
assert not (p/'seed').exists(),'prepare once; never overwrite seed'
def sha(f):return hashlib.sha256(Path(f).read_bytes()).hexdigest()
def putjson(n,v): (p/n).write_text(json.dumps(v,indent=2)+'\n')
origins={};pins={};overlays=[];miss=[];external=set()
initial=['package.json','package-lock.json','foundry.toml','contracts/SessionVault.sol','contracts/EnclaveSecretVaultV2.sol','contracts/EnclaveAppCatalog.sol','contracts/deployments/source-verification-base.json','relay/sessions.mjs','relay/sessions-abi.mjs','relay/api-relay.js','relay/secrets.js','relay/secrets-release.mjs','relay/shield-secrets.mjs','windows/node/session-api-auth.mjs','windows/node/host.mjs','cli/enclave.mjs','scripts/deploy-session-vault.mjs','test/helpers/sessions-chain.mjs','test/sessions.test.mjs','test/session-api-auth.test.mjs','test/relay-session-forward.test.mjs','test/secrets-release.test.mjs','test/secrets.test.mjs','test/windows-node-secrets.test.mjs','test/windows-node-secrets-unknown.test.mjs','test/windows-node-session.test.mjs','test/cli-session.test.mjs','docs/design/sessions.md','docs/session-auth.md']
initial += [str(f.relative_to(S)) for f in (S/'sdk/sessions').rglob('*') if f.is_file() and 'node_modules' not in f.parts and f.suffix in {'.ts','.json','.md'} and 'dist' not in f.parts]
initial += [str(f.relative_to(S)) for f in (S/'contracts/foundry/test').glob('Session*.sol')]
initial += ['contracts/foundry/test/mocks/SessionMocks.sol']
override={f'relay/{n}':I/n for n in ['sessions.mjs','secrets.js','secrets-release.mjs','shield-secrets.mjs']}
for f in Q.iterdir():
 if f.is_file() and f.suffix in {'.mjs','.js','.json'} and f.name!='sessions.mjs':override['relay/'+f.name]=f
for rel,src in override.items():
 old=S/rel
 overlays.append({'candidate':'enclave/'+rel,'source':str(src),'sha256':sha(src),'baseSource':str(old) if old.exists() else None,'baseSha256':sha(old) if old.exists() else None,'kind':'installed-capture' if src.parent==I else 'matching-installed-sessions-source-closure'})
 (p/'overlay-diffs').mkdir(exist_ok=True)
 (p/'overlay-diffs'/ (rel.replace('/','__')+'.diff')).write_text(''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],src.read_text().splitlines(True),fromfile=str(old),tofile=str(src))))
 if old.exists():pins[str(old)]=sha(old)
queue=list(dict.fromkeys(initial+list(override)))
pattern=re.compile(r'''(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']''')
while queue:
 rel=queue.pop(0)
 if rel in origins:continue
 src=override.get(rel,S/rel)
 if not src.is_file():miss.append({'source':None,'import':rel,'reason':'initial file missing'});continue
 if src.is_symlink():
  resolved=src.resolve(strict=True)
  if not (resolved.is_relative_to(S) or resolved.is_relative_to(U)):raise SystemExit('outside source symlink '+str(src))
  src=resolved
 origins[rel]=src;pins[str(src)]=sha(src)
 if len(origins)>650:raise SystemExit('source closure exceeded 650 files')
 if src.suffix not in {'.js','.mjs','.ts','.sol'}:continue
 for name in pattern.findall(src.read_text()):
  if not name.startswith('.'):
   external.add(name);continue
  target=(S/rel).parent/name
  try:target=target.resolve().relative_to(S)
  except ValueError:miss.append({'source':rel,'import':name,'reason':'outside source root'});continue
  options=[str(target)]
  if str(target).endswith('.js'):options.append(str(target)[:-3]+'.ts')
  if not target.suffix:options.extend(str(target)+x for x in ['.js','.mjs','.ts','.sol']);options.append(str(target/'index.ts'))
  found=next((x for x in options if x in override or (S/x).is_file()),None)
  if found:queue.append(found)
  else:miss.append({'source':rel,'import':name,'reason':'static import not found; root dependency gate'})
assert sum(f.stat().st_size for f in origins.values())<40*1024*1024,'source cap 40MiB'
for rel,src in origins.items():
 dst=p/'seed/enclave'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
# Evidence is read-only, copied not merged into product.
refs=[]
for f in M.iterdir():
 if f.is_file() and f.suffix in {'.md','.json','.sol'}:refs.append((f,Path('review')/f.name))
for f in (U/'wallet-release-prod-site-r3/source').rglob('*'):
 if f.is_file():refs.append((f,Path('preserved-r3')/f.relative_to(U/'wallet-release-prod-site-r3/source')))
refs.append((D/'shipped-sessions.mjs',Path('shipped-sessions.mjs')))
for root,label in [(U/'relay-quarantine-prep-r1','quarantine'),(U/'fee-policy-r1','fee-policy'),(U/'activation-r1','activation')]:
 refs.append((root/'ROOT-REVIEW.md',Path(label)/'ROOT-REVIEW.md'))
 for f in (root/'test').glob('*.mjs'):refs.append((f,Path(label)/'test'/f.name))
refs.append((I/'ROOT-REVIEW.md',Path('installed/ROOT-REVIEW.md')))
for src,rel in refs:
 if not src.is_file():continue
 dst=p/'evidence'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst);pins[str(src)]=sha(src);pins[str(dst)]=sha(dst)
shutil.copytree(p/'seed',p/'candidate')
seed={str(f.relative_to(p/'seed')):sha(f) for f in sorted((p/'seed').rglob('*')) if f.is_file()}
for f in (p/'seed').rglob('*'):
 if f.is_file():pins[str(f)]=sha(f)
for n in ['run.py','collect-terminal.py','readonly-progress.py','turn-metric-investigation.json']:
 shutil.copyfile(D/n,p/n)
# Source-only operational runner adaptations; no product edits.
r=(p/'run.py').read_text().replace("'--max-turns','30'","'--max-turns','55'").replace('timeout=900','timeout=1800')
r=r.replace("claudeBin=Path(prep['claudeExecutable']['path'])", "approval=json.loads((p/'root-author-approval.json').read_text())\nif approval.get('preparedSha256')!=sha(p/'PREPARED.json') or approval.get('launchAuthorized') is not True:raise SystemExit('root review/admission missing or stale; no launch')\nclaudeBin=Path(prep['claudeExecutable']['path'])")
(p/'run.py').write_text(r)
r=(p/'collect-terminal.py').read_text().replace("'configuredMaxAgenticTurns':30","'configuredMaxAgenticTurns':55")
(p/'collect-terminal.py').write_text(r)
(p/'owned-tmp').mkdir(mode=0o700)
putjson('account-requirements.json',{'loggedIn':True,'email':'steven.r.batchelor@gmail.com','subscriptionType':'max','checkedNow':False,'gate':'Root fresh auth status and runner independently before author. No auth command run during preparation.'})
putjson('seed-pins.json',seed)
putjson('seed-provenance.json',{'frozenRoot':str(p/'seed'),'baseRoot':str(S),'baseGitCommit':subprocess.check_output(['git','-C',str(S),'rev-parse','HEAD'],text=True).strip(),'origins':{ 'enclave/'+r:{'path':str(src),'sha256':sha(src)} for r,src in sorted(origins.items())},'overlays':overlays,'preAuthorProductEdits':0,'note':'Byte copies with explicit installed overlays. No runtime/loaded-code or installed freshness claim.'})
putjson('dependency-closure.json',{'staticSourceFiles':len(origins),'staticMissing':miss,'externalImports':sorted(external),'status':'SOURCE_PREPARATION_ONLY_NOT_TEST_OR_BUILD_CLOSURE','note':'Static import inventory only. Dynamic runtime assets/Foundry dependencies/fixtures must be admitted before tests. Do not install or run helper during author.'})
for rel in ['../../2026-10-18/wo/work/claude-test-queue.py']:
 pass
for f in [Path('/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs')]:pins[str(f)]=sha(f)
putjson('input-pins.json',dict(sorted(pins.items())))
print(json.dumps({'seedFiles':len(seed),'inputPins':len(pins),'staticMissing':miss,'seedBytes':sum(f.stat().st_size for f in origins.values())},indent=2))
