# Verify every PINNED non-source input of this kit against INPUTS.json (the published 0ed5a8ba kit's manifest): firmware,
# kernel, OpenHCL, runtime baseline, igvmfilegen, recipe, Go module cache, compile.sh. The source tree is replaced by the
# current integrated source on purpose; pack.py and build-image.mjs carry a recorded source-label delta; README, rebuild.sh
# and the expected-*.json describe the old candidate and are not used. Prints the delta files' hashes.
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent;m=json.loads((root/'INPUTS.json').read_text())
assert m['format']=='enclave-shield-direct-build-inputs/1'
skip_prefix=('source/',);skip={'source.tar','pack.py','build-image.mjs','README.md','rebuild.sh','expected-image.json','expected-initrd.json','verify-inputs.py'}
n=0
for x in m['files']:
 p=x['path']
 if p.startswith(skip_prefix) or p in skip: continue
 f=root/p;assert not f.is_symlink() and f.resolve().is_relative_to(root),p
 assert f.stat().st_size==x['bytes'] and hashlib.sha256(f.read_bytes()).hexdigest()==x['sha256'],p
 n+=1
print('Verified',n,'pinned non-source inputs unchanged from the 0ed5a8ba kit')
for p in ['pack.py','build-image.mjs','compile.sh','verify-kit.py','rebuild-current.sh']:
 print('kit file',p,hashlib.sha256((root/p).read_bytes()).hexdigest())
