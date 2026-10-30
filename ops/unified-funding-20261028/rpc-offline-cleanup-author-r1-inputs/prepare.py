"""Copies and pins only. Never imports product, invokes native tools, checks auth or launches an author."""
from pathlib import Path
import ast,hashlib,json,shutil
p=Path(__file__).resolve().parent;c=p.parent.parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
b=w/'rpc-production-final-20261025';u=b/'unified-funding-20261028'
prior=c/'work/rpc-offline-os-writer-author-r1-20261029'
source=u/'rpc-offline-native-locks-r2/candidate'
def sha(f):
 with Path(f).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
for n in ['PREPARED.json','seed','candidate','evidence','attempt.json','started.json','root-author-approval.json']:
 assert not (p/n).exists(),n
names=['inspect_os_disk.py','inspect_units.py','guest_mask.py','fixture_reference.py','UNIT-PINS.json','offline_mask.py','test_offline_mask.py']
assert set(names)=={f.name for f in source.iterdir() if f.is_file()}
pins={};seed={}
for tree in ['seed','candidate']:
 (p/tree).mkdir()
 for n in names:shutil.copyfile(source/n,p/tree/n)
for n in names:
 h=sha(source/n);assert sha(p/'seed'/n)==sha(p/'candidate'/n)==h
 pins[str(source/n)]=h;pins[str(p/'seed'/n)]=h;seed[n]=h
(p/'evidence').mkdir()
ev={
 'actual-unit-metadata.json':u/'rpc-backup-unit-metadata-r1/RESULT.json',
 'native7-result.json':u/'rpc-offline-native-locks-r2/RESULT.json',
 'native7-review.md':u/'rpc-offline-native-locks-r2/ROOT-REVIEW.md',
 'native7-run.py':u/'rpc-offline-native-locks-r2/run.py',
 'native7-input-pins.json':u/'rpc-offline-native-locks-r2/INPUT-PINS.json',
 'root33-result.json':u/'rpc-offline-lock-repair-unit-r1/RESULT.json',
 'root-integration-tests.py':u/'rpc-offline-writer-root-repaired-r1/test_root_integration.py',
 'native-positive-result.json':u/'rpc-offline-writer-native-fixture-r2/RESULT.json',
 'native-positive-run.py':u/'rpc-offline-writer-native-fixture-r2/run.py',
 'native-gap-review.md':c/'work/rpc-offline-writer-native-review-r1-20261030/REVIEW.md',
 'qualification-plan.md':c/'work/rpc-offline-native-admission-prep-r1-20261030/PLAN.md',
}
for n,f in ev.items():
 shutil.copyfile(f,p/'evidence'/n);pins[str(f)]=sha(f);pins[str(p/'evidence'/n)]=sha(f)
(p/'evidence'/'ROOT-SCOPE.md').write_text('Root task: source-only cleanup/bounded stderr/all regular unit hashes/full RO-to-RW revalidation/immediate unlink-rm identity/complete link timestamps and explicit native no-xattrs checks. Preserve exact r2 locks and root33/native7. Fresh actual metadata is0644/root/no-xattrs on8units and4absolute links. No mixed-mode feature. Holder visibility remains separately unqualified; no successful stub, broad privilege or redesign gate. Author never executes any source/tool/test/image. Root reviews current Max and exact prep before one author.\n')
pins[str(p/'evidence'/'ROOT-SCOPE.md')]=sha(p/'evidence'/'ROOT-SCOPE.md')
for n in ['run.py','collect-terminal.py','root-preflight.py','readonly-progress.py','account-requirements.json','turn-metric-investigation.json','ACCOUNT-PREFLIGHT.md','native-tool-pins.json']:
 shutil.copyfile(prior/n,p/n);pins[str(prior/n)]=sha(prior/n)
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-rpc-offline-os-writer-r1-20261029-author','enclave-rpc-offline-cleanup-r1-20261030-author')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for f in [w/'claude-test-queue.py',w/'enclave/test/helpers/memory-guard.mjs']:pins[str(f)]=sha(f)
for v in json.loads((p/'native-tool-pins.json').read_text())['tools'].values():
 assert sha(v['path'])==v['sha256'];pins[v['path']]=v['sha256']
src=(source/'offline_mask.py').read_text();tree=ast.parse(src);protected={}
for cls in tree.body:
 if not isinstance(cls,ast.ClassDef):continue
 for node in cls.body:
  key=cls.name+'.'+getattr(node,'name','')
  if key in ('OsEffects.hold_qemu_locks','OsEffects.scan_holders','Writer.holders','OsEffects.sparse_copy'):
   text=ast.get_source_segment(src,node)
   protected[key]={'sha256':hashlib.sha256(text.encode()).hexdigest(),'startLine':node.lineno,'endLine':node.end_lineno,'source':text}
assert len(protected)==4
put('PROTECTED-SOURCE.json',{'sourceSha256':seed['offline_mask.py'],'methodComparison':'exact ast.get_source_segment text, including comments/body, no execution','immutableMethods':protected,'semanticPreserve':['systemctl user-bus environment propagation','no native execution in author','all existing tests unchanged']})
put('seed-pins.json',seed)
put('seed-provenance.json',{'sourceRoot':str(source),'frozenRoot':str(p/'seed'),'seedEntries':len(seed),'productPreEdits':0,'sourceOnly':True,'qualifiedNativeLockCases':7,'rootUnitCases':33})
put('allowed-edit-paths.json',{'existing':['offline_mask.py'],'newTests':['test_exporter_cleanup.py','test_offline_revalidation.py'],'reports':['REPORT.md','CLOSURE.json'],'immutable':[n for n in names if n!='offline_mask.py']+['all files outside candidate','four methods in PROTECTED-SOURCE.json'],'scope':'Focused exporter/inventory/revalidation/rollback repair only','note':'Tools are not an OS sandbox; root reviews semantic diff and mutation replay.'})
put('dependency-closure.json',{'runtime':'Existing Python stdlib/native tools; new helpers standard library only','preserved':'root33 and native7, no execution here','testSources':'Original test file immutable; new bounded injected regressions only; any real fixture proposal source-only','holderVisibility':'UNQUALIFIED and unchanged; no successful stub','collector':'actual terminal unit/main/runner/Claude identities required before once-only freeze'})
put('input-pins.json',pins)
drift=[n for n,h in pins.items() if sha(n)!=h];assert not drift,drift
put('preparation-audit.json',{'seedEntries':len(seed),'candidateEqualsSeed':True,'productPreEdits':0,'readonlyInputPins':len(pins),'inputDrift':drift,'protectedMethods':list(protected),'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'nativeToolsExecuted':False,'imagesOrDatabaseRead':False,'runtimeOrFinancialAction':False})
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. Exact r2 seed unchanged. No auth, author, tests, native tools, images, runtime or finance. Root reviews final digest and independently admits ONE source invocation.\n')
old=json.loads((prior/'PREPARED.json').read_text());prep={k:v for k,v in old.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=len(seed),readonlyInputPins=len(pins),persistentTmpdir=str(p/'owned-tmp'),scope='Focused r2 offline writer cleanup/logging/inventory/revalidation/rollback source repair; qualified locks and tests preserved',sourceClosureLimitations=['Holder visibility remains separately unqualified; unchanged.','No current Max check or author launch in preparation.','Targeted tests authored only, future root qualification required.','No actual image mutation/publication or runtime/financial authority in this package.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':len(seed),'readonlyInputPins':len(pins),'inputDrift':drift,'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py'),'rootPreflightSha256':sha(p/'root-preflight.py'),'protectedMethods':list(protected),'authorLaunched':False},indent=2))
