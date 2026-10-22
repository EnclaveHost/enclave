#!/usr/bin/env bash
# ONE CAS patch against CURRENT main (../enclave working tree), its file inventory with prior / final / composition
# provenance, and the checks: the tree differs from main in exactly SOURCE-SET.txt + the declared generated outputs; the
# patch dry-runs on main (read-only) and reproduces the tree; every generated manifest's input inventory matches current
# main (+ this patch). Reads main; never writes it. Builds nothing (builders ran through the shared queue: logs/).
set -euo pipefail
C="$(cd "$(dirname "$0")" && pwd)"; cd "$C"
exec python3 - "$@" <<'EOF'
import hashlib, json, os, subprocess, sys, tempfile, shutil, datetime
C = os.getcwd(); MAIN = os.path.realpath('../enclave'); TREE = os.path.join(C, 'tree')
PRIOR_PATCH = '../credit-vault-independence/patches/credit-vault-independence.patch'
PRIOR_TREE = '../credit-vault-independence/tree'
FINAL_PATCH = '../credit-vault-final-integration/patches/credit-vault-final-integration.patch'
FINAL_TREE = '../credit-vault-final-integration/tree'
INTEGRATED = {'network/lease-gas-owner.mjs': 'ddd3ba9b', 'cli/lease-gas.mjs': '27d49989', 'test/lease-gas-owner-cli.test.mjs': 'ffc100c4'}
# generated, deterministic, NOT in the patch (root refreshes them after integration; see the interface)
GENERATED = ['network/host-services/packages/credit-vault-submitter.mjs', 'network/host-services/packages/credit-vault-submitter.package.json',
             'network/host-services/packages/policy-mirror.package.json', 'network/host-services/packages/route-dns.mjs',
             'network/host-services/packages/route-dns.package.json', 'windows/node/lease-gas-runtime.bundle.mjs',
             'windows/node/lease-gas-runtime.bundle.mjs.manifest.json']
PRUNE = {'.git', 'node_modules', 'target'}; PRUNE_PATHS = {'contracts/foundry/out'}
SOURCE = [l.strip() for l in open('SOURCE-SET.txt') if l.strip()]
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
def shaof(root, rel):
    p = os.path.join(root, rel); return sha(p) if os.path.isfile(p) else None
def files(root):
    out = set()
    for d, dirs, fs in os.walk(root):
        rd = os.path.relpath(d, root); rd = '' if rd == '.' else rd
        dirs[:] = [x for x in dirs if x not in PRUNE and os.path.join(rd, x) not in PRUNE_PATHS]
        for f in fs:
            r = os.path.join(rd, f)
            if os.path.isfile(os.path.join(root, r)) or os.path.islink(os.path.join(root, r)): out.add(r)
    return out
def touched(patch):
    return {l[6:].split('\t')[0].strip() for l in open(patch) if l.startswith('+++ b/')}
fail = []
# 1. the tree differs from current main in exactly the source set + the generated outputs
allf = files(MAIN) | files(TREE)
diff = sorted(r for r in allf if shaof(MAIN, r) != shaof(TREE, r))
want = sorted(set(SOURCE) | set(GENERATED))
extra = sorted(set(diff) - set(want)); missing = sorted(set(want) - set(diff))
if extra: fail.append('tree differs from main outside the declared set (main moved, or undeclared change): ' + ', '.join(extra[:20]))
if missing: fail.append('declared but identical to main: ' + ', '.join(missing))
for r in INTEGRATED:
    if shaof(TREE, r) != shaof(MAIN, r) or not shaof(MAIN, r).startswith(INTEGRATED[r]): fail.append(f'integrated path not main\'s {INTEGRATED[r]}: {r}')
# 2. the patch, in SOURCE-SET order
P = os.path.join(C, 'patches/credit-final-composition.patch'); chunks = []
for r in SOURCE:
    a = os.path.join(MAIN, r) if os.path.isfile(os.path.join(MAIN, r)) else '/dev/null'
    la = 'a/' + r if a != '/dev/null' else '/dev/null'
    d = subprocess.run(['diff', '-u', '--label', la, '--label', 'b/' + r, a, os.path.join(TREE, r)], capture_output=True)
    if d.returncode not in (0, 1): fail.append(f'diff failed for {r}: {d.stderr.decode()}')
    chunks.append(d.stdout)
