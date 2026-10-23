"""Export the frozen-0931 batch for the checkpoint, from Git OBJECTS only (never from mutable or dirty worktrees). "0931" is the
batch IDENTIFIER = its actual start, 2026-10-23T09:31Z (date -u); it is not a publication time.

Linear series on a base already preserved in pushed checkpoint material (cadf0ebb), or root commits:
* a-parity        rpc-priority/repo                       df8fbafa -> c3a61fd1, e32dd607 (A consumer parity; patches 0015-0016)
* b-runtime-final rpc-runtime-final-integration/repo      df8fbafa -> 19 commits -> c31e975a (B final verifier runtime, tree 6fbe601d)
* f-rpc-closure   host-service-rpc-closure/candidate      4106c311 -> bb86e0ce, 30123801, 14d1e495 (F)
* c-drain         storage-write-release                   bbf0a009 -> fbaecfc, 5a3ee31, 5293405, 19b9148 (C rollback order + DB drain)
* s-browser       browser-rpc-closure/repo                e820e240 -> 2bd1eea (ROOT WalletConnect), 349318a0 (S)
* s-report        browser-rpc-closure (report repo)       root -> 4439755, b55ca791
* root-pg         root-pg-drain-review                    root -> 555dc752 (ROOT PostgreSQL counterexample)
* root-tls        nucbox-tls-recovery-20261023/retry-recovery  root -> be8a71d, edac1dc, 9bc2053, ab52706 (ROOT TLS recovery)
SOURCE-ONLY DERIVATIVES (patches rebuild the DERIVATIVE trees = original minus the excluded paths, NOT the exact originals):
* p-l1            rpc-l1-source-package  root -> 12 commits -> f835148, minus the vendored upstream binary
                  evidence/sources/lighthouse-v8.3.2/.../mainnet/genesis.ssz.zip (sigp/lighthouse v8.3.2 tree a376defa blob 28405c78)
* e-closure       rpc-transaction-independence  159fd148 (preserved as a derivative in cadf0ebb) -> 017b8aa, 027ff549, ca818b75,
                  minus fixtures/artifacts/ (13 compiled outputs; recipe frozen-0931-e-artifact-recipe.json) and exports/ (E's own
                  patches + git bundle, which embed those outputs)
D installed baseline (NucBox): the installed source files not already in the checkpoint's history, the build manifests, and the
omitted compiled bundles/executables with their recipes (d-installed-baseline/BASELINE.json).
"""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile

