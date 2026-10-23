"""Export the 06:30Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

Root-terminal / root-reviewed immutable heads since checkpoint 8ac1aa51 (ROOT-PENDING-LATEST.txt and the notes it names):
* root-kernel-lock         root-rpc-kernel-lock                 ROOT -> 794d2ff3 -> 336ea56a (parent-owned kernel lock + export)
* root-snapshot-lifecycle  verified-snapshot-lifecycle-fix      2efc4a83 -> fd6a1762 (ROOT: close verified snapshots)
* a-native-relay           rpc-priority/repo                    2efc4a83 -> 71448f63 (A: verifier through relay/issuer/launchers)
* p-deadline               witness-failover/repo                7b4dd692 -> 7b4e8c68 -> d0775541 (P: block responses, deadlines)
* e-history                rpc-sia-cache/history-compose/repo   7b4dd692 -> 96b877b7 -> 6a058877 -> afc443e0 (E prior history)
* p-compose                witness-cache-deadline-compose/repo  d0775541 -> 8389e983 .. 9e838ba7 (P FINAL composition)
* c-carriers               windows-host-services-compose/cand.  427780bb -> 0757085e (C: host-service gate carriers)
* f-lifecycle              host-service-lifecycle/candidate     427780bb -> 24fb993c -> 862f6549 -> 6c38c048 (F lifecycle)
* s-holder                 fresh-witness-supply                 ROOT -> 0cec8c65 .. 1773ab60 -> f6de2364 (S holder, root fixes)
* root-holder              root-holder-stop-ownership           f6de2364 -> b1b6f184 -> c3efff41 (ROOT stop/unwind fixes)
* d-linux-fec              linux-runtime-release/src            493ee9ee -> fbeab506 .. fec43a6a (D+ROOT on the image commit)

Every base is a head already preserved in checkpoint 8ac1aa51, a head exported in THIS batch, a root commit, or (493ee9ee)
an ancestor of the pushed origin/candidate/decentralized-control-20261022 (dfe020abf); verify-frozen-0630-export.py
rebuilds each. Per side: a format-patch series and every changed file at its head blob. No binaries. Reports and root
evidence are only hashed here; capture-frozen-0630.py refuses to copy anything whose bytes changed after this export.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0630-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '8ac1aa51c36ec4e8a1fa3d5a60c0438a721190ab'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
A2EFC = '2efc4a83ec6636f875fa4523d50674bda06bcdcb'
P7B4 = '7b4dd69201d00bc5649cda6bcf57b21c6197c3af'
C427 = '427780bbc0fc524f8091893614eae8a653518139'

SIDES = {
    'root-kernel-lock': {
        'repo': base / 'root-rpc-kernel-lock', 'name': 'root-kernel-lock-336ea56a', 'branch': 'master',
        'base': None, 'head': '336ea56ab458fa4f80481f332fd44f3bf88ded1f', 'commits': ['794d2ff3', '336ea56a'],
        'baseProvenance': 'root commit (standalone ROOT repo)'},
    'root-snapshot-lifecycle': {
        'repo': base / 'verified-snapshot-lifecycle-fix', 'name': 'root-snapshot-lifecycle-fd6a1762', 'branch': 'fix/verified-snapshot-lifecycle',
        'base': A2EFC, 'head': 'fd6a1762ed1218d5d32fb43df2ccb97caa2b17e4', 'commits': ['fd6a1762'],
        'baseProvenance': '2efc4a83 preserved in 8ac1aa51 as frozen-0420-export/a-policy-callers-2efc4a83'},
    'a-native-relay': {
        'repo': base / 'rpc-priority/repo', 'name': 'a-native-relay-71448f63', 'branch': 'rpc-priority',
        'base': A2EFC, 'head': '71448f63ba189b1f61153e7df766f9421b350205', 'commits': ['71448f63'],
        'baseProvenance': '2efc4a83 preserved in 8ac1aa51 as frozen-0420-export/a-policy-callers-2efc4a83'},
    'p-deadline': {
        'repo': base / 'witness-failover/repo', 'name': 'p-deadline-d0775541', 'branch': 'witness-failover',
        'base': P7B4, 'head': 'd0775541db0a0cb599cfe5c7b3853e24242aaaec', 'commits': ['7b4e8c68', 'd0775541'],
        'baseProvenance': '7b4dd692 preserved in 34723cba as frozen-0410-export/p-real-history-7b4dd692'},
    'e-history': {
        'repo': base / 'rpc-sia-cache/history-compose/repo', 'name': 'e-history-afc443e0', 'branch': 'work/sia-history-compose',
        'base': P7B4, 'head': 'afc443e032647c2d8ea31535f5ff0f6609d99ba6', 'commits': ['96b877b7', '6a058877', 'afc443e0'],
        'baseProvenance': '7b4dd692 preserved in 34723cba as frozen-0410-export/p-real-history-7b4dd692'},
    'p-compose': {
        'repo': base / 'witness-cache-deadline-compose/repo', 'name': 'p-compose-9e838ba7', 'branch': 'witness-cache-deadline-compose',
        'base': 'd0775541db0a0cb599cfe5c7b3853e24242aaaec', 'head': '9e838ba758b96f96eb9858e35f4898a95fc5cba7',
        'commits': ['8389e983', 'e2ffb7aa', '52bb57ff', '9e838ba7'],
        'baseProvenance': 'd0775541 = this export\'s p-deadline head'},
    'c-carriers': {
        'repo': base / 'windows-host-services-compose/candidate', 'name': 'c-carriers-0757085e', 'branch': 'compose/host-services',
        'base': C427, 'head': '0757085e5b78ed38efc11920fb3cf4a25d7dfc4d', 'commits': ['0757085e'],
        'baseProvenance': '427780bb preserved in 34723cba as frozen-0410-export/c-host-services-cold-427780bb'},
    'f-lifecycle': {
        'repo': base / 'host-service-lifecycle/candidate', 'name': 'f-lifecycle-6c38c048', 'branch': 'fix/host-service-lifecycle',
        'base': C427, 'head': '6c38c0489d769db12e5037e7c20f7372e56d5620', 'commits': ['24fb993c', '862f6549', '6c38c048'],
        'baseProvenance': '427780bb preserved in 34723cba as frozen-0410-export/c-host-services-cold-427780bb'},
    's-holder': {
        'repo': root / 'work/fresh-witness-supply', 'name': 's-holder-f6de2364', 'branch': 'master',
        'base': None, 'head': 'f6de2364a593bc4f49ea8bbe98fc0b44f4adb71a', 'commits': ['0cec8c65', '4267c1e9', '1773ab60', 'f6de2364'],
        'baseProvenance': 'root commit (S standalone repo)'},
    'root-holder': {
        'repo': base / 'root-holder-stop-ownership', 'name': 'root-holder-c3efff41', 'branch': 'fix/cache-stop-mount-ownership',
        'base': 'f6de2364a593bc4f49ea8bbe98fc0b44f4adb71a', 'head': 'c3efff41337bba272fa7186a2585e5eb7ff852a7',
        'commits': ['b1b6f184', 'c3efff41'], 'baseProvenance': 'f6de2364 = this export\'s s-holder head'},
    'd-linux-fec': {
        'repo': base / 'linux-runtime-release/src', 'name': 'd-linux-fec43a6a', 'branch': None,
        'base': '493ee9ee07497c94159ec4f6916e9ea920d31959', 'head': 'fec43a6a08da2ac287fb3a5c42de89f096f4f678',
        'commits': ['fbeab506', 'e4591e22', 'ee7a059f', 'fec43a6a'],
        'baseProvenance': '493ee9ee (the native image commit, native-final-image) is an ancestor of dfe020abf = pushed '
                          'origin/candidate/decentralized-control-20261022; the 4 commits are D 09ff3ed5/b744ba19/f1d0666b + ROOT '
                          '1086cf23 (preserved in 34723cba/8ac1aa51) re-applied with git am --committer-date-is-author-date'},
}
W = 'work/resume-after-checkpoint-20261022/'
FROZEN = [
    'witness-failover/RESULT-DEADLINE.md', 'witness-failover/PROVENANCE-DEADLINE.json', 'witness-failover/TEST-EVIDENCE-DEADLINE.txt',
    'witness-failover/RESULT-BLOCK-RESPONSES.md', 'witness-failover/PROVENANCE-BLOCK-RESPONSES.json',
    'witness-failover/TEST-EVIDENCE-BLOCK-RESPONSES.txt',
    'witness-cache-deadline-compose/RESULT.md', 'witness-cache-deadline-compose/PROVENANCE.json',
    'witness-cache-deadline-compose/TEST-EVIDENCE.txt', 'witness-cache-deadline-compose/FIXTURES.sha256',
    'rpc-sia-cache/history-compose/RESULT-HISTORY-COMPOSE.md', 'rpc-sia-cache/history-compose/FIXTURES.sha256',
    'rpc-priority/RESULT-NATIVE-RELAY-CLOSURE.md', 'rpc-priority/patches/enclave/0009-Carry-the-explicit-local-verifier-through-the-relay-.patch',
    'rpc-priority/patches/SHA256SUMS',
    'windows-host-services-compose/RESULT-CARRIERS.md', 'windows-host-services-compose/host-services-carriers.patch',
    'host-service-lifecycle/RESULT.md', 'host-service-lifecycle/artifacts-6c38c048.sha256', 'host-service-lifecycle/artifacts-24fb993c.sha256',
    'host-service-lifecycle/gitleaks-range.json', 'host-service-lifecycle/host-service-lifecycle.patch',
    'host-service-lifecycle/0001-Host-services-cancel-and-withdraw-on-stop-no-late-ci.patch',
    'host-service-lifecycle/0002-Host-services-test-the-transport-s-own-late-startup-.patch',
    'host-service-lifecycle/0003-Host-services-lifecycle-test-hold-the-event-loop-whi.patch',
    *[f'host-service-lifecycle/{n}' for n in ('artifacts.sh', 'artifacts-final.sh', 'build-runtime.sh', 'compose-check.sh', 'job.sh',
                                              'mutants.py', 'q.sh', 'setup.sh', 'verify.sh', 'verify2.sh', 'commit.sh', 'commit2.sh',
                                              'commit3.sh', 'commit-msg.txt', 'commit-msg-2.txt')],
    'source-preservation/frozen-0630-f-test-evidence.txt',
    'linux-runtime-release/RESULT-LINUX-PACKAGE.md', 'linux-runtime-release/RECIPE.md', 'linux-runtime-release/PINS.sha256',
]
LINUX_DIRS = ['linux-runtime-release/public', 'linux-runtime-release/tools', 'linux-runtime-release/patches']
ROOT_EVIDENCE = [
    *[f'root-verified-snapshot-review/{n}' for n in ('RESULT.json', 'probe.guard.log', 'probe.mjs', 'rpc-identity.mjs', 'verified-chain.mjs')],
    *[f'root-rpc-runtime-lock-review/{n}' for n in ('RESULT.json', 'frozen-takeLock.js', 'probe.guard.log', 'probe.mjs')],
    'root-policy-carrier-preflight/prepare.mjs', 'root-policy-carrier-preflight/read.guard.log',
    *[f'root-legacy-admission-audit/{n}' for n in ('collect.py', 'collect-control.py', 'read.guard.log', 'identify.guard.log',
                                                   'control.guard.log', 'control-corrected-r4.guard.log')],
    'root-holder-stop-ownership.patch', 'root-holder-unwind-failure.patch', 'root-holder-stop-control.guard.log',
    'root-holder-stop-fixed.guard.log', 'root-holder-unwind-control.guard.log', 'root-holder-unwind-fixed.guard.log',
    'root-storage-cleanup-check.py', 'root-storage-cleanup-check.guard.log', 'root-storage-cleanup-check-r2.guard.log',
    *[f'sia-whole-restore-bounded-reviewed/{n}' for n in ('finish-reviewed-root.py', 'runner.py', 'whole_restore.py', 'observe.py',
                                                          'start-reviewed.sh', 'prepare-0325.guard.log', 'start-reviewed-3.guard.log',
                                                          'poll-initial.guard.log', 'isolation-observation.guard.log',
                                                          'isolation-observation-r2.guard.log', 'memory-observation.guard.log',
                                                          'poll-0340.guard.log', 'poll-0357.guard.log')],
    *[f'node-updater-readonly/{n}' for n in ('pre-0313.log', 'post-0313-0317.guard.log', 'post-0413.guard.log', 'check-0513.py',
                                             'post-0513.guard.log', 'check-0613.py', 'check-0613.guard.log')],
    'rpc-priority/ROOT-WINDOWS-NEXT-SCOPE.txt',
    'windows-host-services-compose/ROOT-QUEUE-REVIEW.json', 'windows-host-services-compose/ROOT-F-FINAL-COMPOSITION.txt',
    'source-preservation/ROOT-PENDING-LATEST.txt', 'source-preservation/ROOT-PENDING-0443.txt',
    'source-preservation/ROOT-STORAGE-SUCCESS-0502.txt', 'source-preservation/ROOT-DEADLINE-FINAL-0518.txt',
    '../fresh-witness-supply/ROOT-STOP-OWNERSHIP-FIX-FINAL.txt', '../fresh-witness-supply/ROOT-UNWIND-FIX-FINAL.txt',
    '../effective-goal-requirements.txt',
    *[f'../../outputs/decentralization-audit/{n}' for n in (
        'holder-stop-ownership-20261023.json', 'holder-unwind-failure-20261023.json',
        'production-control-admission-inventory-20261023.json', 'production-legacy-admission-inventory-20261023.json',
        'production-policy-carrier-preflight-20261023.json', 'rpc-runtime-kernel-lock-20261023.json',
        'source-checkpoint-verified-20261023T0435Z.json', 'storage-whole-recovery-bounded-live-20261023.json',
        'storage-whole-recovery-final-20261023.json', 'windows-node-updater-0513-postcheck-20261023.json',
        'windows-node-updater-0613-postcheck-20261023.json', 'windows-rpc-consumer-gaps-20261023.json')],
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
# ---- root's stated hashes and the facts the labels assert -----------------------------------------------------------
audit = root / 'outputs/decentralization-audit'
kl = json.loads((audit / 'rpc-runtime-kernel-lock-20261023.json').read_text())
assert kl['sourceCommit'] == sides['root-kernel-lock']['commits'][0]['commit']
assert kl['exportCommit'] == sides['root-kernel-lock']['head']
for path, want in kl['fileSha256'].items():
    assert files['root-kernel-lock'].get(path) == want, ('kernel-lock receipt hash', path)
assert files['d-linux-fec']['supervisor.js'] == '4939dc688cefeed25a8801ecb4c939d7eff9e8735e9c52a15d30d069666d8d48'
assert files['d-linux-fec']['egress.js'] == 'bd960a2b6ff51e8269dd3979e7d6e1c842796d351fe0e82257e7c84f8f897843'
assert sides['d-linux-fec']['headTree'] == '13e18b0895e37a7baa5bc9e11ad1fdcf337daac0'
assert 'ROOT-REVIEW.md' in files['root-snapshot-lifecycle'] and 'test/verified-chain-lifecycle.test.mjs' in files['root-snapshot-lifecycle']
prov = (base / 'witness-cache-deadline-compose/PROVENANCE.json').read_text()
assert '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411' in prov and 'ef3202982b475212d9bb6adfdc3eed4ebb0b83c5' in prov
assert sides['p-compose']['headTree'] == '90ecef92d89783aaf8da58eb2e0eae2483abf546', sides['p-compose']['headTree']
sv = json.loads((audit / 'source-checkpoint-verified-20261023T0435Z.json').read_text())
assert sv['checkpointCommit'] == '8ac1aa51c36ec4e8a1fa3d5a60c0438a721190ab' and sv['mainCommit'] == '7752a4239b3bec2cf452491cd1b95164a8c2bdb8'
st = json.loads((audit / 'storage-whole-recovery-final-20261023.json').read_text())
assert st['state'] == 'succeeded', st['state']
lin = (base / 'linux-runtime-release/RESULT-LINUX-PACKAGE.md').read_text()
assert '3043f6ff8d8bbfbe995d3dde5e93e790a9b3bb5db432375b8e8b3c72b1cc26a2aaee5cab174a7a4134b92923c81ea77d' in lin
for g in ('check-0513.py', 'check-0613.py'):
    assert (base / 'node-updater-readonly' / g).is_file()
for n in ('0513', '0613'):
    u = json.loads((audit / f'windows-node-updater-{n}-postcheck-20261023.json').read_text())
    assert u['updater']['result'] == 0 and u['matchesReviewedRuntime'] is True and u['runningApps'] == 9, n
# ---- reports and root evidence: hashed only -------------------------------------------------------------------------
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
for d in LINUX_DIRS:
    for p in sorted((base / d).iterdir()):
        assert p.is_file() and not p.is_symlink(), p
        frozen[str(p.relative_to(base))] = sha(p.read_bytes())
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {
    'format': 'enclave-frozen-0630-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, deployed or activated (the Linux image '
              '3043f6ff is built locally only and stays hash-addressed outside Git). Root-terminal/root-reviewed immutable heads '
              'since 8ac1aa51; mutable A/B/C/F/S/E/P active trees are NOT captured past these heads.'),
    'sides': sides,
    'frozenSources': frozen,
    'rootEvidence': evidence,
    'notPreserved': [
        'every active worktree past the exported heads (A Windows consumer closure, B runtime, C/F new compose, S active integration '
        'past f6de2364 incl. 08f2ef, E rpc-transaction-independence, P any later work); the superseded unpublished 2161582 holder object',
        'raw logs outside committed history, run handles/plans/stages/snapshots/restored data, keys, compiled binaries, images, '
        'node_modules, build caches; the Linux image + release tar (hash-addressed in linux-runtime-release/public)',
        'older uncaptured root receipts not named by the pending notes (rpc-array-probe, rpc-host-memory-attribution, '
        'rpc-minipc-capacity, windows-node-update-preflight, storage-whole-recovery-size): root may request them'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))