open(P, 'wb').write(b''.join(chunks))
psha = sha(P); cas = os.path.join(C, f'patches/credit-final-composition.{psha}.patch'); shutil.copyfile(P, cas)
dry = subprocess.run(['patch', '--dry-run', '-s', '-p1', '-d', MAIN, '-i', P], capture_output=True, text=True)
if dry.returncode: fail.append('patch --dry-run on current main failed: ' + dry.stdout + dry.stderr)
with tempfile.TemporaryDirectory() as T:
    for r in SOURCE:
        if os.path.isfile(os.path.join(MAIN, r)): os.makedirs(os.path.dirname(os.path.join(T, r)), exist_ok=True); shutil.copyfile(os.path.join(MAIN, r), os.path.join(T, r))
    ap = subprocess.run(['patch', '-s', '-p1', '-d', T, '-i', P], capture_output=True, text=True)
    if ap.returncode: fail.append('patch does not apply to main copies: ' + ap.stdout + ap.stderr)
    for r in SOURCE:
        if shaof(T, r) != shaof(TREE, r): fail.append(f'patch does not reproduce {r}')
# 3. generated manifests: every recorded input equals the tree (= main + patch) and, outside the patch, current main
closure = {}; NM = {}
def nested(root, rel):
    # the builders record any (possibly nested) .../node_modules/X as node_modules/X: every copy of X in this root
    if root not in NM:
        idx = {}
        for d, dirs, fs in os.walk(root):
            rd = os.path.relpath(d, root)
            dirs[:] = [x for x in dirs if x not in ('.git', 'target') and os.path.join(rd, x) not in ('./contracts/foundry/out', 'contracts/foundry/out')]
            if 'node_modules' not in rd.split(os.sep): continue
            for f in fs:
                p = os.path.relpath(os.path.join(d, f), root); k = 'node_modules/' + p.split('node_modules/')[-1]
                idx.setdefault(k, []).append(p)
        NM[root] = idx
    return NM[root].get(rel, [])
def resolve(root, rel, d):
    if not rel.startswith('node_modules/'): return shaof(root, rel)
    shas = {shaof(root, p) for p in nested(root, rel)}
    return d if d in shas else (sorted(shas)[0] if shas else None)
def check_inputs(name, inputs):
    bad = []; outside = 0; ours = 0
    for rel, d in inputs.items():
        t = resolve(TREE, rel, d)
        if t is None: bad.append(f'{rel} unresolved'); continue
        if t != d: bad.append(f'{rel} recorded {d[:8]} tree {t[:8]}'); continue
        if rel in SOURCE: ours += 1
        else:
            outside += 1
            if resolve(MAIN, rel, d) != d: bad.append(f'{rel} recorded {d[:8]} main {str(resolve(MAIN, rel, d))[:8]}')
    closure[name] = {'inputs': len(inputs), 'fromThisPatch': ours, 'fromCurrentMain': outside, 'mismatches': bad}
    if bad: fail.append(f'{name}: dependency closure differs from current main: ' + '; '.join(bad[:10]))
for g in GENERATED:
    if g.endswith('.package.json'):
        m = json.load(open(os.path.join(TREE, g))); check_inputs(g, m['inputs'])
        if m.get('bundleSha256') and m['bundleSha256'] != shaof(TREE, os.path.join(os.path.dirname(g), m['bundle'])): fail.append(f'{g}: bundle sha differs')
    elif g.endswith('.manifest.json'):
        m = json.load(open(os.path.join(TREE, g))); check_inputs(g, m['inputs'])
        if m['sha256'] != shaof(TREE, m['bundle']): fail.append(f'{g}: bundle sha differs')
# 4. inventory with provenance
prior = touched(PRIOR_PATCH); final = touched(FINAL_PATCH)
def hunks(patch, rel):
    # the +/- lines a patch makes to one file (context excluded): the same change rebased onto a newer main keeps them
    out, on = [], False
    for l in open(patch, encoding='utf-8', errors='replace'):
        if l.startswith('+++ '): on = l[4:].split('\t')[0].strip() == 'b/' + rel; continue
        if l.startswith('--- '): continue
        if on and l[:1] in '+-': out.append(l)
    return out
