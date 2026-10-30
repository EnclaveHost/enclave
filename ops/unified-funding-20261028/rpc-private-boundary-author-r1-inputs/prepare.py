"""Preparation: copy/hash committed source and evidence only; no product imports, tests, auth or author launch."""
from pathlib import Path
import ast,gzip,hashlib,json,shutil,subprocess
p=Path(__file__).resolve().parent
c=p.parent.parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
u=w/'rpc-production-final-20261025/unified-funding-20261028'
repo=w/'rpc-production-final-20261025/source'
prior=c/'work/rpc-offline-cleanup-author-r1-20261030'
source=u/'rpc-offline-cleanup-root-repaired-r1/candidate'
def sha(f):
 with Path(f).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
for n in ['PREPARED.json','seed','candidate','evidence','attempt.json','started.json','root-author-approval.json']:
 assert not (p/n).exists(),n
expected={'offline_mask.py':'9744e66c7ef920f7c1ef7f21f947e0420b0e9a80505b0d1ffee1bd17f0760200'}
seed_sources={n:source/n for n in ['inspect_os_disk.py','inspect_units.py','guest_mask.py','fixture_reference.py','UNIT-PINS.json','offline_mask.py','test_offline_mask.py','test_exporter_cleanup.py','test_offline_revalidation.py']}
seed_sources.update({'test_root_cleanup.py':u/'rpc-offline-cleanup-root-repaired-r1/test_root_cleanup.py','test_root_integration.py':u/'rpc-offline-writer-root-repaired-r1/test_root_integration.py'})
commit=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
pins={};seed={};committed={}
for name,f in seed_sources.items():
 rel='ops/unified-funding-20261028/'+str(f.relative_to(u))
 raw=subprocess.check_output(['git','-C',str(repo),'show',commit+':'+rel])
 assert raw==f.read_bytes(),f'working source differs from committed seed: {f}'
 h=sha(f)
 if name in expected:assert h==expected[name],name
 committed[name]={'source':str(f),'gitPath':rel,'commit':commit,'sha256':h}
for tree in ['seed','candidate']:
 (p/tree).mkdir()
 for n,f in seed_sources.items():shutil.copyfile(f,p/tree/n)
for n,f in seed_sources.items():
 h=sha(f);assert sha(p/'seed'/n)==sha(p/'candidate'/n)==h
 pins[str(f)]=h;pins[str(p/'seed'/n)]=h;seed[n]=h
(p/'evidence').mkdir()
ev={
 'private-boundary-proposal.md':u/'rpc-private-derivative-boundary-review-r1/PROPOSAL.md',
 'private-path-metadata.json':u/'rpc-private-derivative-boundary-review-r1/PATH-METADATA.json',
 'writer-repaired-review.md':u/'rpc-offline-cleanup-root-repaired-r1/ROOT-REVIEW.md',
 'writer-repaired-result.json':u/'rpc-offline-cleanup-root-repaired-r1/RESULT.json',
 'writer-repaired-protected.json':u/'rpc-offline-cleanup-root-repaired-r1/PROTECTED-COMPARISON.json',
 'native-positive-result.json':u/'rpc-offline-cleanup-native-r1/RESULT.json',
 'native-positive-collection.json':u/'rpc-offline-cleanup-native-r1/ROOT-COLLECTION.json',
 'native-positive-run.py':u/'rpc-offline-cleanup-native-r1/run.py',
 'native-negative-result.json':u/'rpc-offline-cleanup-native-negative-r1/RESULT.json',
 'native-negative-collection.json':u/'rpc-offline-cleanup-native-negative-r1/ROOT-COLLECTION.json',
 'native-negative-run.py':u/'rpc-offline-cleanup-native-negative-r1/run.py',
 'native7-review.md':u/'rpc-offline-native-locks-r2/ROOT-REVIEW.md',
 'native7-result.json':u/'rpc-offline-native-locks-r2/RESULT.json',
}
for n,f in ev.items():
 shutil.copyfile(f,p/'evidence'/n);pins[str(f)]=sha(f);pins[str(p/'evidence'/n)]=sha(f)
