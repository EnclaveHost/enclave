from pathlib import Path
import hashlib
import json
import subprocess

p = Path(__file__).resolve().parent
u = p.parent
old = u / 'production-grant-terms-r1'
sha = lambda b: hashlib.sha256(b).hexdigest()
subprocess.run(['node', str(p/'candidate/scripts/build-funding-vendor.mjs')], check=True, timeout=120)
original = json.loads((old/'generated/BUILD-PINS.json').read_text())['inputs']
for name, digest in original.items():
    assert sha((u/name).read_bytes()) == digest, name
mapping = {
    'client-execution-site-r2/candidate/site/js/pages/funding.js': p.name+'/candidate/site/js/pages/funding.js',
    'client-site-repair-r2/authored/site/js/funding/state.js': p.name+'/candidate/site/js/funding/state.js',
    'client-site-repair-r2/authored/site/js/funding/flows.js': p.name+'/candidate/site/js/funding/flows.js',
}
names = [mapping.get(n, n.replace('production-grant-terms-r1/', p.name+'/')) for n in original]
pins = {n: sha((u/n).read_bytes()) for n in names}
(p/'generated/BUILD-PINS.json').write_text(json.dumps({'schema':'cutover-page-root-pins-r1','inputs':pins},indent=2)+'\n')
subprocess.run(['node', str(p/'build/build-harness.mjs')], check=True, timeout=120)
old_h = json.loads((old/'generated/HARNESS-INPUTS.json').read_text())
for n, h in old_h['files'].items():
    assert sha((u/n).read_bytes()) == h, n
files = {n.replace('production-grant-terms-r1/',p.name+'/'): None for n in old_h['files']}
files = {n:sha((u/n).read_bytes()) for n in files}
vendor = {k:v.replace('production-grant-terms-r1/',p.name+'/') for k,v in old_h['vendor'].items()}
(p/'generated/HARNESS-INPUTS.json').write_text(json.dumps({'schema':'cutover-page-root-harness-r1','files':files,'vendor':vendor},indent=2)+'\n')
subprocess.run(['node','--check',str(p/'out/server.mjs')],check=True,timeout=20)
print(json.dumps({'build':'PASS','testOnly':True,'files':files},indent=2))
