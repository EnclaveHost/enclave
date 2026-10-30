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
observer=u/'rpc-holder-observer-prep-r3'
def sha(f):
 with Path(f).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
for n in ['PREPARED.json','seed','candidate','evidence','attempt.json','started.json','root-author-approval.json']:
 assert not (p/n).exists(),n
expected={'offline_mask.py':'9744e66c7ef920f7c1ef7f21f947e0420b0e9a80505b0d1ffee1bd17f0760200','observe.py':'517625237f818eb5474d7e9a0b17243177d82bff29f0fdb97e7799b6b3b75ebc'}
seed_sources={n:source/n for n in ['inspect_os_disk.py','inspect_units.py','guest_mask.py','fixture_reference.py','UNIT-PINS.json','offline_mask.py','test_offline_mask.py','test_exporter_cleanup.py','test_offline_revalidation.py']}
seed_sources.update({'observe.py':observer/'observe.py','test_observe.py':observer/'test_observe.py','test_root_cleanup.py':u/'rpc-offline-cleanup-root-repaired-r1/test_root_cleanup.py','test_root_integration.py':u/'rpc-offline-writer-root-repaired-r1/test_root_integration.py'})
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
 'observer-r3-review.md':observer/'ROOT-REVIEW.md','observer-r3-result.json':observer/'RESULT.json',
 'observer-r3-tests.txt':observer/'tests.txt','observer-r3-input-pins.json':observer/'INPUT-PINS.json',
 'writer-repaired-review.md':u/'rpc-offline-cleanup-root-repaired-r1/ROOT-REVIEW.md',
 'writer-repaired-result.json':u/'rpc-offline-cleanup-root-repaired-r1/RESULT.json',
 'writer-repaired-protected.json':u/'rpc-offline-cleanup-root-repaired-r1/PROTECTED-COMPARISON.json',
 'native-positive-result.json':u/'rpc-offline-cleanup-native-r1/RESULT.json',
 'native-positive-collection.json':u/'rpc-offline-cleanup-native-r1/ROOT-COLLECTION.json',
 'native-negative-result.json':u/'rpc-offline-cleanup-native-negative-r1/RESULT.json',
 'native-negative-collection.json':u/'rpc-offline-cleanup-native-negative-r1/ROOT-COLLECTION.json',
 'native7-review.md':u/'rpc-offline-native-locks-r2/ROOT-REVIEW.md',
 'native7-result.json':u/'rpc-offline-native-locks-r2/RESULT.json',
 'shared-queue.py':w/'claude-test-queue.py',
 'memory-guard.mjs':w/'enclave/test/helpers/memory-guard.mjs',
}
for n,f in ev.items():
 shutil.copyfile(f,p/'evidence'/n);pins[str(f)]=sha(f);pins[str(p/'evidence'/n)]=sha(f)
(p/'evidence/ROOT-SCOPE.md').write_text('Root authorized preparation only of one SOURCEONLY Claude task/runner/collector/pins for functional smallest fixed privileged observer launcher+installer+caller effects adapter. Exact committed observer r3 and cleanup repaired writer remain unchanged. No product preedit, author launch, tests, installation, native/live or financial work. Root reviews package/current Max before ONE author. Fullhost snapshot supplementary to OFD/workflow locks. Functional successful integration and bounded opt-in qualification fixtures required, not refusal-only stubs. No new RPC/custody authority.\n')
pins[str(p/'evidence/ROOT-SCOPE.md')]=sha(p/'evidence/ROOT-SCOPE.md')
# Local primary documentation copied as text, never executed.
docs={}
for section,name in [('1','systemd-run'),('5','systemd.service'),('5','systemd.resource-control'),('5','systemd.exec'),('5','sudoers')]:
 f=Path('/usr/share/man')/('man'+section)/(name+'.'+section+'.gz')
 if f.is_file():
  raw=gzip.decompress(f.read_bytes());assert len(raw)<2000000
  dest=p/'evidence'/(name+'.man.txt');dest.write_bytes(raw)
  pins[str(f)]=sha(f);pins[str(dest)]=sha(dest);docs[str(f)]=str(dest)
for n in ['run.py','collect-terminal.py','root-preflight.py','readonly-progress.py','account-requirements.json','turn-metric-investigation.json','ACCOUNT-PREFLIGHT.md','native-tool-pins.json']:
 shutil.copyfile(prior/n,p/n);pins[str(prior/n)]=sha(prior/n)