root = Path(__file__).resolve().parents[3]
W = root / 'work'
base = W / 'resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
out = sp / 'frozen-0931-export'
checkpoint = W / 'source-checkpoint-20261022/main-repo'
CHECKPOINT_HEAD = 'cadf0ebb83338d847ef1cb5d3f14a64fe7560098'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'
DF8 = 'df8fbafae081321f3c9a9c774e41007200913f32'
SIDES = {
    'a-parity': {'repo': base / 'rpc-priority/repo', 'name': 'a-parity-e32dd607', 'branch': 'rpc-priority', 'base': DF8,
        'head': 'e32dd607b55b9c6afd605482a4bc31c9d30528d6', 'commits': ['c3a61fd1', 'e32dd607'],
        'baseProvenance': 'df8fbafa preserved in cadf0ebb as frozen-0830-export/a-windows-df8fbafa'},
    'b-runtime-final': {'repo': base / 'rpc-runtime-final-integration/repo', 'name': 'b-runtime-final-c31e975a', 'branch': 'runtime-final', 'base': DF8,
        'head': 'c31e975a44ef3114d4eadddb27e75956b33ccf2c', 'commits': 'daf9e10d 30c634b1 7af6dd66 f7817efe 86317118 5aed3a49 32691173 a8d03cd3 7032177e cc9e4da5 dc8adb8e e6b9bf27 a1fd9dfc 88bdbbb9 564cc8ae fb1c410b 5296cdeb 69b966f7 c31e975a'.split(),
        'baseProvenance': 'df8fbafa preserved in cadf0ebb as frozen-0830-export/a-windows-df8fbafa', 'headTree': '6fbe601d8659ab12c2a649ae8c8e89cb7e497db2'},
    'f-rpc-closure': {'repo': base / 'host-service-rpc-closure/candidate', 'name': 'f-rpc-closure-14d1e495', 'branch': 'closure/host-service-rpc',
        'base': '4106c3114dd13f39692195c182d3152efa5e212c', 'head': '14d1e4954cf7c9900d5d3e841a23f02de945c1b2', 'commits': ['bb86e0ce', '30123801', '14d1e495'],
        'baseProvenance': '4106c311 preserved in cadf0ebb as frozen-0830-export/f-final-4106c311 (merge, one diff vs first parent)'},
    'c-drain': {'repo': base / 'storage-write-release', 'name': 'c-drain-19b91486', 'branch': 'storage/write-release',
        'base': 'bbf0a009b4f823f17a7d7679007b0ad74c49e76f', 'head': '19b91486825c94e32ec28cae988ee29dd6197bde', 'commits': ['fbaecfc', '5a3ee31', '5293405', '19b9148'],
        'baseProvenance': 'bbf0a009 preserved in cadf0ebb as frozen-0830-export/c-storage-write-bbf0a009'},
    's-browser': {'repo': W / 'browser-rpc-closure/repo', 'name': 's-browser-349318a0', 'branch': 'browser-rpc-closure',
        'base': 'e820e2405af91010c18913acf4740f651618c644', 'head': '349318a0600917bad8f391ad628fa0c7f134b3f6', 'commits': ['2bd1eea', '349318a0'],
        'baseProvenance': 'e820e240 preserved in cadf0ebb as the 4th commit of frozen-0830-export/a-windows-df8fbafa'},
    's-report': {'repo': W / 'browser-rpc-closure', 'name': 's-report-b55ca791', 'branch': 'master', 'base': None,
        'head': 'b55ca7916d4c61f79bc308828270a9b4f386b61b', 'commits': ['4439755', 'b55ca79'], 'baseProvenance': 'root commit (S report repo)'},
    'root-pg': {'repo': base / 'root-pg-drain-review', 'name': 'root-pg-555dc752', 'branch': 'master', 'base': None,
        'head': '555dc7528312bd169d68f8ef81e64a51818c2eda', 'commits': ['555dc752'], 'baseProvenance': 'root commit (ROOT repo)'},
    'root-tls': {'repo': W / 'nucbox-tls-recovery-20261023/retry-recovery', 'name': 'root-tls-ab527067', 'branch': 'master', 'base': None,
        'head': 'ab527067023a0cb153288bdb0392d47f9c3a8b5c', 'commits': ['be8a71d', 'edac1dc', '9bc2053', 'ab52706'], 'baseProvenance': 'root commit (ROOT repo)'},
}
ZIP = 'evidence/sources/lighthouse-v8.3.2/common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip'
# text files that quote Sigma Prime's PUBLIC release-signing PGP fingerprint, which the checkpoint's UNCHANGED gitleaks config
# flags (generic-api-key); P allowlisted it in its own config (7d5ccb1f). Omitted rather than weakening the checkpoint's scanner.
FPR = ('evidence/lighthouse-binary-20261023T080144Z/release.yml', 'logs/fetch-lh-2.out', 'logs/verify-lh-2.out', 'logs/verify-lh-3.out')
DERIVS = {
    'p-l1': {'repo': W / 'rpc-l1-source-package', 'name': 'p-l1-f8351487', 'branch': 'main', 'base': None, 'head': 'f83514874646d3be1ea46bc420f0fed5e664f6ef',
        'commits': 'e318e38b c0282ca5 5ccee196 e373dca6 c2f2b180 1260cdcb 8ea82585 83805a1b 47f4f42a e83301df 7d5ccb1f f8351487'.split(),
        'exclude': (ZIP, *FPR), 'baseProvenance': 'root commit (P standalone repo); SOURCE-ONLY DERIVATIVE (one vendored upstream binary excluded)'},
    'e-closure': {'repo': W / 'rpc-transaction-independence', 'name': 'e-closure-ca818b75', 'branch': 'master',
        'base': '159fd1480ddab9652043cce5163348ff4fa6996b', 'head': 'ca818b759172adc98c5089796784133f9310e597', 'commits': ['017b8aa', '027ff549', 'ca818b75'],
        'exclude': ('fixtures/artifacts/', 'exports/'),
        'baseProvenance': '159fd148 preserved in cadf0ebb as the source-only derivative frozen-0830-export/e-derivative-159fd148 (derivative tree 827da8c7)'},
}
FROZEN = (['rpc-priority/RESULT-CONSUMER-PARITY.md', 'rpc-priority/patches/enclave/0015-Verify-contract-wallet-owner-signatures-through-the-.patch',
           'rpc-priority/patches/enclave/0016-Make-the-local-verifier-the-state-authority-of-indep.patch',
           'rpc-runtime-final-integration/RESULT.md', 'rpc-runtime-final-integration/INVENTORY.json']
          + sorted('rpc-runtime-final-integration/jobs/' + p.name for p in (base / 'rpc-runtime-final-integration/jobs').iterdir() if p.suffix in ('.sh', '.py'))
          + ['host-service-rpc-closure/' + n for n in ('RESULT.md', 'PROGRESS.txt', 'artifacts-js-14d1e495.sha256', 'build-js.sh', 'build-pkg.sh', 'commit-msg-2.txt',
             'commit-msg-3.txt', 'commit1.sh', 'commit2.sh', 'commit3.sh', 'compose-a.sh', 'gitleaks-range.json', 'job.sh', 'q.sh', 'race.sh', 'regress.sh',
             'resolve-runner.py', 'scan.sh', 'setup.sh')]
          + ['source-preservation/' + n for n in ('RESULT-frozen-0830-checkpoint.md', 'frozen-0931-b-runtime-test-evidence.txt', 'frozen-0931-f-rpc-closure-test-evidence.txt',
             'frozen-0931-c-drain-test-evidence.txt', 'frozen-0931-d-review-test-evidence.txt', 'frozen-0931-e-artifact-recipe.json',
             'frozen-0931-work/installed-unpreserved.json', 'snapshots-0931/ROOT-PENDING-LATEST.snapshot-0931.txt',
             'snapshots-0931/effective-goal-requirements.snapshot-0931.txt', 'find-installed-unpreserved.py', 'make-frozen-0931-e-recipe.mjs')])