inv = []
for r in SOURCE:
    prov = []; e = {'path': r, 'change': 'modify' if shaof(MAIN, r) else 'new', 'mainBefore': shaof(MAIN, r), 'after': shaof(TREE, r)}
    if r in prior: prov.append('prior'); e['priorResult'] = shaof(PRIOR_TREE, r)
    if r in final: prov.append('final'); e['finalResult'] = shaof(FINAL_TREE, r)
    cand = e.get('finalResult') or e.get('priorResult')
    if cand != e['after']:
        layer = FINAL_PATCH if r in final else PRIOR_PATCH if r in prior else None
        prov.append('rebased' if layer and e['change'] == 'modify' and hunks(layer, r) == hunks(P, r) else 'composition')
    e['provenance'] = '+'.join(prov); inv.append(e)
dropped = sorted((final | prior) - set(SOURCE))
gen = [{'path': g, 'mainNow': shaof(MAIN, g), 'regenerated': shaof(TREE, g)} for g in GENERATED]
doc = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), 'status': 'candidate source; no production change',
       'base': 'CURRENT main working tree ' + MAIN, 'patch': {'path': os.path.relpath(cas, C), 'sha256': psha, 'lines': sum(c.count(b'\n') for c in chunks)},
       'layers': {'prior': sha(PRIOR_PATCH), 'final': sha(FINAL_PATCH), 'finalExcluded(already integrated in main)': INTEGRATED},
       'files': inv, 'notInPatch': {r: ('already integrated in main (identical bytes)' if r in INTEGRATED else 'removed by the composition (the shared scripts/build-host-service-packages.mjs builds the role)') for r in dropped},
       'generated(not in patch; regenerate after integration)': gen, 'dependencyClosure': closure, 'checks': 'FAILED' if fail else 'ok', 'failures': fail}
json.dump(doc, open('INVENTORY.json', 'w'), indent=2); open('INVENTORY.json', 'a').write('\n')
with open('INVENTORY.txt', 'w') as o:
    o.write(f"CREDIT-VAULT FINAL COMPOSITION: inventory ({doc['at']})\nbase: {doc['base']}\npatch: {doc['patch']['path']} sha256 {psha} ({doc['patch']['lines']} lines)\n")
    o.write(f"layers: prior {doc['layers']['prior']}\n        final {doc['layers']['final']} minus {', '.join(f'{k} ({v})' for k, v in INTEGRATED.items())}\n\n")
    o.write('provenance: prior / final = the file is in that layer and, unless marked otherwise, has exactly that layer\'s result bytes;\n'
            '  +composition = changed in this composition; +rebased = the layer\'s identical +/- lines on a newer main\n\n')
    o.write('PATCH FILES  change  provenance  main-before  after\n')
    for e in inv: o.write(f"{e['path']}  {e['change']}  {e['provenance']}  {(e['mainBefore'] or '-')[:16]}  {e['after']}\n")
    o.write('\nNOT IN THE PATCH\n'); [o.write(f'{r}  {why}\n') for r, why in doc['notInPatch'].items()]
    o.write('\nGENERATED (not in the patch)  main-now  regenerated\n'); [o.write(f"{g['path']}  {(g['mainNow'] or 'NEW')[:16]}  {g['regenerated']}\n") for g in gen]
    o.write('\nDEPENDENCY CLOSURE (generated manifests vs current main + this patch)\n')
    for k, v in closure.items(): o.write(f"{k}: {v['inputs']} inputs, {v['fromThisPatch']} from this patch, {v['fromCurrentMain']} identical to current main, {len(v['mismatches'])} mismatches\n")
    o.write('\nCHECKS: ' + ('ok' if not fail else 'FAILED\n  ' + '\n  '.join(fail)) + '\n')
print(open('INVENTORY.txt').read().split('PATCH FILES')[0] + ('[make-result] ok' if not fail else '[make-result] FAILED:\n  ' + '\n  '.join(fail)))
sys.exit(1 if fail else 0)
EOF
