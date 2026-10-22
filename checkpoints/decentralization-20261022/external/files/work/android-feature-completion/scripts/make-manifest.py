#!/usr/bin/env python3
# The feature-completion manifest: the patch (pristine -> tree, deterministic headers), each changed file's base and new
# sha256, every artifact (bytes + sha256), and every suite's TAP counts with its log's sha256. Read-only on what it hashes.
import hashlib, json, os, re, subprocess, datetime
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
diff = subprocess.run(['diff', '-ruN', '-x', 'node_modules', '-x', 'target', '-x', 'out', '-x', 'out-*', '-x', '.claude', 'pristine', 'tree'], cwd=H, capture_output=True, text=True).stdout
patch = re.sub(r'^((?:---|\+\+\+) [^\t\n]+)\t[^\n]*', r'\1', diff, flags=re.M)
open(os.path.join(H, 'android-feature-completion.patch'), 'w').write(patch)
files = []
for m in re.finditer(r'^diff .* pristine/(\S+) tree/\S+$', patch, flags=re.M):
    rel = m.group(1); b = os.path.join(H, 'pristine', rel); t = os.path.join(H, 'tree', rel)
    files.append({'path': rel, 'base': sha(b) if os.path.exists(b) else None, 'new': sha(t) if os.path.exists(t) else None})
art = {}
for root, _, fs in os.walk(os.path.join(H, 'artifacts')):
    for f in sorted(fs):
        p = os.path.join(root, f); rel = os.path.relpath(p, H)
        if rel.endswith('.log') or '/classes/' in rel or '/gen/' in rel or '/stub/' in rel or rel.endswith('.o') or '/deployed-shared/' in rel: continue
        art[rel] = {'sha256': sha(p), 'bytes': os.path.getsize(p)}
suites = {}
for f in sorted(os.listdir(os.path.join(H, 'logs'))):
    if not f.endswith('.log') or f.endswith('.guard.log'): continue
    t = open(os.path.join(H, 'logs', f), errors='replace').read()
    c = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|skipped|cancelled) (\d+)$', t, flags=re.M)}
    if c: suites[f[:-4]] = {**c, 'logSha256': sha(os.path.join(H, 'logs', f))}
# which runs count: the last run of every group (final3-* supersedes final-* for the same group), and the pristine baseline
final = {k for k in suites if k.startswith('final-') and ('final3-' + k[6:]) not in suites} | {k for k in suites if k.startswith('final3-')}
for k in suites: suites[k]['final'] = k in final
for k in suites:
    if k.startswith('base-'): suites[k]['baselineFor'] = 'final3-' + k[5:] if ('final3-' + k[5:]) in suites else 'final-' + k[5:]
m = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'base': open(os.path.join(H, 'BASE.txt')).read().strip().splitlines(),
     'patch': {'file': 'work/android-feature-completion/android-feature-completion.patch', 'sha256': hashlib.sha256(patch.encode()).hexdigest(), 'files': len(files)},
     'files': files, 'artifacts': art, 'suites': suites, 'signed': False, 'installed': False, 'productionActivated': False}
json.dump(m, open(os.path.join(H, 'MANIFEST.json'), 'w'), indent=1)
print(json.dumps({'patch': m['patch'], 'files': len(files), 'artifacts': len(art), 'suites': {k: f"{v.get('pass')}/{v.get('tests')}" for k, v in suites.items()}}, indent=1))
