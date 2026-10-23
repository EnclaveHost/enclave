"""Export the 03:18Z frozen commits for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees).

* witness-enclave  witness-failover/repo    9fdc1418c (finished A candidate, preserved as patches in 9f40daae) .. bfbd649d
* witness-helios   witness-failover/helios  eeffcc9 (enclave-base-evm, preserved as patches in 9f40daae) .. 1ec2c1a5
* d-review         linux-wallet-unknown/candidate  09ff3ed5 (preserved as a patch in 7b477d57) .. b744ba19
                   UNREADY: root later found a permit-capture window (ROOT-LINUX-DECISION-WINDOW-REVIEW.txt)

Per side: format-patch series (--full-index --no-renames) and every changed file at its head blob. Worker report files
and root evidence are only hashed here (frozenSources / rootEvidence); capture-frozen-0318.py refuses to copy anything
whose bytes changed after this export. Writes only source-preservation/frozen-0318-export/ (rebuilt from scratch except
REBUILD.md). No network, builds or tests.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
out = base / 'source-preservation/frozen-0318-export'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = '7b477d578973dd11ebada8cc448bc1b3913f3bd9'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'

SIDES = {
    'witness-enclave': {
        'repo': base / 'witness-failover/repo', 'name': 'witness-enclave-bfbd649d', 'branch': 'witness-failover',
        'base': '9fdc1418caff88d1baa5c5967ac7eaaf9cf2a368', 'head': 'bfbd649d8c416922691a6dd1eaada8a81765bba5',
        'commits': ['ee45734df', 'bfbd649d8'],
        'baseProvenance': '9fdc1418c = worker A finished rpc-priority candidate, preserved in checkpoint 9f40daae as '
                          'rpc-base-evm-export/enclave-rpc-priority-9fdc1418c (4 patches on public dfe020abf, head tree '
                          '5c84c3da); the base is rebuilt from those stored patches, not from A\'s active tree'},
    'witness-helios': {
        'repo': base / 'witness-failover/helios', 'name': 'witness-helios-1ec2c1a5', 'branch': 'enclave-witness-check',
        'base': 'eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e', 'head': '1ec2c1a52399b6a8d0fc1eb7658bf030987e132a',
        'commits': ['1ec2c1a52'],
        'baseProvenance': 'eeffcc9 = enclave-base-evm (upstream a16z/helios 0.12.0 2af9b418 + 4 patches), preserved in '
                          'checkpoint 9f40daae as rpc-base-evm-export/helios-enclave-base-evm-eeffcc9 (head tree 2171ad2b; '
                          'its one binary test object is rebuilt from the stored hex fixture)'},
    'd-review': {
        'repo': base / 'linux-wallet-unknown/candidate', 'name': 'd-linux-wallet-review-b744ba19',
        'branch': 'fix/linux-wallet-unknown-hold', 'base': '09ff3ed553ba97f5fd5a880ab4197d3209a83d0a',
        'head': 'b744ba19022763e9688c6b006e8cecd24e21cc18', 'commits': ['b744ba190'],
        'baseProvenance': '09ff3ed5 = D\'s first hold commit, preserved in checkpoint 7b477d57 as '
                          'rpc-native-codec-export/d-linux-wallet-unknown-09ff3ed5 (1 patch on pushed 2bbea898)'},
}
# Worker reports frozen by hash: each describes exactly the exported head (re-checked at capture).
FROZEN = ['witness-failover/RESULT.md', 'witness-failover/PROVENANCE.json', 'witness-failover/TEST-EVIDENCE.txt',
          'linux-wallet-unknown/RESULT-REVIEW.md']
# Root evidence reviewed at ~03:25Z (content read: offline probes, reviews, public receipts; no keys or private data).
ROOT_EVIDENCE = [
    'ROOT-LINUX-DECISION-WINDOW-REVIEW.txt',
    'root-linux-decision-window-probe.mjs',
    'root-linux-decision-window-result.json',
    'root-linux-decision-window-probe.guard.log',
    'ROOT-VERIFIER-DEADLINE-REVIEW.txt',
    'root-verifier-deadline-probe.mjs',
    'root-verifier-deadline-result.json',
    'root-verifier-deadline-probe.guard.log',
    'ROOT-VERIFIER-POSITIVE-CONSUMER-REVIEW.txt',
    'node-updater-readonly/check-0313.py',
    'check-dns-tls-current.py',
    'dns-tls-0317.guard.log',
    'storage-worker-steering-interrupt.json',
    'ROOT-BRIDGE-HALFCLOSE-REVIEW.txt',
    'root-bridge-halfclose/probe.py',
    'root-bridge-halfclose/result.json',
    'root-bridge-halfclose/probe.guard.log',
    'root-bridge-halfclose/runner-snapshot.py',
]
RECEIPTS = ['windows-node-updater-0313-postcheck-20261023.json', 'enclavedns-tls-followup-20261023T0317Z.json',
            'storage-failed-attempt-cleanup-20261023.json', 'rpc-hdd-feasibility-primary-source-20261023.json']


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export(key, spec):
    repo, dst = spec['repo'], out / spec['name']
    head = git(repo, 'rev-parse', spec['head'] + '^{commit}').strip()
    assert head == spec['head'], f'{key}: {spec["head"]} resolves to {head}'
    base_full = git(repo, 'rev-parse', spec['base'] + '^{commit}').strip()
    assert base_full == spec['base'], key
    rng = f'{base_full}..{head}'
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%cI%x09%s', rng).splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'committedAt', 'subject'), l.split('\t'))) for l in log]
    assert len(rows) == len(spec['commits']) and [r['commit'][:len(c)] for r, c in zip(rows, spec['commits'])] == spec['commits'], \
        f"{key}: commits {[r['commit'][:9] for r in rows]} != {spec['commits']}"
    assert rows[0]['parent'] == base_full, f'{key}: first parent'
    assert all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows))), f'{key}: not a linear series'
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), f'{key}: unexpected author/committer'
    files = []
    for line in git(repo, 'diff', '--name-status', '--no-renames', base_full, head).splitlines():
        status, path = line.split('\t')
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        data.decode('utf-8')   # every authored file is text; a binary aborts the export
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755'), (path, mode)
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status == 'M' else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'), rng)
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
    return {'repo': str(repo.relative_to(base)), 'branch': spec['branch'],
            'headReachableFromBranch': subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head,
                                                      spec['branch']]).returncode == 0,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()

sides = {k: export(k, s) for k, s in SIDES.items()}
frozen = {name: sha((base / name).read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).read_bytes()) for name in ROOT_EVIDENCE}
# The work/storage-restore-memory copy of root's bridge review must be byte-identical to the one captured here.
assert (root / 'work/storage-restore-memory/ROOT-BRIDGE-HALFCLOSE-REVIEW.txt').read_bytes() == (base / 'ROOT-BRIDGE-HALFCLOSE-REVIEW.txt').read_bytes()
receipts = {name: sha((root / 'outputs/decentralization-audit' / name).read_bytes()) for name in RECEIPTS}
d_supervisor = next(f for f in sides['d-review']['changedFiles'] if f['path'] == 'supervisor.js')
inventory = {
    'format': 'enclave-frozen-0318-export/v1',
    'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'label': ('SOURCE + OFFLINE TESTS ONLY. Not deployed, not merged into the normal tree, not imaged. witness-enclave '
              'bfbd649d + witness-helios 1ec2c1a5: proof-aware witness failover (native witness-check verifies each '
              'untrusted witness against a root from a signed head) and a content-addressed cache; offline proof and '
              'availability tests only, NOT production and NOT RPC independence. d-review b744ba19: UNREADY candidate; root '
              'later found a permit-capture window in tryClaim (gate built after an await) and the stop handling is '
              'incomplete on other teardown paths; worker D is repairing.'),
    'sides': sides,
    'frozenSources': frozen,
    'rootEvidence': evidence,
    'receipts': receipts,
    'rootProbeSourceNotes': {
        'root-linux-decision-window-probe': f"probed D working source sha256 db73a7f2 (r1b, 02:51Z); the committed b744ba19 "
                                            f"supervisor.js is {d_supervisor['sha256'][:8]} (D reports a whitespace-only "
                                            f"reformat of revokeLeasePermits). The finding concerns tryClaim ordering",
        'root-verifier-deadline-probe': 'probed worker A lease-reader.mjs sha256 3d1850b2 (A commit 921d60c2, ACTIVE, not '
                                        'captured here)',
        'root-bridge-halfclose': 'root snapshot runner-snapshot.py = S bridge runner 160db08b (S is ACTIVE with fixes; the '
                                 'snapshot is the reviewed defective version, never a release)'},
    'notPreserved': ['worktrees and anything after the exported heads: the witness-failover worker has since committed '
                     'newer work on both branches (root-history follow-up; not reviewed for this checkpoint) and D is ACTIVE '
                     'repairing; none of that newer work or working state is captured',
                     'witness-failover target/, bin/ (helper 42a8a841, Helios copies), cargo-home/, vendor-inspect/, '
                     'fixtures/ (copy of the already-preserved base-calls fixture), test-scratch/, logs/ (digest = '
                     'TEST-EVIDENCE.txt), jobs/, patches/ (equivalent to these exports)',
                     'D logs/, tmp/ (mutants, control copies), stubs/, job scripts and its own .patch files (equivalent '
                     'to these exports)',
                     'root-bridge-halfclose/__pycache__',
                     'restored storage data, raw logs, keys, backups and remote handles'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles']), 'patches': len(v['patches'])}
                  for k, v in sides.items()} | {'frozen': len(frozen), 'rootEvidence': len(evidence), 'receipts': len(receipts),
                                                'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))
