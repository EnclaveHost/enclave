"""frozen-1951 ("1951" = batch start 2026-10-23T19:51Z, an identifier; snapshot taken 19:53:03Z): dated snapshot of root's living journal
ROOT-CONTINUE-LATEST.txt (append-only by source path). ROOT-PENDING-LATEST.txt and effective-goal-requirements.txt are byte-identical to
their frozen-1852 snapshots (asserted), so they are not copied again. First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert h(sp / 'ROOT-PENDING-LATEST.txt') == h(sp / 'snapshots-1852/ROOT-PENDING-LATEST.snapshot-1852.txt')
assert h(work / 'effective-goal-requirements.txt') == h(sp / 'snapshots-1852/effective-goal-requirements.snapshot-1852.txt')
snap = sp / 'snapshots-1951'; snap.mkdir(exist_ok=True)
t = snap / 'ROOT-CONTINUE-LATEST.snapshot-1951.txt'
if not t.exists(): shutil.copyfile(sp.parent / 'ROOT-CONTINUE-LATEST.txt', t)
print(t.name, h(t))
