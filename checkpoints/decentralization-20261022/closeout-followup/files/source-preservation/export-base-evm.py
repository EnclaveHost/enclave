"""Export the FINISHED rpc-priority Base EVM work (worker A) for the checkpoint, from Git OBJECTS only.

Enclave candidate 9fdc1418c (4 commits on public dfe020abf) and patched Helios eeffcc9 (4 commits on upstream
0.12.0 = 2af9b418) are read with `git show`/`format-patch` at their exact commits, never from the (mutable, dirty)
worktrees. Non-Git reports, tools, job recipes and the real-mainnet call fixture are hashed into INVENTORY.json;
capture-latest.py re-checks every hash before it copies anything. Job logs become a digest (TEST-EVIDENCE.txt).
Writes only rpc-base-evm-export/ (rebuilt from scratch). No network, builds or tests.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
rp = base / 'rpc-priority'
out = base / 'rpc-base-evm-export'
AUTHOR = 'SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>'

ENCLAVE = {'repo': rp / 'repo', 'name': 'enclave-rpc-priority-9fdc1418c',
           'base': 'dfe020abf1794bedc42943e43fe85eb02593dd8d',
           'head': '9fdc1418caff88d1baa5c5967ac7eaaf9cf2a368',
           'commits': ['97785a40cda92c42d8b8e14ab9e9d25afc3332a2', '36a83c89bfe9cf5bfd1045da3a3c1595c690a258',
                       'eb707adc0e52050f38ba7352865bcba24b6f6d2e', '9fdc1418caff88d1baa5c5967ac7eaaf9cf2a368']}
HELIOS = {'repo': rp / 'helios-patched', 'name': 'helios-enclave-base-evm-eeffcc9',
          'base': '2af9b41887e069144ee56cd710f3ddca195473f8',
          'head': 'eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e',
          'commits': ['0a02256c3fcd269c97d68e7158f4e208631d1859', '3416a24527ddc7e9915d2ec3d9072e30cd3e7dfd',
                      'b93fcfdc53fac155022c3fb789ac57bbf5322e37', 'eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e']}
# The one binary Helios test object: byte-identical to B's public hex fixture already in the checkpoint.
SNAPPY = 'opstack/tests/data/ec197b9f01acd9b93c900014b5b16142183fc77b559e0e0a727687d171e3e467.v4.snappy'
SNAPPY_HEX = 'rpc-peer-audit/head-listener/crates/enclave-base-head-listener/tests/fixtures/base-mainnet-52965074.v4.snappy.hex'
SNAPPY_HEX_STORED = ('checkpoints/decentralization-20261022/closeout-followup/files/rpc-peer-audit/head-listener/crates/'
                     'enclave-base-head-listener/tests/fixtures/base-mainnet-52965074.v4.snappy.hex')
BASE_BASE = {'repo': 'https://github.com/base/base', 'tag': 'v1.5.1', 'commit': '5476069f1eb74a56bccb56fdefd4b4bb0e3cda42',
             'checkout': rp / 'vendor-inspect/base-v1.5.1', 'relativeToHelios': '../vendor-inspect/base-v1.5.1'}
FIXTURE = rp / 'fixtures/base-calls-20261023T014412Z'
# Only the FINISHED Base EVM / witness runs; later jobs (e.g. verifier-unit-*, the consumer wiring in progress) are excluded.
FINISHED_JOBS = ('base-', 'chain-r5', 'helios-build', 'witness-tests', 'q-retry')
HEADS = rp / 'fixtures/base-heads-b-live-20261023T013719Z'


def git(repo, *args, text=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=text).stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def export_repo(spec, binary_ok=()):
    repo, dst = spec['repo'], out / spec['name']
    log = git(repo, 'log', '--reverse', '--format=%H%x09%P%x09%T%x09%an <%ae>%x09%cn <%ce>%x09%s',
              f"{spec['base']}..{spec['head']}").splitlines()
    rows = [dict(zip(('commit', 'parent', 'tree', 'author', 'committer', 'subject'), l.split('\t'))) for l in log]
    assert [r['commit'] for r in rows] == spec['commits'], f"{spec['name']}: commit range is not exactly {spec['commits']}"
    assert rows[0]['parent'] == spec['base'] and all(rows[i]['parent'] == rows[i - 1]['commit'] for i in range(1, len(rows)))
    assert all(r['author'] == AUTHOR and r['committer'] == AUTHOR for r in rows), 'unexpected author/committer'
    names = git(repo, 'diff', '--name-status', '--no-renames', spec['base'], spec['head']).splitlines()
    files = []
    for line in names:
        status, path = line.split('\t')
        assert status in ('A', 'M'), line
        blob = git(repo, 'rev-parse', f"{spec['head']}:{path}").strip()
        data = git(repo, 'cat-file', 'blob', blob, text=False)
        entry = {'path': path, 'status': status, 'blob': blob, 'sha256': sha(data), 'bytes': len(data),
                 'baseBlob': git(repo, 'rev-parse', f"{spec['base']}:{path}").strip() if status == 'M' else None}
        try:
            data.decode('utf-8')
        except UnicodeDecodeError:
            assert path in binary_ok, f'unexpected binary {path}'
            entry['notStored'] = 'binary; see snappy reconstruction'
            files.append(entry)
            continue
        target = dst / 'files' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append(entry)
    spec_args = ['--', '.', *[f':(exclude){p}' for p in binary_ok]]
    (dst / 'patches').mkdir(parents=True)
    git(repo, 'format-patch', '--full-index', '--no-signature', '-o', str(dst / 'patches'),
        f"{spec['base']}..{spec['head']}", *spec_args)
    patches = sorted((dst / 'patches').iterdir())
    assert len(patches) == len(rows)
    return {'base': spec['base'], 'head': spec['head'], 'headTree': rows[-1]['tree'], 'commits': rows, 'changedFiles': files,
            'patches': [{'file': str(p.relative_to(out)), 'sha256': sha(p.read_bytes())} for p in patches],
            'patchesExclude': list(binary_ok)}


out.mkdir(exist_ok=True)
for child in out.iterdir():  # regenerate everything except the hand-written REBUILD.md
    if child.name != 'REBUILD.md':
        shutil.rmtree(child) if child.is_dir() else child.unlink()

enclave = export_repo(ENCLAVE)
enclave['baseProvenance'] = ('dfe020abf = public origin branch candidate/decentralized-control-20261022 head (EnclaveHost/enclave, '
                             'ls-remote at export); the candidate branch rpc-priority sits on it. NOT merged into the normal '
                             'checkpoint tree.')
enclave['localBranchAtExport'] = git(ENCLAVE['repo'], 'rev-parse', 'rpc-priority').strip()
assert git(root / 'work/source-checkpoint-20261022/main-repo', 'cat-file', '-t', ENCLAVE['base']).strip() == 'commit'

helios = export_repo(HELIOS, binary_ok=(SNAPPY,))
snappy_bytes = bytes.fromhex((base / SNAPPY_HEX).read_text().strip())
assert sha(snappy_bytes) == 'ec197b9f01acd9b93c900014b5b16142183fc77b559e0e0a727687d171e3e467'
assert git(HELIOS['repo'], 'cat-file', 'blob', f"{HELIOS['head']}:{SNAPPY}", text=False) == snappy_bytes
assert sha((root / 'work/source-checkpoint-20261022/main-repo' / SNAPPY_HEX_STORED).read_bytes()) == sha((base / SNAPPY_HEX).read_bytes())
helios['snappyReconstruction'] = {'path': SNAPPY, 'sha256': sha(snappy_bytes), 'bytes': len(snappy_bytes),
                                  'blob': git(HELIOS['repo'], 'rev-parse', f"{HELIOS['head']}:{SNAPPY}").strip(),
                                  'fromHexFixtureInCheckpoint': SNAPPY_HEX_STORED,
                                  'how': 'xxd -r -p <hex> > <path> (identical bytes; not duplicated here)'}
helios['upstream'] = {'repo': 'https://github.com/a16z/helios', 'tag': '0.12.0', 'commit': HELIOS['base'],
                      'tagVerifiedLocally': git(HELIOS['repo'], 'rev-parse', '0.12.0^{commit}').strip() == HELIOS['base']}
helios['localBranchAtExport'] = git(HELIOS['repo'], 'rev-parse', 'enclave-base-evm').strip()
helios['compatBranch'] = {'enclave-base-compat': git(HELIOS['repo'], 'rev-parse', 'enclave-base-compat').strip(),
                          'note': 'compat = first commit 0a02256 of this series (preserved in patch 0001)'}
assert helios['compatBranch']['enclave-base-compat'] == HELIOS['commits'][0]
assert not git(HELIOS['repo'], 'status', '--porcelain', '--ignored').strip(), 'helios-patched has files outside Git'
# The base/base path dependency must be an unmodified checkout of the pinned release.
bb = BASE_BASE['checkout']
assert git(bb, 'rev-parse', 'HEAD').strip() == BASE_BASE['commit']
assert git(bb, 'rev-parse', 'v1.5.1^{commit}').strip() == BASE_BASE['commit']
assert not git(bb, 'status', '--porcelain').strip(), 'base-v1.5.1 checkout is modified'
helios['dependencies'] = {
    'base/base (path dependency, MIT)': {k: v for k, v in BASE_BASE.items() if k != 'checkout'} | {'checkoutClean': True},
    'git': sorted(set(re.findall(r'source = "(git\+[^"]+)"', (out / HELIOS['name'] / 'files/Cargo.lock').read_text()))),
    'crates.io': 'every other package pinned by name+version+checksum in the preserved Cargo.lock',
    'toolchain': 'Rust 1.96.0 (base/base rust-version 1.96), selected per job with RUSTUP_TOOLCHAIN=1.96.0; '
                 'helios rust-toolchain.toml (upstream, unchanged) pins 1.94.0',
    'notPreserved': ['cargo-home (1.3 GiB registry/git cache: re-fetch from Cargo.lock)', 'helios-target*/ (debug binaries)',
                     'vendor-inspect/ (upstream clones/tarballs: re-fetch from the pins above)']}

# Non-Git sources: frozen by hash here; capture-latest.py refuses to copy any that changed afterwards.
frozen = {}
def freeze(p):
    frozen[str(p.relative_to(base))] = sha(p.read_bytes())
for name in ('RESULT-BASE-EVM.md', 'RESULT.md', 'WITNESS-INITIAL.md', 'ROOT-RESEARCH.json'):
    freeze(rp / name)
for p in sorted((rp / 'fixture-tools').iterdir()):
    freeze(p)
for p in sorted((rp / 'jobs').glob('*.sh')):
    if p.name.startswith(FINISHED_JOBS):
        freeze(p)
freeze(FIXTURE / 'fixture.json')
cache = sorted((FIXTURE / 'cache').rglob('*.json'))
assert len(cache) == 49 and all(p.parent.name == '0x117db438e945b68030939fe5f9309a34bd28855b08d4765c2f36457567eb89c5' for p in cache)
for p in cache:
    json.loads(p.read_text())
    freeze(p)
fixture = json.loads((FIXTURE / 'fixture.json').read_text())
assert fixture['format'] == 'enclave-base-call-fixture/v1' and fixture['block']['number'] == 52965249

heads = []
for p in sorted((HEADS / 'objects').iterdir()):
    data = p.read_bytes()
    assert p.name == sha(data) + '.v4.snappy'
    heads.append({'name': p.name, 'bytes': len(data)})
assert len(heads) == 52

# Test evidence digest: per log its sha256/size, then only queue/guard/summary/failure lines.
KEEP = re.compile(r'^\[(queue|memory-guard)\]|^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|^(not )?ok \d|'
                  r'^test result:|^test .* \.\.\. |FAILED|panicked|^[0-9a-f]{64}  |BUILD_TEST_OK|UNEXPECTED|external network|'
                  r'^FIXTURE|^== |^rustc |^error|✖|SIGABRT|timed out|^[0-9a-f]{7,9} ')
ANSI = re.compile(r'\x1b\[[0-9;]*m')
lines = ['# rpc-priority (Base EVM) terminal test evidence digest, generated from rpc-priority/jobs/*.out (the full logs stay local).',
         '# Per log: sha256/size of the full log, its .rc and .guard.log, then only queue/guard/summary/failure/hash lines.',
         '# Exit 99 = memory guard stop (not a pass); exit 98 = not started. See RESULT-BASE-EVM.md section 4 for the reading.', '']
for o in sorted(o for o in (rp / 'jobs').glob('*.out') if o.name.startswith(FINISHED_JOBS)):
    data = o.read_bytes()
    rc = o.with_suffix('.rc')
    guard = o.with_name(o.stem + '.guard.log')
    lines.append(f'## {o.name}  sha256 {sha(data)}  bytes {len(data)}  rc {rc.read_text().strip() if rc.is_file() else "n/a"}')
    if guard.is_file():
        lines += ['    guard: ' + l for l in guard.read_text().splitlines()]
    kept = [ANSI.sub('', l) for l in data.decode('utf-8', 'replace').splitlines() if KEEP.search(ANSI.sub('', l))]
    lines += ['    ' + l[:400] for l in kept[:250]]
    if len(kept) > 250:
        lines.append(f'    ... {len(kept) - 250} more matching lines omitted')
    lines.append('')
(out / 'TEST-EVIDENCE.txt').write_text('\n'.join(lines))

inventory = {
    'format': 'enclave-base-evm-export/v1',
    'label': ('SOURCE + OFFLINE/RECORDED FIXTURES ONLY. Not deployed, not activated, NOT RPC independence. Proven: 5 real '
              'Cobalt-era Base mainnet eth_call replays byte-exact (block 52965249), offline replay 12/12, Rust 15/15, real '
              'gossip head E2E 3/3 (debug builds only). NOT proven: fresh proof-source independence (fresh witnesses still need '
              'a JSON-RPC execution source), finality, tx broadcast, consumer (LeaseReader) wiring, Sia witness-cache backend, '
              'release builds. Base execution refused from Denim (2026-11-05T18:00Z) until a Denim-era replay validates it.'),
    'enclave': enclave,
    'helios': helios,
    'frozenSources': frozen,
    'fixture': {'dir': str(FIXTURE.relative_to(base)), 'block': fixture['block'], 'providers': fixture['providers'],
                'calls': [c['name'] for c in fixture['calls']], 'witnessEntries': len(cache),
                'testSequencerSigner': fixture['testSequencerSigner'],
                'note': 'public chain state only (block header fields, eth_call results, eth_getProof/eth_getCode witnesses). The head '
                        'commitment is signed by a TEST key ("5e" x 32, in record-base-calls.mjs), not the Base sequencer. '
                        'Not preserved: helios.log (raw run log), home/.helios/helios.toml (regenerated by the test).'},
    'baseHeadsReferencedNotCopied': {'dir': str(HEADS.relative_to(base)), 'objects': heads,
                                     'note': ('Worker B\'s 52 real Base v4 gossip objects (content-addressed names). Raw binaries '
                                              'are NOT duplicated here; the head E2E (test/helios-base-head.e2e.test.mjs) needs '
                                              'this local directory (BASE_HEADS_DIR) or B\'s preserved objects. One of them '
                                              '(52965074) is in the checkpoint as a hex fixture.')},
    'notPreserved': ['the dirty worktrees (rpc-priority/repo has untracked node_modules, contracts/foundry/out)',
                     'helios-target/, helios-target-base/ (debug binaries: helios cc962e2b, opstack-server 35e2f012; compat helios '
                     '0929f7f3)', 'cargo-home/ registry/git caches', 'vendor-inspect/ upstream copies (stock 0.12.0 release helios '
                     'a7f777b4, npm package, crate tarballs)', 'raw job logs (digest only)', 'test-scratch/, probes/ outputs',
                     'fixtures base-calls-20261023T014145Z/014245Z (failed recordings r1/r2), live-*/ (earlier synthetic runs)',
                     'WITNESS-INITIAL.v1-superseded.md'],
}
(out / 'INVENTORY.json').write_text(json.dumps(inventory, indent=1) + '\n')
print(json.dumps({'enclaveFiles': len(enclave['changedFiles']), 'heliosFiles': len(helios['changedFiles']),
                  'frozenSources': len(frozen), 'heads': len(heads), 'inventorySha256': sha((out / 'INVENTORY.json').read_bytes())}))
