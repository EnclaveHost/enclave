#!/usr/bin/python3 -I
"""shared-hook-digest-stage: DUAL-hook qualification (ROOT runs it from jobs/root-shared-hook-digest.sh; Claude did not run it).

Reproduces the real layout: the repository's core.hooksPath is an ABSOLUTE path to a shared hooks directory (here a PRIVATE mirror
of /home/steven/Projects/enclave/.githooks, never the live one), whose pre-commit/pre-push run BOTH the committing tree's own
.githooks/scan-crypto-keys.py and the shared copy when they differ (and pre-push also runs gitleaks with the pushed .gitleaks.toml).
Each scratch repo: commit 1 = source HEAD tooling (.githooks + .gitleaks.toml) through the hooks; commit 2 = the change under test
(the patched tree scanner/config as root staged them + the scenario file) through the REAL pre-commit; then a push to a scratch bare
remote through the REAL pre-push. No --no-verify. Random values are never printed (asserted).

  --mirror-current D --mirror-patched D   shared-hooks mirrors (current 613a0e11 / patched 3257213d), each D/.githooks
  --src-head D                           source HEAD tooling root (.githooks + .gitleaks.toml)
  --src-scanner F --src-config F         the source PATCHED scanner (3257213d) and .gitleaks.toml (f1c149d6)
  --file F --gitleaks GL --out D"""
import argparse, json, os, re, secrets, shutil, subprocess, sys, tempfile

PATH = 'ops/rpc-consumer-final-r4-20261026/stage/inputs/regenerated/credit-vault-submitter.package.json'
KEYS = ['node_modules/viem/_esm/accounts/generatePrivateKey.js', 'node_modules/viem/_esm/accounts/privateKeyToAccount.js',
        'node_modules/viem/_esm/accounts/utils/privateKeyToAddress.js']
CB = 'node_modules/viem/_esm/actions/test/setCoinbase.js'
ap = argparse.ArgumentParser()
for k in ('mirror-current', 'mirror-patched', 'src-head', 'src-scanner', 'src-config', 'file', 'gitleaks', 'out'):
    ap.add_argument('--' + k, required=True)
a = ap.parse_args()
ACTUAL, PSCAN, PCFG = open(a.file).read(), open(a.src_scanner).read(), open(a.src_config).read()
tmp = tempfile.mkdtemp(prefix='dual-')
gcfg = os.path.join(tmp, 'gitconfig'); open(gcfg, 'w').close()
hook_tmp = os.path.join(tmp, 'hook-tmp'); os.makedirs(hook_tmp)
ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': gcfg, 'GIT_CONFIG_NOSYSTEM': '1', 'GITLEAKS': a.gitleaks, 'TMPDIR': hook_tmp,
       'GIT_AUTHOR_NAME': 'dual', 'GIT_AUTHOR_EMAIL': 'dual@example.invalid', 'GIT_COMMITTER_NAME': 'dual', 'GIT_COMMITTER_EMAIL': 'dual@example.invalid'}
GENERATED, OUTPUTS, results, failures = [], [], {}, []
MIRROR = {'current': os.path.abspath(os.path.join(a.mirror_current, '.githooks')), 'patched': os.path.abspath(os.path.join(a.mirror_patched, '.githooks'))}


def rand64():
    v = secrets.token_hex(32); GENERATED.append(v); return v


def git(cwd, *args):
    p = subprocess.run(['git', *args], cwd=cwd, env=ENV, capture_output=True, text=True, timeout=600)
    OUTPUTS.append(p.stdout + p.stderr); return p


def put(r, path, text):
    f = os.path.join(r, path); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'w').write(text)


