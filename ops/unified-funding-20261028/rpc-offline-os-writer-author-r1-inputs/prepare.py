"""Preparation only: copy/pin source and write metadata, never import product or execute CLI tools."""
from pathlib import Path
import hashlib,json,shutil
p=Path(__file__).resolve().parent
c=p.parent.parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
b=w/'rpc-production-final-20261025'
prior=c/'work/rpc-maintenance-qmp-author-r1-20261029'
procedure=c/'work/rpc-offline-os-mask-prep-r1-20261029'
fixture=b/'unified-funding-20261028/rpc-offline-mask-fixture-r1'
def sha(f):
 with Path(f).open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
for n in ['PREPARED.json','seed','candidate','evidence','attempt.json','started.json','root-author-approval.json']:
 assert not (p/n).exists(),n
sources={
 'inspect_os_disk.py':b/'rpc-memory-recovery-stage/r1/inspect_os_disk.py',
 'inspect_units.py':b/'postrestore-recovery-stage/r1/inspect_units.py',
 'guest_mask.py':b/'postrestore-maintenance-stage/r1/guest_mask.py',
 'fixture_reference.py':fixture/'run.py',
 'UNIT-PINS.json':procedure/'UNIT-PINS.json',
}
pins={};seed={}
for tree in ['seed','candidate']:
 (p/tree).mkdir()
 for n,f in sources.items():shutil.copyfile(f,p/tree/n)
for n,f in sources.items():
 h=sha(f);assert sha(p/'seed'/n)==sha(p/'candidate'/n)==h
 pins[str(f)]=h;pins[str(p/'seed'/n)]=h;seed[n]=h
(p/'evidence').mkdir()
evidence={n:procedure/n for n in ['PROCEDURE.md','PUBLICATION-CHECKLIST.md','SOURCE-PINS.json','FIXTURE-READBACK-PINS.json']}
evidence.update({'fixture-RESULT.json':fixture/'RESULT.json','fixture-INPUT-PINS.json':fixture/'INPUT-PINS.json'})
for n,f in evidence.items():
 shutil.copyfile(f,p/'evidence'/n);pins[str(f)]=sha(f);pins[str(p/'evidence'/n)]=sha(f)
for n in ['account-requirements.json','turn-metric-investigation.json','readonly-progress.py','ACCOUNT-PREFLIGHT.md']:
 shutil.copyfile(prior/n,p/n);pins[str(prior/n)]=sha(prior/n)
runner=(prior/'run.py').read_text()
assert runner.count("'--max-turns','55'")==1 and runner.count('timeout=1800')==1
(p/'run.py').write_text(runner.replace("'--max-turns','55'","'--max-turns','20'").replace('timeout=1800','timeout=900'))
collector=(prior/'collect-terminal.py').read_text()
assert collector.count("'configuredMaxAgenticTurns':55")==1
(p/'collect-terminal.py').write_text(collector.replace("'configuredMaxAgenticTurns':55","'configuredMaxAgenticTurns':20"))
shutil.copyfile(prior/'root-preflight-v2.py',p/'root-preflight.py')
for n in ['run.py','collect-terminal.py','root-preflight-v2.py']:pins[str(prior/n)]=sha(prior/n)
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-rpc-maintenance-qmp-r1-20261029-author','enclave-rpc-offline-os-writer-r1-20261029-author').replace('RuntimeMaxSec=2100','RuntimeMaxSec=1200')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for f in [w/'claude-test-queue.py',w/'enclave/test/helpers/memory-guard.mjs']:pins[str(f)]=sha(f)
tools={}
for n in ['nbdfuse','qemu-nbd','qemu-img','debugfs','e2fsck','fusermount3']:
 f=(Path('/usr/bin')/n).resolve(strict=True)
 tools[n]={'path':str(f),'sha256':sha(f)};pins[str(f)]=sha(f)
put('native-tool-pins.json',{'scope':'metadata hashing only; no CLI executed','tools':tools})
put('seed-pins.json',seed)
put('seed-provenance.json',{'frozenRoot':str(p/'seed'),'sourceFiles':{n:str(f) for n,f in sources.items()},'seedEntries':len(seed),'allSeedImmutable':True,'productPreEdits':0,'sourceOnly':True})
put('allowed-edit-paths.json',{'existing':[],'newSource':['offline_mask.py'],'newTests':['test_offline_mask.py'],'reports':['REPORT.md','CLOSURE.json'],'immutable':list(seed)+['all files outside candidate'],'scope':'Fresh OS derivative writer only; never production publication or VM/client/DB/funding changes','note':'Tool allowlist is not an OS sandbox; manual semantic review and terminal mutation audit required.'})
put('dependency-closure.json',{'sourceRuntime':'Python standard library plus exact reviewed native CLIs for a FUTURE root-run writer; no execution here','nativeToolsMetadata':'native-tool-pins.json','newTests':'Authored only; fake injected effects and small synthetic fixtures. No production paths/import effects.','referenceFixture':'Root-owned synthetic32MiB actual PASS, independently pinned, not rerun or broadened here','collector':'Actual terminal unit plus observed main/runner/Claude PIDs required; otherwise manual failure audit, no fabricated PID'})
put('input-pins.json',pins)
drift=[n for n,h in pins.items() if sha(n)!=h];assert not drift,drift
put('preparation-audit.json',{'seedEntries':len(seed),'candidateEqualsSeed':True,'productPreEdits':0,'readonlyInputPins':len(pins),'inputDrift':drift,'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'imageOrDatabaseRead':False,'networkOrRemoteRead':False,'runtimeOrFinancialAction':False})
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. No author, auth, tests, image operations, runtime or publication. Root reviews final digest and independently admits one source invocation.\n')
old=json.loads((prior/'PREPARED.json').read_text())
prep={k:v for k,v in old.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=len(seed),readonlyInputPins=len(pins),turnLimit=20,childTimeoutSec=900,outerTimeoutSec=1200,persistentTmpdir=str(p/'owned-tmp'),scope='New source-only offline OS derivative writer; five immutable references, no production edits or publication',sourceClosureLimitations=['No actual image identity or current account check in preparation.','Native hashes are metadata pins, not current production tool qualification.','Only referenced root synthetic primitive fixture has run; new author tests never run here.','No production image/VM/DB/client/funding action authorized by this package.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':len(seed),'readonlyInputPins':len(pins),'inputDrift':drift,'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py'),'rootPreflightSha256':sha(p/'root-preflight.py'),'nativeTools':len(tools),'authorLaunched':False},indent=2))