(p/'evidence/ROOT-SCOPE.md').write_text('Root authorized PREPARE ONLY separate small SOURCEONLY author for explicit private-derivative policy on cleanup repaired writer. Default global-holder gate unchanged. Strict opt-in reviewed plan declares local root/maintenance UID trust, exact file+ancestor+ACL+new-private-directory checks, native locks/full digests/current stopped VM and honest receipt scope. No fake empty scan, boot/publication/source-write/existing-backing change or hostile-root/sameUID race guarantee. Preserve original53 tests and qualified methods. Bridge HOLD unchanged. Root reviews exact prepared hash/current Max/resources before ONE author. No preedit/launch/test/image/live/finance.\n')
pins[str(p/'evidence/ROOT-SCOPE.md')]=sha(p/'evidence/ROOT-SCOPE.md')
for n in ['run.py','collect-terminal.py','root-preflight.py','readonly-progress.py','account-requirements.json','turn-metric-investigation.json','ACCOUNT-PREFLIGHT.md','native-tool-pins.json']:
 shutil.copyfile(prior/n,p/n);pins[str(prior/n)]=sha(prior/n)
# Collector changes concern audit mechanics only, never product source.
collector=(p/'collect-terminal.py').read_text()
collector=collector.replace('import hashlib,json,shutil,subprocess','import hashlib,json,shutil,subprocess,ast')
collector=collector.replace("pins=json.loads((p/'input-pins.json').read_text());", "with (p/'collection-attempt.json').open('x') as once:json.dump({'admission':a,'unit':status},once)\nobservedInvocation=dict(line.split('=',1) for line in status.splitlines() if '=' in line).get('InvocationID')\nassert not observedInvocation or observedInvocation==a['invocationId'],'different terminal unit invocation'\npins=json.loads((p/'input-pins.json').read_text());")
needle="for rel in removed:issues.append({'file':rel,'reason':'removed file needs explicit audit'})"
addition=needle+"\nallowed=json.loads((p/'allowed-edit-paths.json').read_text())\nallowedNew=set(allowed['newFiles'])\nfor rel in changes:\n if rel in seed and rel not in allowed['existing']:issues.append({'file':rel,'reason':'immutable seed edited'})\n elif rel not in seed and rel not in allowedNew:issues.append({'file':rel,'reason':'new file outside exact allowlist'})\nfor rel,h in seed.items():\n if rel not in allowed['existing'] and before.get(rel)!=h:issues.append({'file':rel,'reason':'immutable source hash mismatch'})\nfor rel in before:\n if (p/'candidate'/rel).stat().st_size>1048576:issues.append({'file':rel,'reason':'source file exceeds1MiB audit budget'})"
assert needle in collector;collector=collector.replace(needle,addition)
audit = r"""
prot=json.loads((p/'PROTECTED-SOURCE.json').read_text())
try:
 sourceText=(p/'candidate/offline_mask.py').read_text();tree=ast.parse(sourceText);definitions={}
 for top in tree.body:
  if isinstance(top,(ast.FunctionDef,ast.AsyncFunctionDef)):
   if top.name in definitions:raise ValueError('duplicate top-level definition '+top.name)
   definitions[top.name]=top
  if isinstance(top,ast.ClassDef):
   for node in top.body:
    if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
     key=top.name+'.'+node.name
     if key in definitions:raise ValueError('duplicate method '+key)
     definitions[key]=node
 for key,want in prot['immutableDefinitions'].items():
  node=definitions.get(key)
  if node is None or hashlib.sha256(ast.get_source_segment(sourceText,node).encode()).hexdigest()!=want['sha256']:
   issues.append({'definition':key,'reason':'protected definition changed/missing'})
 execute=definitions.get('Writer.execute')
 if execute is None:raise ValueError('Writer.execute missing')
 actual=[ast.get_source_segment(sourceText,node) for node in execute.body];position=0
 for want in prot['executeStatements']:
  while position<len(actual) and actual[position]!=want:
   node=execute.body[position]
   if not isinstance(node,ast.Expr) or not isinstance(node.value,ast.Call):
    issues.append({'definition':'Writer.execute','line':node.lineno,'reason':'inserted statement is not a check call'})
   position+=1
  if position==len(actual):raise ValueError('original execute statement changed/removed/reordered')
  position+=1
 for node in execute.body[position:]:
  if not isinstance(node,ast.Expr) or not isinstance(node.value,ast.Call):
   issues.append({'definition':'Writer.execute','line':node.lineno,'reason':'appended statement is not a check call'})
except (SyntaxError,ValueError,OSError) as exc:
 issues.append({'file':'offline_mask.py','reason':'protected definition audit: '+str(exc)})
"""
collector=collector.replace("shutil.copytree(p/'candidate',p/'author-delivery');",audit+"\nshutil.copytree(p/'candidate',p/'author-delivery');")
(p/'collect-terminal.py').write_text(collector)
# Affinity applies to the queue itself, unlike previous launch's narrower inner-only taskset.
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-rpc-offline-cleanup-r1-20261030-author','enclave-rpc-private-boundary-r1-20261030-author')
launch=launch.replace('--collect /usr/bin/python3','--collect /usr/bin/taskset -c 1 /usr/bin/python3')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for v in json.loads((p/'native-tool-pins.json').read_text())['tools'].values():
 assert sha(v['path'])==v['sha256'];pins[v['path']]=v['sha256']