DREV = 'windows-upgrade-delta-review/'
D_SKIP = {'receipts/proposals/a-port/windows_node_host-admission.bundle.mjs.merged'}   # a textual merge of two COMPILED bundles: not source
W1M = sorted(p for p in (base / DREV / 'receipts/w1').glob('*.inputs.json'))   # published as sums text (below), not as JSON
D_SKIP |= {str(p.relative_to(base / DREV)) for p in W1M}
FROZEN += sorted(DREV + str(p.relative_to(base / DREV)) for p in (base / DREV).rglob('*') if p.is_file()
                 and p.relative_to(base / DREV).parts[0] in ('receipts', 'tools', 'stub') and str(p.relative_to(base / DREV)) not in D_SKIP)
FROZEN += [DREV + n for n in ('RESULT.md', 'D-WINDOWS-UPGRADE-DELTA.txt', 'SHA256SUMS.txt')]
ROOT_EVIDENCE = [DREV + 'ROOT-EXPERIMENT-AND-OWNER-HOLD.txt', DREV + 'ROOT-NEW-TERMINAL-B-S.txt', DREV + 'ROOT-NEXT-PRESERVATION-TLS.txt',
                 'host-service-rpc-closure/ROOT-INSTALLED-BASELINE-GATE.txt', 'storage-write-release/ROOT-POSTGRES-DRAIN-REVIEW.txt',
                 '../nucbox-tls-recovery-20261023/ROOT-INCIDENT-UPDATE.txt', '../nucbox-tls-recovery-20261023/ROOT-PRODUCTION-RECOVERY.txt',
                 '../rpc-l1-source-package/ROOT-BUDGET-ACCOUNTING-PIN-PENDING.txt', '../rpc-l1-source-package/ROOT-BUDGET-V2-REVIEW.txt',
                 '../rpc-l1-source-package/ROOT-STORAGE-PINS-AND-BUDGET.txt', '../rpc-l1-source-package/ROOT-TRANSACTION-INTERFACE-FINAL.txt'] + \
    ['../../outputs/decentralization-audit/' + n for n in ('checkpoint-verified-cadf0ebb-20261023.json', 'windows-host-services-installed-baseline-20261023.json',
     'windows-host-services-config-state-20261023.json', 'windows-crash-recovery-observation-20261023.json', 'windows-candidate-baseline-gate-20261023T084849Z.json',
     'postgres-inflight-stop-counterexample-20261023.json', 'storage-cutover-rollback-review-20261023.json', 'rpc-integration-review-20261023-0850.json')]


# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
def git(repo, *args, text=True, env=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text, env=env).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def gblob(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def export(key, spec, exclude=()):
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
    if 'headTree' in spec: assert rows[-1]['tree'] == spec['headTree'], f'{key}: head tree'
    files = []
    diff_args = [base_full, head] if base_full else ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', head]
    for line in git(repo, 'diff', '--name-status', '--no-renames', *diff_args).splitlines():
        status, path = line.split('\t')
        if any(path.startswith(x) for x in exclude):
            continue
        if status == 'D':
            files.append({'path': path, 'status': 'D', 'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip()})
            continue
        assert status in ('A', 'M', 'T'), line
        blob = git(repo, 'rev-parse', f'{head}:{path}').strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        mode = git(repo, 'ls-tree', head, '--', path).split()[0]
        assert mode in ('100644', '100755', '120000'), (path, mode)   # 120000: files/ holds the link text; the patch carries the link
        data.decode('utf-8')   # every exported file is text; a binary aborts the export
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({'path': path, 'status': status, 'mode': mode, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                      'baseBlob': git(repo, 'rev-parse', f'{base_full}:{path}').strip() if status in ('M', 'T') else None})
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-renames', '--no-signature', '-o', str(dst / 'patches'),
        *(['--root', head] if not base_full else [rng]), '--', '.', *[f':(exclude){x}' for x in exclude])
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows), f'{key}: {len(patches)} patches for {len(rows)} commits'
    for p in patches:
        p.read_bytes().decode('utf-8')
        assert b'GIT binary patch' not in p.read_bytes(), p
        for x in exclude: assert f'diff --git a/{x}'.encode() not in p.read_bytes(), (p, x)
    reach = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', head, spec['branch']]).returncode == 0
    assert reach, f'{key}: head not on {spec["branch"]}'
    return {'repo': str(repo.relative_to(root)), 'branch': spec['branch'], 'headReachableFromBranch': reach,
            'base': base_full, 'baseProvenance': spec['baseProvenance'], 'head': head, 'headTree': rows[-1]['tree'],
            'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches]}


def derived_tree(repo, commit, exclude):   # the original tree minus every excluded entry, in a throwaway index
    with tempfile.TemporaryDirectory() as t:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(t) / 'index')}
        run = lambda *a: subprocess.run(['git', '-C', str(repo), *a], env=env, check=True, capture_output=True, text=True).stdout
        run('read-tree', commit)
        for x in exclude:
            run('rm', '-q', '--cached', '-r', '--ignore-unmatch', '--', x)
        return run('write-tree').strip()


assert git(checkpoint, 'rev-parse', 'HEAD').strip() == CHECKPOINT_HEAD, 'checkpoint HEAD moved'
out.mkdir(exist_ok=True)
for child in out.iterdir():
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()
sides = {k: export(k, s) for k, s in SIDES.items()}
derivs = {}
for k, s in DERIVS.items():
    d = export(k, s, exclude=s['exclude'])
    omitted = {}
    for c in d['commits']:
        c['originalTree'] = c['tree']; c['tree'] = derived_tree(s['repo'], c['commit'], s['exclude'])
        omitted[c['commit']] = [dict(zip(('mode', 'type', 'blob', 'bytes', 'path'), l.split(None, 4)))
                                for x in s['exclude'] for l in git(s['repo'], 'ls-tree', '-r', '-l', c['commit'], '--', x).splitlines()]
    d['originalHeadTree'] = d['headTree']; d['headTree'] = d['commits'][-1]['tree']
    d['omittedAtHead'] = omitted[d['head']]; d['omittedByCommitCount'] = {c: len(v) for c, v in omitted.items()}
    d['excluded'] = list(s['exclude'])
    derivs[k] = d
