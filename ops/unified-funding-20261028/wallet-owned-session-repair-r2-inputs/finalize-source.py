# Metadata/hash preparation only; never launches author or executes product code.
from pathlib import Path
import hashlib,json
p=Path(__file__).resolve().parent
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
def put(n,obj):(p/n).write_text(json.dumps(obj,indent=2)+'\n')
assert not (p/'PREPARED.json').exists()
for n in ['root-author-approval.json','attempt.json','started.json','claude.out','finished.json']:assert not (p/n).exists(),n
cl=json.loads((p/'dependency-closure.json').read_text())
assert all(x.get('import')=='...' and x.get('from')=='windows/node/deploy-files.mjs' for x in cl['additionalSourceMissing'])
cl['excludedCommentMatches']=[{'from':'windows/node/deploy-files.mjs','line':8,'matches':['import("...")','require("...")'],'reason':'documentation comment, not real dependencies'}]
cl['additionalSourceMissing']=[]
cl['executionGates']=['Original dynamic relay/network-runtime.bundle.mjs absent; root must supply qualified runtime/dependency closure before any import/integration execution.','New compiled artifact identity cannot be generated or claimed by source-only author.']
put('dependency-closure.json',cl)
allowed={
 'existing':['enclave/contracts/WalletSessionVault.sol','enclave/contracts/WalletSessionPolicy.sol','enclave/relay/wallet-session-policy.mjs','enclave/relay/sessions.mjs','enclave/relay/sessions-abi.mjs','enclave/relay/api-relay.js','enclave/relay/secrets.js','enclave/relay/secrets-release.mjs','enclave/relay/shield-secrets.mjs','enclave/windows/node/session-api-auth.mjs','enclave/windows/node/host.mjs','enclave/windows/node/agent.mjs','enclave/supervisor.js','enclave/cli/enclave.mjs','enclave/Dockerfile','enclave/windows/node/deploy-files.mjs','enclave/windows/installer/stage-bundle.sh','enclave/sdk/sessions/build.mjs'],
 'patterns':['enclave/sdk/sessions/src/*','enclave/test/wallet-session/*'],
 'boundedNewPaths':{'immutableProfileSolidity':'At most one focused file under enclave/contracts; legacy contracts immutable.','provenanceManifestModules':'At most two focused JS modules; exact paths/imports require root scope review.','artifactBuilder':'At most one source-only builder; no execution or generated artifact fabrication.','newTests':'Small focused SDK and Solidity regression files, no constructor-heavy rigs and no changes to existing Solidity assertions.'},
 'reports':['REPORT-R2.md','CLOSURE-R2.json'],
 'immutable':['All seed/evidence/metadata outside candidate','Legacy SessionVault.sol, ledger, catalog, source deployment records','Installed funding/fee/quarantine controls','r3 UI/site/vendor and shipped SDK/dist','Package versions and locks','Original Solidity test assertions'],
 'testConstraint':'Node seven-author/three-root security assertions preserved; only explicit fixture proof-reader additions, with mapping and exact originals in evidence. Do not double-count overlapping seven.',
 'note':'Manual scope review is required after successful Write/Edit replay. This allowlist is not an OS sandbox or proof of acceptable semantic changes.'}
put('allowed-edit-paths.json',allowed)
t=(p/'TASK.txt').read_text()
t+='\nROOT OWNERSHIP-CONTINUITY LIMIT\nThe legacy ledger has no on-chain ownership-generation primitive. If transfer-away/back cannot be contract-enforced, retain and report the exact limitation. Authenticated history may gate consumers but must not be presented as on-chain revocation. No foreign/global oracle or custody veto to fake continuity. Do not enlarge scope to replace the legacy ledger.\n'
(p/'TASK.txt').write_text(t)
seed=json.loads((p/'seed-pins.json').read_text());pins=json.loads((p/'input-pins.json').read_text())
manifest=lambda root:{str(f.relative_to(root)):sha(f) for f in sorted(root.rglob('*')) if f.is_file()}
assert manifest(p/'seed')==seed==manifest(p/'candidate')
frozen=json.loads((p/'evidence/review/frozen202-manifest.json').read_text());assert len(frozen)==202 and all(seed.get(k)==v for k,v in frozen.items())
drift=[n for n,h in pins.items() if not Path(n).is_file() or sha(n)!=h];assert not drift,drift
assert all(not f.is_symlink() for root in ['seed','candidate'] for f in (p/root).rglob('*'))
put('preparation-audit.json',{'status':'PREPARATION_ONLY','seedEntries':len(seed),'originalFrozenEntries':len(frozen),'originalFrozenPreserved':True,'additionalEntries':len(seed)-len(frozen),'readonlyInputPins':len(pins),'inputDrift':drift,'candidateEqualsSeed':True,'productPreEdits':0,'authorLaunched':False,'accountCheckedNow':False,'testsRun':False,'buildsRun':False,'approvalPresent':False,'note':'Static source/hash audit, not product validation. Separate thin harness proposal is not executable closure.'})
old=json.loads((p.parent/'wallet-owned-session-create-r1-20261029/PREPARED.json').read_text())
old.update({'seedEntries':len(seed),'readonlyInputPins':len(pins),'persistentTmpdir':str(p/'owned-tmp'),'scope':'Focused wallet-owned session source repair; no production or funded old-app migration','sourceClosureLimitations':cl['executionGates'],'hashes':{f.name:sha(f) for f in sorted(p.iterdir()) if f.is_file() and f.name!='PREPARED.json'}})
assert sha(old['claudeExecutable']['path'])==old['claudeExecutable']['sha256']
put('PREPARED.json',old)
print(json.dumps({'preparedSha256':sha(p/'PREPARED.json'),'taskSha256':sha(p/'TASK.txt'),'runnerSha256':sha(p/'run.py'),'audit':json.loads((p/'preparation-audit.json').read_text())},indent=2))
