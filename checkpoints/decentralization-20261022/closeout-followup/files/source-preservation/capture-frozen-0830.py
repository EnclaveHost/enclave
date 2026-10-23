"""APPEND the frozen-0830 material to closeout-followup/MANIFEST.json without recapturing any existing (mutable) source.

Unlike capture-latest.py (which regenerates the whole manifest from live paths), this script:
* never re-reads an existing entry's source: it checks every existing entry's STORED file against its manifest sha256
  and that the manifest JSON round-trips byte-identically before anything is written;
* copies only the new paths below, each pinned by hash in frozen-0830-export/INVENTORY.json (or here), refusing any
  byte change since the export, any path already in the manifest and any overwrite of an existing stored file;
* appends the new entries (labelled) and an `appends` record; existing entries, unchangedAlreadyPreserved, status,
  exclusions and supersessions are left exactly as they are.
Writes only inside the checkpoint's closeout-followup/ (MANIFEST.json, README.md, new files/...).
"""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
sp = base / 'source-preservation'
repo = root / 'work/source-checkpoint-20261022/main-repo'
dest = repo / 'checkpoints/decentralization-20261022/closeout-followup'
fx = sp / 'frozen-0830-export'
CK = '842ca044199b5562136c80b2842cffe8374b65aa'
pins = json.loads((sp / 'frozen-0830-pins.json').read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


assert git('rev-parse', 'HEAD').strip() == CK and not git('status', '--porcelain').strip(), 'checkpoint repo not clean at 842ca044'
mpath = dest / 'MANIFEST.json'
raw = mpath.read_text()
m = json.loads(raw)
assert json.dumps(m, indent=2) + '\n' == raw, 'MANIFEST.json does not round-trip byte-identically'
tracked = set(git('ls-files', '--', 'checkpoints/decentralization-20261022/closeout-followup/files').splitlines())
bad, untracked = [], []
for e in m['entries']:
    p = dest / e['stored']
    if sha(p.read_bytes()) != e['sha256']:
        bad.append(e['stored'])
    if str(p.relative_to(repo)) not in tracked:
        untracked.append(e['stored'])
assert not bad and not untracked, ('existing stored entries', bad[:5], untracked[:5])
existing_sources = {e['source'] for e in m['entries']}

# ---- what to append -------------------------------------------------------------------------------------------------
for name, want in pins.items():
    assert sha((fx / name).read_bytes()) == want, f'NOT CAPTURED: frozen-0830-export/{name} changed'
inv = json.loads((fx / 'INVENTORY.json').read_text())
add = []   # (path, label)
for name in pins:
    add.append((fx / name, None))
m_ = inv['merge']
merge_side = {'patches': m_['patches'], 'changedFiles': [{**f, 'status': f['status']} for f in m_['changedFilesVsFirstParent']]}
for side in [*inv['sides'].values(), inv['derivative'], merge_side]:
    for patch in side['patches']:
        p = fx / patch['file']
        assert sha(p.read_bytes()) == patch['sha256'], f'NOT CAPTURED: {patch["file"]} differs'
        add.append((p, None))
    folder = fx / Path(side['patches'][0]['file']).parts[0] / 'files'
    for f in side['changedFiles']:
        if f['status'] != 'D':
            p = folder / f.get('storedAsHex', f['path'])
            if 'storedAsHex' in f:
                assert sha(p.read_bytes()) == f['hexSha256'], f'NOT CAPTURED: {p} differs'
                assert sha(bytes.fromhex(p.read_text().strip())) == f['sha256'], f'NOT CAPTURED: {p} does not decode to its blob'
                add.append((p, None))
                continue
            assert sha(p.read_bytes()) == f['sha256'], f'NOT CAPTURED: {p} differs from its commit blob'
            add.append((p, None))
for group in ('frozenSources', 'rootEvidence'):
    for name, want in inv[group].items():
        p = (base / name).resolve()
        assert sha(p.read_bytes()) == want, f'NOT CAPTURED: {name} changed after the frozen-0830 export'
        add.append((p, None))
for name in ('export-frozen-0830.py', 'verify-frozen-0830-export.py', 'capture-frozen-0830.py', 'frozen-0830-pins.json',
             'frozen-0830-export.sh', 'frozen-0830-capture.sh', 'frozen-0830-labels.json', 'make-frozen-0830-digests.py', 'make-frozen-0830-e-recipe.mjs'):
    add.append((sp / name, None))

LABELS = json.loads((sp / 'frozen-0830-labels.json').read_text())

entries, total = [], 0
seen = set()
for p, _ in add:
    assert p not in seen, p
    seen.add(p)
    assert p.is_file() and not p.is_symlink(), p
    data = p.read_bytes()
    assert len(data) < 5_000_000, p
    data.decode('utf-8')
    rel = (p.relative_to(base) if p.is_relative_to(base) else Path('outputs') / p.relative_to(root / 'outputs')
           if p.is_relative_to(root / 'outputs') else Path('work') / p.relative_to(root / 'work'))
    source = str(p.relative_to(root))
    assert source not in existing_sources, f'already in the manifest (not recaptured): {source}'
    out = dest / 'files' / rel
    assert not out.exists(), f'refusing to overwrite an existing stored file: {out}'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    out.chmod(0o644 | (p.stat().st_mode & 0o111))
    label = max(((k, v) for k, v in LABELS.items() if str(rel).startswith(k)), key=lambda kv: len(kv[0]), default=(None, None))[1]
    entries.append({**({'label': label} if label else {}), 'source': source, 'stored': str(out.relative_to(dest)),
                    'sha256': sha(data), 'bytes': len(data)})
    total += len(data)
unlabelled = [e['source'] for e in entries if 'label' not in e]
assert not unlabelled, unlabelled
before = len(m['entries'])
m['entries'].extend(entries)
m.setdefault('appends', []).append({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'by': 'source-preservation/capture-frozen-0830.py',
    'onCheckpoint': CK, 'entriesBefore': before, 'added': len(entries), 'bytes': total,
    'note': 'append-only: existing entries were verified against their stored bytes and not recaptured from their (mutable) '
            'sources; capturedAt above is the last full capture-latest.py run'})
mpath.write_text(json.dumps(m, indent=2) + '\n')
readme = dest / 'README.md'
text = readme.read_text()
line = ('\nFrozen 08:30Z append (2026-10-23): A Windows chain consumers df8fbafa (+ B deadline, ROOT fd6, client closure; patches '
        '0010-0014), ROOT canonical doc correction bcd3d9ca (tree = that of dc767fc3), C storage distributed-write cutover package '
        '6fd7a929 + RESULT bbf0a009, F final host-services compose merge 4106c311, and E 159fd148 as a SOURCE-ONLY DERIVATIVE (7 compiled '
        'fixtures omitted; blobs/hashes and a regeneration recipe recorded; exact original trees not reproducible from it). Source + '
        'offline tests only; nothing deployed. See `MANIFEST.json` `appends`.\n')
marker2 = 'Frozen 07:45Z append (2026-10-23)'
assert marker2 in text
i = text.index('\n', text.index(marker2))
readme.write_text(text[:i + 1] + line + text[i + 1:])
print(json.dumps({'before': before, 'added': len(entries), 'after': len(m['entries']), 'bytes': total}))
