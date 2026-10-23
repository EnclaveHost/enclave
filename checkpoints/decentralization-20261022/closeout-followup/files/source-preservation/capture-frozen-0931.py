"""APPEND the frozen-0931 material ("0931" = batch start 2026-10-23T09:31Z, an identifier) to closeout-followup/MANIFEST.json without
recapturing any existing (mutable) source. As capture-frozen-0830.py:
* never re-reads an existing entry's source: every existing entry's STORED file is checked against its manifest sha256 and the
  manifest JSON must round-trip byte-identically before anything is written;
* copies only the new paths below, each pinned by hash in frozen-0931-export/INVENTORY.json (or frozen-0931-pins.json), refusing
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
fx = sp / 'frozen-0931-export'
CK = 'cadf0ebb83338d847ef1cb5d3f14a64fe7560098'
pins = json.loads((sp / 'frozen-0931-pins.json').read_text())


# OLD = the former provider name the 2026-10-21 repository rewrite replaced by 'Cloud Provider'; built from hex so this tool
# itself does not carry the literal it guards against
OLD = bytes.fromhex('54696e666f696c')
def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


assert git('rev-parse', 'HEAD').strip() == CK and not git('status', '--porcelain').strip(), 'checkpoint repo not clean at cadf0ebb'
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
    assert sha((fx / name).read_bytes()) == want, f'NOT CAPTURED: frozen-0931-export/{name} changed'
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
bl = json.loads((fx / 'd-installed-baseline/BASELINE.json').read_text())
add.append(fx / 'd-installed-baseline/BASELINE.json')
for f in bl['exported']:
    p = fx / 'd-installed-baseline/files' / f['path']
    assert sha(p.read_bytes()) == f['sha256'], f'NOT CAPTURED: {p} differs'
    add.append(p)
for group in ('frozenSources', 'rootEvidence'):
    for name, want in inv[group].items():
        p = (base / name).resolve()
        assert sha(p.read_bytes()) == want, f'NOT CAPTURED: {name} changed after the frozen-0931 export'
        add.append(p)
for name in ('export-frozen-0931.py', 'verify-frozen-0931-export.py', 'capture-frozen-0931.py', 'frozen-0931-pins.json', 'frozen-0931-q.sh',
             'frozen-0931-export.sh', 'frozen-0931-capture.sh', 'frozen-0931-labels.json', 'make-frozen-0931-digests.py'):
    add.append(sp / name)

LABELS = json.loads((sp / 'frozen-0931-labels.json').read_text())

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
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'by': 'source-preservation/capture-frozen-0931.py',
    'onCheckpoint': CK, 'entriesBefore': before, 'added': len(entries), 'bytes': total,
    'note': 'append-only: existing entries were verified against their stored bytes and not recaptured from their (mutable) '
            'sources; capturedAt above is the last full capture-latest.py run. "0931" is a batch identifier (start 09:31Z), not this time'})
mpath.write_text(json.dumps(m, indent=2) + '\n')
readme = dest / 'README.md'
text = readme.read_text()
line = ('\nFrozen 0931 append (2026-10-23; "0931" = the batch start 09:31Z, an identifier): A consumer parity e32dd607, B final verifier '
        'runtime c31e975a, F host-service-rpc-closure 14d1e495, C rollback order + database drain 19b91486, S browser closure 349318a0 '
        '(+ROOT 2bd1eea) and report b55ca791, ROOT PostgreSQL counterexample 555dc752 and TLS retry-recovery ab527067; P f8351487 and '
        'E ca818b75 as SOURCE-ONLY DERIVATIVES (one vendored upstream zip; 13 compiled fixtures and E exports omitted, recipes recorded); '
        "D's installed NucBox baseline sources/manifests and the Windows baseline-to-candidate review; the 0830 receipt with its time "
        'correction (cadf0ebb committed 07:57:53Z). Source + offline tests only; nothing deployed. See `MANIFEST.json` `appends`.\n')
marker = 'Frozen 08:30Z append (2026-10-23)'
assert marker in text
i = text.index('\n', text.index(marker))
readme.write_text(text[:i + 1] + line + text[i + 1:])
print(json.dumps({'before': before, 'added': len(entries), 'after': len(m['entries']), 'bytes': total}))