# ---- the two derivatives' recipes ------------------------------------------------------------------------------------------
p = derivs['p-l1']
assert sorted(a['path'] for a in p['omittedAtHead']) == sorted([ZIP, *FPR])
zipent = next(a for a in p['omittedAtHead'] if a['path'] == ZIP); assert zipent['blob'] == '28405c78f0daddee3e132ccb6976f71ea56fb28c'
upstream = json.loads(git(DERIVS['p-l1']['repo'], 'show', f"{p['head']}:evidence/trees-20261023T061333Z/lighthouse-v8.3.2-tree.json"))
ent = [e for e in upstream['tree'] if e['path'] == ZIP[len('evidence/sources/lighthouse-v8.3.2/'):]]
assert len(ent) == 1 and ent[0]['sha'] == zipent['blob'] and int(ent[0]['size']) == int(zipent['bytes'])
zipb = git(DERIVS['p-l1']['repo'], 'cat-file', 'blob', zipent['blob'], text=False)
rel = next(a for a in p['omittedAtHead'] if a['path'] == FPR[0]); up = [e for e in upstream['tree'] if e['path'] == '.github/workflows/release.yml']
assert len(up) == 1 and up[0]['sha'] == rel['blob']
p['omittedFingerprintFiles'] = [{**a, 'sha256': sha(git(DERIVS['p-l1']['repo'], 'cat-file', 'blob', a['blob'], text=False)),
    'restore': ('sigp/lighthouse v8.3.2 .github/workflows/release.yml (upstream blob 75a69cf0, pinned in the same tree JSON)' if a['path'] == FPR[0]
                else "P's own job log; kept in P's repository (work/rpc-l1-source-package) only")} for a in p['omittedAtHead'] if a['path'] in FPR]
p['omittedFingerprintWhy'] = ("these text files quote Sigma Prime's PUBLIC Lighthouse release-signing PGP fingerprint (release.yml:195), which the "
                              "checkpoint's unchanged gitleaks config flags as generic-api-key; P allowlisted exactly that value in its own config "
                              "(7d5ccb1f). The checkpoint scanner is not weakened; the files are omitted and recorded instead")
p['omittedRecipe'] = {'path': ZIP, 'gitBlob': ent[0]['sha'], 'sha256': sha(zipb), 'bytes': len(zipb),
    'upstream': {'repo': 'sigp/lighthouse', 'tag': 'v8.3.2', 'tree': upstream['sha'], 'path': ent[0]['path'],
                 'pinnedBy': 'evidence/trees-20261023T061333Z/lighthouse-v8.3.2-tree.json (in this export)'},
    'regenerate': 'fetch sigp/lighthouse v8.3.2 (tree a376defa), copy common/eth2_network_config/built_in_network_configs/mainnet/genesis.ssz.zip to the path above; its git blob id must be 28405c78f0daddee3e132ccb6976f71ea56fb28c',
    'why': 'a vendored upstream BINARY (zip of the mainnet genesis state): not authored source, and the export is text-only'}
p['label'] = ('SOURCE-ONLY DERIVATIVE: the exact original trees cannot be rebuilt from this export until the upstream zip (omittedRecipe) and the '
              'four fingerprint-quoting text files (omittedFingerprintFiles: release.yml from upstream; three job logs from P\'s repository) are restored')
e = derivs['e-closure']
recipe = json.loads((sp / 'frozen-0931-e-artifact-recipe.json').read_text())
assert recipe['head'] == e['head'] and not recipe['recipeSources']['missing'] and recipe['compilerPin'] == ['0.8.35+commit.47b9dedd']
want = {(a['path'], a['blob']) for a in recipe['artifacts']} | {(a['path'], a['blob']) for a in recipe['exportsOmitted']}
assert {(a['path'], a['blob']) for a in e['omittedAtHead']} == want, 'recipe and omitted E outputs disagree'
e['artifactRecipe'] = {'file': 'source-preservation/frozen-0931-e-artifact-recipe.json', 'extends': recipe['extends'], 'compilerPin': recipe['compilerPin'],
    'artifacts': len(recipe['artifacts']), 'sameAsFrozen0830': sum(1 for a in recipe['artifacts'] if a.get('sameAsFrozen0830')),
    'exportsOmitted': len(recipe['exportsOmitted'])}
e['label'] = ('SOURCE-ONLY DERIVATIVE: these patches apply to 159fd148\'s DERIVATIVE tree and reproduce the derivative trees (original minus '
              'fixtures/artifacts/ and exports/); the exact original trees are NOT reproducible until the 13 compiled fixtures are regenerated '
              '(solc 0.8.35+commit.47b9dedd, settings per artifact) and E\'s exports re-made')