for name in ['/usr/bin/python3','/usr/bin/node','/usr/bin/taskset','/usr/bin/systemd-run']:
 f=Path(name).resolve(strict=True);pins[str(f)]=sha(f)
for f in [w/'claude-test-queue.py',w/'enclave/test/helpers/memory-guard.mjs']:
 pins[str(f)]=sha(f)
src=(source/'offline_mask.py').read_text();tree=ast.parse(src);protected={};execute=None
allowedDefinitions={'validate_plan','Writer.holders','Writer.receipt','Writer.execute'}
for top in tree.body:
 nodes=[(top.name,top)] if isinstance(top,(ast.FunctionDef,ast.AsyncFunctionDef)) else []
 if isinstance(top,ast.ClassDef):nodes=[(top.name+'.'+n.name,n) for n in top.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))]
 for key,node in nodes:
  if key=='Writer.execute':execute=node
  if key in allowedDefinitions:continue
  body=ast.get_source_segment(src,node);protected[key]={'sha256':hashlib.sha256(body.encode()).hexdigest(),'startLine':node.lineno,'endLine':node.end_lineno}
assert execute is not None
put('PROTECTED-SOURCE.json',{'sourceSha256':seed['offline_mask.py'],'immutableDefinitions':protected,'executeStatements':[ast.get_source_segment(src,n) for n in execute.body],'allowedExistingDefinitions':sorted(allowedDefinitions),'executeRule':'Original top-level statements byte-identical and in order; only inserted check calls permitted; root semantic review required.'})
new=['test_private_boundary.py','qualify_private_boundary.py','PRIVATE-POLICY.md','PRIVATE-CLOSURE.json']
put('allowed-edit-paths.json',{'existing':['offline_mask.py'],'newFiles':new,'immutable':[n for n in seed if n!='offline_mask.py']+['all files outside candidate'],'scope':'Strict opt-in private-derivative policy, default global-holder gate unchanged','note':'Tool allowlist is not an OS sandbox; collector audits exact paths/immutable definitions/statement order/mutation replay; root semantic review remains necessary.'})
put('seed-pins.json',seed)
put('seed-provenance.json',{'frozenRoot':str(p/'seed'),'seedEntries':len(seed),'productPreEdits':0,'sourceOnly':True,'committedSources':committed,'rootUnitCases':53,'nativePositiveAndNegative':'see copied root evidence; no execution in preparation'})
put('dependency-closure.json',{'runtime':'Existing Python standard library/native tools; no new dependency or privilege','preserved':'All existing writer definitions except explicitly allowed policy points; original test bytes','author':'source only; no execution','collector':'terminal actual unit/PID evidence and once-only freeze/replay','policyQualification':'unqualified; future root review/targeted tests/native fixtures required'})
put('input-pins.json',pins)
drift=[n for n,h in pins.items() if sha(n)!=h];assert not drift,drift
put('preparation-audit.json',{'seedEntries':len(seed),'candidateEqualsSeed':True,'committedSeedVerified':True,'commit':commit,'productPreEdits':0,'readonlyInputPins':len(pins),'inputDrift':drift,'allowedNewFiles':new,'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'nativeToolsExecuted':False,'imagesOrDatabaseRead':False,'runtimeOrFinancialAction':False,'metadataGitReadOnly':True})
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. Exact committed11-file seed unchanged. No auth, author, tests, image/native/live/finance. Root reviews digest/current account/resources before ONE author.\n')
old=json.loads((prior/'PREPARED.json').read_text());prep={k:v for k,v in old.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=len(seed),readonlyInputPins=len(pins),persistentTmpdir=str(p/'owned-tmp'),scope='Explicit private-derivative plan policy; default global-holder gate unchanged; preserve native lock/copy/cleanup/filesystem',sourceClosureLimitations=['No current Max check or author launch.','No new policy qualification or actual derivative preparation.','Existing tests preserved; new tests source-only.','Root reviews source and resource admission before all execution.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':len(seed),'readonlyInputPins':len(pins),'inputDrift':drift,'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py'),'rootPreflightSha256':sha(p/'root-preflight.py'),'authorLaunched':False},indent=2))
