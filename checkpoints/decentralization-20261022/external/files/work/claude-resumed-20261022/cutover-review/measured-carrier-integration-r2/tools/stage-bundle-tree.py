#!/usr/bin/env python3
"""stage-bundle-tree.py <out dir> [--measured-control FILE]

A NEW REAL tree (no symlink anywhere) for the UNCHANGED builder scripts/build-platform-api-guest-bundle.mjs (d9857128), staged
CONTENT-ADDRESSED from the reviewed provenance of the current bundle 2a903c36 (resume-20261021/platform-bundle-smoke/
job-integrated-build-v1.sh: reconciled-candidate + work/enclave node_modules, relay/build-network.mjs first). Every one of the
2195 inputs of the current manifest is copied from the FIRST source whose bytes have exactly the manifest's sha256:
  1. resume-20261021/reconciled-candidate                       (the candidate tree that job copied)
  2. work/enclave working tree                                  (the node_modules that job copied)
  3. git object e762a9c5:<path> of work/enclave                 (read with `git show`; work/enclave is never written)
  4. relay/network-runtime.bundle.mjs <- platform-bundle-smoke/integrated-out/network-runtime.bundle.mjs.prereq
     (the generated prerequisite that same reviewed build produced and saved)
No input may be missing or differ. Also staged: the package.json files esbuild's resolver reads (input ancestors from the
candidate; each node_modules package's own from work/enclave, as the job did), the sidecar source, the builder, the current
bundle + manifest (for --check) and the esbuild TOOL (node_modules/esbuild + @esbuild/linux-x64; not a bundle input).
--measured-control FILE replaces metal/guest/measured-control.mjs, the ONLY intended source change. Prints a JSON inventory."""
import hashlib, json, os, shutil, subprocess, sys
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
CAND, ENCLAVE, REV = f'{W}/resume-20261021/reconciled-candidate', f'{W}/enclave', 'e762a9c5'
PREREQ = {'relay/network-runtime.bundle.mjs': f'{W}/resume-20261021/platform-bundle-smoke/integrated-out/network-runtime.bundle.mjs.prereq'}
MANIFEST, BUILDER = 'metal/guest/platform-api.bundle.mjs.manifest.json', 'scripts/build-platform-api-guest-bundle.mjs'
BUILDER_SHA = 'd985712862a666c7ddd8a835b262db7a7da16933d26797daf81f43e70529290e'   # INTEGRATION-RESULT.json "after"
BUNDLE_SHA = '2a903c362eecbde7e7bd75da75ed98c0eee93086b180cb8722aefb2b2588c578'
TOOLS = ['node_modules/esbuild', 'node_modules/@esbuild/linux-x64']
h = lambda b: hashlib.sha256(b).hexdigest()
def read(p):
    try:
        with open(p, 'rb') as f: return f.read()
    except OSError: return None
def git_blob(rel):
    r = subprocess.run(['git', '-C', ENCLAVE, 'show', f'{REV}:{rel}'], capture_output=True, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    return r.stdout if r.returncode == 0 else None

def main(argv):
    out = os.path.abspath(argv[0]); override = None
    if '--measured-control' in argv: override = os.path.abspath(argv[argv.index('--measured-control') + 1])
    if os.path.exists(out): sys.exit(f'{out} exists: a new tree only')
    m = json.loads(read(os.path.join(CAND, MANIFEST)))
    if m['sha256'] != BUNDLE_SHA: sys.exit('the candidate manifest is not the 2a903c36 bundle')
    def put(rel, data):
        dst = os.path.join(out, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f: f.write(data)
    origin, missing = {}, []
    for rel, want in m['inputs'].items():
        if rel == 'metal/guest/measured-control.mjs' and override:
            put(rel, read(override)); origin[rel] = 'override'; continue
        for name, get in (('candidate', lambda: read(os.path.join(CAND, rel))), ('enclave', lambda: read(os.path.join(ENCLAVE, rel))),
                          (f'git:{REV}', lambda: git_blob(rel)), ('prereq', lambda: read(PREREQ[rel]) if rel in PREREQ else None)):
            data = get()
            if data is not None and h(data) == want: put(rel, data); origin[rel] = name; break
        else: missing.append(rel)
    if missing: sys.exit(f'no source has the manifest bytes of: {missing[:8]}')
    pkgs, anc = set(), set()
    for rel in m['inputs']:
        parts = rel.split('/')
        for i in range(len(parts) - 1, -1, -1): anc.add('/'.join(parts[:i] + ['package.json']))
        nm = [i for i, p in enumerate(parts) if p == 'node_modules']
        if nm:
            j = nm[-1]; pkgs.add('/'.join(parts[:j + 2 + (1 if parts[j + 1].startswith('@') else 0)]))
    pj = {}
    for a in anc:
        if '/node_modules/' in '/' + a: continue
        d = read(os.path.join(CAND, a))
        if d is not None: pj[a] = ('candidate', d)
    for p in pkgs:
        for d, dirs, files in os.walk(os.path.join(ENCLAVE, p)):
            dirs[:] = [x for x in dirs if x != 'node_modules']
            if 'package.json' in files:
                rel = os.path.relpath(os.path.join(d, 'package.json'), ENCLAVE); pj[rel] = ('enclave', read(os.path.join(d, 'package.json')))
    for rel, (_, data) in pj.items(): put(rel, data)
    for beside, s in m.get('sidecars', {}).items():
        data = read(os.path.join(CAND, s['source']))
        if data is None or h(data) != s['sha256']: sys.exit(f'sidecar {s["source"]} differs from the manifest')
        put(s['source'], data)
    b = read(os.path.join(CAND, BUILDER))
    if h(b) != BUILDER_SHA: sys.exit('the candidate builder is not d9857128')
    put(BUILDER, b); put(MANIFEST, read(os.path.join(CAND, MANIFEST))); put('metal/guest/platform-api.bundle.mjs', read(os.path.join(CAND, 'metal/guest/platform-api.bundle.mjs')))
    for t in TOOLS:
        for d, dirs, files in os.walk(os.path.join(ENCLAVE, t)):
            for f in files: put(os.path.relpath(os.path.join(d, f), ENCLAVE), read(os.path.join(d, f)))
    os.chmod(os.path.join(out, 'node_modules/@esbuild/linux-x64/bin/esbuild'), 0o755)
    for d, dirs, files in os.walk(out):
        for x in dirs + files:
            if os.path.islink(os.path.join(d, x)): sys.exit(f'symlink in the staged tree: {os.path.join(d, x)}')
    from collections import Counter
    print(json.dumps({'out': out, 'inputs': len(m['inputs']), 'inputOrigins': dict(Counter(origin.values())),
                      'nonCandidateInputs': {k: v for k, v in origin.items() if v not in ('candidate', 'enclave')},
                      'packageJson': {'count': len(pj), 'sha256': h(json.dumps({k: h(v[1]) for k, v in sorted(pj.items())}, sort_keys=True).encode())},
                      'override': override and h(read(override)), 'builderSha256': BUILDER_SHA, 'currentBundleSha256': BUNDLE_SHA,
                      'esbuild': json.loads(read(os.path.join(ENCLAVE, 'node_modules/esbuild/package.json')))['version']}, indent=1))

if __name__ == '__main__': main(sys.argv[1:])
