# Preparation only: copies/hash-pins source and constructs standard JSON; NEVER invokes a compiler.
from pathlib import Path
import hashlib,json,shutil,re,os
p=Path(__file__).resolve().parent;D=p.parent/'wallet-owned-session-create-r1-20261029/author-delivery/enclave';old=p.parent/'wallet-owned-session-foundry-r1-20261029'
assert not (p/'seed').exists(),'prepare once'
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def put(n,j):(p/n).write_text(json.dumps(j,indent=2)+'\n')
rels=['contracts/WalletSessionVault.sol','contracts/WalletSessionPolicy.sol','contracts/SessionVault.sol'];src={};pins={};origins={}
for rel in rels:
 f=D/rel;dst=p/'seed'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,dst)
 src[rel]={'content':f.read_text()};pins[str(f)]=sha(f);pins[str(dst)]=sha(dst);origins[rel]={'path':str(f),'sha256':sha(f)}
outputs=['abi','metadata','evm.bytecode.object','evm.bytecode.linkReferences','evm.deployedBytecode.object','evm.deployedBytecode.linkReferences','evm.deployedBytecode.immutableReferences']
settings={'optimizer':{'enabled':True,'runs':1},'viaIR':True,'evmVersion':'osaka','metadata':{'bytecodeHash':'ipfs'},'outputSelection':{'contracts/WalletSessionVault.sol':{'WalletSessionVault':outputs,'WalletSessionVaultFactory':outputs},'contracts/SessionVault.sol':{'SessionVaultLib':outputs},'contracts/WalletSessionPolicy.sol':{'WalletSessionPolicy':['abi']}}}
put('compiler-input.json',{'language':'Solidity','sources':src,'settings':settings})
(p/'owned-tmp').mkdir(mode=0o700)
(p/'compile-cwd').mkdir()
verification=p.parent/'enclave-deployment-lifecycle/contracts/deployments/source-verification-base.json';j=json.loads(verification.read_text())
for f in [Path('/home/steven/.local/share/svm/0.8.35/solc-0.8.35'),Path('/usr/bin/python3').resolve(),Path('/usr/bin/node'),Path('/usr/bin/unshare'),Path('/usr/bin/env'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py'),Path('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs'),verification,old/'outer.log',old/'compile-sizes.log',old/'PREPARED.json']:
 pins[str(f)]=sha(f)
put('input-pins.json',dict(sorted(pins.items())));put('source-origins.json',origins)
put('closure.json',{'status':'PREPARED_ONLY_NOT_EXECUTED','sources':rels,'sourceBytes':sum(len(x['content'].encode()) for x in src.values()),'outputSelection':settings['outputSelection'],'settings':settings,'sourceTransformation':'NONE: full byte-identical original files. No interfaces/library extraction or product rewrite.','omittedCodegen':'Legacy SessionVault/SessionVaultFactory, all old ledgers, all test rigs/fixtures/forge-std. Whole SessionVault.sol still parsed/typechecked; only SessionVaultLib output requested. New factory naturally embeds new executor initcode.','requiredImports':'WalletSessionVault imports ./SessionVault.sol and ./WalletSessionPolicy.sol, both included at original unit paths. Other two files contain no Solidity imports.','sourceVerifiedLegacyHash':j['builds']['legacy-sessions-v2']['sources']['SessionVault.sol']['sha256'],'deployedSettings':j['builds']['legacy-sessions-v2']['settings'],'deployedCompiler':j['compiler'],'toolchainLimit':'Pinned native solc0.8.35 vs verification Emscripten soljson; explicitOsaka and IPFS metadata retain harness choices. No runtime or CBOR equivalence claim. Local source unit names and unresolved library links differ from deployed bytecode.','previousFailure':{'path':str(old),'invocation':'c8ae998b3b28482aa5cfcbc0196cb241','summary':'Outer STOP99/SIGTERM at526MiB treeRSS>512cap; Compiling33files only; no RESULT/size/tests. Preserved untouched. No unchanged retry or cap raise.'},'hostNetworkNamespace':os.readlink('/proc/self/ns/net')})
print(json.dumps({'sources':len(rels),'pins':len(pins),'bytes':sum(len(x['content'].encode()) for x in src.values())}))
