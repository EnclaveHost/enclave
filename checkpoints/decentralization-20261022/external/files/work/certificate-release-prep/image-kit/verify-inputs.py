from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;manifest=json.loads((root/'INPUTS.json').read_text());seen=set()
assert manifest['format']=='enclave-shield-direct-build-inputs/1'
for x in manifest['files']:
 rel=Path(x['path']);assert not rel.is_absolute() and '..' not in rel.parts and str(rel) not in seen;seen.add(str(rel));p=root/rel
 assert p.resolve().is_relative_to(root) and not p.is_symlink()
 assert p.stat().st_size==x['bytes'] and hashlib.sha256(p.read_bytes()).hexdigest()==x['sha256'],str(rel)
print('Verified',len(seen),'pinned build-input files')
