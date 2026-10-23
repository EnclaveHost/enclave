"""frozen-2025 ("2025" = batch start 2026-10-23T20:25Z, an identifier): dated snapshot of root's living journal ROOT-CONTINUE-LATEST.txt
(append-only by source path), and of root's living custody-v2-live-verification-20261023.md (already in the manifest from an earlier
batch with sha256 23c9aeba...; its source has since changed, and the stored old bytes are never rewritten). ROOT-PENDING-LATEST.txt and effective-goal-requirements.txt are byte-identical to their frozen-1852
snapshots (asserted), so they are not copied again. First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert h(sp / 'ROOT-PENDING-LATEST.txt') == h(sp / 'snapshots-1852/ROOT-PENDING-LATEST.snapshot-1852.txt')
assert h(work / 'effective-goal-requirements.txt') == h(sp / 'snapshots-1852/effective-goal-requirements.snapshot-1852.txt')
assert h(sp.parent / 'ROOT-CONTINUE-LATEST.txt') != h(sp / 'snapshots-1951/ROOT-CONTINUE-LATEST.snapshot-1951.txt'), 'journal unchanged since 1951'
snap = sp / 'snapshots-2025'; snap.mkdir(exist_ok=True)
t = snap / 'ROOT-CONTINUE-LATEST.snapshot-2025.txt'
if not t.exists(): shutil.copyfile(sp.parent / 'ROOT-CONTINUE-LATEST.txt', t)
print(t.name, h(t))
v = work.parent / 'outputs/decentralization-audit/custody-v2-live-verification-20261023.md'
assert h(v) != '23c9aeba780ff07f7f' and not h(v).startswith('23c9aeba780ff07f'), 'unchanged since its earlier capture: nothing to snapshot'
tv = snap / 'custody-v2-live-verification-20261023.snapshot-2025.md'
if not tv.exists(): shutil.copyfile(v, tv)
print(tv.name, h(tv))
