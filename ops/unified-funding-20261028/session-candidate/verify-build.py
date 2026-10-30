#!/usr/bin/env python3
"""Read-only build size/provenance guard. Run AFTER forge test; never deploys or signs.
Passing proves size/source checks only, not linked addresses, runtime identity or production readiness.
"""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parent
repo=root.parents[2]
for name,expected in json.loads((root/'DEPENDENCIES-SHA256.json').read_text()).items():
    actual=hashlib.sha256((repo/name).read_bytes()).hexdigest()
    if actual!=expected: raise SystemExit('Dependency hash mismatch: '+name)
result={}
for source,name in [('FundingSessionVault.sol','FundingSessionVault'),('FundingSessionVault.sol','FundingSessionVaultFactory'),('FundingSessionVault.sol','FundingSessionVaultLib'),('FundingGasLib.sol','FundingGasLib')]:
    a=json.loads((root/'out'/source/(name+'.json')).read_text())
    metadata=json.loads(a['metadata']) if isinstance(a['metadata'],str) else a['metadata']
    cfg=metadata['settings']
    assert metadata['compiler']['version'].startswith('0.8.35+'), metadata['compiler']
    assert cfg['optimizer']['enabled'] and cfg['optimizer']['runs']==1
    assert cfg['viaIR'] and cfg['evmVersion']=='osaka' and cfg['metadata']['bytecodeHash']=='none'
    for src,record in metadata['sources'].items():
        # sha256 source manifest below binds package inputs; compiler metadata holds keccak256 inputs.
        assert record.get('keccak256'),src
    runtime=a['deployedBytecode']['object'].removeprefix('0x')
    creation=a['bytecode']['object'].removeprefix('0x')
    assert len(runtime)%2==0 and len(creation)%2==0
    size=len(runtime)//2
    if size>24576: raise SystemExit(f'{name}: runtime {size} exceeds EIP170')
    if name=='FundingSessionVaultFactory' and len(creation)//2+7*32>49152:
        raise SystemExit('Factory initcode plus arguments exceeds EIP3860')
    result[name]={'runtimeBytes':size,'creationBytes':len(creation)//2,'unresolvedLinks':a['bytecode'].get('linkReferences',{})}
for name,h in json.loads((root/'PACKAGE-SHA256.json').read_text()).items():
    assert hashlib.sha256((root.parent/name).read_bytes()).hexdigest()==h,name
print(json.dumps({'sizeAndSourceChecksPass':True,'productionReady':False,'contracts':result},indent=2))
