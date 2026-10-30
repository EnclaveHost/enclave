"""Copy exact local source/evidence and pin preparation. Never executes product or Claude."""
from pathlib import Path
import hashlib,json,re,shutil
p=Path(__file__).resolve().parent
c=p.parent.parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo')
b=w/'work/rpc-production-final-20261025'
source=b/'postrestore-maintenance-stage/r1'
failure=b/'postrestore-maintenance-stage/production-20261028'
prior=c/'work/wallet-owned-session-repair-r2-20261029'
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
assert not (p/'PREPARED.json').exists()
for n in ['seed','candidate','attempt.json','started.json','claude.out','root-author-approval.json']:assert not (p/n).exists(),n
names=['maint_boot.py','guest_mask.py','test_root_maintenance.py','SHA256SUMS']
pins={};seed={}
for tree in ['seed','candidate']:
 (p/tree).mkdir()
 for n in names:shutil.copyfile(source/n,p/tree/n)
for n in names:
 h=sha(source/n);assert sha(p/'seed'/n)==sha(p/'candidate'/n)==h
 pins[str(source/n)]=h;pins[str(p/'seed'/n)]=h;seed[n]=h
tests=re.findall(r'^    def (test_\w+)\(', (source/'test_root_maintenance.py').read_text(), re.M)
assert len(tests)==13,tests
e=p/'evidence';(e/'production-failure').mkdir(parents=True)
for n in ['PREPARED.json','LAUNCHED.json','plan.json','RESULT.json']:
 f=failure/n;d=e/'production-failure'/n;shutil.copyfile(f,d);pins[str(f)]=sha(f);pins[str(d)]=sha(d)
f=b/'source/ops/rpc-backend-bootstrap/2026-10-25/provision_vm.py'
assert sha(f)=='38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7'
shutil.copyfile(f,e/'captured-launcher.py');pins[str(f)]=sha(f);pins[str(e/'captured-launcher.py')]=sha(f)
for n in ['run.py','collect-terminal.py','readonly-progress.py','account-requirements.json','turn-metric-investigation.json']:
 shutil.copyfile(prior/n,p/n);pins[str(prior/n)]=sha(prior/n)
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-wallet-owned-session-repair-r2-20261029-author','enclave-rpc-maintenance-qmp-r1-20261029-author')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for f in [w/'work/claude-test-queue.py',w/'work/enclave/test/helpers/memory-guard.mjs']:pins[str(f)]=sha(f)
put('seed-pins.json',seed)
put('seed-provenance.json',{'sourceRoot':str(source),'frozenRoot':str(p/'seed'),'seedEntries':len(seed),'productPreEdits':0,'originalTestCount':len(tests),'originalTestMethods':tests,'originalTestsSha256':seed['test_root_maintenance.py'],'originalFailureRoot':str(failure),'sourceOnly':True,'limits':'Historical exact source and failure only. Original failure has no phase/trace, cause unknown. No runtime readiness or fixes proved.'})
put('allowed-edit-paths.json',{'existing':['maint_boot.py'],'optionalNewHelper':['qmp_transport.py'],'newTests':['test_qmp_transport.py','test_maintenance_diagnostics.py'],'reports':['REPORT.md','CLOSURE.json'],'immutable':['guest_mask.py','test_root_maintenance.py','SHA256SUMS','all seed/evidence/preparation outside candidate'],'semanticBoundaries':['QMP socket/deadline/framing/correlation/event buffers','safe bounded phase/errno diagnostics','actual existing call-site wiring and connection closure','no alteration of ownership/prelaunch/resource/storage/backup/security guards or budget constants'],'note':'Manual semantic scope review remains required; source-tool limit is not an OS sandbox.'})
put('dependency-closure.json',{'sourceRuntime':'Python standard library only in original maint_boot.py/guest_mask.py; optional focused helper must preserve that. No imports/execution performed.','originalTests':{'count':13,'preserved':True,'externalMetadataDependencies':['DEFAULT_CFG.launcher pinned source','DEFAULT_CFG.manifest pinned metadata'],'qualification':'Original tests read external pinned source/manifest during setup; not claimed hermetic. Root must supply a reviewed fixture harness/runtime closure before executing. No image/database dependency is authorized.'},'newTests':'Authored fake socket/monotonic clock and small temporary local AF_UNIX fixtures only, no execution in source author.','collector':'Unchanged strict collector needs actual terminal invocation and actual main/runner/Claude PIDs. If transient PID uncaptured use separate manual failure audit; never fabricate.'})
put('input-pins.json',pins)
put('preparation-audit.json',{'sourceFiles':4,'candidateFiles':4,'candidateEqualsSeed':True,'productPreEdits':0,'originalTests':13,'readonlyInputPins':len(pins),'inputDrift':[n for n,h in pins.items() if sha(n)!=h],'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'buildsRun':False,'imageOrDatabaseRead':False,'networkOrRemoteRead':False,'runtimeOrFinancialAction':False})
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. Fresh package; no author/account preflight/tests/builds/images/DB/remote/runtime/finance. Root reviews and independently admits one source invocation. Consumed OAuth-failed release author is not reused.\n')
old=json.loads((prior/'PREPARED.json').read_text());prep={k:v for k,v in old.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=4,readonlyInputPins=len(pins),persistentTmpdir=str(p/'owned-tmp'),scope='Exact maintenance QMP transport/diagnostics source-only repair; original13tests/guestmask/guards unchanged',sourceClosureLimitations=['Original tests have external metadata setup; root fixture qualification needed before execution.','Original production BlockingIOError phase/cause unknown.','This package grants no boot, retry, image/DB, resource, activation or financial action.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':4,'originalTests':13,'readonlyPins':len(pins),'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py'),'rootPreflightSha256':sha(p/'root-preflight.py')},indent=2))
