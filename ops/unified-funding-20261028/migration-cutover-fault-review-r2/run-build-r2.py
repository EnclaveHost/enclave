"""ROOT runs this AFTER fixture/generate_fixture.py (UNREVIEWED, NOT RUN by its author). TEST ONLY, local files + node only.
Mirrors migration-cutover-site-review-r1/run-build-r1.py: verifies the qualified inputs, writes this directory's
generated/BUILD-PINS.json (shell -> this directory; page/flows/state/util/vendor/sessions stay the qualified review-r1
bytes), bundles page/dist/harness.js, writes generated/HARNESS-INPUTS.json and node --check's the derived server.
Refuses to overwrite an existing pins file."""
from pathlib import Path
import hashlib
import json
import subprocess

p = Path(__file__).resolve().parent
u = p.parent
R = 'migration-cutover-site-review-r1'
sha = lambda b: hashlib.sha256(b).hexdigest()

gen = json.loads((p / 'out/GENERATED.json').read_text())
for rel, h in gen['outputs'].items():
    assert sha((p / rel).read_bytes()) == h, rel
for rel, h in gen['unchangedUnderTest'].items():
    assert sha((u / rel).read_bytes()) == h, rel
rp = json.loads((u / R / 'generated/BUILD-PINS.json').read_text())['inputs']
for n, d in rp.items():
    assert sha((u / n).read_bytes()) == d, n
names = [n.replace(R + '/shell/', p.name + '/shell/') for n in rp]
pins = {n: sha((u / n).read_bytes()) for n in names}
for n in names:
    if not n.startswith(p.name + '/'):
        assert pins[n] == rp[n], n                       # the code under test: the qualified bytes
assert pins[R + '/candidate/site/vendor/funding.js'] == 'f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957'
bp = p / 'generated/BUILD-PINS.json'
if bp.exists():
    raise SystemExit('generated/BUILD-PINS.json exists; inspect or move it first')
bp.write_text(json.dumps({'schema': 'cutover-fault-r2-root-pins', 'inputs': pins}, indent=2) + '\n')
subprocess.run(['node', str(p / 'build/build-harness.mjs')], check=True, timeout=120)

rh = json.loads((u / R / 'generated/HARNESS-INPUTS.json').read_text())
files = {}
for n in rh['files']:
    m = n.replace(R + '/page/', p.name + '/page/')
    files[m] = sha((u / m).read_bytes())
    if m == n:
        assert files[m] == rh['files'][n], n             # vendor client + sessions SDK: the qualified bytes
hi = p / 'generated/HARNESS-INPUTS.json'
if hi.exists():
    raise SystemExit('generated/HARNESS-INPUTS.json exists; inspect or move it first')
hi.write_text(json.dumps({'schema': 'cutover-fault-r2-root-harness', 'files': files, 'vendor': rh['vendor']}, indent=2) + '\n')
subprocess.run(['node', '--check', str(p / 'out/server.mjs')], check=True, timeout=20)
print(json.dumps({'build': 'PASS', 'testOnly': True, 'files': files}, indent=2))
