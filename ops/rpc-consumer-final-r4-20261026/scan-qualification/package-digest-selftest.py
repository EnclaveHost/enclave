#!/usr/bin/python3 -I
"""package-digest-scan-stage qualification (ROOT runs it from jobs/root-package-digest-scan.sh; Claude did not run it).

Every scenario is a scratch git repository whose FIRST commit is the tooling under test (.githooks/ + .gitleaks.toml, committed
through its own hooks; core.hooksPath=.githooks), then ONE commit adding the scenario file through the REAL pre-commit hook
(scan-crypto-keys.py --staged), then a push to a scratch bare remote through the REAL pre-push hook (scanner over the range +
gitleaks with the pushed commit's .gitleaks.toml). Nothing is bypassed (no --no-verify). Generated values are random and are
never printed; the receipt asserts no generated value appears in any captured output.

  --patched DIR   tooling root with the patch applied     --head DIR   tooling root at source HEAD (baseline)
  --file F        the actual staged manifest (pinned sha by the job)   --gitleaks GL   --out DIR (receipt.json)

Expected (patched): actual file at the exact path is allowed by both hooks; a wrong digest, a wrong path, an extra key line, a
real key under a listed name, extra content on a listed line, and a changed setCoinbase digest are refused (by the scanner at
pre-commit and/or gitleaks at pre-push, as stated per case). Baseline (HEAD tooling): the actual file is refused at pre-commit with
exactly the three keyword findings root 1374 saw, and HEAD gitleaks reports exactly labelled 3 + coinbase 1 on it."""
import argparse, json, os, re, secrets, shutil, subprocess, sys, tempfile

PATH = 'ops/rpc-consumer-final-r4-20261026/stage/inputs/regenerated/credit-vault-submitter.package.json'
KEYS = ['node_modules/viem/_esm/accounts/generatePrivateKey.js', 'node_modules/viem/_esm/accounts/privateKeyToAccount.js',
        'node_modules/viem/_esm/accounts/utils/privateKeyToAddress.js']
CB = 'node_modules/viem/_esm/actions/test/setCoinbase.js'
ap = argparse.ArgumentParser()
for k in ('patched', 'head', 'file', 'gitleaks', 'out'):
    ap.add_argument('--' + k, required=True)
a = ap.parse_args()
ACTUAL = open(a.file).read()
tmp = tempfile.mkdtemp(prefix='pds-')
gcfg = os.path.join(tmp, 'gitconfig'); open(gcfg, 'w').close()
hook_tmp = os.path.join(tmp, 'hook-tmp'); os.makedirs(hook_tmp)
ENV = {**os.environ, 'GIT_CONFIG_GLOBAL': gcfg, 'GIT_CONFIG_NOSYSTEM': '1', 'GITLEAKS': a.gitleaks, 'TMPDIR': hook_tmp,
       'GIT_AUTHOR_NAME': 'pds', 'GIT_AUTHOR_EMAIL': 'pds@example.invalid', 'GIT_COMMITTER_NAME': 'pds', 'GIT_COMMITTER_EMAIL': 'pds@example.invalid'}
GENERATED, OUTPUTS, results, failures = [], [], {}, []


def rand64():
    v = secrets.token_hex(32); GENERATED.append(v); return v


def git(cwd, *args):
    p = subprocess.run(['git', *args], cwd=cwd, env=ENV, capture_output=True, text=True, timeout=600)
    OUTPUTS.append(p.stdout + p.stderr)
    return p


def repo(name, tooling, hooks=True):
    r = os.path.join(tmp, name); os.makedirs(r)
    git(r, 'init', '-q', '-b', 'main')
    shutil.copytree(os.path.join(tooling, '.githooks'), os.path.join(r, '.githooks'), ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy(os.path.join(tooling, '.gitleaks.toml'), os.path.join(r, '.gitleaks.toml'))
    if hooks:
        git(r, 'config', 'core.hooksPath', '.githooks')
    git(r, 'add', '-A')
    p = git(r, 'commit', '-q', '-m', 'tooling under test')
    if p.returncode != 0:
        raise SystemExit(f'{name}: the tooling commit itself was refused by its own hooks (rc {p.returncode})')
    remote = os.path.join(tmp, name + '.git'); git(tmp, 'init', '-q', '--bare', remote); git(r, 'remote', 'add', 'origin', remote)
    return r


def put(r, path, text):
    f = os.path.join(r, path); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'w').write(text)


def scenario(name, tooling, files, commit_refused, push_refused):
    r = repo(name, tooling)
    for p, t in files.items():
        put(r, p, t)
    git(r, 'add', '-A')
    c = git(r, 'commit', '-q', '-m', name)
    res = {'commitRefused': c.returncode != 0}
    if c.returncode == 0:
        pu = git(r, 'push', '-q', 'origin', 'main')
        res['pushRefused'] = pu.returncode != 0
    else:
        res['pushRefused'] = None                       # nothing to push: the commit was refused (never bypassed)
    ok = res['commitRefused'] == commit_refused and (push_refused is None or res['pushRefused'] == push_refused)
    res['expected'] = {'commitRefused': commit_refused, 'pushRefused': push_refused}; res['ok'] = ok
    results[name] = res
    if not ok:
        failures.append(name)


