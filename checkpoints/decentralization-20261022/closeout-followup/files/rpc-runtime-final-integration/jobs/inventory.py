"""Write ../INVENTORY.json: the immutable source/artifact inventory of rpc-runtime-final-integration (read-only)."""
import hashlib
import json
import pathlib
import re
import subprocess

F = pathlib.Path(__file__).resolve().parent.parent
REPO = F / 'repo'
BASE = 'df8fbafae081321f3c9a9c774e41007200913f32'


def git(*a):
    return subprocess.run(['git', *a], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip()


def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


head = git('rev-parse', 'HEAD')
assert not git('status', '--porcelain', '--', 'network', 'test', 'docs', 'scripts'), 'tracked source must be clean'
commits = [dict(zip(['commit', 'author', 'subject'], l.split('\t'))) for l in git('log', '--reverse', '--format=%H\t%an <%ae>\t%s', f'{BASE}..HEAD').splitlines()]
files = []
for f in git('diff', '--name-only', BASE, 'HEAD').splitlines():
    files.append({'path': f, 'blob': git('rev-parse', f'HEAD:{f}'), 'sha256': sha(REPO / f)})
jobs = {}
for rc in sorted((F / 'jobs').glob('*.rc')):
    n = rc.stem
    out = F / 'jobs' / f'{n}.out'
    text = out.read_text(errors='replace') if out.exists() else ''
    summary = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', text, re.M)}
    peak = re.findall(r'peakTreeRssMiB=(\d+)', text)
    cap = re.findall(r'cap=(\d+)MiB', text)
    jobs[n] = {'rc': rc.read_text().strip(), 'out_sha256': sha(out) if out.exists() else None, 'summary': summary or None,
               'peakTreeRssMiB': int(peak[-1]) if peak else None, 'capMiB': int(cap[0]) if cap else None,
               'stoppedByGuard': 'STOPPED: process tree RSS' in text}
inv = {
    'format': 'rpc-runtime-final-integration-inventory/v1',
    'label': 'SOURCE + OFFLINE PROCESS TESTS. Not deployed, pushed or merged. Not RPC independence.',
    'repo': {'path': 'rpc-runtime-final-integration/repo', 'branch': git('rev-parse', '--abbrev-ref', 'HEAD'), 'head': head, 'tree': git('rev-parse', 'HEAD^{tree}'),
             'base': {'commit': BASE, 'what': "A rpc-priority/repo final (0c43 + 437d/2efc/71448 + deadline b56a/f344 + fd6 as 25c0 + e820 + Windows df8f)"},
             'provenanceRefs': {r.split()[1]: r.split()[0] for r in git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/provenance').splitlines()}},
    'sources': {
        'P': {'repo': 'witness-cache-deadline-compose/repo', 'range': '9fdc1418c..9e838ba758b96f96eb9858e35f4898a95fc5cba7', 'tree': '90ecef92d89783aaf8da58eb2e0eae2483abf546'},
        'B': {'repo': 'rpc-runtime-composition/repo', 'range': '1ad7c4a3e0c6f8f1f279bb82d9633a58ffc903ff..8c8fa957ceeef4f3cbc116552656067157007db5'},
        'rootLock': {'repo': 'root-rpc-kernel-lock', 'commit': '794d2ff3c7e9e99a9fa92b54390030cb46f108cf', 'export': '336ea56ab458fa4f80481f332fd44f3bf88ded1f:source-only.patch'},
        'helper': {'helios': 'ef3202982b475212d9bb6adfdc3eed4ebb0b83c5', 'tree': 'eec339e18296d850a514f72de2efdd8729302efd'},
        'listener': {'commit': '5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7', 'tree': '00e3a61d48c91a6072355bf0ac67564490a6fc8b'},
        'budget': {'repo': 'fresh-witness-supply', 'commit': '959e56fd7ea191bfcc7eb94b26a20d4795856bd3', 'report': 'bcd3d9ca', 'use': 'binding rule only (no local cache enabled); nothing vendored or allocated'},
    },
    'commits': commits,
    'lineagePatches': {str(p.relative_to(F)): sha(p) for p in sorted((F / 'lineage').glob('*/*.patch'))},
    'changedFiles': files,
    'binaries': {'bin': {l.split()[1]: l.split()[0] for l in (F / 'bin' / 'PINS.sha256').read_text().splitlines()},
                 'bin-release': {l.split()[1]: l.split()[0] for l in (F / 'bin-release' / 'PINS.sha256').read_text().splitlines()},
                 'acceptedByRuntime': {'listener': ['ebd045b4 (debug)', '9ca75047 (release)'], 'helios': ['cc962e2b (debug)'], 'witnessCheck': ['4fe0cd3b (debug, ef320298)']}},
    'fixtures': {'P manifest (109 files)': sha(F.parent / 'witness-cache-deadline-compose' / 'FIXTURES.sha256'),
                 'reth-dev-8453-genesis.json': sha(F / 'fixtures' / 'reth-dev-8453-genesis.json'),
                 'reth-dev-8453-genesis-2935.json': sha(F / 'fixtures' / 'reth-dev-8453-genesis-2935.json')},
    'closure': {'base-5476069f.tar.gz': sha(F / 'closure' / 'src' / 'base-5476069f.tar.gz'),
                'cargo-home-helios/CLOSURE.json': sha(F / 'closure' / 'cargo-home-helios' / 'CLOSURE.json'),
                'cargo-home-listener/CLOSURE.json': sha(F / 'closure' / 'cargo-home-listener' / 'CLOSURE.json')},
    'jobs': jobs,
}
(F / 'INVENTORY.json').write_text(json.dumps(inv, indent=1) + '\n')
print(head, len(commits), 'commits', len(files), 'files', len(jobs), 'jobs')