# Collector changes concern audit mechanics only, never product source.
collector=(p/'collect-terminal.py').read_text()
collector=collector.replace('import hashlib,json,shutil,subprocess','import hashlib,json,shutil,subprocess,ast')
collector=collector.replace("pins=json.loads((p/'input-pins.json').read_text());", "with (p/'collection-attempt.json').open('x') as once:json.dump({'admission':a,'unit':status},once)\nobservedInvocation=dict(line.split('=',1) for line in status.splitlines() if '=' in line).get('InvocationID')\nassert not observedInvocation or observedInvocation==a['invocationId'],'different terminal unit invocation'\npins=json.loads((p/'input-pins.json').read_text());")
needle="for rel in removed:issues.append({'file':rel,'reason':'removed file needs explicit audit'})"
addition=needle+"\nallowed=json.loads((p/'allowed-edit-paths.json').read_text())\nallowedNew=set(allowed['newFiles'])\nfor rel in changes:\n if rel in seed:issues.append({'file':rel,'reason':'immutable seed edited'})\n elif rel not in allowedNew:issues.append({'file':rel,'reason':'new file outside exact allowlist'})\nfor rel,h in seed.items():\n if before.get(rel)!=h:issues.append({'file':rel,'reason':'immutable source hash mismatch'})\nfor rel in before:\n if (p/'candidate'/rel).stat().st_size>1048576:issues.append({'file':rel,'reason':'source file exceeds1MiB audit budget'})"
assert needle in collector;collector=collector.replace(needle,addition)
(p/'collect-terminal.py').write_text(collector)
# Affinity applies to the queue itself, unlike previous launch's narrower inner-only taskset.
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-rpc-offline-cleanup-r1-20261030-author','enclave-rpc-holder-bridge-r1-20261030-author')
launch=launch.replace('--collect /usr/bin/python3','--collect /usr/bin/taskset -c 1 /usr/bin/python3')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for v in json.loads((p/'native-tool-pins.json').read_text())['tools'].values():
 assert sha(v['path'])==v['sha256'];pins[v['path']]=v['sha256']
toolpaths=['/usr/bin/python3','/usr/bin/node','/usr/bin/taskset','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/sudo','/usr/bin/visudo']
tools={}
for name in toolpaths:
 f=Path(name);actual=f.resolve(strict=True)
 tools[name]={'resolvedPath':str(actual),'sha256':sha(actual),'executed':False};pins[str(actual)]=sha(actual)
put('bridge-tool-pins.json',{'scope':'file hashing only; no native tool or account invocation','tools':tools,'localPrimaryDocs':docs})
src=(source/'offline_mask.py').read_text();tree=ast.parse(src);protected={}
for cls in tree.body:
 if not isinstance(cls,ast.ClassDef):continue
 for node in cls.body:
  key=cls.name+'.'+getattr(node,'name','')
  if key in ('OsEffects.hold_qemu_locks','OsEffects.scan_holders','Writer.holders','OsEffects.sparse_copy'):
   body=ast.get_source_segment(src,node);protected[key]={'sha256':hashlib.sha256(body.encode()).hexdigest(),'startLine':node.lineno,'endLine':node.end_lineno,'source':body}
assert len(protected)==4
put('PROTECTED-SOURCE.json',{'immutableFiles':seed,'methodsForAdditionalReview':protected,'adapterRule':'New subclass/composition only. Entire qualified writer and observer unchanged. No blanket caller PID skip.'})
new=['holder_protocol.py','install_holder.py','holder_launcher.py','holder_effects.py','run_offline_observed.py','test_holder_bridge.py','qualify_holder_bridge.py','README-HOLDER.md','BRIDGE-CLOSURE.json']
put('allowed-edit-paths.json',{'existing':[],'newFiles':new,'immutable':list(seed)+['all files outside candidate'],'scope':'Functional fixed privileged read-only holder bridge only','note':'Tool allowlist is not an OS sandbox; collector audits exact paths, immutable seed hashes and mutation replay.'})
put('seed-pins.json',seed)
put('seed-provenance.json',{'frozenRoot':str(p/'seed'),'seedEntries':len(seed),'productPreEdits':0,'sourceOnly':True,'committedSources':committed,'rootUnitCases':53,'observerUnitCases':12,'nativePositiveAndNegative':'see copied root evidence; no execution in preparation'})
put('dependency-closure.json',{'runtime':'Python standard library and pinned native administrative tools; no new package dependency','preserved':'Entire observer/writer and all original test bytes','author':'source only; no execution','collector':'terminal actual unit/PID evidence and once-only freeze/replay','privilegedQualification':'unqualified; explicit future root review and admission required'})
put('input-pins.json',pins)
drift=[n for n,h in pins.items() if sha(n)!=h];assert not drift,drift
put('preparation-audit.json',{'seedEntries':len(seed),'candidateEqualsSeed':True,'committedSeedVerified':True,'commit':commit,'productPreEdits':0,'readonlyInputPins':len(pins),'inputDrift':drift,'allowedNewFiles':new,'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'nativeToolsExecuted':False,'imagesOrDatabaseRead':False,'runtimeOrFinancialAction':False,'metadataGitReadOnly':True})
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. Exact committed13-file seed unchanged. No auth, author, tests, install, native/live/finance. Root reviews digest/current account/resources before ONE author.\n')
old=json.loads((prior/'PREPARED.json').read_text());prep={k:v for k,v in old.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=len(seed),readonlyInputPins=len(pins),persistentTmpdir=str(p/'owned-tmp'),scope='Fixed privileged metadata observer installer/launcher/caller bridge; unchanged qualified observer/writer',sourceClosureLimitations=['No current Max check or author launch.','No helper installation or privileged qualification.','Existing tests preserved; new tests source-only.','Root reviews source and resource admission before all execution.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':len(seed),'readonlyInputPins':len(pins),'inputDrift':drift,'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py'),'rootPreflightSha256':sha(p/'root-preflight.py'),'authorLaunched':False},indent=2))