def scenario(name, mirror, tree_scanner_patched, files, commit_refused, push_refused):
    r = os.path.join(tmp, name); os.makedirs(r)
    git(r, 'init', '-q', '-b', 'main')
    shutil.copytree(os.path.join(a.src_head, '.githooks'), os.path.join(r, '.githooks'), ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy(os.path.join(a.src_head, '.gitleaks.toml'), os.path.join(r, '.gitleaks.toml'))
    git(r, 'config', 'core.hooksPath', MIRROR[mirror])                 # ABSOLUTE shared hooks path, as in the real repository config
    git(r, 'add', '-A')
    if git(r, 'commit', '-q', '-m', 'source HEAD tooling').returncode != 0:
        raise SystemExit(f'{name}: the HEAD tooling commit was refused by the hooks')
    remote = os.path.join(tmp, name + '.git'); git(tmp, 'init', '-q', '--bare', remote); git(r, 'remote', 'add', 'origin', remote)
    if tree_scanner_patched:
        put(r, '.githooks/scan-crypto-keys.py', PSCAN)
    put(r, '.gitleaks.toml', PCFG)
    for p, t in files.items():
        put(r, p, t)
    git(r, 'add', '-A')
    c = git(r, 'commit', '-q', '-m', name)
    res = {'mirror': mirror, 'treeScannerPatched': tree_scanner_patched, 'commitRefused': c.returncode != 0,
           'refusals': len(re.findall(r'^\s*\[eth-key\]', c.stdout + c.stderr, re.M))}
    res['pushRefused'] = (git(r, 'push', '-q', 'origin', 'main').returncode != 0) if c.returncode == 0 else None
    res['expected'] = {'commitRefused': commit_refused, 'pushRefused': push_refused}
    res['ok'] = res['commitRefused'] == commit_refused and (push_refused is None or res['pushRefused'] == push_refused)
    results[name] = res
    if not res['ok']:
        failures.append(name)
    return res


def replace_line(text, key, new_value=None, suffix=''):
    rx = re.compile(r'^(\s*"' + re.escape(key) + r'"\s*:\s*")([0-9a-f]{64})(",?)$', re.M)
    assert len(rx.findall(text)) == 1, key
    return rx.sub(lambda m: m.group(1) + (new_value or m.group(2)) + m.group(3) + suffix, text)


def add_entry(text, key, value):
    i = text.index('"' + KEYS[0] + '"')
    return text[:i] + f'"{key}": "{value}",\n    ' + text[i:]


# the failure root 1385 saw, then the fix, then each scanner still enforcing on its own
s1 = scenario('S1-shared-current-tree-patched', 'current', True, {PATH: ACTUAL}, True, None)
if s1['commitRefused'] and s1['refusals'] != 6:
    failures.append(f"S1 expected the 6 shared-scanner findings of root 1385, saw {s1['refusals']}")
scenario('S2-shared-patched-tree-patched', 'patched', True, {PATH: ACTUAL}, False, False)
scenario('S3-shared-patched-tree-HEAD-scanner', 'patched', False, {PATH: ACTUAL}, True, None)
# negative controls with BOTH scanners patched
scenario('N1-wrong-digest', 'patched', True, {PATH: replace_line(ACTUAL, KEYS[1], rand64())}, True, None)
scenario('N2-wrong-path', 'patched', True, {PATH.replace('/regenerated/', '/regenerated/copy/'): ACTUAL}, True, None)
scenario('N3-new-privateKey-entry', 'patched', True, {PATH: add_entry(ACTUAL, 'node_modules/x/privateKeyBackup.js', rand64())}, True, None)
scenario('N4-real-key-field', 'patched', True, {PATH: add_entry(ACTUAL, 'privateKey', rand64())}, True, None)
scenario('N5-extra-content-on-listed-line', 'patched', True, {PATH: replace_line(ACTUAL, KEYS[0], suffix=' "privateKey": "' + rand64() + '"')}, True, None)
scenario('N6-changed-setCoinbase-digest', 'patched', True, {PATH: replace_line(ACTUAL, CB, rand64())}, False, True)
leaked = [i for i, v in enumerate(GENERATED) if any(v in o for o in OUTPUTS)]
if leaked:
    failures.append(f'{len(leaked)} generated value(s) appeared in captured hook output')
doc = {'format': 'shared-hook-digest-dual-selftest/v1', 'scenarios': results, 'noGeneratedValuePrinted': not leaked,
       'failures': failures, 'pass': not failures}
json.dump(doc, open(os.path.join(a.out, 'receipt.json'), 'x'), indent=1, sort_keys=True)
print(json.dumps({'pass': not failures, 'failures': failures, 'scenarios': {k: v['ok'] for k, v in results.items()}}))
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if not failures else 1)
