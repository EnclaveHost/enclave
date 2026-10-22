#!/usr/bin/env python3
"""Verify (and optionally reconstruct) the external source appendix.

Usage:
  python3 tools/verify_appendix.py --appendix <dir containing MANIFEST.json> \
      --enclave <clone of EnclaveHost/enclave> --enclave-apps <clone of EnclaveHost/enclave-apps> \
      --indexd <clone of SiaFoundation/indexd> [--reconstruct <out dir>]

Each clone must contain the baseline commits listed in MANIFEST.json "baselines"
(fetch EnclaveHost/enclave main + decentralize/nan-retirement, EnclaveHost/enclave-apps
decentralize/wallet-uploads + decentralize/sia-recovery, and SiaFoundation/indexd ddaf24b9).
Plain or bare clones both work. Needs git and patch on PATH.

Checks: every stored file matches stored_sha256; every diff applies to its baseline blob and yields
stored_content_sha256 (or sha256 when no transform was applied). With --reconstruct, writes each
reconstructed file (and its aliases) under <out dir>/<original path>.
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('--appendix', required=True)
ap.add_argument('--enclave', required=True)
ap.add_argument('--enclave-apps', required=True)
ap.add_argument('--indexd', required=True)
ap.add_argument('--reconstruct')
a = ap.parse_args()
REPOS = {'enclave': a.enclave, 'enclave-apps': a.enclave_apps, 'indexd': a.indexd}
SCRATCH_BASE = 'd09f377d0'  # EnclaveHost/enclave decentralize/nan-retirement


def git(repo, *args):
    gd = REPOS[repo]
    pre = ['--git-dir', gd] if gd.endswith('.git') else ['-C', gd]
    return subprocess.run(['git', *pre, *args], capture_output=True)


def sha(b): return hashlib.sha256(b).hexdigest()


m = json.load(open(os.path.join(a.appendix, 'MANIFEST.json')))
tmp = tempfile.mkdtemp()
bad = nd = 0
for e in m['entries']:
    stored = open(os.path.join(a.appendix, e['stored']), 'rb').read()
    if sha(stored) != e['stored_sha256']:
        print('HASH MISMATCH', e['stored']); bad += 1; continue
    content = stored
    if e.get('kind') == 'diff':
        if e['group'] == 'workspace-diff':
            r = git(e['baseline'].split('@')[0], 'cat-file', 'blob', e['baseline_blob'])
        elif e['baseline'].startswith('enclave@'):
            r = git('enclave', 'cat-file', 'blob', SCRATCH_BASE + ':' + e['path'])
        else:
            r = subprocess.CompletedProcess([], 0, b'', b'')  # new file: empty baseline
        if r.returncode:
            print('BASELINE MISSING', e['stored'], r.stderr.decode().strip()[:120]); bad += 1; continue
        base = os.path.join(tmp, 'base'); open(base, 'wb').write(r.stdout)
        p = subprocess.run(['patch', '-s', '-o', base + '.out', base], input=stored, capture_output=True)
        content = open(base + '.out', 'rb').read() if p.returncode == 0 else None
        want = e.get('stored_content_sha256', e['sha256'])
        if content is None or sha(content) != want:
            print('RECONSTRUCT FAIL', e['stored']); bad += 1; continue
        nd += 1
    if a.reconstruct and e.get('path'):
        dsts = [e['path']] + e.get('aliases', [])
        if e['group'] == 'scratch-repo-snapshot-diff':
            dsts = ['scratch-repos/%s/%s/%s' % (e['repo'].replace('/', '__'), e['commit'][:12], e['path'])]
        for dst in dsts:
            out = os.path.join(a.reconstruct, dst)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'wb').write(content)
shutil.rmtree(tmp)
print('entries', len(m['entries']), 'diffs reconstructed', nd, 'failures', bad)
sys.exit(1 if bad else 0)
