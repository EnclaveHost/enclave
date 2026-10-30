"""Local source copy/hash preparation only. No product import/execution or author launch."""
from pathlib import Path
import hashlib,json,re,shutil
p=Path(__file__).resolve().parent
c=p.parent.parent
w=Path('/home/steven/Documents/Codex/2026-10-18/wo')
baseline=w/'work/rpc-production-final-20261025/unified-funding-20261028/installed-manager-http-baseline-r1'
prior=c/'work/wallet-owned-session-repair-r2-20261029'
capture=c/'work/restore-queued-20261028/nucbox-reconnect-source'
review=c/'work/wallet-refund-migration-review-r1-20261029'
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
assert not (p/'PREPARED.json').exists()
for n in ['candidate','seed','root-author-approval.json','attempt.json','started.json','claude.out']:assert not (p/n).exists(),n
files=sorted(f for f in (baseline/'control').rglob('*') if f.is_file())
assert len(files)==114 and all(not f.is_symlink() for f in files)
for tree in ['seed','candidate']:shutil.copytree(baseline/'control',p/tree/'control')
pins={str(f):sha(f) for f in files}
seeds={str(f.relative_to(baseline)):sha(f) for f in files}
for rel,h in seeds.items():
 assert sha(p/'seed'/rel)==sha(p/'candidate'/rel)==h
 pins[str(p/'seed'/rel)]=h
matches={}
for name in ['agent.mjs','host.mjs','chain.mjs','lease-gas-runtime.bundle.mjs']:
 orig=capture/name; dst=baseline/'control/windows/node'/name
 assert sha(orig)==sha(dst)
 pins[str(orig)]=sha(orig);matches[name]=sha(orig)
e=p/'evidence';e.mkdir()
sources=[baseline/'PROVENANCE.json',baseline/'source-manifest.json',capture/'metadata.json',
 c/'work/windows-operator-identity-observation-r1-20261029/result.json',
 review/'RELEASE-ENABLEMENT-PREP.md',review/'RELEASE-ENABLEMENT-AUDIT.json',
 review/'INSTALLED-WINDOWS-ROUTE-PREP.md',review/'INSTALLED-WINDOWS-ROUTE-PINS.json']
for f in sources:
 name='prior-identity-result.json' if f.name=='result.json' else f.name
 shutil.copyfile(f,e/name);pins[str(f)]=sha(f);pins[str(e/name)]=sha(e/name)
for name in ['run.py','collect-terminal.py','readonly-progress.py','account-requirements.json','turn-metric-investigation.json']:
 shutil.copyfile(prior/name,p/name);pins[str(prior/name)]=sha(prior/name)
launch=(prior/'launch-command.txt').read_text().replace(str(prior),str(p)).replace('enclave-wallet-owned-session-repair-r2-20261029-author','enclave-windows-release-stopped-r1-20261029-author')
(p/'launch-command.txt').write_text(launch)
(p/'owned-tmp').mkdir(mode=0o700)
for f in [w/'work/claude-test-queue.py',w/'work/enclave/test/helpers/memory-guard.mjs']:pins[str(f)]=sha(f)
put('seed-pins.json',seeds)
put('seed-provenance.json',{'archiveBaseline':str(baseline),'frozenRoot':str(p/'seed'),'seedEntries':len(seeds),'installedCapture':str(capture),'independentlyCapturedMatches':matches,'preAuthorProductEdits':0,'limit':'Disk-source identity only; not loaded-code proof or current identity of every archived module.'})
put('allowed-edit-paths.json',{'existing':['control/windows/node/'+n+'.mjs' for n in ['hosting','host','chain']], 'optionalNewHelper':['control/windows/node/release-stopped.mjs'],'newTests':{'path':'control/test/release-stopped/*.test.mjs','maximumFiles':3},'reports':['REPORT.md','CLOSURE.json'],'immutable':['agent.mjs and every other baseline file','All generated bundles, dependency locks, package versions','All seed/evidence/preparation files outside candidate'],'note':'Manual semantic/scope review required; tool restriction is not an OS sandbox.'})
bundle=(capture/'lease-gas-runtime.bundle.mjs').read_text()
snippets={}
for term in ['function Oy(', 'signAuthorization(', 'signTypedData(', 'onSigned:A']:
 at=bundle.find(term);assert at>=0
 snippets[term]={'offset':at,'context':bundle[max(0,at-450):at+1000]}
put('evidence/signer-callsite-excerpts.json',{'source':str(capture/'lease-gas-runtime.bundle.mjs'),'sha256':sha(capture/'lease-gas-runtime.bundle.mjs'),'note':'Bounded byte-substring observations only; full exact bundle in seed. onSigned follows typed signing. Not executed.','excerpts':snippets})
pins[str(e/'signer-callsite-excerpts.json')]=sha(e/'signer-callsite-excerpts.json')
missing=[];bare=set()
pattern=re.compile(r'''(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']''')
for f in files:
 if f.suffix not in ['.mjs','.js'] or '.bundle.' in f.name:continue
 for spec in pattern.findall(f.read_text()):
  if spec.startswith('.'):
   target=f.parent/spec
   if not target.exists():missing.append({'from':str(f.relative_to(baseline)),'specifier':spec})
  elif not spec.startswith('node:'):bare.add(spec)
