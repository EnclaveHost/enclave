"""frozen-1726 ("1726" = batch start 2026-10-23T17:26Z; snapshots taken 17:30:05Z, an identifier): dated snapshots of root's two living documents (the
journal ROOT-PENDING-LATEST.txt and effective-goal-requirements.txt), whose earlier bytes are already in the manifest under their own
paths (append-only by source path). First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
snap = sp / 'snapshots-1726'; snap.mkdir(exist_ok=True)
for src, name in ((sp / 'ROOT-PENDING-LATEST.txt', 'ROOT-PENDING-LATEST.snapshot-1726.txt'), (work / 'effective-goal-requirements.txt', 'effective-goal-requirements.snapshot-1726.txt')):
    t = snap / name
    if not t.exists(): shutil.copyfile(src, t)
    print(name, hashlib.sha256(t.read_bytes()).hexdigest())
