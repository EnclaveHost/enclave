"""frozen-2100 ("2100" = batch start 2026-10-23T21:00:37Z, an identifier): dated snapshots of two living sources, append-only by source
path: root's journal ROOT-CONTINUE-LATEST.txt and outputs/decentralization-audit/custody-v2-live-verification-20261023.md (its earlier
bytes 23c9aeba... and the frozen-2025 snapshot a033b002... stay stored unchanged). ROOT-PENDING-LATEST.txt and
effective-goal-requirements.txt are byte-identical to their frozen-1852 snapshots (asserted), so they are not copied again.
First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert h(sp / 'ROOT-PENDING-LATEST.txt') == h(sp / 'snapshots-1852/ROOT-PENDING-LATEST.snapshot-1852.txt')
assert h(work / 'effective-goal-requirements.txt') == h(sp / 'snapshots-1852/effective-goal-requirements.snapshot-1852.txt')
snap = sp / 'snapshots-2100'; snap.mkdir(exist_ok=True)
for src, prev, name in ((sp.parent / 'ROOT-CONTINUE-LATEST.txt', sp / 'snapshots-2025/ROOT-CONTINUE-LATEST.snapshot-2025.txt', 'ROOT-CONTINUE-LATEST.snapshot-2100.txt'),
                        (work.parent / 'outputs/decentralization-audit/custody-v2-live-verification-20261023.md',
                         sp / 'snapshots-2025/custody-v2-live-verification-20261023.snapshot-2025.md', 'custody-v2-live-verification-20261023.snapshot-2100.md')):
    t = snap / name
    if not t.exists():
        assert h(src) != h(prev), f'{src.name} unchanged since its frozen-2025 snapshot: nothing to snapshot'
        shutil.copyfile(src, t)
    print(name, h(t))