def replace_line(text, key, new_value=None, suffix=''):
    rx = re.compile(r'^(\s*"' + re.escape(key) + r'"\s*:\s*")([0-9a-f]{64})(",?)$', re.M)
    assert len(rx.findall(text)) == 1, key
    return rx.sub(lambda m: m.group(1) + (new_value or m.group(2)) + m.group(3) + suffix, text)


def add_entry(text, key, value):
    i = text.index('"' + KEYS[0] + '"')
    return text[:i] + f'"{key}": "{value}",\n    ' + text[i:]


# ---- patched tooling: the actual file is allowed through both real hooks; every negative control is refused
scenario('P0-actual-exact-path', a.patched, {PATH: ACTUAL}, False, False)
scenario('P1-wrong-digest', a.patched, {PATH: replace_line(ACTUAL, KEYS[1], rand64())}, True, None)
scenario('P2-wrong-path', a.patched, {PATH.replace('/regenerated/', '/regenerated/copy/'): ACTUAL}, True, None)
scenario('P3-new-privateKey-entry', a.patched, {PATH: add_entry(ACTUAL, 'node_modules/x/privateKeyBackup.js', rand64())}, True, None)
scenario('P4-real-key-field', a.patched, {PATH: add_entry(ACTUAL, 'privateKey', rand64())}, True, None)
scenario('P5-extra-content-on-listed-line', a.patched, {PATH: replace_line(ACTUAL, KEYS[0], suffix=' "privateKey": "' + rand64() + '"')}, True, None)
scenario('P6-changed-setCoinbase-digest', a.patched, {PATH: replace_line(ACTUAL, CB, rand64())}, False, True)   # gitleaks-only rule
# ---- baseline (HEAD tooling): root 1374's refusal reproduces through the same real hook
scenario('B0-head-actual-exact-path', a.head, {PATH: ACTUAL}, True, None)
# ---- exact rule counts on the actual file (gitleaks git over a plain fixture repo with the file committed; hooks not installed
#      there because this measures CONFIG behaviour only; the hook path is covered by the scenarios above)
counts = {}
for label, tooling in (('head', a.head), ('patched', a.patched)):
    r = repo('count-' + label, tooling, hooks=False)
    put(r, PATH, ACTUAL); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'file')
    rep = os.path.join(tmp, f'gl-{label}.json')
    p = subprocess.run([a.gitleaks, 'git', '--no-banner', '--redact=100', '--config', os.path.join(r, '.gitleaks.toml'),
                        '--report-format', 'json', '--report-path', rep, '--exit-code', '0', r], env=ENV, capture_output=True, text=True, timeout=600)
    OUTPUTS.append(p.stdout + p.stderr)
    found = [f for f in json.load(open(rep)) if f.get('File') == PATH]
    counts[label] = {'rc': p.returncode, 'byRule': {k: sum(1 for f in found if f['RuleID'] == k) for k in sorted({f['RuleID'] for f in found})},
                     'lines': sorted(f.get('StartLine') for f in found)}
    sc = subprocess.run([sys.executable, '-I', os.path.join(r, '.githooks/scan-crypto-keys.py'), '--files', PATH], cwd=r, env=ENV,
                        capture_output=True, text=True, timeout=600)
    OUTPUTS.append(sc.stdout + sc.stderr)
    counts[label]['scannerRc'] = sc.returncode; counts[label]['scannerEthKeyLines'] = len(re.findall(r'eth-key', sc.stdout + sc.stderr))
exp_head = counts['head']['byRule'] == {'coinbase-access-token': 1, 'ethereum-private-key-labelled': 3} and counts['head']['scannerRc'] != 0
exp_patched = counts['patched']['byRule'] == {} and counts['patched']['scannerRc'] == 0
if not exp_head:
    failures.append('baseline gitleaks/scanner counts differ from labelled 3 + coinbase 1 / scanner refusal (see counts)')
if not exp_patched:
    failures.append('patched config/scanner still report the actual file')
leaked = [i for i, v in enumerate(GENERATED) if any(v in o for o in OUTPUTS)]
if leaked:
    failures.append(f'{len(leaked)} generated value(s) appeared in captured hook/scanner/gitleaks output')
doc = {'format': 'package-digest-scan-selftest/v1', 'scenarios': results, 'counts': counts, 'noGeneratedValuePrinted': not leaked,
       'failures': failures, 'pass': not failures}
json.dump(doc, open(os.path.join(a.out, 'receipt.json'), 'x'), indent=1, sort_keys=True)
print(json.dumps({'pass': not failures, 'failures': failures, 'scenarios': {k: v['ok'] for k, v in results.items()}}))
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if not failures else 1)