put('dependency-closure.json',{'baselineFiles':114,'bytes':sum(f.stat().st_size for f in files),'bareImportCandidates':sorted(bare),'missingRelativeCandidates':missing,'qualification':'Static regex scan only, may include comments and excludes minified bundles. No dependency installation, import, test, build or product execution. Root must qualify the focused test dependency closure before execution. Full original captured bundle retained read-only.'})
(p/'SOURCE-NOTES.md').write_text('''# Installed-source navigation and activation limits

`control/windows/node/agent.mjs` statically imports hosting at line45 and passes its live Host to startHostingAdmin around825–840. No agent edit is needed. Local host/stop at806 only stops a local apps entry; generic deployment route at627 does not implement DELETE release. Neither is a release command.

`hosting.mjs` hostingAdminHandler around389 applies loopback and constant-time token authentication before route dispatch. Add the exact new route there. Preserve the existing bounded body helper and other route behavior.

`host.mjs` construction sets cfg.dir/lease-release-journal.json at190–191. init at364 loads this host's operator and schedules work. Never execute init in tests. Inactive handling2373/#stopApp2799 does not release chain lease. #giveUp2603–2670 coalesces per-ID operations but can swallow errors; retirement at2766 includes by-name lookup. Renewal coordination at2232 and #renewVoid must be inspected for races. The new route needs positive wiring, not just a detached helper.

`chain.mjs` ordinary and sponsored sends share chainTx. leaseSender270 uses configuredLeaseSender with acct and onSigned. leaseSend285 begins journal before sending, persists signed intent through onSigned, retains unknown signed outcomes; resolvePendingReleases321 uses recorded identities. Existing gate is synchronous. releaseDeployment349 currently takes no options. readDeployment183 is currently publicClient().readContract, not proof of authenticated consensus. Preserve bundle send/receipt verification and accurately describe trust limits.

Read evidence/signer-callsite-excerpts.json and full bundle selectively. account.signAuthorization and signTypedData are called after async reads/admission. onSigned is AFTER signing. A scoped account wrapper may guard actual calls without editing the generated bundle, with original account identity/method binding preserved. A guard at queue entrance alone is insufficient.

Startup/ownership evidence: agent285 spawns supervised children; exit handler301 restarts host/worker unless stopping. SIGINT1197 kills supervised children and TPM. Isolation-only agent startup849+ invokes manager GPU refresh and host.init909. Host1305–1324 deliberately retires/reboots manager-marked recovered VMs. Thus preserving a VM requires keeping its manager intact and proving current actual process/job boundaries. The prior identity artifact records SYSTEM scheduled task, known disk paths and listener PID; it explicitly does not prove effective NODE_DIR, job ancestry, exclusive signer or loaded-code identity. It is historical, not a current remote observation.

Static module replacement requires restarting the agent; its listener/proxy/relay streams drop. No qualified graceful queue-drain endpoint exists in the captured agent. No restart, manager stop, injection, second signer, deployment or transaction is authorized by this package. These are root-owned activation blockers. Do not implement unrelated lifecycle/capacity or queue-drain work.
''')
put('input-pins.json',pins)
audit={'seedFiles':len(seeds),'candidateFiles':sum(1 for f in (p/'candidate').rglob('*') if f.is_file()),'productPreEdits':0,'seedEqualsCandidate':all(sha(p/'candidate'/r)==h for r,h in seeds.items()),'inputPins':len(pins),'inputDrift':[n for n,h in pins.items() if sha(n)!=h],'authorLaunched':False,'authInvoked':False,'productExecuted':False,'testsRun':False,'remoteRead':False,'runtimeMutation':False,'financialOperation':False}
put('preparation-audit.json',audit)
(p/'REVIEW-STATUS.txt').write_text('PREPARED ONLY. Await coordinator source/package review and exact admission; no author launched, no product changes, no tests/builds/runtime/remote/financial operations. Restart is not authorized.\n')
priorprep=json.loads((prior/'PREPARED.json').read_text())
prep={k:v for k,v in priorprep.items() if k not in ['hashes','sourceClosureLimitations']}
prep.update(seedEntries=len(seeds),readonlyInputPins=len(pins),persistentTmpdir=str(p/'owned-tmp'),scope='Exact installed targeted release-stopped route source only; no activation/lifecycle/capacity/financial work',sourceClosureLimitations=['Static dependency inventory is not a runnable test qualification.','Source provenance does not establish loaded-code or current process/job ownership.','Existing agent lacks qualified graceful replacement queue drain; restart not authorized.'])
prep['hashes']={f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}
put('PREPARED.json',prep)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'seedEntries':len(seeds),'readonlyPins':len(pins),'inputDrift':audit['inputDrift'],'preEdits':0,'missingRelativeCandidates':len(missing),'runnerSha256':sha(p/'run.py'),'collectorSha256':sha(p/'collect-terminal.py')},indent=2))
