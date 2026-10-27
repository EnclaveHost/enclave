import hashlib, importlib.util, json
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
f=p/'multipart-validation-view-stage/r6/production_import.py'
assert hashlib.sha256(f.read_bytes()).hexdigest()=='4d48f74ea0360db6b264fcef97750a5c83e3ba5f8ef47260864b93e940b1b2dc'
s=importlib.util.spec_from_file_location('pi',f);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b=p.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026';raw=(b/'manifest.json').read_bytes();sha=hashlib.sha256(raw).hexdigest();assert sha=='f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9';d=json.loads(raw)
r=Path('/home/steven/.local/share/enclave-recovery/base-20261026/parts-root')
checks=[]
for mode,n in [('copy','part-0000.json'),('verify','part-0000.verify-20261027T000530Z-2504266.json')]:
 raw=(r/n).read_bytes();why=m.binding_problem(json.loads(raw)['source'],d,sha,mode)
 checks.append({'mode':mode,'recordSha256':hashlib.sha256(raw).hexdigest(),'problem':why})
assert all(x['problem'] is None for x in checks)
print(json.dumps({'pass':True,'checks':checks,'scope':'two actual canary record bindings only; no byte reads, no production view import'}))