# ---- D: the installed NucBox baseline ---------------------------------------------------------------------------------------
reach = set(l.split()[0] for l in git(checkpoint, 'rev-list', '--objects', CHECKPOINT_HEAD).splitlines())
iu = json.loads((sp / 'frozen-0931-work/installed-unpreserved.json').read_text())
dd = out / 'd-installed-baseline'
G4C, G4R, RCF = W / 'g4-network-composition-20261021', W / 'g4-challenge-retry-package-20261022', W / 'root-control-final-20261022/control-package'
dfiles, dref = [], []
def as_sums(b):
    # {path: sha256} JSON -> 'sha256  path' lines (the sha256sum layout: the hash precedes its file name, so the checkpoint's
    # unchanged gitleaks rules - which flag a 64-hex value AFTER a label such as privateKeyToAccount.js - do not misfire);
    # returns the text and the exact JSON formatting that reproduces the original bytes from it
    d = json.loads(b); assert all(isinstance(v, str) and len(v) == 64 for v in d.values())
    forms = [(i, nl) for i in (1, 2) for nl in (True, False) if (json.dumps(d, indent=i) + ('\n' if nl else '')).encode() == b]
    assert len(forms) == 1, 'no unique JSON formatting reproduces the manifest'
    i, nl = forms[0]
    text = ''.join(f'{v}  {k}\n' for k, v in d.items()).encode()
    rebuilt = json.dumps(dict(reversed(l.split('  ', 1)) for l in text.decode().splitlines()), indent=i) + ('\n' if nl else '')
    assert rebuilt.encode() == b
    return text, {'originalSha256': sha(b), 'originalBytes': len(b), 'rebuild': f"json.dumps(dict((p, h) for each line 'h  p' in order), indent={i})" + (" + '\\n'" if nl else '') + ' (Python)'}
def dcopy(src, rel, why):
    b = src.resolve().read_bytes(); b.decode('utf-8'); conv = None
    if rel.endswith('.inputs.json'):
        b, conv = as_sums(b); rel = rel[:-len('.json')] + '.sha256sums'
    rec = {'path': rel, 'source': str(src.relative_to(root)), 'sha256': sha(b), 'gitBlob': gblob(b), 'bytes': len(b), 'why': why,
           **({'convertedFromJson': conv} if conv else {})}
    if gblob(b) in reach: dref.append({**rec, 'alreadyInCheckpointHistory': True}); return
    (dd / 'files' / rel).parent.mkdir(parents=True, exist_ok=True); (dd / 'files' / rel).write_bytes(b); dfiles.append(rec)
for r in iu['notPreserved']:
    if r['path'] == 'relay/snp-verify.mjs': continue          # recorded by relation below (it carries the rewritten literal)
    dcopy(W / r['file'], 'installed-src/' + r['path'], r['provenance'])
for rel, src in [('g4-challenge-retry-package/build.mjs', G4R / 'build.mjs'), ('g4-challenge-retry-package/build-result.json', G4R / 'build-result.json'),
                 ('g4-challenge-retry-package/source-inventory.json', G4R / 'source-inventory.json')] + \
                [(f'g4-challenge-retry-package/candidate/{n}.inputs.json', G4R / f'candidate/{n}.inputs.json') for n in ('privacy-agent.mjs', 'windows-circuit-worker.mjs', 'host-service-ingress.mjs')] + \
                [('g4-network-composition/out/build-manifest.json', G4C / 'out/build-manifest.json')] + \
                [(f'g4-network-composition/out/g4/{n}.inputs.json', G4C / f'out/g4/{n}.inputs.json') for n in ('privacy-agent.mjs', 'windows-circuit-worker.mjs', 'host-service-ingress.mjs')] + \
                [('root-control-final/control-package/manifest.json', RCF / 'manifest.json')]:
    dcopy(src, 'build/' + rel, 'build manifest / recipe of the installed bundles')
for m in W1M:
    dcopy(m, 'review-w1/' + m.name, "D review w1: F 4106c311's rebuilt bundle input manifest (windows-upgrade-delta-review/receipts/w1)")
