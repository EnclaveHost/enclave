"""Export the 07:45Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* d-linux-carrier   linux-carrier-closure/repo           fec43a6a -> 4cdd4622 .. fad657bc (19: carriers, harness, test fixes,
                                                          admin-CLI + A 71448f63 + B 8d110101 + ROOT fd6a1762 cherry-picks, bundles)
* s-holder-final    fresh-witness-supply                 f6de2364 -> ea504aa1 .. 47c2f71f (10: root fixes integrated, official
                                                          binary preflight 6b9dae92, budget 2681e8a6/9f1492fb, budget v2 959e56fd/47c2f71f)
* root-wallet-fix   root-wallet-rpc-fix                  ROOT -> ed071dc -> 320d7e9f (ROOT WalletConnect independent-RPC fix)
* root-cache-budget root-cache-budget-review             ROOT -> 08fffd5a (ROOT reproduction of uncharged allocation)
ROOT dc767fc3 (doc-only, on 47c2f71f) is preserved as CONTENT ONLY (frozen-0745-dc767fc3-doc-correction.txt): its commit identity
is not the noreply identity, so its commit object/patch is not published.
Bases: fec43a6a and f6de2364 are heads preserved in 871e2197 (frozen-0630-export); the rest are root commits.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0745-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '871e21975828c0b9aea463ba6c7affd249a71732'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
FEC = 'fec43a6a08da2ac287fb3a5c42de89f096f4f678'
SIDES = {
    'd-linux-carrier': {
        'repo': base / 'linux-carrier-closure/repo', 'name': 'd-linux-carrier-fad657bc', 'branch': 'linux-carrier-closure',
        'base': FEC, 'head': 'fad657bc5626166bde1bde4454ec4f73d23dde47',
        'commits': ['4cdd4622', '9a00b983', '65f3fb98', '95d86a59', 'd292b930', '1d3f2e4f', '4a35bec0', 'ea336bc3', '2afb9d5c',
                    '25a3dffd', '03d588e4', '4f5a789e', 'b6bc6b6c', 'b6fd6a00', 'a177ce8c', 'a76a86ee', '280d2849', '714aa0dc', 'fad657bc'],
        'baseProvenance': 'fec43a6a preserved in 871e2197 as frozen-0630-export/d-linux-fec43a6a (on 493ee9ee)'},
    's-holder-final': {
        'repo': root / 'work/fresh-witness-supply', 'name': 's-holder-final-47c2f71f', 'branch': 'master',
        'base': 'f6de2364a593bc4f49ea8bbe98fc0b44f4adb71a', 'head': '47c2f71f472c973593702b310017f9fd4744e6d1',
        'commits': ['ea504aa', '08f2efe', '1a50957', 'fd0134d', 'eb32894', '6b9dae9', '2681e8a', '9f1492f', '959e56f', '47c2f71'],
        'baseProvenance': 'f6de2364 preserved in 871e2197 as frozen-0630-export/s-holder-f6de2364'},
    'root-wallet-fix': {
        'repo': base / 'root-wallet-rpc-fix', 'name': 'root-wallet-fix-320d7e9f', 'branch': 'master',
        'base': None, 'head': '320d7e9fdbb14b7297225802023ce0b471cc205f', 'commits': ['ed071dc', '320d7e9'],
        'baseProvenance': 'root commit (ROOT standalone repo; ed071dc captures the wallet module from e820e2405)'},
    'root-cache-budget': {
        'repo': base / 'root-cache-budget-review', 'name': 'root-cache-budget-08fffd5a', 'branch': 'master',
        'base': None, 'head': '08fffd5aa26e9eb8f50fbc90f61efcac569df16d', 'commits': ['08fffd5'],
        'baseProvenance': 'root commit (ROOT standalone review repo)'},
}
L = 'linux-carrier-closure/'
FROZEN = [L + n for n in ('RESULT.md', 'TEST-EVIDENCE.txt', 'PROGRESS.txt')] + \
    [L + 'tools/' + n for n in ('env.sh', 'q.sh', 'c0-repo.sh', 't1-tests.sh', 't2-compose.sh', 'b2-bundles.sh', 'union-check.py',
                                'input-closure.py', 't3-final.sh', 't4-head.sh', 'make-test-evidence.py')] + \
    [L + 'receipts/' + n for n in ('union-check.json', 'union-check-final.json', 'input-closure-head.json', 'input-closure-carrier-only.json',
                                   'gitleaks-range.json', 'patches.sha256', 'commits.txt')] + \
    ['source-preservation/frozen-0745-dc767fc3-doc-correction.txt']
RC_GLOB = (L + 'receipts', 't[124]-*.rc')
ROOT_EVIDENCE = [
    *[f'root-wallet-rpc-review/{n}' for n in ('PIN.json', 'fixed.guard.log', 'negative-check.guard.log', 'negative-control.py', 'negative.out',
                                              'probe-and-checkpoint.guard.log', 'probe.mjs', 'run.sh', 'standard-runner.guard.log',
                                              'standard-runner.out', 'wallet.frozen.js', 'walletconnect-profile.patch')],
    *[f'root-storage-cutover-review/{n}' for n in ('base-public-receipt.json', 'frozen-cutover.py', 'probe.guard.log', 'probe.py', 'vm-state.txt')],
    'storage-write-release/ROOT-CUTOVER-FRESHNESS-REVIEW.txt', 'rpc-priority/ROOT-BROWSER-RPC-NEXT.txt', '../fresh-witness-supply/ROOT-BUDGET-ROUNDING-REVIEW.txt',
    'node-updater-readonly/check-0713.py', 'node-updater-readonly/check-0713.guard.log',
    *[f'../../outputs/decentralization-audit/{n}' for n in (
        'browser-wallet-rpc-bypass-20261023.json', 'browser-wallet-rpc-fix-20261023.json', 'cache-budget-allocation-accounting-20261023.json',
        'cache-budget-v2-review-20261023.json', 'checkpoint-verified-0650-20261023.json', 'storage-cutover-backup-freshness-review-20261023.json',
        'windows-node-updater-0713-postcheck-20261023.json')],
]


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec):
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip() if spec['base'] else None
    assert base_full == spec['base'], key
    rng = f'{base_full}..{head}' if base_full else head
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == (base_full or ''), f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a linear series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755', '120000'), (path, mode)   # 120000: files/ holds the link text; the patch carries the link
        data.decode('utf-8')   # every authored file is text; a binary aborts the export
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status == 'M' else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]))
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
    reach = (subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
             if spec['branch'] else None)
    return {'repo': str(repo.relative_to(root)), 'branch': spec['branch'], 'headReachableFromBranch': reach,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()

sides = {k: export(k, s) for k, s in SIDES.items()}
files = {k: {f['path']: f.get('sha256') for f in v['changedFiles']} for k, v in sides.items()}
assert all(s['headReachableFromBranch'] in (True, None) for s in sides.values()), {k: s['headReachableFromBranch'] for k, s in sides.items()}
# ---- the facts the labels assert ------------------------------------------------------------------------------------------
assert sides['d-linux-carrier']['headTree'] == '5e2e43319e1041d45ee1ab313ddb7e48e4cdbfd1'
assert files['d-linux-carrier']['windows/node/host-admission.bundle.mjs'] == '2dba0cebe450eeaeee39db6a2344f7790d549ccc6f9774f4f1bc6b5a8f39278b'
assert files['d-linux-carrier']['metal/guest/host-policy.bundle.mjs'] == '9a6aa25a1995384aa8bf6cccacd5fedc0af61d0b641c67819b0c639d0d2b1b59'
assert 'supervisor.js' not in files['d-linux-carrier'] and 'egress.js' not in files['d-linux-carrier']
uc = json.loads((base / 'linux-carrier-closure/receipts/union-check-final.json').read_text()); assert uc['ok'] is True
assert all(json.loads((base / 'linux-carrier-closure/receipts/input-closure-head.json').read_text())[k] for k in ('npmPackagesOk',))
audit = root / 'outputs/decentralization-audit'
cv = json.loads((audit / 'checkpoint-verified-0650-20261023.json').read_text())
assert '871e21975828c0b9aea463ba6c7affd249a71732' in json.dumps(cv) and '7752a4239b3bec2cf452491cd1b95164a8c2bdb8' in json.dumps(cv)
u = json.loads((audit / 'windows-node-updater-0713-postcheck-20261023.json').read_text())
assert u['updater']['result'] == 0 and u['matchesReviewedRuntime'] is True and u['runningApps'] == 9
# ---- reports and root evidence: hashed only -------------------------------------------------------------------------
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
for p in sorted((base / RC_GLOB[0]).glob(RC_GLOB[1])):
    frozen[str(p.relative_to(base))] = sha(p.read_bytes())
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {
    'format': 'enclave-frozen-0745-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged, deployed or activated. D\'s Linux carrier '
              'closure + A/B/ROOT composition fad657bc (ready for final composition; needs B\'s final runtime), S\'s final cache budget v2 '
              '47c2f71f (source accepted for composition, NOT device proof), '
              'ROOT\'s WalletConnect fix 320d7e9f and ROOT\'s cache-budget review 08fffd5a. Active trees past these heads are not captured.'),
    'sides': sides,
    'frozenSources': frozen,
    'rootEvidence': evidence,
    'notPreserved': [
        'ROOT dc767fc3 commit object/patch (non-noreply identity): content only, frozen-0745-dc767fc3-doc-correction.txt',
        'E initial L1 transaction head a460c36c/159fd1480ddab9652043cce5163348ff4fa6996b (rpc-transaction-independence): its commits carry 7 '
        'compiled contract artifacts (fixtures/artifacts/*.json, ABI + bytecode); build outputs are not archived, so root decides how to '
        'preserve it (e.g. the artifacts by hash plus the recipe)',
        'every active tree past the exported heads (E rpc-transaction-closure, S browser-rpc-closure, B, C storage-write-release, F)',
        'linux-carrier-closure rawlogs/, tmp/, draft/, stub/ and repo/ worktree; the patches/ dir (= this export\'s patches)',
        'raw logs outside committed history, run handles, keys, binaries, images, node_modules, build caches'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))
