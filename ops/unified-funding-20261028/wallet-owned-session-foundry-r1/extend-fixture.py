# Test-only preparation. Original author test and all product sources remain byte-for-byte unchanged.
from pathlib import Path
import hashlib,json,shutil,difflib
p=Path(__file__).resolve().parent;A=p.parent/'wallet-owned-session-create-r1-20261029/author-delivery/enclave'
M=p.parent/'wallet-ownership-migration-review-r1-20261029';S=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');U=S.parent/'unified-funding-20261028'
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def put(n,v):(p/n).write_text(json.dumps(v,indent=2)+'\n')
orig=A/'contracts/foundry/test/WalletSessionVault.t.sol';old=orig.read_text()
new=old.replace('"../../../deploy/ledger/EnclaveDeployments.sol"','"./fixtures/EnclaveDeploymentsRev16D.sol"').replace('LedgerR15D','LedgerR16D').replace('contract WalletSessionVaultTest is SessionRig','contract WalletSessionVaultRev16DTest is SessionRig')
new='// ROOT PREPARED EXACT-REV16D FIXTURE. Original author assertions retained below; NOT RUN.\n'+new
assert new.endswith('}\n')
new=new[:-2]+'''
    // Root regression: policy-owner checks must read the pinned ledger, never a moved address-book ledger.
    function test_rootOwnerPolicyRejectsMovedLedgerBeforeOwnershipRead() public {
        bytes32 sid = _wopen(_anyBoth());
        bytes32 id = abi.decode(_wexec(sid, 0, CREATE, _cargs(freeRef, 1, 0), 0), (bytes32));
        book.set("deployments", address(ledger));
        vm.expectRevert(abi.encodeWithSignature("LedgerMoved()"));
        vm.prank(owner);
        wv.setEnvironment(id, "prod", 1, bytes32(0), 0, "");
    }
}
'''
fixture=p/'seed/contracts/foundry/test/WalletSessionVaultRev16D.t.sol';fixture.write_text(new)
exact=p/'seed/contracts/foundry/test/fixtures/EnclaveDeploymentsRev16D.sol';shutil.copyfile(M/'ledger-rev16d-EnclaveDeployments.sol',exact)
(p/'rev16d-fixture.diff').write_text(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile=str(orig),tofile=str(fixture))))
(p/'evidence').mkdir(exist_ok=True)
verification=p.parent/'enclave-deployment-lifecycle/contracts/deployments/source-verification-base.json'
shutil.copyfile(verification,p/'evidence/source-verification-base.json')
meta=json.loads(verification.read_text());soljson=S/'node_modules/solc/soljson.js'
assert sha(soljson)==meta['compiler']['soljsonSha256']
# Retain exact historical Node regression/result pins as references, no copying executable Node tree or rerun.
node=U/'wallet-owned-create-root-tests-r1';refs=[node/x for x in ['candidate/enclave/test/wallet-session/root-discovery.test.mjs','source-pins.json','dependency-pins.json','dependency-packages.json','run.py','result.tap','result.rc','ROOT-REVIEW.md'] if (node/x).is_file()]
pins=json.loads((p/'input-pins.json').read_text())
for f in [orig,fixture,exact,verification,p/'evidence/source-verification-base.json',soljson.resolve(),*refs]:pins[str(f)]=sha(f)
seed={str(f.relative_to(p/'seed')):sha(f) for f in sorted((p/'seed').rglob('*')) if f.is_file()}
for f in (p/'seed').rglob('*'):
 if f.is_file():pins[str(f)]=sha(f)
put('seed-pins.json',seed);put('input-pins.json',dict(sorted(pins.items())))
put('fixture-provenance.json',{'original':{'path':str(orig),'sha256':sha(orig)},'testCopy':{'path':str(fixture),'sha256':sha(fixture)},'exactLedger':{'path':str(exact),'sha256':sha(exact),'expectedSha256':meta['builds']['ledger-rev16d']['sources']['EnclaveDeployments.sol']['sha256']},'changes':'Separate copy only: import/type/class renamed, one root LedgerMoved owner-policy regression appended. Original author test/product unchanged. Comments within copied assertions still describe historical assumptions.','settingsMap':{x:meta['builds'][x]['settings'] for x in ['ledger-rev16d','legacy-sessions-v2','catalog']},'soljson':{'path':str(soljson.resolve()),'sha256':sha(soljson),'matchesSourceVerification':True},'toolchainCaveat':'Prepared test uses pinned native solc 0.8.35; deployed verification used pinned Emscripten soljson. Version/settings alignment is not fresh binary/runtime/metadata equivalence proof. Explicit Osaka is harness choice, deployment map leaves evmVersion unset. Full-source paths/local library addresses alter metadata. Local behavior/size only, no production deployment claim.','links':{x:meta['contracts'][x]['links'] for x in ['deployments','legacySessionVaultImplementation']},'nodeReferenceFiles':[{'path':str(f),'sha256':sha(f)} for f in refs]})
closure=json.loads((p/'closure.json').read_text());closure.update({'files':len(seed),'sourcePins':len(pins),'exactFixture':'contracts/foundry/test/WalletSessionVaultRev16D.t.sol','matchContract':'WalletSessionVault(Test|Rev16DTest)','ledgerWarning':'Original author suite remains rev15d. Separate explicit rev16d fixture retains its assertions and adds one owner-policy LedgerMoved regression. Both UNRUN. Generic ledger/catalog/router SessionRig dependencies are not all exact deployed builds; do not overstate live equivalence.','settings':'Pinned native solc0.8.35,optimizer1,viaIR,explicitOsaka,default metadata IPFS (no override),FFI false,offline,no code size override. Deployed map sessions/ledger optimizer1/viaIR agrees; native/Emscripten/default target equivalence not freshly proved.'});put('closure.json',closure)
print(json.dumps({'files':len(seed),'pins':len(pins),'originalUnchanged':sha(orig)==sha(p/'seed/contracts/foundry/test/WalletSessionVault.t.sol'),'rev16d':sha(exact)}))