snp = next(r for r in iu['notPreserved'] if r['path'] == 'relay/snp-verify.mjs')
snpb = (W / snp['file']).read_bytes(); fb = git(SIDES['f-rpc-closure']['repo'], 'show', '4106c3114dd13f39692195c182d3152efa5e212c:relay/snp-verify.mjs', text=False)
T = lambda x: x.replace(OLD, b'Cloud Provider').replace(OLD.lower(), b'Cloud Provider')
assert T(snpb) == fb and sha(snpb) == snp['sha256']
def art(p, note):
    b = p.read_bytes(); return {'path': str(p.relative_to(root)), 'sha256': sha(b), 'bytes': len(b), 'note': note}
baseline = {'format': 'enclave-d-installed-baseline/v1',
    'scope': 'NucBox installed files per ROOT R3 (outputs/decentralization-audit/windows-host-services-installed-baseline-20261023.json, 08:01:05Z; on-disk hashes, not loaded-process identity)',
    'installedSourceCheck': {'checked': iu['checked'], 'alreadyInCheckpointHistory': iu['alreadyPreserved'], 'exportedHere': [f['path'] for f in dfiles if f['path'].startswith('installed-src/')],
                             'method': 'git blob id of the exact bytes vs every object reachable from cadf0ebb (find-installed-unpreserved.py)'},
    'byRelation': [{'path': 'relay/snp-verify.mjs', 'installedSha256': snp['sha256'], 'installedGitBlob': snp['gitBlob'], 'bytes': snp['bytes'],
                    'relation': "T(installed) == F 4106c311's relay/snp-verify.mjs 93f9e9d2 (preserved), T = the 2026-10-21 repository rewrite (byte replacement of the former provider name by 'Cloud Provider'); one occurrence, a line-2 comment",
                    'notExported': 'its bytes carry the rewritten literal; publishing them would reintroduce it'}],
    'omittedCompiled': [
        {**art(G4R / 'candidate/privacy-agent.mjs', 'installed network\\privacy-agent.mjs cfb69370'), 'recipe': 'node work/g4-challenge-retry-package-20261022/build.mjs: esbuild over g4-network-composition-20261021/src with the 2 changed inputs from g4-challenge-retry-package-20261022/src; inputs = build/g4-challenge-retry-package/candidate/privacy-agent.mjs.inputs.json (1938, every sha256)'},
        {**art(G4R / 'candidate/windows-circuit-worker.mjs', 'installed network\\windows-circuit-worker.mjs 13ce44f1 (= the g4 composition build)'), 'recipe': 'same build; inputs = build/g4-network-composition/out/g4/windows-circuit-worker.mjs.inputs.json'},
        {**art(G4R / 'candidate/host-service-ingress.mjs', 'installed network\\host-service-ingress.mjs c952dce4'), 'recipe': 'same build; inputs = build/g4-network-composition/out/g4/host-service-ingress.mjs.inputs.json'},
        {**art(RCF / 'files/windows/node/host-admission.bundle.mjs', 'installed windows\\node\\host-admission.bundle.mjs 6bef372d'), 'recipe': 'no input manifest locally (G4 package: "admission, NOT rebuilt"); proven = F 3438cdf2 with PRODUCTION_MIRRORS [] instead of the 4 DO fronts (windows-upgrade-delta-review/receipts/bundles/host-admission-delta.json)'},
        {**art(RCF / 'files/windows/node/lease-gas-runtime.bundle.mjs', 'installed windows\\node\\lease-gas-runtime.bundle.mjs 159108d1'), 'recipe': 'no input manifest locally; proven = F 008cdca1 up to minifier renames (receipts/bundles/lease-gas-runtime-rename-check.json)'},
        {'path': 'network\\enclave-wg.exe (NucBox)', 'sha256': 'cbaf8313ce4e2cfce347abed99bdeaf5fc0631b8ab07bfbab20471f60920264c', 'note': 'no local copy; Go buildinfo (vcs.revision) unknown: root read-only capture item'},
        {'path': 'network\\enclave-circuit-firewall.exe (NucBox)', 'sha256': '78daec71f51f89a53600cb7d4bfb0492e2f0d642047422e4fbec30b2a5c238a6', 'note': 'no local copy; Go buildinfo unknown: root read-only capture item'}],
    'exported': dfiles, 'referencedAlreadyPreserved': dref,
    'review': 'windows-upgrade-delta-review/RESULT.md (delta, tests t1/t2, F/A handoff D-WINDOWS-UPGRADE-DELTA.txt)'}
