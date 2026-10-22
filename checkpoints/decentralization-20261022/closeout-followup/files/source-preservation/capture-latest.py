"""Preserve authored closeout sources; never copy live run directories or secrets."""
from pathlib import Path
import datetime
import hashlib
import json

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
repo = root / 'work/source-checkpoint-20261022/main-repo'
dest = repo / 'checkpoints/decentralization-20261022/closeout-followup'
prior = repo / 'checkpoints/decentralization-20261022/closeout-drafts/files'
paths = set()
for directory in ('controller-bounds-validation', 'postgres-init-stage', 'production-final'):
    for p in (base / directory).rglob('*'):
        rel = p.relative_to(base / directory)
        if any(x in ('logs', 'runs', '__pycache__', 'secrets') for x in rel.parts):
            continue
        if p.is_file() and not p.is_symlink() and not p.name.startswith('logs-') and p.suffix not in ('.out', '.log'):
            paths.add(p)
for p in (base / 'production-run').rglob('*'):
    if any(x in ('runs', 'secrets', '__pycache__') for x in p.relative_to(base / 'production-run').parts):
        continue
    if p.is_file() and not p.is_symlink() and p.suffix in ('.py', '.sh'):
        paths.add(p)
for directory in ('src', 'tools', 'base', 'patches'):
    for p in (base / 'measured-composition' / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts:
            paths.add(p)
for p in (base / 'measured-composition').glob('*.json'):
    paths.add(p)
for directory in ('measured-image-build/tools', 'measured-image-build/public', 'measured-image-build/stub/bin', 'storage-activation-next'):
    for p in (base / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and p.name != 'published-ls-tree.txt' and '__pycache__' not in p.parts:
            paths.add(p)
paths.add(base / 'measured-composition/out/c/INPUT-MANIFEST.json')
# Preserve reviewed native-discovery work without copying generated TLS keys,
# raw logs, dependency trees, or the withdrawn deployment bundle.
native = base / 'native-control-discovery'
for pattern in ('*.patch', '*.txt', '*.sh', '*.py'):
    paths.update(p for p in native.glob(pattern) if p.is_file() and not p.is_symlink())
for relative in (
    'repo/relay/native-discovery.mjs',
    'repo/test/native-discovery.test.mjs',
    'repo/docs/design/nan-retirement.md',
    'draft-6e46c06d/test/native-control-substitution.test.mjs',
):
    paths.add(native / relative)
for p in (native / 'stubs').rglob('*'):
    if p.is_file() and not p.is_symlink():
        paths.add(p)
paths.add(base / 'native-control-discovery-root-review.txt')
# Read-only public catalog/admission evidence and reproducible probe sources.
for p in (base / 'storage-public-read').iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.mjs', '.json'):
        paths.add(p)
paths.add(Path(__file__).resolve())
entries = []
unchanged = []
for p in sorted(paths):
    data = p.read_bytes()
    assert len(data) < 5_000_000, p
    data.decode('utf-8')
    rel = p.relative_to(base)
    old = prior / rel
    if old.is_file() and old.read_bytes() == data:
        unchanged.append(str(old.relative_to(repo)))
        continue
    out = dest / 'files' / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.chmod(0o644)
    out.write_bytes(data)
    out.chmod(0o644 | (p.stat().st_mode & 0o111))
    entries.append({'source': str(p.relative_to(root)), 'stored': str(out.relative_to(dest)),
                    'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
manifest = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status': 'Recovery checkpoint; drafts and ongoing validation, not a release or activation',
            'entries': entries, 'unchangedAlreadyPreserved': unchanged,
            'exclusions': ['credentials and private configuration', 'live run directories and raw transcripts',
                           'generated images/binaries and dependency caches', 'copied base trees preserved earlier']}
(dest / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'files': len(entries), 'bytes': sum(e['bytes'] for e in entries),
                  'unchanged': len(unchanged), 'capturedAt': manifest['capturedAt']}))
