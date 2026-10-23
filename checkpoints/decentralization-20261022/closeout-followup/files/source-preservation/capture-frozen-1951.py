"""APPEND the frozen-1951 material ("1951" = batch start 2026-10-23T19:51Z, an identifier) to closeout-followup/MANIFEST.json without
recapturing any existing (mutable) source. As capture-frozen-0830.py:
* never re-reads an existing entry's source: every existing entry's STORED file is checked against its manifest sha256 and the
  manifest JSON must round-trip byte-identically before anything is written;
* copies only the new paths below, each pinned by hash in frozen-1951-export/INVENTORY.json (or frozen-1951-pins.json), refusing
  any byte change since the export, any path already in the manifest and any overwrite of an existing stored file;
* appends the new entries (every one labelled) and an `appends` record; existing entries, unchangedAlreadyPreserved, status,
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
fx = sp / 'frozen-1951-export'
CK = '45bf6552f07a71cf7968e9b5bc48df8f5047d028'
pins = json.loads((sp / 'frozen-1951-pins.json').read_text())


# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


assert git('rev-parse', 'HEAD').strip() == CK and not git('status', '--porcelain').strip(), 'checkpoint repo not clean at 45bf6552'
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
    assert sha((fx / name).read_bytes()) == want, f'NOT CAPTURED: frozen-1951-export/{name} changed'
inv = json.loads((fx / 'INVENTORY.json').read_text())
add = [fx / name for name in pins]
for side in [*inv['sides'].values(), *inv['derivatives'].values()]:
    for patch in side['patches']:
        p = fx / patch['file']
        assert sha(p.read_bytes()) == patch['sha256'], f'NOT CAPTURED: {patch["file"]} differs'
        add.append(p)
    folder = fx / Path(side['patches'][0]['file']).parts[0] / 'files'
    for f in side['changedFiles']:
        if f['status'] != 'D':
            p = folder / f['path']
            assert sha(p.read_bytes()) == f['sha256'], f'NOT CAPTURED: {p} differs from its commit blob'
            add.append(p)
for side in inv['derivatives'].values():   # converted forms published beside a derivative (asserted round-trip in the export)
    for c in [*side.get('convertedManifest', {}).get('files', []), *(f for cm in side.get('convertedManifests', []) for f in cm['files'])]:
        p = fx / c['file']; assert sha(p.read_bytes()) == c['sha256'], f'NOT CAPTURED: {p} differs'; add.append(p)
for side in inv['sides'].values():   # base files of a side whose base tree is not in pushed material (touched-file reproduction)
    for c in side.get('baseFiles', []):
        p = fx / c['file']; assert sha(p.read_bytes()) == c['sha256'], f'NOT CAPTURED: {p} differs'; add.append(p)
for group in ('frozenSources', 'rootEvidence'):
    for name, want in inv[group].items():
        p = (base / name).resolve()
        assert sha(p.read_bytes()) == want, f'NOT CAPTURED: {name} changed after the frozen-1951 export'
        add.append(p)
for name in ('export-frozen-1951.py', 'verify-frozen-1951-export.py', 'capture-frozen-1951.py', 'frozen-1951-pins.json', 'frozen-1951-q.sh',
             'frozen-1951-export.sh', 'frozen-1951-capture.sh', 'frozen-1951-labels.json', 'make-frozen-1951-snapshots.py'):
    add.append(sp / name)

LABELS = json.loads((sp / 'frozen-1951-labels.json').read_text())

entries, total, plan = [], 0, []
seen = set()
# pass 1 checks EVERY item before anything is written (frozen-0931-capture-1 wrote 798 files, then failed on a later item)
for p in add:
    assert p not in seen, p
    seen.add(p)
    assert p.is_file() and not p.is_symlink(), p
    data = p.read_bytes()
    assert len(data) < 5_000_000, p
    data.decode('utf-8')
    assert OLD not in data, f'rewritten literal: {p}'
    rel = (p.relative_to(base) if p.is_relative_to(base) else Path('outputs') / p.relative_to(root / 'outputs')
           if p.is_relative_to(root / 'outputs') else Path('work') / p.relative_to(root / 'work'))
    source = str(p.relative_to(root))
    assert source not in existing_sources, f'already in the manifest (not recaptured): {source}'
    out = dest / 'files' / rel
    assert not out.exists(), f'refusing to overwrite an existing stored file: {out}'
    label = max(((k, v) for k, v in LABELS.items() if str(rel).startswith(k)), key=lambda kv: len(kv[0]), default=(None, None))[1]
    assert label, f'unlabelled: {source}'
    plan.append((p, data, out, label, source))
assert len({o for _, _, o, _, _ in plan}) == len(plan), 'two sources map to one stored path'
# pass 2 writes
for p, data, out, label, source in plan:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    out.chmod(0o644 | (p.stat().st_mode & 0o111))
    entries.append({'label': label, 'source': source, 'stored': str(out.relative_to(dest)), 'sha256': sha(data), 'bytes': len(data)})
    total += len(data)
before = len(m['entries'])
m['entries'].extend(entries)
m.setdefault('appends', []).append({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'by': 'source-preservation/capture-frozen-1951.py',
    'onCheckpoint': CK, 'entriesBefore': before, 'added': len(entries), 'bytes': total,
    'note': 'append-only: existing entries were verified against their stored bytes and not recaptured from their (mutable) '
            'sources; capturedAt above is the last full capture-latest.py run. "1951" is a batch identifier (start 19:51Z), not this time'})
mpath.write_text(json.dumps(m, indent=2) + '\n')
readme = dest / 'README.md'
text = readme.read_text()
line = ('\nFrozen 1951 append (2026-10-23; "1951" = the batch start 19:51Z, an identifier): ROOT CPU production activation 785f77af '
        '(all 9 apps on exact coupled shares, 18/18 TLS per root) with B manager 1bda7b79 and guest f6d5fbed source and ROOT native quota '
        'verification e859355e; custody v2 durability a5eae96c (source only, not built or activated), ROOT corrected-image release 44bf8f4f '
        '(e012 quote-only hardware canary, superseded for activation, not activated), R dashboard 4acad4a7 (source/test), ROOT live config '
        '70019fdf; root receipts and journal snapshot. Existing custody remains the single-seat bootstrap. See `MANIFEST.json` `appends`.\n')
marker = 'Frozen 1852 append (2026-10-23;'
assert marker in text
i = text.index('\n', text.index(marker))
readme.write_text(text[:i + 1] + line + text[i + 1:])
print(json.dumps({'before': before, 'added': len(entries), 'after': len(m['entries']), 'bytes': total}))