(dd).mkdir(exist_ok=True); (dd / 'BASELINE.json').write_text(json.dumps(baseline, indent=1) + '\n')
# ---- literal guard: the 2026-10-21 rewrite must not be undone by this export ------------------------------------------------
lit = {}
for f in out.rglob('*'):
    if f.is_file():
        b = f.read_bytes(); n = (b.count(OLD), b.count(OLD.lower()))
        if any(n): lit[str(f.relative_to(out))] = n
for name in FROZEN + ROOT_EVIDENCE:
    b = (base / name).resolve().read_bytes(); n = (b.count(OLD), b.count(OLD.lower()))
    if any(n): lit['frozen:' + name] = n
assert not any(v[0] for v in lit.values()), ('capitalised rewritten literal in export', {k: v for k, v in lit.items() if v[0]})
# ---- facts -----------------------------------------------------------------------------------------------------------------
cv = json.loads((root / 'outputs/decentralization-audit/checkpoint-verified-cadf0ebb-20261023.json').read_text())
assert CHECKPOINT_HEAD in json.dumps(cv)
frozen = {name: sha((base / name).resolve().read_bytes()) for name in FROZEN}
evidence = {name: sha((base / name).resolve().read_bytes()) for name in ROOT_EVIDENCE}
inventory = {'format': 'enclave-frozen-0931-export/v1', 'checkpointHeadAtExport': CHECKPOINT_HEAD,
    'batch': '0931 = the batch start 2026-10-23T09:31Z (date -u): an identifier, not a publication time',
    'label': ('SOURCE + OFFLINE TESTS ONLY. Nothing here is merged into the normal tree, imaged, deployed or activated. Terminal immutable heads '
              'since cadf0ebb: A e32dd607, B c31e975a, F 14d1e495, C 19b91486, S 349318a0 (+ROOT 2bd1eea) and report b55ca791, ROOT 555dc752 and '
              'ab527067; P f8351487 and E ca818b75 as source-only derivatives; D installed NucBox baseline sources and manifests.'),
    'sides': sides, 'derivatives': derivs, 'dInstalledBaseline': 'd-installed-baseline/BASELINE.json',
    'lowercaseRewrittenLiteral': lit, 'frozenSources': frozen, 'rootEvidence': evidence,
    'notPreserved': ['P evidence/sources/.../mainnet/genesis.ssz.zip (vendored upstream binary; blob/sha256/upstream pin recorded)',
                     'E fixtures/artifacts/*.json (13 compiled outputs) and exports/ (E\'s own patches + git bundle that embed them); recipe recorded',
                     'installed compiled bundles and the two Go executables (hashes + recipes in BASELINE.json); D a-port merge of the compiled admission bundle',
                     'installed relay/snp-verify.mjs bytes (recorded by relation; they carry the rewritten literal) and D\'s raw snp-verify diff (local)',
                     'B binaries (bin/, bin-release/), closure/ (2 GB build closure), fixtures/, lineage/ patches (duplicate the Git objects), raw job logs',
                     'F host-service-rpc-closure.patch (duplicates the Git objects), raw logs; S and B NOTE-FROM-S-BROWSER-RPC.md (handoff note)',
                     'P NOTE-FROM-S-*.md, bin/, bin-staging/, scratch/; C rehearsal/runs/d1-failed (untracked, C\'s own)',
                     'raw logs (digests instead), run handles, keys, binaries, node_modules, build caches',
                     'ACTIVE work (not final): B and S new owned trees, E after ca818b75 (dirty, new task), F\'s new compose tree, the ninth TLS worker (nucbox-tls-recovery-20261023/claude-run, candidate)',
                     'rpc-priority/patches/SHA256SUMS update (path already in the manifest; the Git-object patches are authoritative)']}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({k: {'commits': len(v['commits']), 'files': len(v['changedFiles'])} for k, v in {**sides, **derivs}.items()}
                 | {'d': {'exported': len(dfiles), 'referenced': len(dref)}, 'frozen': len(frozen), 'rootEvidence': len(evidence),
                    'lowercaseLiteralFiles': len(lit), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))
